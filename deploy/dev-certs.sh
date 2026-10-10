#!/usr/bin/env bash
# Mint an HTTPS server cert for the plugin service, signed by a private CA.
# Multica trusts that CA for the hook origins listed in
# MULTICA_PLUGIN_DEV_ORIGINS when MULTICA_PLUGIN_DEV_CA points at its PEM.
# For local development and for plugin services on a private network.
#
# Usage:
#   ./deploy/dev-certs.sh <ca-dir> <out-dir> [host]
#   ./deploy/dev-certs.sh /path/to/certs ./deploy/certs
#   ./deploy/dev-certs.sh /path/to/certs ./deploy/certs ovmem.internal
# [host] defaults to host.docker.internal. <ca-dir> holds plugin-dev-ca.key +
# plugin-dev-ca.pem; when both are missing a new CA is created there.
set -euo pipefail

CA_DIR="${1:?usage: dev-certs.sh <ca-dir> <out-dir> [host]}"
OUT_DIR="${2:?usage: dev-certs.sh <ca-dir> <out-dir> [host]}"
HOST="${3:-host.docker.internal}"

mkdir -p "$CA_DIR" "$OUT_DIR"
CA_DIR="$(cd "$CA_DIR" && pwd)"

if [[ ! -f "$CA_DIR/plugin-dev-ca.key" && ! -f "$CA_DIR/plugin-dev-ca.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -keyout "$CA_DIR/plugin-dev-ca.key" -out "$CA_DIR/plugin-dev-ca.pem" \
    -subj "/CN=multica plugin dev CA" 2>/dev/null
  chmod 600 "$CA_DIR/plugin-dev-ca.key"
  echo "created CA $CA_DIR/plugin-dev-ca.pem (point MULTICA_PLUGIN_DEV_CA at it)"
elif [[ ! -f "$CA_DIR/plugin-dev-ca.key" || ! -f "$CA_DIR/plugin-dev-ca.pem" ]]; then
  echo "$CA_DIR has only one of plugin-dev-ca.key / plugin-dev-ca.pem" >&2
  exit 1
fi

cd "$OUT_DIR"

if [[ "$HOST" =~ ^[0-9.]+$ ]]; then HOST_SAN="IP:$HOST"; else HOST_SAN="DNS:$HOST"; fi

cat > server.cnf <<EOF
[req]
distinguished_name = dn
req_extensions = ext
prompt = no
[dn]
CN = $HOST
[ext]
subjectAltName = $HOST_SAN,DNS:localhost,IP:127.0.0.1
EOF

openssl req -new -newkey rsa:2048 -sha256 -nodes \
  -keyout hook-server.key -out hook-server.csr \
  -config server.cnf 2>/dev/null

openssl x509 -req -in hook-server.csr -CA "$CA_DIR/plugin-dev-ca.pem" \
  -CAkey "$CA_DIR/plugin-dev-ca.key" -CAcreateserial \
  -out hook-server.pem -days 825 -sha256 \
  -extfile server.cnf -extensions ext 2>/dev/null

rm -f hook-server.csr server.cnf
chmod 600 hook-server.key
echo "wrote $OUT_DIR/hook-server.pem + hook-server.key (SAN: $HOST, localhost, 127.0.0.1)"
