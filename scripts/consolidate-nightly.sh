#!/usr/bin/env bash
# Nightly shared-memory promotion: distil reusable knowledge from agent/task
# spaces into the workspace shared space. Run by launchd (local.openviking.
# memory-consolidate) — see deploy/consolidate.plist.
set -euo pipefail
PLUGIN_TOKEN_FILE="${1:-/Users/cloud/.ovmem-service/plugin-token}"
STATE_LOG="$(dirname "$0")/../state/consolidate.log"
WORKSPACE_ID="${OVMEM_WS:-71546543-17e1-4373-95bf-5246cc99df3b}"
mkdir -p "$(dirname "$STATE_LOG")"
echo "[$(date -Iseconds)] consolidate start" >> "$STATE_LOG"
curl -sk -X POST https://127.0.0.1:8790/admin/consolidate \
  -H "Authorization: Bearer $(cat "$PLUGIN_TOKEN_FILE")" \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_id\":\"$WORKSPACE_ID\"}" >> "$STATE_LOG" 2>&1
echo >> "$STATE_LOG"
