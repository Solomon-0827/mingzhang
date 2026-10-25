import csv
import hashlib
import io
import json
import zipfile
from datetime import datetime
from decimal import Decimal, InvalidOperation
from uuid import uuid4

import openpyxl

from backend.ledger import Entry, fail, save_entry

ALIASES = {
    "date": ["日期", "时间", "交易时间", "交易日期", "date"],
    "kind": ["类型", "交易类型", "收支类型", "收支", "kind"],
    "amount": ["金额", "交易金额", "金额(元)", "金额（元）", "amount"],
    "account": ["账户", "账户名称", "支付账户", "account"],
    "to_account": ["转入账户", "目标账户"],
    "category": ["分类", "大类", "一级分类", "category"],
    "subcategory": ["小类", "二级分类"],
    "merchant": ["商家", "商户", "交易对象", "merchant"],
    "memo": ["备注", "说明", "memo"],
    "currency": ["币种", "货币", "currency"],
}
TYPE_MAP = {
    "收入": "income",
    "支出": "expense",
    "转账": "transfer",
    "income": "income",
    "expense": "expense",
    "transfer": "transfer",
}


def read_file(content, name):
    if len(content) > 5 * 1024 * 1024:
        fail("文件不能超过 5 MB")
    if name.lower().endswith(".xlsx"):
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                if sum(i.file_size for i in archive.infolist()) > 30 * 1024 * 1024:
                    fail("表格解压后过大")
            workbook = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
            rows = []
            for row in workbook.active.iter_rows(values_only=True):
                rows.append([str(x) if x is not None else "" for x in row])
                if len(rows) > 10001:
                    fail("每次最多导入 10000 行")
            workbook.close()
        except (ValueError, zipfile.BadZipFile, KeyError):
            fail("无法读取 XLSX 文件")
    elif name.lower().endswith(".csv"):
        try:
            value = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                value = content.decode("gb18030")
            except UnicodeDecodeError:
                fail("文件编码无法识别，请导出 UTF-8 CSV")
        rows = list(csv.reader(io.StringIO(value)))
    else:
        fail("请选择 CSV 或 XLSX 文件")
    rows = [r for r in rows if any(str(v).strip() for v in r)]
    if not rows or len(rows) > 10001:
        fail("文件为空或超过 10000 行")
    header_index = 0
    for i, row in enumerate(rows[:20]):
        if any(x.strip() in ALIASES["amount"] for x in row) and any(x.strip() in ALIASES["date"] for x in row):
            header_index = i
            break
    headers = [str(v).strip() or f"列{i + 1}" for i, v in enumerate(rows[header_index])]
    if len(set(headers)) != len(headers):
        fail("表头有重复列名，请先修改后再导入")
    mapping = {key: next((h for h in headers if h in aliases), "") for key, aliases in ALIASES.items()}
    return headers, rows[header_index + 1 :], mapping


def fingerprint(data):
    fields = ["date", "kind", "amount_cents", "account_id", "to_account_id", "category", "merchant", "memo"]
    return hashlib.sha256(json.dumps([data.get(k) for k in fields], ensure_ascii=False).encode()).hexdigest()


def preview(db, rows, headers, mapping):
    existing = {fingerprint(dict(x)) for x in db.execute("SELECT * FROM entries WHERE deleted=0")}
    accounts = {x["name"]: x["id"] for x in db.execute("SELECT * FROM accounts")}
    results = []
    new_accounts = {}
    for i, row in enumerate(rows):
        source = dict(zip(headers, row, strict=False))

        def get(key, source=source):
            return str(source.get(mapping.get(key, ""), "")).strip()

        try:
            if get("currency") not in ["", "CNY", "RMB", "人民币", "元", "¥", "￥"]:
                raise ValueError("首版仅支持人民币，请单独处理其他币种")
            kind = TYPE_MAP.get(get("kind"))
            if not kind:
                raise ValueError("类型须为收入、支出或转账；退款/借贷请手工关联原交易")
            raw_amount = Decimal(get("amount").replace(",", "").replace("￥", "").replace("¥", ""))
            if not raw_amount.is_finite() or raw_amount <= 0 or raw_amount != raw_amount.quantize(Decimal("0.01")):
                raise ValueError("金额须为正数，最多两位小数")
            raw_date = (
                get("date").replace("/", "-").replace("年", "-").replace("月", "-").replace("日", "").split(" ")[0]
            )
            parsed_date = datetime.strptime(raw_date, "%Y-%m-%d").date().isoformat()
            name = get("account")
            if not name:
                raise ValueError("缺少账户名称")

            def account_id(name):
                if name not in accounts:
                    accounts[name] = str(uuid4())
                    new_accounts[name] = accounts[name]
                return accounts[name]

            to_name = get("to_account")
            if kind == "transfer" and (not to_name or to_name == name):
                raise ValueError("转账需要不同的转出、转入账户")
            category = "/".join(filter(None, [get("category"), get("subcategory")]))
            if kind in ["income", "expense"] and not category:
                category = "未分类"
            entry = Entry(
                date=parsed_date,
                kind=kind,
                amount_cents=int(raw_amount * 100),
                account_id=account_id(name),
                to_account_id=account_id(to_name) if kind == "transfer" else None,
                category=category,
                merchant=get("merchant"),
                memo=get("memo"),
            ).model_dump(mode="json")
            fp = fingerprint(entry)
            duplicate = fp in existing
            existing.add(fp)
            results.append(dict(row=i + 2, entry=entry, account=name, fingerprint=fp, duplicate=duplicate, error=""))
        except (ValueError, InvalidOperation) as exc:
            results.append(dict(row=i + 2, error=str(exc), duplicate=False, source=source))
    return dict(rows=results, new_accounts=new_accounts)


def commit_import(db, batch, selection):
    payload = json.loads(batch["payload"])
    preview_data = preview(db, payload["rows"], payload["headers"], payload["mapping"])
    chosen = [x for x in preview_data["rows"] if x["row"] in selection]
    if not chosen or any(x["error"] for x in chosen):
        fail("请选择至少一条有效记录")
    if any(x["duplicate"] for x in chosen):
        fail("发现重复记录，请重新预览并取消重复行")
    used = {x["entry"]["account_id"] for x in chosen} | {x["entry"]["to_account_id"] for x in chosen}
    for name, aid in preview_data["new_accounts"].items():
        if aid in used:
            db.execute("INSERT INTO accounts(id,name,kind,opening_cents) VALUES (?,?,?,0)", (aid, name, "bank"))
    for x in chosen:
        save_entry(db, Entry(**x["entry"]), batch_id=batch["id"], fingerprint=x["fingerprint"])
    db.execute("UPDATE imports SET status='committed' WHERE id=?", (batch["id"],))
    return len(chosen)
