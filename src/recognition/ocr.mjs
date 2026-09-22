import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import { createRecognitionResult } from "./schema.mjs";

const ROOT = process.cwd();
const OCR_SOURCE = path.join(ROOT, "src", "vision-ocr.m");
const OCR_BINARY = path.join(ROOT, "runtime", "vision-ocr");
const OCR_LANG = process.env.OCR_LANG || "chi_sim+eng";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function resolveEngine() {
  const configured = (process.env.OCR_ENGINE || "auto").trim().toLowerCase();
  if (configured === "auto") return process.platform === "darwin" ? "apple-vision" : "tesseract";
  if (["apple-vision", "tesseract"].includes(configured)) return configured;
  throw new Error(`不支持的 OCR_ENGINE：${configured}；可选值为 auto、apple-vision、tesseract`);
}

export async function initializeOcr() {
  const engine = resolveEngine();
  if (engine !== "apple-vision") return;
  if (process.platform !== "darwin") {
    throw new Error("OCR_ENGINE=apple-vision 只能在 macOS 上使用");
  }
  try {
    await access(OCR_BINARY);
  } catch {
    await run("clang", [
      "-fobjc-arc", OCR_SOURCE, "-o", OCR_BINARY,
      "-framework", "Foundation", "-framework", "Vision",
    ]);
  }
}

export async function recognizeText(imagePath) {
  const engine = resolveEngine();
  await initializeOcr();
  const { stdout } = engine === "apple-vision"
    ? await run(OCR_BINARY, [imagePath])
    : await run("tesseract", [imagePath, "stdout", "-l", OCR_LANG, "--psm", "6"]);
  return stdout.trim();
}

export function parseExpense(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const compact = lines.join(" ");
  const dateMatch = compact.match(/(20\d{2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?/);
  const expenseDate = dateMatch
    ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`
    : "";

  const prioritized = [];
  const amountRegex = /(?:¥|￥|RMB\s*)?\s*(\d{1,7}(?:\.\d{1,2})?)/gi;
  for (const line of lines) {
    if (/(实付|支付金额|合计|总计|价税合计|金额)/.test(line)) {
      for (const match of line.matchAll(amountRegex)) prioritized.push(Number(match[1]));
    }
  }
  const allAmounts = [...compact.matchAll(/(?:¥|￥)\s*(\d{1,7}(?:\.\d{1,2})?)/g)]
    .map(match => Number(match[1]));
  const validAmounts = [...prioritized, ...allAmounts].filter(n => Number.isFinite(n) && n > 0);
  const price = validAmounts.length ? validAmounts[0] : 0;

  const isInvoice = /(发票|税号|购买方|销售方|价税合计)/.test(compact);
  const payment = ["微信支付", "支付宝", "云闪付", "银行卡", "信用卡", "现金"]
    .find(method => compact.includes(method)) || "";

  const excluded = /(订单号|交易号|支付|合计|总计|金额|发票|税号|购买方|销售方|日期|时间|收款|商户|微信|支付宝|¥|￥|RMB)/;
  const candidates = lines.filter(line =>
    line.length >= 3 && line.length <= 60 && !excluded.test(line) && !/^\d[\d\s.:/-]*$/.test(line)
  );
  const product = candidates.sort((a, b) => b.length - a.length)[0] || "";

  return {
    fields: {
      "类别": "",
      "商品名称": product,
      "价格": price,
      "消费日期": expenseDate,
      "支付方式": payment,
    },
    kind: isInvoice ? "invoice" : "order",
  };
}

export async function recognizeExpenseWithOcr(imagePath) {
  const ocrText = await recognizeText(imagePath);
  if (!ocrText) throw new Error("图片中没有识别到文字");
  const parsed = parseExpense(ocrText);
  return createRecognitionResult({
    ...parsed,
    raw: { ocrText, visionResponse: "" },
  });
}
