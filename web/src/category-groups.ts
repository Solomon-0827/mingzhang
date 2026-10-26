export function categoryGroups(values: string[]) {
  const groups = new Map<string, string[]>();
  for (const value of values) {
    const parent = value.split('/')[0];
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent)!.push(value);
  }
  return Array.from(groups, ([name, items]) => ({ name, items }));
}
export function categoryLeaf(value: string) {
  const index = value.indexOf('/');
  return index < 0 ? '未细分' : value.slice(index + 1);
}
