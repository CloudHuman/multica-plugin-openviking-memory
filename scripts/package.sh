#!/usr/bin/env bash
# Build the distributable multica plugin package (zip).
# The zip carries what multica ingests: manifest + skill resources (+ surfaces).
# The backend service ships as the repo itself (Docker / node).
#
# Options:
#   --url https://hooks.example.com   override hook transport URLs
#   --host hooks.example.com          net: scope host to grant (must match --url host)
#   --version 1.2.3                   override version in the packaged manifest
#   --with-chats-read                 also request chats:read, so direct-chat runs
#                                     can be archived; only for multica builds with
#                                     the task read API (stock multica rejects it)
set -euo pipefail
cd "$(dirname "$0")/.."

URL=""; HOST=""; VERSION=""; CHATS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --with-chats-read) CHATS=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$URL" ]]; then
  echo "warning: no --url given; hooks point at https://host.docker.internal:8790," >&2
  echo "         which multica only reaches with MULTICA_PLUGIN_DEV_ORIGINS set (local development)." >&2
fi

STAGE="$(mktemp -d)/pkg"
mkdir -p "$STAGE"
cp multica.plugin.json "$STAGE/"
cp -R skills "$STAGE/"

if [[ -n "$VERSION" || -n "$URL" || -n "$HOST" || -n "$CHATS" ]]; then
  node - "$STAGE/multica.plugin.json" "$VERSION" "$URL" "$HOST" "$CHATS" <<'EOF'
const [path, version, url, host, chats] = process.argv.slice(2);
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(path, 'utf8'));
if (version) m.version = version;
let hostname = host;
if (url) {
  hostname = hostname || new URL(url).hostname;
  for (const h of m.contributes.hooks ?? []) {
    h.transport.url = `${url.replace(/\/+$/, '')}/hooks/${h.key}`;
  }
}
if (hostname) {
  m.scopes = [...new Set([...m.scopes.filter((s) => !s.startsWith('net:')), `net:${hostname}`])];
}
if (chats) m.scopes = [...new Set([...m.scopes, 'chats:read'])];
fs.writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
EOF
fi

node scripts/validate-manifest.mjs "$STAGE/multica.plugin.json"

VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STAGE/multica.plugin.json','utf8')).version)")
mkdir -p dist
OUT="dist/openviking-memory-${VER}${CHATS:+-chats}.zip"
rm -f "$OUT"
(
  cd "$STAGE"
  # manifest must sit at the archive root
  zip -qr "$OLDPWD/$OUT" multica.plugin.json skills
)
echo "packaged: $OUT ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT"
