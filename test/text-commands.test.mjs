import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTextCommandHandler, HELP_TEXT, messageText } from "../src/text-commands.mjs";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const pdf = Buffer.from("%PDF-1.4\nfixture");
const event = { message_id: "om_reminder-request", content: "请帮我催票" };

async function harness(t, records = [], { failedToken, queryError } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "text-commands-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const replies = [];
  const media = [];
  const downloads = [];
  const errors = [];
  let queries = 0;
  const repository = {
    findOrdersMissingInvoices: async () => {
      queries += 1;
      if (queryError) throw queryError;
      return records;
    },
    downloadOrderAttachment: async (recordId, fileToken, outputPath) => {
      downloads.push({ recordId, fileToken, outputPath });
      if (fileToken === failedToken) throw new Error("download failed");
      const bytes = fileToken.includes("pdf") ? pdf : fileToken.includes("jpg") ? jpg : png;
      await writeFile(outputPath, bytes);
      return { saved_path: outputPath, file_token: fileToken };
    },
  };
  const runJson = async args => {
    media.push(args);
    const flag = args.includes("--image") ? "--image" : "--file";
    await access(path.join(root, args[args.indexOf(flag) + 1]));
    return { message_id: "om_sent" };
  };
  const reply = async (...args) => { replies.push(args); };
  const handle = createTextCommandHandler({ repository, runJson, reply, runtimeDir, root, onError: (...args) => errors.push(args) });
  return { handle, replies, media, downloads, errors, root, runtimeDir, queries: () => queries };
}

function order(recordId, attachments, product = "测试商品") {
  return { recordId, fields: { "商品名称": product, "价格": "15.87", "消费日期": "2026-09-29 00:00:00", "订单截图": attachments } };
}

test("message text accepts compact text and raw Feishu text JSON", () => {
  assert.equal(messageText(" 催票 "), "催票");
  assert.equal(messageText('{"text":"帮助"}'), "帮助");
  assert.equal(messageText({ text: " help " }), "help");
  assert.equal(messageText(null), "");
});

test("help returns complete instructions without reading the table or sending attachments", async t => {
  const h = await harness(t);
  for (const content of ["帮助", " HELP ", { text: "使用说明" }, '{"text":"帮助"}']) {
    await h.handle({ ...event, content });
  }
  assert.equal(h.queries(), 0);
  assert.equal(h.media.length, 0);
  assert.ok(h.replies.every(([, text, suffix]) => text === HELP_TEXT && suffix === "help"));
  for (const term of ["录入订单", "关联发票", "含税总额", "税号", "最后一页", "催票", "整个“收集表”"]) assert.ok(HELP_TEXT.includes(term));
});

test("reminder replies to its triggering message with every image or PDF and stable distinct idempotency keys", async t => {
  const h = await harness(t, [
    order("r1", [{ file_token: "png-1", name: "../../wrong.jpg" }, { file_token: "jpg-2", name: "wrong.png" }], "商品![x](https://example.com/image.png)"),
    order("r2", [{ file_token: "pdf-3", name: "order.pdf" }]),
  ]);
  await h.handle(event);
  assert.equal(h.queries(), 1);
  assert.deepEqual(h.downloads.map(({ recordId, fileToken }) => [recordId, fileToken]), [["r1", "png-1"], ["r1", "jpg-2"], ["r2", "pdf-3"]]);
  assert.equal(h.media.length, 3);
  assert.equal(h.media[0].includes("--image"), true);
  assert.match(h.media[0][h.media[0].indexOf("--image") + 1], /\.png$/);
  assert.match(h.media[1][h.media[1].indexOf("--image") + 1], /\.jpg$/);
  assert.equal(h.media[2].includes("--file"), true);
  assert.match(h.media[2][h.media[2].indexOf("--file") + 1], /\.pdf$/);
  const keys = h.media.map(args => args[args.indexOf("--idempotency-key") + 1]);
  assert.equal(new Set(keys).size, 3);
  for (const args of h.media) {
    assert.equal(args[args.indexOf("--message-id") + 1], event.message_id);
    assert.equal(args[args.indexOf("--as") + 1], "bot");
    assert.ok(args[args.indexOf("--idempotency-key") + 1].length <= 50);
  }
  const descriptions = h.replies.filter(([, , , options]) => options?.plainText);
  assert.equal(descriptions.length, 2);
  assert.match(descriptions[0][1], /¥15\.87/);
  assert.match(descriptions[0][1], /2026-09-29/);
  assert.match(h.replies.at(-1)[1], /已发回 3 个订单附件/);
  assert.deepEqual(await readdir(path.join(h.runtimeDir, "reminders")), []);
  await h.handle(event);
  assert.deepEqual(h.media.slice(3).map(args => args[args.indexOf("--idempotency-key") + 1]), keys);
});

test("one failed screenshot does not prevent remaining orders and temporary downloads are cleaned", async t => {
  const h = await harness(t, [
    order("r1", [{ file_token: "bad", name: "bad.png" }]),
    order("r2", [{ file_token: "good", name: "good.png" }]),
  ], { failedToken: "bad" });
  await h.handle(event);
  assert.equal(h.media.length, 1);
  assert.equal(h.errors.length, 1);
  assert.ok(h.replies.some(([, text]) => text.includes("这笔订单有 1 个附件未能发回")));
  assert.match(h.replies.at(-1)[1], /已发回 1 个订单附件/);
  assert.match(h.replies.at(-1)[1], /1 个附件发送失败/);
  assert.deepEqual(await readdir(path.join(h.runtimeDir, "reminders")), []);
});

test("missing screenshots and file tokens are reported rather than silently omitted", async t => {
  const h = await harness(t, [order("r1", []), order("r2", [{ name: "missing-token.png" }])]);
  await h.handle(event);
  assert.equal(h.media.length, 0);
  assert.equal(h.downloads.length, 0);
  assert.ok(h.replies.some(([, text]) => text.includes("此订单没有订单截图")));
  assert.match(h.replies.at(-1)[1], /1 笔订单没有截图/);
  assert.match(h.replies.at(-1)[1], /1 个附件发送失败/);
});

test("empty reminder query reports no missing invoices without downloading anything", async t => {
  const h = await harness(t);
  await h.handle({ ...event, content: '{"text":"催票"}' });
  assert.equal(h.queries(), 1);
  assert.equal(h.replies.length, 1);
  assert.match(h.replies[0][1], /没有缺少发票文件的订单/);
  assert.equal(h.downloads.length, 0);
});

test("query failure propagates to the bot error handler without falsely reporting an empty table", async t => {
  const h = await harness(t, [], { queryError: new Error("access denied") });
  await assert.rejects(h.handle(event), /access denied/);
  assert.equal(h.replies.length, 0);
  assert.equal(h.media.length, 0);
});

test("unrecognized text points users to help and reminder commands without querying the table", async t => {
  const h = await harness(t);
  await h.handle({ ...event, content: "你好" });
  assert.equal(h.queries(), 0);
  assert.match(h.replies[0][1], /催票/);
  assert.match(h.replies[0][1], /帮助/);
});
