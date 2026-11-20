"""Category names are a catalog; deleting a name never deletes ledger entries."""
import json
from typing import Literal

from pydantic import BaseModel, Field

DEFAULTS = ['日常/餐饮', '日常/购物', '日常/交通', '居住/房租', '居住/水电',
            '生活/娱乐', '生活/旅行', '健康/医疗', '学习/书籍', '收入/工资', '收入/其他', '未分类']


def catalog(db):
    row = db.execute("SELECT value FROM settings WHERE key='category_catalog'").fetchone()
    result = json.loads(row[0]) if row else {'items': {}, 'hidden': [], 'version': 0}
    items = {}
    # A complete imported catalog owns the active choices, including unused categories.
    # Defaults and old transaction labels must not silently reappear after a sync.
    if not result.get('authoritative', False):
        items = {p: (['income'] if p.startswith('收入/') else ['income', 'expense'] if p == '未分类' else ['expense'])
                 for p in DEFAULTS}
        for row in db.execute("SELECT DISTINCT category,kind FROM entries WHERE category<>'' AND kind IN ('income','expense')"):
            kinds = items.setdefault(row['category'], [])
            if row['kind'] not in kinds:
                kinds.append(row['kind'])
    items.update(result['items'])
    result.setdefault('retired', [])
    result.setdefault('removed_kinds', {})
    result['items'] = {p: kinds for p, kinds in items.items() if p not in result['hidden'] and p not in result['retired']}
    return result


def drop_placeholder(db, items, parent):
    # An empty first-level category is kept as a bare item so its group stays visible.
    # Once the group has second-level categories again, the bare item is no longer needed,
    # unless ledger entries still use it.
    if parent in items and any(p.startswith(parent + '/') for p in items):
        if not db.execute('SELECT 1 FROM entries WHERE category=? LIMIT 1', (parent,)).fetchone():
            items.pop(parent)


class CategoryChange(BaseModel):
    action: Literal['add', 'rename', 'delete', 'restore']
    level: Literal['parent', 'child'] = 'child'
    path: str = Field(min_length=1, max_length=80)
    name: str = Field(default='', max_length=40)
    kind: Literal['expense', 'income'] = 'expense'
    version: int = Field(ge=0)


def change_category(db, body):
    from backend.ledger import audit, display_order, fail
    db.execute('BEGIN IMMEDIATE')
    value = catalog(db)
    if value['version'] != body.version:
        fail('分类已在另一端修改，请刷新后重试', 409)
    items, hidden = value['items'], set(value['hidden'])
    path = body.path.strip()
    if any(not part.strip() or part != part.strip() for part in path.split('/')) or path.count('/') > 1:
        fail('分类名称不能为空，且最多支持两级分类')
    if body.level == 'parent' and '/' in path:
        fail('一级分类名称不能包含斜杠')
    if body.level == 'child' and '/' not in path:
        fail('请选择二级分类')
    parents = {p.split('/')[0] for p in items}
    mapping = {}
    affected = [p for p in items if p == path or (body.level == 'parent' and p.startswith(path + '/'))]
    if body.action == 'add':
        if path in items or (body.level == 'parent' and path in parents):
            fail('同名分类已存在')
        if body.level == 'parent' and '/' in path:
            fail('一级分类名称不能包含斜杠')
        if body.level == 'child' and ('/' not in path or path.split('/')[0] not in parents):
            fail('请先创建所属一级分类')
        items[path] = [body.kind]
        hidden.discard(path)
        value['retired'] = [p for p in value['retired'] if p != path]
        drop_placeholder(db, items, path.split('/')[0])
    elif body.action == 'restore':
        # Restoring a first-level category brings back every deleted category in that group.
        targets = [p for p in hidden if p == path or (body.level == 'parent' and p.startswith(path + '/'))]
        if not targets:
            fail('分类不在已删除列表中')
        for p in targets:
            hidden.remove(p)
            items[p] = value['removed_kinds'].pop(p, None) or list({r[0] for r in db.execute("SELECT DISTINCT kind FROM entries WHERE category=? AND kind IN ('income','expense')", (p,))}) or [body.kind]
        drop_placeholder(db, items, path.split('/')[0])
    else:
        if not affected:
            fail('分类不存在', 404)
        if body.action == 'delete':
            for p in affected:
                value['removed_kinds'][p] = items.pop(p)
                hidden.add(p)
            if body.level == 'child':
                parent = path.split('/')[0]
                if not any(p == parent or p.startswith(parent + '/') for p in items):
                    items[parent] = value['removed_kinds'][path]
        else:
            name = body.name.strip()
            if not name or '/' in name:
                fail('名称不能为空或包含斜杠')
            target = name if body.level == 'parent' else path.split('/')[0] + '/' + name
            if target == path:
                fail('名称没有变化')
            if target in items or target in hidden or (body.level == 'parent' and target in parents):
                fail('同名分类已存在（也可能在已删除列表中）')
            # Deleted categories in a renamed group move with it, so restoring them later
            # (and their history entries) lands under the new first-level name.
            moved_hidden = [p for p in hidden if body.level == 'parent' and (p == path or p.startswith(path + '/'))]
            mapping = {p: target + p[len(path):] for p in affected + moved_hidden}
            if any(len(p) > 80 or p in hidden or (p in items and p not in affected) for p in mapping.values()):
                fail('名称过长或与已有分类冲突')
            for old, new in mapping.items():
                if old in hidden:
                    hidden.remove(old)
                    hidden.add(new)
                    if old in value['removed_kinds']:
                        value['removed_kinds'][new] = value['removed_kinds'].pop(old)
                else:
                    items[new] = items.pop(old)
                value['retired'].append(old)
                db.execute('UPDATE entries SET category=?,version=version+1 WHERE category=?', (new, old))
            # Renaming back to an earlier name makes that name active again.
            value['retired'] = [p for p in value['retired'] if p not in mapping.values()]
    order = display_order(db)
    version = order['version']
    if mapping:
        order['categories'] = list(dict.fromkeys(mapping.get(p, p) for p in order['categories']))
        order['favorites'] = list(dict.fromkeys(mapping.get(p, p) for p in order.get('favorites', [])))
        order['version'] += 1
    favorites = [p for p in order.get('favorites', []) if p in items and p not in hidden]
    if favorites != order.get('favorites', []):
        order['favorites'] = favorites
        order['version'] += 1
    if order['version'] != version:
        db.execute("INSERT OR REPLACE INTO settings VALUES ('display_order',?)", (json.dumps(order, ensure_ascii=False),))
    value.update(hidden=sorted(hidden), version=value['version'] + 1)
    db.execute("INSERT OR REPLACE INTO settings VALUES ('category_catalog',?)", (json.dumps(value, ensure_ascii=False),))
    audit(db, 'category.' + body.action, body.model_dump())
    return {'ok': True}
