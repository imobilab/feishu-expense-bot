import { copyFile, mkdir, open } from "node:fs/promises";
import path from "node:path";

import { moneyToCents } from "./invoice/money.mjs";

function safePart(value, label, maxLength) {
  const clean = Array.from(String(value ?? "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim()).slice(0, maxLength).join("").replace(/[.\s]+$/g, "").trim();
  if (!clean) throw new Error(`${label}不能为空，无法命名附件`);
  return clean;
}

async function fileExtension(filePath) {
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(12);
    await handle.read(bytes, 0, bytes.length, 0);
    if (bytes.subarray(0, 4).toString("ascii") === "%PDF") return ".pdf";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
    throw new Error("无法识别图片格式，不能命名附件");
  } finally {
    await handle.close();
  }
}

export async function prepareNamedAttachment({
  sourcePath, runtimeDir, messageId, index = 0, amount, submitterName, projectName,
}) {
  const cents = moneyToCents(amount);
  if (cents === null) throw new Error("金额无效，无法命名附件");
  const amountPart = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  const personPart = safePart(submitterName, "提交人姓名", 24);
  const projectPart = safePart(projectName, "项目名称", 48);
  const messagePart = safePart(messageId, "消息 ID", 64);
  const extension = await fileExtension(sourcePath);
  const directory = path.join(runtimeDir, "named", messagePart, String(index));
  await mkdir(directory, { recursive: true });
  const targetPath = path.join(directory, `${amountPart}-${personPart}-${projectPart}${extension}`);
  await copyFile(sourcePath, targetPath);
  return targetPath;
}
