FROM node:24-alpine

WORKDIR /app
COPY src ./src
COPY multica.plugin.json skills ./skills-staging/

ENV OVMEM_BIND=0.0.0.0 \
    OVMEM_PORT=8790 \
    OVMEM_STATE_DIR=/app/state

RUN mkdir -p /app/state && chown -R node:node /app
USER node
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-check-certificate -qO- https://127.0.0.1:8790/healthz >/dev/null || exit 1

CMD ["node", "src/server.mjs"]
