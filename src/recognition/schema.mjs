export const EXPENSE_FIELD_NAMES = Object.freeze([
  "类别",
  "商品名称",
  "价格",
  "消费日期",
  "支付方式",
]);

export function emptyExpenseFields() {
  return {
    "类别": "",
    "商品名称": "",
    "价格": 0,
    "消费日期": "",
    "支付方式": "",
  };
}

export function hasFieldValue(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function normalizeAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  const normalized = String(value ?? "").replace(/[,，¥￥\s]/g, "");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  const amount = match ? Number(match[0]) : 0;
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function normalizeDate(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/(20\d{2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})/);
  return match
    ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`
    : "";
}

export function normalizeExpenseFields(fields = {}) {
  const normalized = emptyExpenseFields();
  for (const name of EXPENSE_FIELD_NAMES) {
    if (name === "价格") normalized[name] = normalizeAmount(fields[name]);
    else if (name === "消费日期") normalized[name] = normalizeDate(fields[name]);
    else normalized[name] = String(fields[name] ?? "").trim();
  }
  return normalized;
}

export function createRecognitionResult({ fields = {}, kind = "order", raw = {} } = {}) {
  return {
    fields: normalizeExpenseFields(fields),
    kind,
    raw: {
      ocrText: String(raw.ocrText || ""),
      visionResponse: String(raw.visionResponse || ""),
    },
  };
}
