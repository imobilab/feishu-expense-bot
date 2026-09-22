import { readFile } from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";

export const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

export const EXPENSE_VISION_PROMPT = `你是一个专业的消费订单识别系统。

请分析上传的订单截图、支付记录、购物小票、行程订单、酒店订单、餐饮订单或其他消费凭证，从复杂版面中提取本次订单的核心信息。

识别结果将直接提交到飞书多维表格“收集表”。只提取该表需要的订单字段。本任务不是增值税发票识别，不要输出销售方、购买方、发票号码、税额、订单号或其他额外字段。

请严格返回以下 JSON：

{
  "类别":"",
  "商品名称":"",
  "价格":0,
  "消费日期":"",
  "支付方式":""
}

字段规则：

1. 类别：只有图片明确标注了报销类别时才填写。商品分类、店铺分类和模型自行推断的“耗材”“餐饮”等都不能作为类别；通常返回空字符串。
2. 商品名称：提取订单中实际购买的商品或服务名称，并保留图片中明确显示的型号、规格、颜色等关键信息。不要使用店铺名、页面标题、订单状态、物流信息或广告。不要补全图片中被省略号隐藏的文字。多个主要商品用“、”连接。
3. 价格：提取订单最终实付款、支付金额或订单合计。应选择优惠后的实际支付金额，不要选择商品原价、划线价、优惠金额、运费、单价、余额或积分。必须返回数字且不带货币符号；无法确认时返回 0。
4. 消费日期：优先提取支付时间或交易完成时间，其次使用明确标注的下单时间。统一为 YYYY-MM-DD。配送时间、预计送达、自动确认收货倒计时、售后期限和手机状态栏时间都不是消费日期；无法确认时返回空字符串。
5. 支付方式：仅提取图片中明确显示的微信支付、支付宝、银行卡、信用卡、现金或平台余额等支付渠道；无法确认时返回空字符串。

输出要求：

1. 只输出一个合法 JSON 对象，不要输出解释、Markdown 或代码块。
2. 所有字段都必须出现，不得增加其他字段。
3. 无法确认的文本字段填写空字符串，价格无法确认时填写 0，禁止凭常识猜测。
4. 如果图片包含多个区域，结合版面、标签和数值关系判断同一笔订单的信息，避免把广告、推荐商品或历史订单混入结果。
5. 如果图片中存在多笔独立订单，提取视觉上处于主体位置或信息最完整的一笔订单。`;

function imageMimeType(imagePath) {
  const extension = path.extname(imagePath).toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  }[extension] || "image/jpeg";
}

function createClient() {
  const apiKey = process.env.QWEN_API_KEY?.trim();
  if (!apiKey) throw new Error("缺少 QWEN_API_KEY，无法调用 Qwen-VL");
  return new OpenAI({
    apiKey,
    baseURL: process.env.QWEN_BASE_URL || QWEN_BASE_URL,
  });
}

export async function callQwenVision(imagePath, options = {}) {
  const image = await readFile(imagePath);
  const dataUrl = `data:${imageMimeType(imagePath)};base64,${image.toString("base64")}`;
  const client = options.client || createClient();
  const completion = await client.chat.completions.create({
    model: process.env.QWEN_MODEL || "qwen2.5-vl-7b-instruct",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: EXPENSE_VISION_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0,
  });
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Qwen-VL 返回了空响应");
  }
  return content.trim();
}
