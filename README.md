# 飞书报销 OCR 机器人

在飞书中私聊机器人发送订单截图或发票，机器人调用 macOS Vision OCR 识别以下字段：

- 商品名称
- 价格
- 消费日期
- 支付方式

机器人先回复可编辑的 Card 2.0 表单。用户可以直接修改商品名称、价格、消费日期和支付方式，再点击“确认入账”；点击“取消本次录入”则不会写入表格。

## 运行条件

- macOS 13 或更新版本，并安装 Xcode Command Line Tools
- Node.js 20+
- 已安装并登录 `lark-cli`
- 飞书应用已启用机器人能力
- 应用已订阅 `im.message.receive_v1`
- 飞书开发者后台“事件与回调 → 回调配置”已启用，以接收 `card.action.trigger`
- 应用具有接收私聊消息、发送消息、读取消息资源、Base 表单写入和云文档素材上传权限
- 机器人对目标多维表格有编辑权限

当前项目已经验证 `im.message.receive_v1` 长连接可以建立。

## 启动

```bash
cd feishu-expense-bot
npm run check
npm start
```

默认写入：

- 表单分享 Token：`shrcnTHfdZFYP2lB11p07xvR1Cc`
- Base Token：`IruKbsT0VaMwZwsR2qecroHtnue`

可以用环境变量覆盖：

```bash
FEISHU_FORM_SHARE_TOKEN=shr_xxx FEISHU_BASE_TOKEN=base_xxx npm start
```

运行状态存放在 `runtime/state.json`，下载的原图存放在 `runtime/uploads/`。

## 当前边界

- 只处理机器人私聊，不处理群聊。
- 一位用户同时维护一笔待确认记录；连续发送图片会合并到这一笔。
- 包含“发票、税号、购买方、销售方、价税合计”的图片归到“发票文件”，其他图片归到“订单截图”。
- OCR 结果必须在交互卡片中人工确认后才写入表格。
- 第一版使用规则提取金额、日期和商品名。票据版式差异较大时，可以直接在交互卡片中校正；后续可换成视觉模型提取。

## 使用 Docker Compose 部署

Docker 版本使用 Tesseract 的中文与英文模型做 OCR，不依赖 macOS，也不需要开放 HTTP 端口。容器通过 WebSocket 主动连接飞书。

服务器要求：

- Linux x86_64 或 arm64
- Docker Engine 24+
- Docker Compose v2
- 能访问飞书开放平台和 npm

部署步骤：

```bash
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，填写飞书开发者后台中的 App ID 和 App Secret。App Secret 只保存在服务器本地的 `.env` 中，不要提交到 Git。

然后构建并启动：

```bash
docker compose up -d --build
docker compose logs -f expense-bot
```

日志中同时出现以下两行表示连接成功：

```text
[event] ready event_key=im.message.receive_v1
[event] ready event_key=card.action.trigger
```

常用维护命令：

```bash
docker compose ps
docker compose logs --tail=200 expense-bot
docker compose restart expense-bot
docker compose down
```

`bot-data` 卷保存待确认记录和下载的原图，`lark-cli-config` 卷保存 CLI 应用配置。`docker compose down` 不会删除这两个卷；只有显式执行 `docker compose down -v` 才会删除。

正式切换到服务器时，应先停止 Mac 上的机器人，再启动服务器容器，避免同一个应用同时建立两组消费者：

```bash
# Mac 项目目录中
docker compose down  # 仅当 Mac 也使用 Docker 运行

# 服务器项目目录中
docker compose up -d --build
```
