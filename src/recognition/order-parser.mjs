import { callVisionModel } from "../providers/qwen.mjs";
import { ORDER_SYSTEM_PROMPT } from "./prompts.mjs";
import { orderSchema } from "./schemas.mjs";

export async function parseOrder(imagePath, options = {}) {
  const result = await callVisionModel({ imagePath, systemPrompt: ORDER_SYSTEM_PROMPT, schema: orderSchema, ...options });
  return { order: result.data, raw: result.raw };
}
