#!/usr/bin/env bash
# Mint an HTTPS server cert for host.docker.internal signed by the multica
# plugin dev CA (MULTICA_PLUGIN_DEV_CA). For local/dev deployments where the
# multica backend requires HTTPS but uses a self-signed dev CA.
#
# Usage:
#   ./deploy/dev-certs.sh <ca-dir> <out-dir>
#   ./deploy/dev-certs.sh /path/to/certs ./deploy/certs
# <ca-dir> must contain plugin-dev-ca.key + plugin-dev-ca.pem.
set -euo pipefail

CA_DIR="${1:?usage: dev-certs.sh <ca-dir> <out-dir>}"
OUT_DIR="${2:?usage: dev-certs.sh <ca-dir> <out-dir>}"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

cat > server.cnf <<'EOF'
[req]
distinguished_name = dn
req_extensions = ext
prompt = no
[dn]
CN = host.docker.internal
[ext]
subjectAltName = DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout hook-server.key -out hook-server.csr \
  -config server.cnf 2>/dev/null

openssl x509 -req -in hook-server.csr -CA "$CA_DIR/plugin-dev-ca.pem" \
  -CAkey "$CA_DIR/plugin-dev-ca.key" -CAcreateserial \
  -out hook-server.pem -days 825 -sha256 \
  -extfile server.cnf -extensions ext 2>/dev/null

rm -f hook-server.csr server.cnf
chmod 600 hook-server.key
echo "wrote $OUT_DIR/hook-server.pem + hook-server.key (SAN: host.docker.internal, localhost, 127.0.0.1)"
