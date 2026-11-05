# 明账 · 个人账本

第一轮可运行版本：React 网页 + Electron macOS 客户端 + FastAPI / SQLite 服务。三端连接同一服务地址后共用账本。暂名「明账」，面向单人、人民币、联网记账。

## 已实现

- 月度、季度、年度、自定义日期筛选；每日收支与累计结余曲线；点击日期/分类下钻流水。
- 收入、支出、转账、关联退款、借入、借出、收回、还款；复制、编辑、搜索、账户筛选、回收站恢复。
- 银行卡、现金、电子钱包、信用卡；期初余额、实时余额、总资产、总负债、净资产、未结清往来。
- CSV / XLSX 列映射、导入预览、异常提示、重复排除、选中导入、批次撤销；流水 CSV 导出。
- 独立账本密码、会话认证、跨站请求检查、登录限流；客户端提交 UUID 防止重复记账、版本号检测编辑冲突。
- 每日 SQLite 完整备份，保留最近 30 份；手动下载备份；离线恢复命令及运行中恢复保护。
- macOS 独立窗口、Dock、菜单、服务器地址配置、Command+N 快速记账、刷新与缩放；Apple silicon 和 Intel 安装包。

## 本机运行

需要 Python 3.12+、uv；开发或重新打包前端需要 Node/npm。

```sh
uv sync
npm --prefix web ci
npm --prefix web run build
```

双击 `scripts/start-demo.command` 打开独立的虚构演示账本，或：

```sh
LEDGER_DB=data/demo.sqlite3 uv run python -m scripts.demo
LEDGER_DB=data/demo.sqlite3 LEDGER_BACKUPS=backups/demo uv run uvicorn backend.main:app --host 127.0.0.1 --port 8765
```

演示地址 http://127.0.0.1:8765 ，密码 `Mingzhang-Demo-2026`。演示数据与真实账本严格分开。

真实账本双击 `scripts/start.command`，首次在终端设置至少 12 位密码。地址 http://127.0.0.1:8766 。不会自动导入演示数据。窗口保持打开；Control+C 停止。服务器不监听局域网或公网。

更换当前账本密码：在网页版或 Mac 客户端进入「设置 → 修改密码」，输入当前密码和两次新密码即可；成功后各端需重新登录。也可以在仓库目录运行 `uv run python -m scripts.manage password`，按提示输入当前密码、新密码及确认密码（至少 12 位，输入不回显）。更换后所有设备需重新登录，账目不受影响；此命令使用 `LEDGER_DB` 指定的数据库，默认是 `data/ledger.sqlite3`。

## Mac 客户端

解压对应 CPU 的 `.zip`，把 `明账.app` 拖入 Applications。打开后填入账本服务地址。本机运行填上述 localhost 地址；云端运行填同一个 HTTPS 域名。用户名不需要，输入账本密码即可。修改服务器地址：菜单「明账 → 服务器连接」。

客户端不包含 Python 后端，需要可连接的账本服务。它不提供离线保存。第一次手工签发的预览包没有 Apple Developer ID 公证，不修改系统安全设置、不绕过安全警告；受系统策略限制时可先使用网页版。

开发和打包：

```sh
npm --prefix desktop ci
npm --prefix desktop start
npm --prefix desktop run package
```

## 记账口径

金额存储为整数分；日期以 Asia/Shanghai 为账本时区，按实际交易日统计。期初余额不计收入；信用卡欠款用负期初余额。

- 转账、信用卡偿还本金：一个账户减少、另一个账户增加，净资产和收支不变。
- 退款：关联原支出，可多次部分退款，总额不得超过原金额；在退款发生日抵扣原分类支出，因此某月净支出可为负。
- 借出：现金减少、应收增加；收回减少应收。借入/还款同理影响应付；本金不计收支。
- 利息、手续费：另外记录为收入/支出。
- 已有关联退款/还款的原交易受保护，避免修改或删除后破坏关系。
- 账户余额为期初余额加全部有效流水；净资产为账户净额加应收减应付，独立于当前报表日期筛选。

## 历史迁移

数据管理 → 上传 CSV 或 XLSX → 核对字段映射 → 查看异常/疑似重复 → 确认导入。支持 UTF-8、带 BOM 的 UTF-8 和 GB18030 CSV，最多 5 MB / 10,000 行。新账户期初余额为 0，迁移后应按历史第一笔之前的真实余额调整并对账。

支持收入、支出、转账。原文件中的退款和借贷必须手工关联原交易，首版不会猜测；外币及旧版 XLS 暂不支持。重复判断使用日期、类型、金额、账户、分类、商家和备注。同日同内容的真实多笔也可能被判为疑似重复；可核对后手工补录。批次撤销保留新建账户，并将流水移入回收站。

尚未获得用户真实的随手记导出样本，因此不能声称已完成真实账本迁移或全部随手记格式兼容。上线迁移前需要核对总笔数、各月收支及账户余额。

## 备份与恢复

服务端启动后及跨日自动备份，保留最近 30 份。备份在同一台服务器不能抵御磁盘丢失；请通过「下载完整备份」另存到另一台设备。备份含账本及密码的加密校验值，按私人财务文件保管。

先停止账本服务，再运行（LEDGER_DB 指向要恢复的实际账本）：

```sh
LEDGER_DB=data/ledger.sqlite3 uv run python -m scripts.manage restore --file /绝对路径/备份.sqlite3
```

恢复前检查数据库完整性和必需表；当前账本另存为 `.before-restore`；清除会话，重启后重新登录。运行中的服务持有锁，恢复命令会拒绝覆盖。

## 阿里云 Ubuntu 24.04 部署

发行包包含已构建网页，无需在 2 GiB 服务器上构建 Node 项目。安装脚本只安装后端并绑定 127.0.0.1，**不会开放明文公网账本**。

```sh
sudo bash deploy/install.sh
sudo -u mingzhang env LEDGER_DB=/opt/mingzhang/data/ledger.sqlite3 \
  /opt/mingzhang/venv/bin/python -m scripts.manage init
```

第二条命令在 `/opt/mingzhang/app` 目录运行，在终端交互设置密码。准备自己的域名、DNS 和 HTTPS 反向代理后，在 `/opt/mingzhang/config.env` 把 `APP_ORIGIN` 设置为准确的 `https://账本域名`。Caddy 配置示例见 `deploy/Caddyfile.example`；按官方方法安装 Caddy，加载配置，使用 systemd 启动服务：

```sh
sudo systemctl enable --now mingzhang
curl http://127.0.0.1:8765/api/health
```

服务使用独立的 `mingzhang` 系统用户、只读程序目录、私有数据目录、单工作进程和自动重启。SQLite 写事务串行，适合当前单人账本，不使用多 worker。

更新：先备份，停止服务，保留 `/opt/mingzhang/data`、`backups`、`config.env`，替换 app 文件，安装新 requirements，再重启、检查健康接口与实际登录。不要覆盖真实数据库。

## 验证

```sh
uv run ruff check backend scripts tests
uv run pytest -q
npm --prefix web run build
```

自动测试覆盖收支口径、部分退款上限、并发退款、跨月统计、借贷净资产、幂等重试、版本冲突、回收站、认证/跨站限制、导入去重/撤销、XLSX、精度及真实恢复命令。

下一轮计划：预算、周期账单、自动分类规则、报销、标签与保存筛选；多币种、自动银行同步、离线同步、多人共享和 AI 不在第一轮范围内。

### 随手记旧版 XLS 迁移

六工作表的旧版 XLS 使用专用迁移命令，保留原始行、时间、成员、项目和备注；相同金额记录不会自动去重，重复文件会被拒绝。

```bash
LEDGER_DB=data/ledger.sqlite3 uv run python -m scripts.import-sui /path/to/myMoney.xls
LEDGER_DB=data/ledger.sqlite3 uv run python -m scripts.import-sui /path/to/myMoney.xls --config /path/to/local-config.json --commit
```

配置可包含 `account_kinds`（账户名到类型）和 `calibrations`（经核对确认的账户、日期、整数分差额和原因）。负债变更取相反余额方向；余额/债权/负债调整不计入收支。外币导出不提供原币种和双边金额，迁移按导出人民币值保留，需要单独对账，不能视为实时多币种账本。

真实数据、密码、校准配置与迁移报告仅保存在本机，不提交 Git。迁移前自动备份既有数据库；写入失败整批回滚。网页 CSV/XLSX 通用入口保持原有预览流程。

## 自动部署

自动部署配置与服务器升级/回退说明见 [deploy/AUTOMATION.md](deploy/AUTOMATION.md)。
PR 运行验证，合并到 `feat/first-release` 后构建部署包，使用 production secrets 连接服务器。
首次启用需要先配置服务器访问凭据；未配置时不会执行成功的云端更新。


## 客户端下载

登录页和账本页底部提供「客户端下载」：Mac Apple Silicon arm64 ZIP、Windows 11 x64 ZIP。
Windows 版解压整个文件夹后运行「明账.exe」；Mac 版解压后拖入应用程序。两者均连接已配置的账本服务。
当前 Mac 使用 ad-hoc 签名但未公证，Windows 未做发行商代码签名；不声称已通过 Windows 11 真机验收。

合并到部署分支后，GitHub Actions 在 macOS 与 Windows runner 构建客户端，通过专用 SSH
身份发布到现有阿里云服务器。网页继续使用固定的 `/downloads/mingzhang-mac-arm64.zip` 和
`/downloads/mingzhang-windows11-x64.zip`。服务器以共享目录原子切换两个安装包与签名清单，
只保留最新一套，不随网页 release 重复复制。ZIP、签名私钥、SSH 私钥和用户数据不进入 Git。

需要本机诊断时，可在 macOS 打包 Mac arm64、在 Windows 打包 Windows x64：

```sh
npm --prefix desktop ci
npm --prefix desktop run package
```

产物在 `desktop/out/downloads/`，附 SHA256 校验文件，仅包含应用代码。本机打包不会发布；
正式发布必须由 Actions 同时取得两平台安装包、生成 Ed25519 签名清单后完成。客户端只信任
内置公钥对应的清单，并再次核对安装包 SHA256。`0.1.1` 及更早版本没有更新器，需要手动
安装一次 `0.2.0` 或更高版本；之后有新版本时左下角会出现更新图标。

## 账户余额与借还款

在资金账户点击当前余额，填写实际余额并回车保存。系统保留期初余额，按当前日期记录调整差额，不计入收支；提交时检查账户版本与余额，避免覆盖其他端的新流水。新建账户仍填写初始余额。

还款选择付款资金账户及负债账户，回款选择收款资金账户及债权账户，两边余额同步更新，本金不计入收入或支出。历史按原交易关联的借还款保持兼容，不自动迁移或重复计算。

“记一笔”不再提供退款、余额调增、余额调减入口；已有记录及其历史统计保留。
