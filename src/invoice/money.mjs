export function moneyToCents(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim().replace(/[,，¥￥\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  let cents = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (Number((fraction + "000")[2]) >= 5) cents += 1n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("金额过大");
  return Number(cents);
}
