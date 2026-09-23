import path from "node:path";

import { moneyToCents } from "./money.mjs";

// lark-cli +record-list accepts at most 200 rows with --format json.
const JSON_PAGE_SIZE = 200;

function matrixRows(data) {
  const fields = data.fields || [];
  return (data.record_id_list || []).map((recordId, index) => ({
    recordId,
    fields: Object.fromEntries(fields.map((field, column) => [field, data.data?.[index]?.[column] ?? null])),
  }));
}

function invoiceNumbers(value) {
  return String(value || "").split(/[\s,，;；、]+/).map(item => item.trim()).filter(Boolean);
}

function cliRelativeFile(filePath) {
  const relative = path.relative(process.cwd(), path.resolve(filePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("发票附件必须位于机器人项目目录内");
  }
  return `./${relative.split(path.sep).join("/")}`;
}

export function createInvoiceRepository({
  runJson,
  baseToken,
  tableId,
  invoiceNumberField = "发票号码",
  invoiceAttachmentField = "发票文件",
}) {
  async function listAll(fields) {
    const rows = [];
    let offset = 0;
    do {
      let data;
      try {
        data = await runJson([
          "base", "+record-list", "--base-token", baseToken, "--table-id", tableId,
          ...fields.flatMap(field => ["--field-id", field]),
          "--limit", String(JSON_PAGE_SIZE), "--offset", String(offset), "--format", "json", "--as", "bot",
        ]);
      } catch (error) {
        if (String(error.message || error).includes(invoiceNumberField)) {
          throw new Error(`收集表缺少文本字段“${invoiceNumberField}”，请先创建后再处理发票`);
        }
        throw error;
      }
      const page = matrixRows(data);
      rows.push(...page);
      if (!data.has_more) break;
      offset += page.length;
      if (!page.length) break;
    } while (true);
    return rows;
  }

  async function findDuplicate(invoiceNumber) {
    const target = String(invoiceNumber || "").trim();
    if (!target) return null;
    const records = await listAll([invoiceNumberField]);
    const duplicate = records.find(record => invoiceNumbers(record.fields[invoiceNumberField]).includes(target)) || null;
    console.log(`[invoice] duplicate=${Boolean(duplicate)} number=${target}`);
    return duplicate;
  }

  async function findAmountCandidates(totalAmount) {
    const target = moneyToCents(totalAmount);
    if (target === null) return [];
    const fields = ["商品名称", "价格", "消费日期", "支付方式"];
    const records = await listAll(fields);
    const candidates = records.filter(record => moneyToCents(record.fields["价格"]) === target);
    console.log(`[invoice] match_candidate_count=${candidates.length} amount_cents=${target}`);
    return candidates;
  }

  async function findDuplicateAndAmountCandidates(invoiceNumber, totalAmount) {
    const targetNumber = String(invoiceNumber || "").trim();
    const targetCents = moneyToCents(totalAmount);
    const records = await listAll([invoiceNumberField, "商品名称", "价格", "消费日期", "支付方式"]);
    const duplicate = targetNumber
      ? records.find(record => invoiceNumbers(record.fields[invoiceNumberField]).includes(targetNumber)) || null
      : null;
    console.log(`[invoice] duplicate=${Boolean(duplicate)} number=${targetNumber}`);
    if (duplicate) return { duplicate, candidates: [] };
    const candidates = targetCents === null ? []
      : records.filter(record => moneyToCents(record.fields["价格"]) === targetCents);
    console.log(`[invoice] match_candidate_count=${candidates.length} amount_cents=${targetCents}`);
    return { duplicate: null, candidates };
  }

  async function getRecord(recordId, fields) {
    const data = await runJson([
      "base", "+record-get", "--base-token", baseToken, "--table-id", tableId,
      "--record-id", recordId, ...fields.flatMap(field => ["--field-id", field]),
      "--format", "json", "--as", "bot",
    ]);
    return matrixRows(data)[0] || null;
  }

  async function updateFields(recordId, fields) {
    await runJson([
      "base", "+record-batch-update", "--base-token", baseToken, "--table-id", tableId,
      "--json", JSON.stringify({ update_records: { [recordId]: fields } }), "--as", "bot",
    ]);
  }

  async function uploadInvoice(recordId, filePath) {
    await runJson([
      "base", "+record-upload-attachment", "--base-token", baseToken, "--table-id", tableId,
      "--record-id", recordId, "--field-id", invoiceAttachmentField, "--file", cliRelativeFile(filePath), "--as", "bot",
    ]);
  }

  async function appendInvoiceNumber(recordId, invoiceNumber) {
    const record = await getRecord(recordId, [invoiceNumberField]);
    const existing = invoiceNumbers(record?.fields?.[invoiceNumberField]);
    if (existing.includes(invoiceNumber)) return;
    await updateFields(recordId, { [invoiceNumberField]: [...existing, invoiceNumber].join("\n") });
  }

  async function createOrder(invoice) {
    const product = invoice.items?.find(item => item.name)?.name || invoice.seller_name || "发票消费";
    const fields = {
      "商品名称": product,
      "价格": invoice.total_amount,
      ...(invoice.invoice_date ? { "消费日期": `${invoice.invoice_date} 00:00:00` } : {}),
    };
    const data = await runJson([
      "base", "+record-batch-create", "--base-token", baseToken, "--table-id", tableId,
      "--json", JSON.stringify({ create_records: [fields] }), "--as", "bot",
    ]);
    const recordId = data.record_id_list?.[0] || data.records?.[0]?.record_id;
    if (!recordId) throw new Error("创建订单后未返回 record_id");
    return recordId;
  }

  return {
    findDuplicate,
    findAmountCandidates,
    findDuplicateAndAmountCandidates,
    getRecord,
    updateFields,
    uploadInvoice,
    appendInvoiceNumber,
    createOrder,
    invoiceNumberField,
    invoiceAttachmentField,
  };
}
