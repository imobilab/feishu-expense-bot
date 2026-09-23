import { callVisionModel } from "../providers/qwen.mjs";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompts.mjs";
import { classifierSchema } from "./schemas.mjs";

export async function classifyDocument(imagePath, options = {}) {
  const result = await callVisionModel({ imagePath, systemPrompt: CLASSIFIER_SYSTEM_PROMPT, schema: classifierSchema, ...options });
  console.log(`[recognition] document_type=${result.data.document_type}`);
  return { documentType: result.data.document_type, raw: result.raw };
}
