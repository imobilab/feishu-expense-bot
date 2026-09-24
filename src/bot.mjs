import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { ACTIONS, STAGES } from "./actions.mjs";
import { prepareVisualAttachment } from "./attachments.mjs";
import {
  alreadyHandledCard, candidateCard, cancelledCard, documentTypeCard, duplicateCard, expiredCard, finishedCard, invoiceReviewCard, noMatchCard,
} from "./invoice/cards.mjs";
import { createInvoiceRepository } from "./invoice/repository.mjs";
import {
  bindConfirmedInvoice, confirmedInvoiceFromForm, createOrderAndBind, DuplicateInvoiceError, matchConfirmedInvoice,
} from "./invoice/workflow.mjs";
import { orderFinishedCard, orderReviewCard } from "./order/cards.mjs";
import { reactionDeleteArgs, withProcessingReaction } from "./processing-reaction.mjs";
import { initializeRecognition, parseDocumentAs, recognizeDocument } from "./recognition/index.mjs";
import { addWorkflow, linkCard, normalizeState, workflowForCard } from "./workflow-state.mjs";

const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, "runtime");
const UPLOADS = path.join(RUNTIME, "uploads");
const STATE_FILE = path.join(RUNTIME, "state.json");
const SHARE_TOKEN = process.env.FEISHU_FORM_SHARE_TOKEN || "shrcnTHfdZFYP2lB11p07xvR1Cc";
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN || "IruKbsT0VaMwZwsR2qecroHtnue";
const TABLE_ID = process.env.FEISHU_TABLE_ID || "tblY8EcAIKPHLIIu";
const FORM_FIELD_NAMES = ["商品名称", "价格", "消费日期", "支付方式"];

await mkdir(UPLOADS, { recursive: true });
await initializeRecognition();
let state = normalizeState(await loadState());
let stateWrite = Promise.resolve();

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
    child.on("close", code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stderr || stdout}`)));
  });
}

async function runJson(args) {
  const result = await run("lark-cli", args);
  const parsed = JSON.parse(result.stdout);
  if (!parsed.ok) throw new Error(parsed.error?.message || "lark-cli request failed");
  return parsed.data;
}

const invoiceRepository = createInvoiceRepository({
  runJson,
  baseToken: BASE_TOKEN,
  tableId: TABLE_ID,
  invoiceNumberField: process.env.FEISHU_INVOICE_NUMBER_FIELD || "发票号码",
  invoiceAttachmentField: process.env.FEISHU_INVOICE_ATTACHMENT_FIELD || "发票文件",
});

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { processed: {}, pending: {}, cards: {} };
  }
}

async function saveState() {
  const snapshot = JSON.stringify(state, null, 2);
  const next = stateWrite.then(async () => {
    const temporary = `${STATE_FILE}.tmp`;
    await writeFile(temporary, snapshot);
    await rename(temporary, STATE_FILE);
  });
  stateWrite = next.catch(() => {});
  await next;
}

function currentDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.TZ || "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function findResourceKey(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.match(/(?:img|file)_[A-Za-z0-9_-]+/)?.[0] || null;
}

async function getResourceKey(event) {
  const direct = findResourceKey(event.content);
  if (direct) return direct;
  const data = await runJson([
    "im", "+messages-mget", "--message-id", event.message_id, "--as", "bot", "--no-reactions",
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
  const startedAt = Date.now();
  try {
    return await runJson([
      "api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot",
      "--data", JSON.stringify({ token, card }),
    ]);
  } finally {
    console.log(`[card] update_duration_ms=${Date.now() - startedAt}`);
  }
}

async function sendWorkflowCard(workflow, card, suffix) {
  const sent = await replyCard(workflow.messageId, card, suffix);
  linkCard(state, sent.message_id, workflow);
  await saveState();
  return sent;
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

function parseFormValue(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  return JSON.parse(raw);
}

function orderFromForm(form, fallback) {
  const price = Number(String(form.price || "").replace(/[,，¥￥\s]/g, ""));
  if (!Number.isFinite(price) || price <= 0) throw new Error("价格必须是大于 0 的数字");
  const product = String(form.product || "").trim();
  if (!product) throw new Error("商品名称不能为空");
  return {
    product,
    price,
    expense_date: String(form.expense_date || fallback.expense_date || currentDate()).slice(0, 10),
    payment_method: String(form.payment_method || "").trim(),
  };
}

async function submitOrder(workflow) {
  const order = workflow.confirmedOrder;
  const fields = {
    "商品名称": order.product,
    "价格": order.price,
    "消费日期": `${order.expense_date} 00:00:00`,
    "支付方式": order.payment_method,
  };
  const cleanFields = Object.fromEntries(FORM_FIELD_NAMES
    .map(name => [name, fields[name]])
    .filter(([, value]) => value !== "" && value !== null && value !== undefined));
  const attachments = { "订单截图": workflow.originalPaths.map(toRelative) };
  return runJson([
    "base", "+form-submit", "--share-token", SHARE_TOKEN, "--base-token", BASE_TOKEN,
    "--json", JSON.stringify({ fields: cleanFields, attachments }), "--as", "bot", "--yes",
  ]);
}

function toRelative(filePath) {
  return `./${path.relative(ROOT, filePath).split(path.sep).join("/")}`;
}

async function applyRecognition(workflow, result, { updateToken } = {}) {
  workflow.documentType = result.documentType;
  if (result.documentType === "order") {
    workflow.orderDraft = result.order;
    workflow.stage = STAGES.ORDER_REVIEW;
    workflow.originalPaths ||= [workflow.originalPath];
    await saveState();
    const card = orderReviewCard({ order: result.order, attachmentCount: workflow.originalPaths.length, today: currentDate() });
    return updateToken ? updateCard(updateToken, card) : sendWorkflowCard(workflow, card, "order-review");
  }
  if (result.documentType === "invoice") {
    workflow.invoiceDraft = result.invoice;
    workflow.confirmedInvoice = null;
    workflow.stage = STAGES.INVOICE_REVIEW;
    await saveState();
    const card = invoiceReviewCard(result.invoice);
    return updateToken ? updateCard(updateToken, card) : sendWorkflowCard(workflow, card, "invoice-review");
  }
  workflow.stage = STAGES.RECEIVED;
  await saveState();
  const card = documentTypeCard();
  return updateToken ? updateCard(updateToken, card) : sendWorkflowCard(workflow, card, "document-type");
}

async function handleAttachment(event) {
  const key = await getResourceKey(event);
  if (!key) throw new Error("没有从消息中找到附件标识");
  const localPath = await downloadResource(event, key);
  const visual = await prepareVisualAttachment(localPath, RUNTIME);
  const workflow = {
    id: event.message_id,
    senderId: event.sender_id,
    messageId: event.message_id,
    resourceKey: key,
    originalPath: visual.originalPath,
    imagePath: visual.imagePath,
    sourceType: visual.sourceType,
    documentType: "unknown",
    invoiceDraft: null,
    confirmedInvoice: null,
    candidateRecordIds: [],
    selectedRecordId: null,
    stage: STAGES.CLASSIFYING,
    createdAt: new Date().toISOString(),
  };
  addWorkflow(state, workflow);
  await saveState();
  const result = await recognizeDocument(visual.imagePath);
  await applyRecognition(workflow, result);
}

async function showInvoiceDecision(workflow, token) {
  workflow.stage = STAGES.INVOICE_DUPLICATE_CHECK;
  await saveState();
  const startedAt = Date.now();
  const result = await matchConfirmedInvoice(invoiceRepository, workflow.confirmedInvoice);
  console.log(`[invoice] initial_match_duration_ms=${Date.now() - startedAt} result=${result.type}`);
  if (result.type === "duplicate") return updateCard(token, duplicateCard(workflow.confirmedInvoice.invoice_number));
  if (result.type === "none") {
    workflow.stage = STAGES.INVOICE_NO_MATCH;
    workflow.candidateRecordIds = [];
    await saveState();
    return updateCard(token, noMatchCard(workflow.confirmedInvoice));
  }
  if (result.type === "multiple") {
    workflow.stage = STAGES.INVOICE_SELECT_ORDER;
    workflow.candidateRecordIds = result.candidates.map(candidate => candidate.recordId);
    workflow.candidates = result.candidates;
    await saveState();
    return updateCard(token, candidateCard(workflow.confirmedInvoice, result.candidates));
  }
  workflow.stage = STAGES.INVOICE_MATCHING;
  await saveState();
  return finishBinding(workflow, result.candidate.recordId, token, result.candidate);
}

async function finishBinding(workflow, recordId, token, candidate) {
  try {
    await bindConfirmedInvoice({ repository: invoiceRepository, workflow, recordId, persist: saveState });
  } catch (error) {
    if (error instanceof DuplicateInvoiceError) {
      workflow.stage = STAGES.INVOICE_DUPLICATE_CHECK;
      await saveState();
      return updateCard(token, duplicateCard(workflow.confirmedInvoice.invoice_number));
    }
    throw error;
  }
  const record = candidate || await invoiceRepository.getRecord(recordId, ["商品名称", "价格"]);
  return updateCard(token, finishedCard({
    product: record?.fields?.["商品名称"] || workflow.confirmedInvoice.items?.[0]?.name || workflow.confirmedInvoice.seller_name || "发票消费",
    amount: record?.fields?.["价格"] ?? workflow.confirmedInvoice.total_amount,
    invoiceNumber: workflow.confirmedInvoice.invoice_number,
  }));
}

async function handleCardAction(event) {
  if (!event?.event_id || state.processed[event.event_id]) return;
  const workflow = workflowForCard(state, event);
  if (!workflow) {
    await updateCard(event.token, expiredCard());
    state.processed[event.event_id] = new Date().toISOString();
    await saveState();
    return;
  }
  const action = event.action_name;
  const form = parseFormValue(event.form_value);

  if (workflow.stage === STAGES.FINISHED) {
    await updateCard(event.token, alreadyHandledCard());
  } else if (workflow.stage === STAGES.CANCELLED) {
    await updateCard(event.token, cancelledCard());
  } else if ([ACTIONS.DOCUMENT_CANCEL, ACTIONS.ORDER_CANCEL, ACTIONS.INVOICE_CANCEL].includes(action)) {
    workflow.stage = STAGES.CANCELLED;
    await saveState();
    await updateCard(event.token, cancelledCard());
  } else if (action === ACTIONS.DOCUMENT_CHOOSE_ORDER || action === ACTIONS.DOCUMENT_CHOOSE_INVOICE) {
    const documentType = action === ACTIONS.DOCUMENT_CHOOSE_ORDER ? "order" : "invoice";
    workflow.stage = documentType === "invoice" ? STAGES.INVOICE_PARSING : STAGES.CLASSIFYING;
    await saveState();
    await applyRecognition(workflow, await parseDocumentAs(documentType, workflow.imagePath), { updateToken: event.token });
  } else if (action === ACTIONS.ORDER_CONFIRM) {
    if (workflow.stage === STAGES.FINISHED) return;
    workflow.confirmedOrder = orderFromForm(form, workflow.orderDraft);
    await saveState();
    await submitOrder(workflow);
    workflow.stage = STAGES.FINISHED;
    workflow.finishedAt = new Date().toISOString();
    await saveState();
    await updateCard(event.token, orderFinishedCard(workflow.confirmedOrder));
  } else if (action === ACTIONS.INVOICE_CONFIRM) {
    workflow.confirmedInvoice = confirmedInvoiceFromForm(form, workflow.invoiceDraft);
    console.log(`[invoice] confirmed number=${workflow.confirmedInvoice.invoice_number} amount=${workflow.confirmedInvoice.total_amount}`);
    await saveState();
    await showInvoiceDecision(workflow, event.token);
  } else if (action === ACTIONS.INVOICE_EDIT_AGAIN) {
    workflow.stage = STAGES.INVOICE_REVIEW;
    await saveState();
    await updateCard(event.token, invoiceReviewCard(workflow.confirmedInvoice || workflow.invoiceDraft));
  } else if (action === ACTIONS.INVOICE_SELECT_ORDER) {
    const selected = String(form.selected_order || "");
    if (!workflow.candidateRecordIds?.includes(selected)) throw new Error("请选择有效的订单");
    console.log(`[invoice] selected_record_id=${selected}`);
    await finishBinding(workflow, selected, event.token, workflow.candidates?.find(candidate => candidate.recordId === selected));
  } else if (action === ACTIONS.INVOICE_CREATE_ORDER) {
    try {
      await createOrderAndBind({ repository: invoiceRepository, workflow, persist: saveState });
      const record = await invoiceRepository.getRecord(workflow.createdOrderId, ["商品名称", "价格"]);
      await updateCard(event.token, finishedCard({
        product: record?.fields?.["商品名称"] || workflow.confirmedInvoice.seller_name || "发票消费",
        amount: record?.fields?.["价格"] ?? workflow.confirmedInvoice.total_amount,
        invoiceNumber: workflow.confirmedInvoice.invoice_number,
      }));
    } catch (error) {
      if (error instanceof DuplicateInvoiceError) {
        workflow.stage = STAGES.INVOICE_DUPLICATE_CHECK;
        await saveState();
        await updateCard(event.token, duplicateCard(workflow.confirmedInvoice.invoice_number));
      } else throw error;
    }
  } else {
    return;
  }

  state.processed[event.event_id] = new Date().toISOString();
  if (Object.keys(state.processed).length > 2000) state.processed = Object.fromEntries(Object.entries(state.processed).slice(-1000));
  await saveState();
}

async function handleText(event) {
  if (/^(帮助|help|使用说明)$/i.test(event.content.trim())) {
    await reply(event.message_id, "发送订单截图、支付截图、发票图片或 PDF。机器人会先判断类型，再显示对应确认卡片。", "help");
  } else {
    await reply(event.message_id, "请发送订单或发票的图片/PDF。", "fallback");
  }
}

function friendlyError(error) {
  const message = String(error?.message || error);
  if (message.includes("视觉模型")) return "附件识别失败，请重新发送或稍后重试。";
  if (message.includes("发票号码")) return message;
  if (message.includes("Forbidden") || message.includes("access denied")) return "机器人没有目标表格或附件的访问权限。";
  return `处理失败：${message.slice(0, 500)}`;
}

async function rememberProcessingReaction(messageId, reactionId) {
  state.processingReactions[messageId] = reactionId;
  await saveState();
}

async function forgetProcessingReaction(messageId, reactionId) {
  if (state.processingReactions[messageId] !== reactionId) return;
  delete state.processingReactions[messageId];
  await saveState();
}

async function clearStaleProcessingReactions() {
  for (const [messageId, reactionId] of Object.entries(state.processingReactions)) {
    try {
      await runJson(reactionDeleteArgs(messageId, reactionId));
      await forgetProcessingReaction(messageId, reactionId);
    } catch (error) {
      console.error(`[reaction ${messageId}] startup cleanup failed`, error);
    }
  }
}

async function handleEvent(event) {
  if (!event?.message_id || event.sender_type === "bot" || event.chat_type !== "p2p") return;
  if (state.processed[event.message_id]) return;
  const work = async () => {
    try {
      if (["image", "file"].includes(event.message_type)) await handleAttachment(event);
      else if (event.message_type === "text") await handleText(event);
      else await reply(event.message_id, "目前支持图片、PDF 和文字指令。", "unsupported");
      state.processed[event.message_id] = new Date().toISOString();
      await saveState();
    } catch (error) {
      console.error(`[event ${event.message_id}]`, error);
      await reply(event.message_id, friendlyError(error), "error").catch(console.error);
    }
  };
  if (["image", "file"].includes(event.message_type)) {
    await withProcessingReaction({
      messageId: event.message_id,
      runJson,
      work,
      onAdded: rememberProcessingReaction,
      onRemoved: forgetProcessingReaction,
      onError: (stage, error) => console.error(`[reaction ${event.message_id}] ${stage} failed`, error),
    });
  } else {
    await work();
  }
}

if (process.argv.includes("--resend-pending")) {
  for (const workflow of Object.values(state.pending)) {
    if (!workflow?.messageId) continue;
    if (workflow.stage === STAGES.ORDER_REVIEW) await sendWorkflowCard(workflow, orderReviewCard({ order: workflow.confirmedOrder || workflow.orderDraft, attachmentCount: workflow.originalPaths?.length || 1, today: currentDate() }), "order-resend");
    if (workflow.stage === STAGES.INVOICE_REVIEW) await sendWorkflowCard(workflow, invoiceReviewCard(workflow.confirmedInvoice || workflow.invoiceDraft), "invoice-resend");
    if (workflow.stage === STAGES.RECEIVED && workflow.documentType === "unknown") await sendWorkflowCard(workflow, documentTypeCard(), "type-resend");
  }
  console.log("已重发待确认卡片。");
  process.exit(0);
}

await clearStaleProcessingReactions();
console.log("飞书订单与发票机器人启动中……");
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
      for (const sibling of consumers) if (sibling !== consumer && !sibling.killed) sibling.kill("SIGTERM");
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
