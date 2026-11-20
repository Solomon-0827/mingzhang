import { ordered, type CategoryCatalog, type Kind } from "./types";

export function categoryAllowsKind(catalog: CategoryCatalog, path: string, kind: Kind) {
  return !Object.hasOwn(catalog.items, path) || catalog.items[path].includes(kind);
}

export function categoriesForKind(catalog: CategoryCatalog, kind: Kind) {
  return Object.keys(catalog.items).filter(path =>
    !catalog.hidden.includes(path) && !catalog.retired?.includes(path) && categoryAllowsKind(catalog, path, kind)
  );
}

export function defaultCategoryForKind(catalog: CategoryCatalog | undefined, kind: Kind, order?: string[]) {
  if (!catalog || (kind !== "income" && kind !== "expense")) return "";
  return ordered(categoriesForKind(catalog, kind), order)[0] ?? "";
}

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
