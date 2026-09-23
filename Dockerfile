ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG LARK_CLI_VERSION=1.0.96

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@larksuite/cli@${LARK_CLI_VERSION}" \
    && npm cache clean --force

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod 755 ./docker-entrypoint.sh \
    && mkdir -p /app/runtime /home/node/.lark-cli \
    && chown -R node:node /app/runtime /home/node/.lark-cli

USER node

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    OCR_LANG=chi_sim+eng

VOLUME ["/app/runtime", "/home/node/.lark-cli"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD kill -0 1 || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
