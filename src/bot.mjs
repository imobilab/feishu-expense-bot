import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, "runtime");
const UPLOADS = path.join(RUNTIME, "uploads");
const STATE_FILE = path.join(RUNTIME, "state.json");
const SHARE_TOKEN = process.env.FEISHU_FORM_SHARE_TOKEN || "shrcnTHfdZFYP2lB11p07xvR1Cc";
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN || "IruKbsT0VaMwZwsR2qecroHtnue";
const OCR_SOURCE = path.join(ROOT, "src", "vision-ocr.m");
const OCR_BINARY = path.join(RUNTIME, "vision-ocr");
const OCR_LANG = process.env.OCR_LANG || "chi_sim+eng";

await mkdir(UPLOADS, { recursive: true });
await ensureOcrBinary();
let state = await loadState();
state.cards ||= {};

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: process.env,
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    if (options.stdin) child.stdin.end(options.stdin);
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function runJson(args) {
  const result = await run("lark-cli", args);
  const parsed = JSON.parse(result.stdout);
  if (!parsed.ok) throw new Error(parsed.error?.message || "lark-cli request failed");
  return parsed.data;
}

async function ensureOcrBinary() {
  if (process.platform !== "darwin") return;
  try {
    await access(OCR_BINARY);
    return;
  } catch {}
  await run("clang", [
    "-fobjc-arc", OCR_SOURCE, "-o", OCR_BINARY,
    "-framework", "Foundation", "-framework", "Vision",
  ]);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { processed: {}, pending: {} };
  }
}

async function saveState() {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function findResourceKey(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.match(/(?:img|file)_[A-Za-z0-9_-]+/)?.[0] || null;
}

async function getResourceKey(event) {
  const direct = findResourceKey(event.content);
  if (direct) return direct;
  const data = await runJson([
    "im", "+messages-mget", "--message-id", event.message_id,
    "--as", "bot", "--no-reactions",
  ]);
  return findResourceKey(data);
}

async function reply(messageId, text, suffix) {
  const idempotency = `${messageId.replace(/[^A-Za-z0-9_-]/g, "").slice(-32)}-${suffix}`.slice(0, 50);
  await runJson([
    "im", "+messages-reply", "--message-id", messageId,
    "--markdown", text, "--as", "bot", "--idempotency-key", idempotency,
  ]);
}

async function replyCard(messageId, card, suffix) {
  const idempotency = `${messageId.replace(/[^A-Za-z0-9_-]/g, "").slice(-32)}-${suffix}`.slice(0, 50);
  return runJson([
    "im", "+messages-reply", "--message-id", messageId,
    "--msg-type", "interactive", "--content", JSON.stringify(card),
    "--as", "bot", "--idempotency-key", idempotency,
  ]);
}

async function updateCard(token, card) {
  return runJson([
    "api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot",
    "--data", JSON.stringify({ token, card }),
  ]);
}

async function downloadResource(event, key) {
  const resourceType = key.startsWith("img_") ? "image" : "file";
  const relative = path.join("runtime", "uploads", `${event.message_id}-${key}`);
  const data = await runJson([
    "im", "+messages-resources-download", "--message-id", event.message_id,
    "--file-key", key, "--type", resourceType, "--output", relative, "--as", "bot",
  ]);
  return path.resolve(data.saved_path || relative);
}

async function recognize(imagePath) {
  const { stdout } = process.platform === "darwin"
    ? await run(OCR_BINARY, [imagePath])
    : await run("tesseract", [imagePath, "stdout", "-l", OCR_LANG, "--psm", "6"]);
  return stdout.trim();
}

function parseExpense(text) {
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
  const price = validAmounts.length ? validAmounts[0] : null;

  const payment = ["微信支付", "支付宝", "云闪付", "银行卡", "信用卡", "现金"]
    .find(method => compact.includes(method)) || "";
  const isInvoice = /(发票|税号|购买方|销售方|价税合计)/.test(compact);

  const excluded = /(订单号|交易号|支付|合计|总计|金额|发票|税号|购买方|销售方|日期|时间|收款|商户|微信|支付宝|¥|￥|RMB)/;
  const candidates = lines.filter(line =>
    line.length >= 3 && line.length <= 60 && !excluded.test(line) && !/^\d[\d\s.:/-]*$/.test(line)
  );
  const product = candidates.sort((a, b) => b.length - a.length)[0] || "";

  return {
    fields: {
      "商品名称": product,
      "价格": price,
      "消费日期": expenseDate,
      "支付方式": payment,
    },
    kind: isInvoice ? "invoice" : "order",
    ocrText: text,
  };
}

function editCard(pending) {
  const f = pending.fields;
  const orderCount = pending.attachments.order.length;
  const invoiceCount = pending.attachments.invoice.length;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(f["消费日期"] || "") ? f["消费日期"] : undefined;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: "请检查 OCR 识别结果" },
      style: {
        text_size: {
          caption: { default: "notation", pc: "notation", mobile: "notation" },
        },
      },
    },
    header: {
      title: { tag: "plain_text", content: "报销识别结果" },
      subtitle: { tag: "plain_text", content: "修改后确认入账" },
      template: "blue",
      icon: { tag: "standard_icon", token: "file-form_colorful" },
      text_tag_list: [
        { tag: "text_tag", text: { tag: "plain_text", content: "待确认" }, color: "yellow" },
      ],
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          element_id: "summary",
          content: `**检查识别内容**\n<font color='grey'>已附带 ${orderCount} 张订单图片、${invoiceCount} 个发票文件</font>`,
          text_size: "normal",
        },
        {
          tag: "form",
          name: "expense_form",
          element_id: "expenseForm",
          direction: "vertical",
          vertical_spacing: "12px",
          padding: "12px",
          elements: [
            {
              tag: "input", name: "product", required: true, width: "fill",
              label: { tag: "plain_text", content: "商品名称" },
              placeholder: { tag: "plain_text", content: "请输入商品名称" },
              default_value: String(f["商品名称"] || ""),
            },
            {
              tag: "input", name: "price", required: true, width: "fill",
              label: { tag: "plain_text", content: "价格" },
              placeholder: { tag: "plain_text", content: "请输入实付金额，如 39.90" },
              default_value: f["价格"] == null ? "" : String(f["价格"]),
            },
            {
              tag: "date_picker", name: "expense_date", required: true, width: "fill",
              ...(date
                ? { initial_date: date }
                : { placeholder: { tag: "plain_text", content: "请选择消费日期" } }),
            },
            {
              tag: "input", name: "payment", width: "fill",
              label: { tag: "plain_text", content: "支付方式" },
              placeholder: { tag: "plain_text", content: "例如：微信支付、支付宝、银行卡" },
              default_value: String(f["支付方式"] || ""),
            },
            {
              tag: "button", name: "submit_expense", form_action_type: "submit",
              text: { tag: "plain_text", content: "确认入账" },
              type: "primary_filled", width: "fill",
              confirm: {
                title: { tag: "plain_text", content: "确认写入表格？" },
                text: { tag: "plain_text", content: "确认后将把当前内容和附件写入报销表。" },
              },
            },
            {
              tag: "button", name: "cancel_expense", form_action_type: "submit",
              text: { tag: "plain_text", content: "取消本次录入" },
              type: "default", width: "fill",
            },
          ],
        },
      ],
    },
  };
}

function statusCard(status, detail, success = false) {
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", summary: { content: status } },
    header: {
      title: { tag: "plain_text", content: status },
      subtitle: { tag: "plain_text", content: detail },
      template: success ? "green" : "grey",
      icon: { tag: "standard_icon", token: "file-form_colorful" },
      text_tag_list: [
        { tag: "text_tag", text: { tag: "plain_text", content: success ? "已完成" : "已取消" }, color: success ? "green" : "grey" },
      ],
    },
    body: {
      direction: "vertical", padding: "12px 12px 20px 12px",
      elements: [{ tag: "markdown", content: success ? "**记录已写入报销表。**" : "本次识别结果未写入表格。" }],
    },
  };
}

async function submit(pending) {
  const missing = ["商品名称", "价格", "消费日期"].filter(name => !pending.fields[name]);
  if (missing.length) throw new Error(`缺少必填字段：${missing.join("、")}`);
  const fields = Object.fromEntries(Object.entries(pending.fields).filter(([, value]) => value !== "" && value !== null));
  if (/^\d{4}-\d{2}-\d{2}$/.test(fields["消费日期"])) {
    fields["消费日期"] = `${fields["消费日期"]} 00:00:00`;
  }
  const attachments = {};
  if (pending.attachments.order.length) attachments["订单截图"] = pending.attachments.order.map(toRelative);
  if (pending.attachments.invoice.length) attachments["发票文件"] = pending.attachments.invoice.map(toRelative);
  return runJson([
    "base", "+form-submit", "--share-token", SHARE_TOKEN, "--base-token", BASE_TOKEN,
    "--json", JSON.stringify({ fields, attachments }), "--as", "bot", "--yes",
  ]);
}

function toRelative(filePath) {
  return `./${path.relative(ROOT, filePath).split(path.sep).join("/")}`;
}

async function handleImage(event) {
  const key = await getResourceKey(event);
  if (!key) throw new Error("没有从消息中找到图片标识");
  const filePath = await downloadResource(event, key);
  const ocrText = await recognize(filePath);
  if (!ocrText) throw new Error("图片中没有识别到文字");
  const parsed = parseExpense(ocrText);
  const pending = state.pending[event.sender_id] || {
    fields: { "商品名称": "", "价格": null, "消费日期": "", "支付方式": "" },
    attachments: { order: [], invoice: [] },
    sourceMessageIds: [],
  };
  for (const [keyName, value] of Object.entries(parsed.fields)) {
    if (value !== "" && value !== null) pending.fields[keyName] = value;
  }
  pending.attachments[parsed.kind].push(filePath);
  pending.sourceMessageIds.push(event.message_id);
  pending.updatedAt = new Date().toISOString();
  state.pending[event.sender_id] = pending;
  await saveState();
  const sent = await replyCard(event.message_id, editCard(pending), "preview-card");
  if (sent.message_id) state.cards[sent.message_id] = event.sender_id;
  await saveState();
}

async function handleText(event) {
  const text = event.content.trim();
  const pending = state.pending[event.sender_id];
  if (/^(帮助|help|使用说明)$/i.test(text)) {
    await reply(event.message_id, "发送订单截图或发票图片，我会识别商品、价格、日期和支付方式。识别完成后可直接在交互卡片中修改、确认或取消。", "help");
    return;
  }
  if (pending && /^(卡片|重新编辑)$/.test(text)) {
    const sent = await replyCard(event.message_id, editCard(pending), "reopen-card");
    if (sent.message_id) state.cards[sent.message_id] = event.sender_id;
    await saveState();
    return;
  }
  await reply(event.message_id, "请发送订单截图或发票图片。识别完成后可直接在卡片中修改并确认。", "fallback");
}

function parseFormValue(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  return JSON.parse(raw);
}

function friendlyError(error) {
  const message = String(error?.message || error);
  if (message.includes("app_scope_not_applied") || message.includes("has not applied for the required scope")) {
    return "机器人缺少附件上传权限。管理员开通“上传云文档素材”权限后，可在原卡片再次点击确认。";
  }
  if (message.includes("unsupported datetime format")) {
    return "消费日期格式不正确。机器人已保留本次数据，请在修复后重新确认。";
  }
  if (message.includes("Forbidden") || message.includes("access denied")) {
    return "机器人没有目标表格或附件的访问权限，请检查应用权限和表格协作者设置。";
  }
  return `提交失败：${message.slice(0, 500)}`;
}

async function handleCardAction(event) {
  if (!event?.event_id || state.processed[event.event_id]) return;
  state.processed[event.event_id] = new Date().toISOString();
  const senderId = state.cards[event.message_id] || event.operator_id;
  const pending = state.pending[senderId];
  if (!pending) {
    await updateCard(event.token, statusCard("记录已失效", "请重新发送图片"));
    await saveState();
    return;
  }
  if (event.action_name === "cancel_expense") {
    delete state.pending[senderId];
    delete state.cards[event.message_id];
    await saveState();
    await updateCard(event.token, statusCard("已取消录入", "没有写入表格"));
    return;
  }
  if (event.action_name !== "submit_expense") return;
  const form = parseFormValue(event.form_value);
  pending.fields = {
    "商品名称": String(form.product || "").trim(),
    "价格": Number(String(form.price || "").replace(/[,，¥￥\s]/g, "")),
    "消费日期": String(form.expense_date || "").slice(0, 10),
    "支付方式": String(form.payment || "").trim(),
  };
  if (!Number.isFinite(pending.fields["价格"]) || pending.fields["价格"] <= 0) {
    throw new Error("价格必须是大于 0 的数字");
  }
  await saveState();
  await submit(pending);
  delete state.pending[senderId];
  delete state.cards[event.message_id];
  await saveState();
  await updateCard(event.token, statusCard("入账成功", `${pending.fields["商品名称"]} · ¥${pending.fields["价格"]}`, true));
}

if (process.argv.includes("--resend-pending")) {
  for (const [senderId, pending] of Object.entries(state.pending)) {
    const sourceMessageId = pending.sourceMessageIds?.at(-1);
    if (!sourceMessageId) continue;
    const sent = await replyCard(sourceMessageId, editCard(pending), "card-upgrade");
    if (sent.message_id) state.cards[sent.message_id] = senderId;
  }
  await saveState();
  console.log("已为待确认记录发送交互卡片。");
  process.exit(0);
}

async function handleEvent(event) {
  if (!event?.message_id || event.sender_type === "bot" || event.chat_type !== "p2p") return;
  if (state.processed[event.message_id]) return;
  state.processed[event.message_id] = new Date().toISOString();
  if (Object.keys(state.processed).length > 2000) {
    state.processed = Object.fromEntries(Object.entries(state.processed).slice(-1000));
  }
  await saveState();
  try {
    if (event.message_type === "image") await handleImage(event);
    else if (event.message_type === "text") await handleText(event);
    else await reply(event.message_id, "目前支持图片和文字指令。请发送订单截图或发票图片。", "unsupported");
  } catch (error) {
    console.error(`[event ${event.message_id}]`, error);
    await reply(event.message_id, `处理失败：${String(error.message || error).slice(0, 500)}`, "error").catch(console.error);
  }
}

console.log("飞书报销机器人启动中……");
const consumers = [];
let shuttingDown = false;
function startConsumer(eventKey, handler) {
  const consumer = spawn("lark-cli", ["event", "consume", eventKey, "--as", "bot"], {
    cwd: ROOT, env: process.env, stdio: ["pipe", "pipe", "pipe"],
  });
  consumers.push(consumer);
  consumer.stderr.on("data", chunk => process.stderr.write(chunk));
  const lines = readline.createInterface({ input: consumer.stdout });
  let queue = Promise.resolve();
  lines.on("line", line => {
    if (!line.trim()) return;
    queue = queue.then(() => handler(JSON.parse(line))).catch(async error => {
      console.error(`[${eventKey}]`, error);
      if (eventKey === "card.action.trigger") {
        const event = JSON.parse(line);
        await reply(event.message_id, friendlyError(error), "card-error").catch(console.error);
      }
    });
  });
  consumer.on("exit", code => {
    console.error(`${eventKey} 监听已退出，状态码 ${code}`);
    if (!shuttingDown) {
      shuttingDown = true;
      for (const sibling of consumers) {
        if (sibling !== consumer && !sibling.killed) sibling.kill("SIGTERM");
      }
      setTimeout(() => process.exit(code || 1), 500).unref();
    }
  });
}
startConsumer("im.message.receive_v1", handleEvent);
startConsumer("card.action.trigger", handleCardAction);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    for (const consumer of consumers) consumer.kill("SIGTERM");
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
