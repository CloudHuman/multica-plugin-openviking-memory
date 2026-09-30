FROM node:24-alpine

WORKDIR /app
# package.json carries the version the service reports on /healthz.
COPY package.json ./
COPY src ./src

ENV OVMEM_BIND=0.0.0.0 \
    OVMEM_PORT=8790 \
    OVMEM_STATE_DIR=/app/state

RUN mkdir -p /app/state && chown -R node:node /app
USER node
EXPOSE 8790

# Probe over whichever protocol the service is configured for (TLS is optional).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "const t=!!process.env.OVMEM_TLS_CERT;const m=require(t?'https':'http');m.get((t?'https':'http')+'://127.0.0.1:'+(process.env.OVMEM_PORT||8790)+'/healthz',{rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Stop gracefully: the service drains its queue and releases the state lease.
STOPSIGNAL SIGTERM
CMD ["node", "src/server.mjs"]
