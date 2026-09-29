import { classifyDocument } from "./classifier.mjs";
import { parseInvoice } from "./invoice-parser.mjs";
import { parseOrder } from "./order-parser.mjs";

export function getRecognitionMode() {
  return (process.env.RECOGNITION_MODE || "vision").trim().toLowerCase();
}

export async function initializeRecognition() {
  const mode = getRecognitionMode();
  if (mode !== "vision") {
    throw new Error(`不支持的 RECOGNITION_MODE：${mode}；当前仅支持 vision`);
  }
  if ((process.env.VISION_PROVIDER || "qwen").trim().toLowerCase() !== "qwen") {
    throw new Error(`不支持的 VISION_PROVIDER：${process.env.VISION_PROVIDER}；当前仅支持 qwen`);
  }
}

export async function parseDocumentAs(documentType, imagePath, options = {}) {
  if (documentType === "order") {
    const parsed = await parseOrder(imagePath, options);
    return { documentType, ...parsed, raw: { classifierResponse: "", parserResponse: parsed.raw } };
  }
  if (documentType === "invoice") {
    const parsed = await parseInvoice(imagePath, options);
    return { documentType, ...parsed, raw: { classifierResponse: "", parserResponse: parsed.raw } };
  }
  throw new Error(`不能解析未知文档类型：${documentType}`);
}

export async function recognizeDocument(imagePath, options = {}) {
  const classified = await classifyDocument(imagePath, options);
  if (classified.documentType === "unknown") {
    return { documentType: "unknown", raw: { classifierResponse: classified.raw, parserResponse: "" } };
  }
  const parsed = await parseDocumentAs(classified.documentType, imagePath, options);
  parsed.raw.classifierResponse = classified.raw;
  return parsed;
}
