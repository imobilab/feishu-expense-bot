import { STAGES } from "../actions.mjs";
import { invoiceSchema } from "../recognition/schemas.mjs";
import { moneyToCents } from "./money.mjs";

export class DuplicateInvoiceError extends Error {
  constructor(invoiceNumber, recordId) {
    super(`发票号码 ${invoiceNumber} 已存在`);
    this.name = "DuplicateInvoiceError";
    this.invoiceNumber = invoiceNumber;
    this.recordId = recordId;
  }
}

function nullableAmount(value) {
  const text = String(value ?? "").replace(/[,，¥￥\s]/g, "");
  if (!text) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 ? amount : NaN;
}

export function confirmedInvoiceFromForm(form, draft) {
  const candidate = {
    invoice_number: String(form.invoice_number || "").trim(),
    invoice_date: String(form.invoice_date || "").slice(0, 10),
    buyer_name: String(form.buyer_name || "").trim(),
    buyer_tax_id: String(form.buyer_tax_id || "").trim(),
    seller_name: String(form.seller_name || "").trim(),
    seller_tax_id: String(form.seller_tax_id || "").trim(),
    amount_without_tax: nullableAmount(form.amount_without_tax),
    tax_amount: nullableAmount(form.tax_amount),
    total_amount: nullableAmount(form.total_amount),
    items: Array.isArray(draft?.items) ? draft.items : [],
  };
  const parsed = invoiceSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`发票字段格式错误：${parsed.error.issues.map(issue => issue.message).join("；")}`);
  if (!parsed.data.invoice_number) throw new Error("发票号码不能为空");
  if (moneyToCents(parsed.data.total_amount) === null) throw new Error("价税合计不能为空且必须是有效金额");
  return parsed.data;
}

export async function matchConfirmedInvoice(repository, confirmedInvoice) {
  const { duplicate, candidates } = await repository.findDuplicateAndAmountCandidates(
    confirmedInvoice.invoice_number,
    confirmedInvoice.total_amount,
  );
  if (duplicate) return { type: "duplicate", duplicate };
  if (candidates.length === 0) return { type: "none", candidates };
  if (candidates.length === 1) return { type: "single", candidate: candidates[0], candidates };
  return { type: "multiple", candidates };
}

export async function bindConfirmedInvoice({ repository, workflow, recordId, persist = async () => {} }) {
  if (workflow.stage === STAGES.FINISHED) return { recordId: workflow.selectedRecordId, alreadyFinished: true };
  const invoice = workflow.confirmedInvoice;
  if (!invoice) throw new Error("缺少用户确认后的发票数据");

  const duplicate = await repository.findDuplicate(invoice.invoice_number);
  if (duplicate) throw new DuplicateInvoiceError(invoice.invoice_number, duplicate.recordId);

  workflow.stage = STAGES.INVOICE_BINDING;
  workflow.selectedRecordId = recordId;
  await persist();

  if (workflow.invoiceAttachmentUploadedTo !== recordId) {
    await repository.uploadInvoice(recordId, workflow.invoiceUploadPath || workflow.originalPath);
    workflow.invoiceAttachmentUploadedTo = recordId;
    await persist();
  }

  const finalDuplicate = await repository.findDuplicate(invoice.invoice_number);
  if (finalDuplicate) throw new DuplicateInvoiceError(invoice.invoice_number, finalDuplicate.recordId);
  await repository.appendInvoiceNumber(recordId, invoice.invoice_number);

  workflow.stage = STAGES.FINISHED;
  workflow.finishedAt = new Date().toISOString();
  await persist();
  console.log(`[invoice] binding_result=success selected_record_id=${recordId}`);
  return { recordId, alreadyFinished: false };
}

export async function createOrderAndBind({ repository, workflow, persist = async () => {} }) {
  if (!workflow.createdOrderId) {
    const duplicate = await repository.findDuplicate(workflow.confirmedInvoice.invoice_number);
    if (duplicate) throw new DuplicateInvoiceError(workflow.confirmedInvoice.invoice_number, duplicate.recordId);
    workflow.createdOrderId = await repository.createOrder(workflow.confirmedInvoice);
    await persist();
  }
  return bindConfirmedInvoice({ repository, workflow, recordId: workflow.createdOrderId, persist });
}
