import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { moneyToCents } from "./invoice/money.mjs";

export const HELP_TEXT = `**使用说明**

**录入订单**
发送购物订单、支付截图或订单 PDF，在卡片中核对商品名称、实付金额、消费日期和支付方式，再点击确认提交到“收集表”。未识别到消费日期时默认使用当天日期。

**关联发票**
发送发票图片或 PDF，重点核对含税总额、购买方税号和销售方税号，以及发票号码。确认后按含税总额匹配订单；多个候选时手动选择，未找到时可以创建新订单。已有发票号码会提示重复。
多页 PDF 识别最后一页，完整原文件会保留。商品明细无需逐行确认。

**催票**
发送“催票”，查询整个“收集表”中有订单但“发票文件”为空的项目，逐项返回商品、金额、日期及订单截图。已有发票号码但缺发票文件的订单也会列出。取回的截图可转发给商家催票。

**帮助**
发送“帮助”、“help”或“使用说明”，再次查看本说明。`;

export function messageText(content) {
  if (content && typeof content === "object") return typeof content.text === "string" ? content.text.trim() : "";
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.text === "string") return parsed.text.trim();
  } catch { /* Compact events may already contain plain text. */ }
  return content.trim();
}

function hash(value, length = 24) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function relativeFile(root, filePath) {
  const relative = path.relative(root, path.resolve(filePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("催票附件必须位于机器人项目目录内");
  }
  return `./${relative.split(path.sep).join("/")}`;
}

function orderDescription(record, index, count) {
  const fields = record.fields;
  const cents = moneyToCents(fields["价格"]);
  const amount = cents === null ? "未填写" : `¥${(cents / 100).toFixed(2)}`;
  const name = String(fields["商品名称"] || "未命名订单").replace(/[\r\n]+/g, " ");
  const date = String(fields["消费日期"] || "未填写").slice(0, 10);
  const missing = !Array.isArray(fields["订单截图"]) || fields["订单截图"].length === 0;
  return `缺票订单 ${index + 1}/${count}\n商品：${name}\n金额：${amount}\n消费日期：${date}`
    + (missing ? "\n此订单没有订单截图，请在收集表中补充。" : "");
}

async function prepareReplyFile(downloadedPath, name) {
  const bytes = (await readFile(downloadedPath)).subarray(0, 12);
  let extension;
  let mediaFlag = "--image";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) extension = ".jpg";
  else if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) extension = ".png";
  else if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") extension = ".webp";
  else {
    mediaFlag = "--file";
    const candidate = path.extname(String(name || "")).toLowerCase();
    extension = bytes.subarray(0, 4).toString("ascii") === "%PDF" ? ".pdf"
      : /^\.[a-z0-9]{1,10}$/.test(candidate) ? candidate : ".bin";
  }
  const originalName = Array.from(path.basename(String(name || "订单截图"))
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, "_").replace(/^\.+/, "").trim()).slice(0, 120).join("");
  const stem = path.parse(originalName).name || "订单截图";
  const readyDir = `${downloadedPath}-ready`;
  await mkdir(readyDir, { recursive: true });
  const filePath = path.join(readyDir, stem + extension);
  await rename(downloadedPath, filePath);
  return { mediaFlag, filePath };
}

export function createTextCommandHandler({ repository, runJson, reply, runtimeDir, root = process.cwd(), onError = console.error }) {
  async function remind(event) {
    const records = await repository.findOrdersMissingInvoices();
    if (!records.length) return reply(event.message_id, "收集表中没有缺少发票文件的订单。", "reminder-empty");
    await reply(event.message_id, `找到 ${records.length} 笔缺票订单，正在逐项取回订单截图。`, "reminder-start");
    const directory = path.join(runtimeDir, "reminders", hash(event.message_id));
    relativeFile(root, path.join(directory, "check"));
    await mkdir(directory, { recursive: true });
    let sent = 0;
    let failed = 0;
    let missing = 0;
    try {
      for (const [index, record] of records.entries()) {
        const recordKey = hash(record.recordId, 10);
        await reply(event.message_id, orderDescription(record, index, records.length), `rem-${recordKey}`, { plainText: true });
        const seenTokens = new Set();
        const attachments = (Array.isArray(record.fields["订单截图"]) ? record.fields["订单截图"] : []).filter(attachment => {
          const token = attachment?.file_token;
          if (token && seenTokens.has(token)) return false;
          if (token) seenTokens.add(token);
          return true;
        });
        if (!attachments.length) { missing += 1; continue; }
        let rowFailures = 0;
        for (const attachment of attachments) {
          try {
            if (!attachment?.file_token) throw new Error("订单附件缺少 file_token");
            const fileToken = attachment.file_token;
            const downloadPath = path.join(directory, hash(`${record.recordId}:${fileToken}`));
            await repository.downloadOrderAttachment(record.recordId, fileToken, downloadPath);
            const { mediaFlag, filePath } = await prepareReplyFile(downloadPath, attachment.name);
            await runJson([
              "im", "+messages-reply", "--message-id", event.message_id,
              mediaFlag, relativeFile(root, filePath), "--as", "bot",
              "--idempotency-key", `rem-${hash(`${event.message_id}:${record.recordId}:${fileToken}`, 40)}`,
            ]);
            sent += 1;
          } catch (error) {
            failed += 1;
            rowFailures += 1;
            onError(error, { recordId: record.recordId, messageId: event.message_id });
          }
        }
        if (rowFailures) await reply(event.message_id,
          `这笔订单有 ${rowFailures} 个附件未能发回，请稍后重新发送“催票”重试。`, `rem-f-${recordKey}`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return reply(event.message_id,
      `催票查询完成：${records.length} 笔缺票订单，已发回 ${sent} 个订单附件。`
      + (missing ? `\n${missing} 笔订单没有截图，请在收集表中补充。` : "")
      + (failed ? `\n${failed} 个附件发送失败，可稍后重新发送“催票”重试。` : ""), "reminder-done");
  }

  return async event => {
    const text = messageText(event.content);
    if (/^(帮助|help|使用说明)$/i.test(text)) return reply(event.message_id, HELP_TEXT, "help");
    if (text.includes("催票")) return remind(event);
    return reply(event.message_id, "请发送订单或发票图片/PDF；发送“催票”取回缺票订单截图，发送“帮助”查看使用说明。", "fallback");
  };
}
