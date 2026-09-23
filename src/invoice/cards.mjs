import { ACTIONS } from "../actions.mjs";

function baseCard(title, subtitle, elements, template = "blue") {
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", summary: { content: title } },
    header: { title: { tag: "plain_text", content: title }, subtitle: { tag: "plain_text", content: subtitle }, template },
    body: { direction: "vertical", padding: "12px 12px 20px 12px", vertical_spacing: "12px", elements },
  };
}

function form(name, elements) {
  return { tag: "form", name, direction: "vertical", vertical_spacing: "12px", padding: "12px", elements };
}

function button(name, text, type = "default") {
  return { tag: "button", name, form_action_type: "submit", text: { tag: "plain_text", content: text }, type, width: "fill" };
}

function amountValue(value) {
  return value == null ? "" : String(value);
}

export function documentTypeCard() {
  return baseCard("无法确定附件类型", "请选择附件类型", [
    { tag: "markdown", content: "模型无法可靠判断该附件属于订单还是正式发票。" },
    form("document_type_form", [
      button(ACTIONS.DOCUMENT_CHOOSE_ORDER, "这是订单", "primary_filled"),
      button(ACTIONS.DOCUMENT_CHOOSE_INVOICE, "这是发票"),
      button(ACTIONS.DOCUMENT_CANCEL, "取消"),
    ]),
  ], "orange");
}

export function invoiceReviewCard(invoice) {
  const items = invoice.items?.length
    ? invoice.items.map(item => `- ${item.name || "未命名项目"}${item.amount == null ? "" : ` ¥${item.amount.toFixed(2)}`}`).join("\n")
    : "- 未识别到商品项目";
  const datePicker = invoice.invoice_date
    ? { tag: "date_picker", name: "invoice_date", width: "fill", initial_date: invoice.invoice_date }
    : { tag: "date_picker", name: "invoice_date", width: "fill", placeholder: { tag: "plain_text", content: "请选择开票日期" } };
  return baseCard("发票识别结果", "请检查并修改；确认后系统将尝试匹配已有订单", [
    form("invoice_review_form", [
      { tag: "input", name: "invoice_number", required: true, width: "fill", label: { tag: "plain_text", content: "发票号码" }, default_value: invoice.invoice_number || "" },
      { tag: "markdown", element_id: "invoiceDateLabel", content: "**开票日期**" },
      datePicker,
      { tag: "input", name: "buyer_name", width: "fill", label: { tag: "plain_text", content: "购买方名称" }, default_value: invoice.buyer_name || "" },
      { tag: "input", name: "buyer_tax_id", width: "fill", label: { tag: "plain_text", content: "购买方税号" }, default_value: invoice.buyer_tax_id || "" },
      { tag: "input", name: "seller_name", width: "fill", label: { tag: "plain_text", content: "销售方名称" }, default_value: invoice.seller_name || "" },
      { tag: "input", name: "seller_tax_id", width: "fill", label: { tag: "plain_text", content: "销售方税号" }, default_value: invoice.seller_tax_id || "" },
      { tag: "input", name: "amount_without_tax", width: "fill", label: { tag: "plain_text", content: "未税金额" }, default_value: amountValue(invoice.amount_without_tax) },
      { tag: "input", name: "tax_amount", width: "fill", label: { tag: "plain_text", content: "税额" }, default_value: amountValue(invoice.tax_amount) },
      { tag: "input", name: "total_amount", required: true, width: "fill", label: { tag: "plain_text", content: "价税合计" }, default_value: amountValue(invoice.total_amount) },
      { tag: "markdown", content: `**识别到的项目**\n${items}` },
      button(ACTIONS.INVOICE_CONFIRM, "确认并匹配", "primary_filled"),
      button(ACTIONS.INVOICE_CANCEL, "取消"),
    ]),
  ]);
}

export function duplicateCard(invoiceNumber) {
  return baseCard("该发票已入账", "系统已找到相同发票号码的记录", [
    { tag: "markdown", content: `**发票号码**\n${invoiceNumber}` },
    form("invoice_duplicate_form", [
      button(ACTIONS.INVOICE_EDIT_AGAIN, "返回修改", "primary_filled"),
      button(ACTIONS.INVOICE_CANCEL, "取消"),
    ]),
  ], "orange");
}

export function noMatchCard(invoice) {
  return baseCard("未找到金额匹配的订单", "请选择后续操作", [
    { tag: "markdown", content: `**发票金额**\n¥${Number(invoice.total_amount).toFixed(2)}\n\n**发票号码**\n${invoice.invoice_number}` },
    form("invoice_no_match_form", [
      button(ACTIONS.INVOICE_CREATE_ORDER, "创建新订单", "primary_filled"),
      button(ACTIONS.INVOICE_EDIT_AGAIN, "返回修改"),
      button(ACTIONS.INVOICE_CANCEL, "取消"),
    ]),
  ], "orange");
}

export function candidateCard(invoice, candidates) {
  const options = candidates.map(candidate => {
    const fields = candidate.fields;
    const date = String(fields["消费日期"] || "").slice(0, 10) || "日期未知";
    const product = String(fields["商品名称"] || "未命名订单").slice(0, 45);
    return { text: { tag: "plain_text", content: `${date}｜${product}｜¥${Number(fields["价格"]).toFixed(2)}` }, value: candidate.recordId };
  });
  return baseCard("选择匹配订单", `找到 ${candidates.length} 笔相同金额订单`, [
    { tag: "markdown", content: `仅按价税合计 **¥${Number(invoice.total_amount).toFixed(2)}** 匹配，请人工选择。` },
    form("invoice_candidate_form", [
      { tag: "select_static", name: "selected_order", required: true, width: "fill", placeholder: { tag: "plain_text", content: "请选择订单" }, options },
      button(ACTIONS.INVOICE_SELECT_ORDER, "确认关联", "primary_filled"),
      button(ACTIONS.INVOICE_EDIT_AGAIN, "返回修改发票"),
      button(ACTIONS.INVOICE_CANCEL, "取消"),
    ]),
  ]);
}

export function finishedCard({ product, amount, invoiceNumber }) {
  return baseCard("发票已成功入账", "发票已添加到对应订单记录", [
    { tag: "markdown", content: `**订单**\n${product}\n\n**金额**\n¥${Number(amount).toFixed(2)}\n\n**发票号码**\n${invoiceNumber}` },
  ], "green");
}

export function cancelledCard() {
  return baseCard("已取消", "没有写入表格", [{ tag: "markdown", content: "本次处理已取消。" }], "grey");
}

export function expiredCard() {
  return baseCard("卡片已过期", "无法确认它对应的附件", [
    { tag: "markdown", content: "请重新发送这份附件，再从新卡片继续。" },
  ], "orange");
}

export function alreadyHandledCard() {
  return baseCard("这笔附件已处理", "不会重复写入表格", [
    { tag: "markdown", content: "这笔附件此前已完成；如需处理另一份附件，请使用它自己的卡片。" },
  ], "green");
}
