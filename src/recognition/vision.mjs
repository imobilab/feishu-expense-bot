import { callQwenVision } from "../providers/qwen.mjs";
import { createRecognitionResult, normalizeExpenseFields } from "./schema.mjs";

export function parseVisionJson(response) {
  const trimmed = String(response || "").trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(withoutFence.slice(start, end + 1));
    throw new Error("Qwen-VL 未返回有效 JSON");
  }
}

export async function recognizeExpenseWithVision(imagePath, options = {}) {
  const provider = (process.env.VISION_PROVIDER || "qwen").trim().toLowerCase();
  if (provider !== "qwen") throw new Error(`不支持的 VISION_PROVIDER：${provider}`);
  const visionResponse = await callQwenVision(imagePath, options);
  const fields = normalizeExpenseFields(parseVisionJson(visionResponse));
  return createRecognitionResult({
    fields,
    kind: "order",
    raw: { ocrText: "", visionResponse },
  });
}
