import { createRecognitionResult, EXPENSE_FIELD_NAMES, hasFieldValue } from "./schema.mjs";

export function mergeRecognitionResults(ocrResult, visionResult) {
  const fields = {};
  for (const name of EXPENSE_FIELD_NAMES) {
    const visionValue = visionResult?.fields?.[name];
    fields[name] = hasFieldValue(visionValue)
      ? visionValue
      : ocrResult?.fields?.[name];
  }
  return createRecognitionResult({
    fields,
    kind: visionResult?.kind === "invoice" || ocrResult?.kind === "invoice" ? "invoice" : "order",
    raw: {
      ocrText: ocrResult?.raw?.ocrText || "",
      visionResponse: visionResult?.raw?.visionResponse || "",
    },
  });
}
