// Match the server's whitespace set, including NEL and C0 separators.
const ledgerWhitespace = "[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const surroundingWhitespace = new RegExp(`^${ledgerWhitespace}+|${ledgerWhitespace}+$`, "g");

export const trimLedgerText = (value: string) => value.replace(surroundingWhitespace, "");
export const textLength = (value: string) => [...value].length;
export const hasLoneSurrogate = (value: string) => /\p{Surrogate}/u.test(value);

export function categoryNameError(name: string, addedPath?: string) {
  if (!trimLedgerText(name) || name.includes("/")) return "名称不能为空或包含斜杠";
  if (hasLoneSurrogate(name)) return "分类名称含无效字符";
  if (textLength(name) > 40) return "分类名称不能超过 40 个字符";
  if (addedPath !== undefined) {
    if (textLength(addedPath) > 80) return "分类路径不能超过 80 个字符";
    const parts = trimLedgerText(addedPath).split("/");
    if (parts.length > 2 || parts.some(part => !part || part !== trimLedgerText(part)))
      return "分类名称不能为空，且最多支持两级分类";
  }
}
