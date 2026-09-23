import { readFile } from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen2.5-vl-7b-instruct";

function config() {
  return {
    apiKey: (process.env.VISION_API_KEY || process.env.QWEN_API_KEY || "").trim(),
    baseURL: process.env.VISION_BASE_URL || process.env.QWEN_BASE_URL || DEFAULT_BASE_URL,
    model: process.env.VISION_MODEL || process.env.QWEN_MODEL || DEFAULT_MODEL,
    timeout: Number(process.env.VISION_TIMEOUT_MS || 60000),
  };
}

function createClient(settings) {
  if (!settings.apiKey) throw new Error("缺少 VISION_API_KEY，无法调用视觉模型");
  return new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    timeout: settings.timeout,
    maxRetries: 0,
  });
}

function imageMimeType(imagePath, bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const extension = path.extname(imagePath).toLowerCase();
  return { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[extension];
}

export function extractJson(content) {
  const trimmed = String(content || "").trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("视觉模型未返回有效 JSON");
  }
}

export async function callVisionModel({ imagePath, systemPrompt, schema, client, retries = 1 }) {
  const settings = config();
  const image = await readFile(imagePath);
  const mimeType = imageMimeType(imagePath, image);
  if (!mimeType) throw new Error(`不支持的图片格式：${path.basename(imagePath)}`);
  const api = client || createClient(settings);
  const startedAt = Date.now();
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const completion = await api.chat.completions.create({
        model: settings.model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: "请分析此附件，并严格按系统指定的 JSON Schema 返回。" },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
            ],
          },
        ],
        temperature: 0,
      });
      const raw = completion.choices?.[0]?.message?.content;
      if (typeof raw !== "string" || !raw.trim()) throw new Error("视觉模型返回了空响应");
      const parsed = schema.safeParse(extractJson(raw));
      if (!parsed.success) throw new Error(`视觉模型 JSON Schema 校验失败：${parsed.error.issues.map(issue => issue.message).join("；")}`);
      console.log(`[vision] model=${settings.model} duration_ms=${Date.now() - startedAt} attempt=${attempt + 1}`);
      return { data: parsed.data, raw };
    } catch (error) {
      lastError = error;
      if (attempt < retries) console.warn(`[vision] attempt=${attempt + 1} failed; retrying: ${error.message || error}`);
    }
  }
  throw new Error(`视觉模型调用失败：${lastError?.message || lastError}`);
}
