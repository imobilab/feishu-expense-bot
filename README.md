# 飞书订单识别机器人

用户在飞书中私聊机器人并发送订单截图后，机器人使用 Qwen-VL 或 OCR 提取订单信息，再回复一张可编辑的 Card 2.0 确认卡片。用户确认后，数据与附件通过飞书表单写入多维表格中的 **“收集表”**。

## 写入目标

- Base Token：`IruKbsT0VaMwZwsR2qecroHtnue`
- 收集表：`tblY8EcAIKPHLIIu`
- 表单分享 Token：`shrcnTHfdZFYP2lB11p07xvR1Cc`

机器人不会直接写入“报销收集”主表。模型的统一结构为：

```json
{
  "类别": "",
  "商品名称": "",
  "价格": 0,
  "消费日期": "",
  "支付方式": ""
}
```

当前分享表单接受商品名称、价格、消费日期、支付方式、订单截图和发票文件。“类别”属于收集表字段，但表单没有开放该题目，因此只保留在识别结果中，不提交。

## 识别架构

```text
飞书图片消息
  → 下载原图
  → Recognition Layer
      ├─ ocr：Tesseract / Apple Vision + 规则解析
      ├─ vision：Qwen-VL 结构化识别，失败时回退 OCR
      └─ hybrid：并行执行 Vision 与 OCR，Vision 优先、OCR 补空
  → 飞书确认卡片
  → 收集表分享表单
```

代码结构：

```text
src/
├── bot.mjs
├── vision-ocr.m
├── providers/
│   └── qwen.mjs
└── recognition/
    ├── index.mjs
    ├── merge.mjs
    ├── ocr.mjs
    ├── schema.mjs
    └── vision.mjs
```

Qwen 请求通过阿里云百炼 OpenAI 兼容接口发送。图片直接编码为 Base64 Data URL，不上传到额外的对象存储。

## 环境变量

复制配置模板：

```bash
cp .env.example .env
chmod 600 .env
```

必须配置：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BRAND=feishu

FEISHU_FORM_SHARE_TOKEN=shrcnTHfdZFYP2lB11p07xvR1Cc
FEISHU_BASE_TOKEN=IruKbsT0VaMwZwsR2qecroHtnue

RECOGNITION_MODE=vision
VISION_PROVIDER=qwen
QWEN_API_KEY=sk-xxx
QWEN_MODEL=qwen3.5-flash

OCR_ENGINE=tesseract
OCR_LANG=chi_sim+eng
TZ=Asia/Shanghai
```

识别模式：

- `ocr`：只运行 OCR 和规则解析。
- `vision`：运行 Qwen-VL；接口异常或密钥不可用时自动回退 OCR。
- `hybrid`：同时运行 Qwen-VL 与 OCR，使用 Vision 的非空字段，并由 OCR 补充空字段。

`OCR_ENGINE=auto` 会在 macOS 使用 Apple Vision，在 Linux 使用 Tesseract。Docker 部署应使用 `tesseract`。

真实 `.env` 包含飞书和 Qwen 密钥，禁止提交到 Git。

## Docker Compose 部署

服务器要求：

- Docker Engine 24+
- Docker Compose v2+
- 能访问飞书开放平台、阿里云百炼和 npm
- 不需要开放 HTTP 端口；容器通过 WebSocket 主动连接飞书

启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f expense-bot
```

日志同时出现以下内容表示连接成功：

```text
[event] ready event_key=im.message.receive_v1
[event] ready event_key=card.action.trigger
```

常用命令：

```bash
docker compose logs --tail=200 expense-bot
docker compose restart expense-bot
docker compose down
```

`bot-data` 保存待确认状态和下载的图片，`lark-cli-config` 保存 CLI 应用配置。`docker compose down` 不删除持久化卷；不要使用 `docker compose down -v`，除非明确需要清空数据。

## 本机与服务器切换

同一个飞书应用全局只能运行一个事件总线。切换环境时必须先停止当前实例，再启动目标实例。

本机 OrbStack 切换到服务器：

```bash
# 本机项目目录
docker compose down

# 服务器
ssh siman@dogserver
cd /home/siman/feishu-expense-bot
docker compose up -d --build
```

服务器切回本机时按相反顺序操作。不要同时启动两边的容器。

## 功能边界

- 只处理机器人私聊。
- 一位用户同时维护一笔待确认记录；连续发送图片会合并到同一笔。
- 模型不会把订单号、交易号、物流号或状态栏时间写入收集表字段。
- 消费日期只接受明确的支付时间、交易完成时间或下单时间。
- 识别结果必须经过交互卡片确认后才会提交。
- Qwen API 故障不会中断 Bot，系统会自动回退 OCR。
