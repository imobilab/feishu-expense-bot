import { classifyDocument } from "./classifier.mjs";
import { parseInvoice } from "./invoice-parser.mjs";
import { initializeOcr, recognizeExpenseWithOcr } from "./ocr.mjs";
import { parseOrder } from "./order-parser.mjs";

export function getRecognitionMode() {
  return (process.env.RECOGNITION_MODE || "vision").trim().toLowerCase();
}

export async function initializeRecognition() {
  const mode = getRecognitionMode();
  if (!["ocr", "vision"].includes(mode)) {
    throw new Error(`不支持的 RECOGNITION_MODE：${mode}；可选值为 ocr、vision`);
  }
  if (mode === "vision" && (process.env.VISION_PROVIDER || "qwen").trim().toLowerCase() !== "qwen") {
    throw new Error(`不支持的 VISION_PROVIDER：${process.env.VISION_PROVIDER}；当前仅支持 qwen`);
  }
  if (mode === "ocr") await initializeOcr();
}

function legacyOrder(result) {
  return {
    documentType: "order",
    order: {
      product: result.fields["商品名称"] || "",
      price: result.fields["价格"] || null,
      expense_date: result.fields["消费日期"] || "",
      payment_method: result.fields["支付方式"] || "",
    },
    raw: { ocrText: result.raw.ocrText, classifierResponse: "", parserResponse: "" },
  };
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
  if (getRecognitionMode() === "ocr") return legacyOrder(await recognizeExpenseWithOcr(imagePath));
  const classified = await classifyDocument(imagePath, options);
  if (classified.documentType === "unknown") {
    return { documentType: "unknown", raw: { classifierResponse: classified.raw, parserResponse: "" } };
  }
  const parsed = await parseDocumentAs(classified.documentType, imagePath, options);
  parsed.raw.classifierResponse = classified.raw;
  return parsed;
}

// Backward-compatible entrypoint for callers that only expect an order.
export async function recognizeExpense(imagePath, options = {}) {
  const result = await recognizeDocument(imagePath, options);
  if (result.documentType !== "order") throw new Error(`附件类型不是订单：${result.documentType}`);
  return {
    fields: {
      "类别": "",
      "商品名称": result.order.product,
      "价格": result.order.price || 0,
      "消费日期": result.order.expense_date,
      "支付方式": result.order.payment_method,
    },
    kind: "order",
    raw: { ocrText: result.raw.ocrText || "", visionResponse: result.raw.parserResponse || "" },
  };
}
