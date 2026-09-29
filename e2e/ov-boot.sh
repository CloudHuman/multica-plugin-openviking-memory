#!/usr/bin/env bash
# Boot a disposable OpenViking instance for end-to-end verification.
# Embedded storage (no external pg/minio), real LLM/embedding providers via env.
# Keys are injected through environment variables only — never written to disk.
set -euo pipefail

NAME="${OV_E2E_CONTAINER:-ovmem-e2e-ov}"
PORT="${OV_E2E_PORT:-1936}"
IMAGE="${OV_E2E_IMAGE:-openviking-cn-beijing.cr.volces.com/volcengine/openviking:v0.4.22}"

: "${OV_ROOT_KEY:?OV_ROOT_KEY must be set (random hex)}"
: "${OV_VLM_KEY:?OV_VLM_KEY must be set}"
: "${OV_EMBED_KEY:?OV_EMBED_KEY must be set}"

if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "container $NAME already running"
  exit 0
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true

export OPENVIKING_CONF_CONTENT='{
  "storage": {
    "workspace": "/app/.openviking/data",
    "vectordb": {"backend": "local"},
    "agfs": {"backend": "local"}
  },
  "embedding": {
    "dense": {
      "provider": "dashscope",
      "api_key": "${OV_EMBED_KEY}",
      "api_base": "https://dashscope.aliyuncs.com",
      "model": "text-embedding-v4",
      "dimension": 1024,
      "input": "text"
    }
  },
  "vlm": {
    "provider": "glm",
    "api_key": "${OV_VLM_KEY}",
    "api_base": "https://open.bigmodel.cn/api/coding/paas/v4",
    "model": "glm-4.6"
  },
  "server": {
    "host": "0.0.0.0",
    "port": 1933,
    "root_api_key": "${OV_ROOT_KEY}"
  }
}'

docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:1933" \
  -e OPENVIKING_CONF_CONTENT \
  -e OV_ROOT_KEY -e OV_VLM_KEY -e OV_EMBED_KEY \
  -v "${NAME}-data:/app/.openviking" \
  "$IMAGE" >/dev/null

echo "started $NAME on 127.0.0.1:${PORT} (image $IMAGE)"
