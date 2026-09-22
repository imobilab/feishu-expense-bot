import { initializeOcr, recognizeExpenseWithOcr } from "./ocr.mjs";
import { mergeRecognitionResults } from "./merge.mjs";
import { recognizeExpenseWithVision } from "./vision.mjs";

export function getRecognitionMode() {
  return (process.env.RECOGNITION_MODE || "ocr").trim().toLowerCase();
}

export async function initializeRecognition() {
  const mode = getRecognitionMode();
  if (!["ocr", "vision", "hybrid"].includes(mode)) {
    throw new Error(`不支持的 RECOGNITION_MODE：${mode}；可选值为 ocr、vision、hybrid`);
  }
  return initializeOcr();
}

async function visionWithOcrFallback(imagePath, options) {
  try {
    return await recognizeExpenseWithVision(imagePath, options);
  } catch (error) {
    console.warn(`[recognition] Vision 识别失败，回退 OCR：${error.message || error}`);
    return recognizeExpenseWithOcr(imagePath);
  }
}

async function recognizeHybrid(imagePath, options) {
  const [ocr, vision] = await Promise.allSettled([
    recognizeExpenseWithOcr(imagePath),
    recognizeExpenseWithVision(imagePath, options),
  ]);
  if (ocr.status === "fulfilled" && vision.status === "fulfilled") {
    return mergeRecognitionResults(ocr.value, vision.value);
  }
  if (vision.status === "fulfilled") {
    console.warn(`[recognition] Hybrid OCR 失败，仅使用 Vision：${ocr.reason?.message || ocr.reason}`);
    return vision.value;
  }
  if (ocr.status === "fulfilled") {
    console.warn(`[recognition] Hybrid Vision 失败，仅使用 OCR：${vision.reason?.message || vision.reason}`);
    return ocr.value;
  }
  throw new AggregateError([ocr.reason, vision.reason], "OCR 和 Vision 识别均失败");
}

export async function recognizeExpense(imagePath, options = {}) {
  const mode = getRecognitionMode();
  if (mode === "ocr") return recognizeExpenseWithOcr(imagePath);
  if (mode === "vision") return visionWithOcrFallback(imagePath, options);
  if (mode === "hybrid") return recognizeHybrid(imagePath, options);
  throw new Error(`不支持的 RECOGNITION_MODE：${mode}；可选值为 ocr、vision、hybrid`);
}
