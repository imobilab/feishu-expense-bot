# 飞书订单与发票机器人

机器人接收飞书私聊中的图片或 PDF，先判断附件是订单、正式发票还是未知类型，再进入对应的确认和入账流程。所有数据只写入多维表格的 **“收集表”**，不会操作“报销收集”主表。

## 写入目标

- Base Token：`IruKbsT0VaMwZwsR2qecroHtnue`
- 收集表 ID：`tblY8EcAIKPHLIIu`
- 订单表单分享 Token：`shrcnTHfdZFYP2lB11p07xvR1Cc`
- 订单附件字段：`订单截图`
- 发票附件字段：`发票文件`
- 发票号码字段：默认 `发票号码`

部署发票流程前，必须在“收集表”中建立文本字段 `发票号码`。字段名也可以通过 `FEISHU_INVOICE_NUMBER_FIELD` 调整。

## 业务流程

```text
图片 / PDF
  → 文档分类
      ├─ order   → 订单模型解析 → 可编辑订单卡片 → 表单写入收集表
      ├─ invoice → 发票模型解析 → 可编辑发票卡片
      │                               → 发票号码查重
      │                               → 仅按价税合计精确匹配订单
      │                                  ├─ 0 条：用户决定是否创建订单
      │                                  ├─ 1 条：自动关联
      │                                  └─ 多条：用户选择 record_id
      │                               → 绑定原始发票附件和发票号码
      └─ unknown → 用户在卡片中选择订单或发票
```

收到图片或文件后，机器人会在原消息上添加 `Typing` 表情；识别并回复卡片或错误消息后清除。表情 ID 会暂存于运行状态，意外重启时尝试补清除。该功能需要飞书应用的 `im:message.reactions:write_only` 权限。

订单确认卡片中的消费日期是独立必选字段。模型没有识别到日期时，默认使用 `TZ` 对应时区的当天日期。

发票识别草稿保存在 `invoiceDraft`。用户修改并提交卡片后生成 `confirmedInvoice`；查重、匹配、创建和绑定只读取 `confirmedInvoice`。

## 代码结构

```text
src/
├── bot.mjs                       # 飞书事件、状态机和业务编排
├── workflow-state.mjs            # 按附件保存工作流并关联对应卡片
├── processing-reaction.mjs       # 附件处理期间的表情添加与清除
├── actions.mjs                   # 卡片 action 与 stage 常量
├── attachments.mjs               # 图片检测与 PDF 首页渲染
├── vision-ocr.m                  # Apple Vision OCR 底层实现
├── providers/
│   └── qwen.mjs                  # OpenAI 兼容视觉模型调用、Base64、JSON 与 Schema 校验
├── recognition/
│   ├── index.mjs                 # vision / ocr 路由
│   ├── classifier.mjs            # order / invoice / unknown 分类
│   ├── order-parser.mjs          # 订单视觉解析
│   ├── invoice-parser.mjs        # 正式发票视觉解析
│   ├── prompts.mjs               # 三类独立系统提示词
│   ├── schemas.mjs               # Zod 输出结构
│   ├── ocr.mjs                   # 旧 OCR + 规则流程适配
│   └── schema.mjs                # 旧订单字段规范化
├── order/
│   └── cards.mjs                 # 订单确认与完成卡片
└── invoice/
    ├── cards.mjs                 # 发票确认、候选、重复、完成卡片
    ├── money.mjs                 # 金额转分
    ├── repository.mjs            # 收集表查询、创建、附件与号码追加
    └── workflow.mjs              # 查重、匹配、绑定和幂等状态
```

## 环境变量

```bash
cp .env.example .env
chmod 600 .env
```

主要配置：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BRAND=feishu

FEISHU_FORM_SHARE_TOKEN=shrcnTHfdZFYP2lB11p07xvR1Cc
FEISHU_BASE_TOKEN=IruKbsT0VaMwZwsR2qecroHtnue
FEISHU_TABLE_ID=tblY8EcAIKPHLIIu
FEISHU_INVOICE_NUMBER_FIELD=发票号码
FEISHU_INVOICE_ATTACHMENT_FIELD=发票文件

RECOGNITION_MODE=vision
VISION_PROVIDER=qwen
VISION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VISION_API_KEY=sk-xxx
VISION_MODEL=qwen3.5-flash
VISION_TIMEOUT_MS=60000

OCR_ENGINE=tesseract
OCR_LANG=chi_sim+eng
TZ=Asia/Shanghai
```

- `RECOGNITION_MODE=vision`：先分类，再使用独立的订单或发票视觉提示词。
- `RECOGNITION_MODE=ocr`：保留旧版 OCR + 规则订单流程，不启用发票流程。
- `VISION_MODEL` 可直接切换百炼兼容接口中的视觉模型。
- `VISION_API_KEY`、飞书密钥和本地 `.env` 禁止提交到 Git。

兼容旧配置：Provider 仍会读取 `QWEN_API_KEY`、`QWEN_MODEL`、`QWEN_BASE_URL` 作为后备值。

## Vision 调用

`callVisionModel()` 负责读取图片、识别 JPEG/PNG/WebP MIME、生成 Base64 Data URL、调用 OpenAI 兼容接口、提取 JSON 并使用 Zod 校验。请求失败、JSON 无效或 Schema 不匹配时会自动重试一次。PDF 使用 `pdftoppm` 将第一页渲染为 PNG，再交给视觉模型；原始 PDF 会作为发票附件保存。

模型异常不会写入多维表格，也不会导致事件监听进程退出。

## 发票匹配与幂等

1. 用户确认后先按完整发票号码查重。
2. 未重复时，将 `confirmedInvoice.total_amount` 和订单 `价格` 都用 `moneyToCents()` 转成分。
3. 只接受分值完全一致的订单；日期、商户、商品和支付方式不参与自动判断。
4. 真正绑定前再次查重。
5. 附件使用飞书 CLI 的附件上传命令追加，发票号码保留已有内容后换行追加。
6. 工作流完成后标记 `FINISHED`；重复卡片事件和重复点击不会再次写入。

运行状态、待确认数据和已处理事件保存在 `runtime/state.json`。

## 本地检查

```bash
npm ci
npm run check
npm test
docker compose config --quiet
docker compose build
```

测试覆盖模型 JSON、重试、订单与发票路由、卡片结构、用户编辑值、金额匹配、0/1/多候选、发票号查重、追加和重复点击。

## Docker Compose

容器自带 Node.js、lark-cli、Tesseract 和 Poppler，无需开放 HTTP 端口。机器人通过 WebSocket 主动连接飞书。

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=200 expense-bot
```

日志中两个事件监听都进入 ready 状态后，机器人才能正常接收消息和卡片操作：

```text
[event] ready event_key=im.message.receive_v1
[event] ready event_key=card.action.trigger
```

持久化卷：

- `bot-data`：状态、下载附件和 PDF 预览。
- `lark-cli-config`：飞书 CLI 配置。

## 本机与服务器切换

同一个飞书应用只能保留一个活跃事件消费者。切换到本机 OrbStack：

```bash
ssh siman@dogserver 'cd /home/siman/feishu-expense-bot && docker compose stop'
cd /path/to/feishu-expense-bot
docker compose up -d --build
```

完成本机测试后先停止本机服务，再恢复服务器：

```bash
docker compose stop
ssh siman@dogserver 'cd /home/siman/feishu-expense-bot && docker compose up -d'
```

`docker compose stop` 只停止容器，不删除容器或数据卷。不要同时运行本机和服务器实例，也不要使用 `docker compose down -v`。

## 当前限制

- 只处理机器人私聊。
- 每个附件有独立工作流和确认卡片；同一用户可以连续发送并分别处理多张订单或发票。
- PDF V1 只识别第一页。
- 商品项目在发票卡片中展示，V1 不提供逐行编辑。
- 发票号并发去重依赖写入前的二次查询和单实例事件队列；多实例部署不受支持。
