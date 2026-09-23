import { callVisionModel } from "../providers/qwen.mjs";
import { INVOICE_SYSTEM_PROMPT } from "./prompts.mjs";
import { invoiceSchema } from "./schemas.mjs";

export async function parseInvoice(imagePath, options = {}) {
  const result = await callVisionModel({ imagePath, systemPrompt: INVOICE_SYSTEM_PROMPT, schema: invoiceSchema, ...options });
  console.log(`[invoice] number=${result.data.invoice_number || "(empty)"} amount=${result.data.total_amount ?? "(empty)"}`);
  return { invoice: result.data, raw: result.raw };
}
