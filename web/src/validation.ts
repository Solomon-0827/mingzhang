// Match the server's whitespace set, including NEL and C0 separators.
const ledgerWhitespace = "[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const surroundingWhitespace = new RegExp(`^${ledgerWhitespace}+|${ledgerWhitespace}+$`, "g");

export const trimLedgerText = (value: string) => value.replace(surroundingWhitespace, "");
export const textLength = (value: string) => [...value].length;
export const hasLoneSurrogate = (value: string) => /\p{Surrogate}/u.test(value);
