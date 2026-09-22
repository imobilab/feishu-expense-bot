#!/bin/sh
set -eu

: "${FEISHU_APP_ID:?请设置 FEISHU_APP_ID}"
: "${FEISHU_APP_SECRET:?请设置 FEISHU_APP_SECRET}"
: "${FEISHU_FORM_SHARE_TOKEN:?请设置 FEISHU_FORM_SHARE_TOKEN}"
: "${FEISHU_BASE_TOKEN:?请设置 FEISHU_BASE_TOKEN}"

mkdir -p /home/node/.lark-cli /app/runtime

printf '%s' "$FEISHU_APP_SECRET" | lark-cli config init \
  --app-id "$FEISHU_APP_ID" \
  --app-secret-stdin \
  --brand "${FEISHU_BRAND:-feishu}"

exec node src/bot.mjs
