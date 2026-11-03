FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3009

# 业务代码只有两个文件，零 npm 依赖，不用 npm install
COPY package.json worker.js server.mjs ./

RUN mkdir -p /app/data && addgroup -S app && adduser -S app -G app \
    && chown -R app:app /app

USER app

VOLUME /app/data

EXPOSE 3009

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

CMD ["node", "server.mjs"]
