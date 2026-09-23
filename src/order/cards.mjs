import { ACTIONS } from "../actions.mjs";

export function orderReviewCard({ order, attachmentCount = 1, today }) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(order.expense_date || "") ? order.expense_date : today;
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", summary: { content: "请检查订单识别结果" } },
    header: {
      title: { tag: "plain_text", content: "订单识别结果" },
      subtitle: { tag: "plain_text", content: "修改后确认入账" },
      template: "blue",
    },
    body: {
      direction: "vertical", padding: "12px 12px 20px 12px", vertical_spacing: "12px",
      elements: [
        { tag: "markdown", content: `**检查识别内容**\n<font color='grey'>已附带 ${attachmentCount} 个订单附件</font>` },
        {
          tag: "form", name: "order_form", element_id: "orderForm", direction: "vertical", vertical_spacing: "12px", padding: "12px",
          elements: [
            { tag: "input", name: "product", required: true, width: "fill", label: { tag: "plain_text", content: "商品名称" }, default_value: order.product || "" },
            { tag: "input", name: "price", required: true, width: "fill", label: { tag: "plain_text", content: "价格" }, placeholder: { tag: "plain_text", content: "请输入实付金额" }, default_value: order.price == null ? "" : String(order.price) },
            { tag: "markdown", element_id: "orderDateLabel", content: "**消费日期（必选）**", margin: "8px 0 0 0" },
            { tag: "date_picker", name: "expense_date", required: true, width: "fill", initial_date: date },
            { tag: "input", name: "payment_method", width: "fill", label: { tag: "plain_text", content: "支付方式" }, default_value: order.payment_method || "" },
            { tag: "button", name: ACTIONS.ORDER_CONFIRM, form_action_type: "submit", text: { tag: "plain_text", content: "确认入账" }, type: "primary_filled", width: "fill" },
            { tag: "button", name: ACTIONS.ORDER_CANCEL, form_action_type: "submit", text: { tag: "plain_text", content: "取消" }, type: "default", width: "fill" },
          ],
        },
      ],
    },
  };
}

export function orderFinishedCard(order) {
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", summary: { content: "订单入账成功" } },
    header: { title: { tag: "plain_text", content: "订单入账成功" }, template: "green" },
    body: {
      direction: "vertical", padding: "12px 12px 20px 12px",
      elements: [{ tag: "markdown", content: `**商品**\n${order.product}\n\n**金额**\n¥${Number(order.price).toFixed(2)}` }],
    },
  };
}
