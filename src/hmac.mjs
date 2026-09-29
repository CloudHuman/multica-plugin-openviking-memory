import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Multica plugin hook signature verification.
 *
 * Multica signs every hook delivery:
 *   sig = hex( HMAC-SHA256( installKey, `${timestamp}.${rawBody}` ) )
 * where installKey is the per-installation key derived by the multica server and
 * handed to the plugin operator once as `whsec_` + hex(installKey) (POST
 * .../token rotation response). The timestamp travels in X-Multica-Timestamp,
 * the signature in `X-Multica-Signature: v1=<hex>`.
 */

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export function parseSigningSecret(secret) {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) {
    throw new Error('signing secret must start with whsec_');
  }
  const hex = secret.slice('whsec_'.length);
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(`signing secret must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

export function computeSignature(key, timestamp, rawBody) {
  const mac = createHmac('sha256', key);
  mac.update(String(timestamp));
  mac.update('.');
  mac.update(rawBody);
  return mac.digest('hex');
}

/**
 * Verify a multica hook delivery.
 * @returns {{ok: true, installation: string}} or {{ok: false, reason: string}}
 */
export function verifyHookDelivery({ secret, timestamp, signature, rawBody, installation, nowMs = Date.now(), skew = TIMESTAMP_TOLERANCE_SECONDS }) {
  let key;
  try {
    key = typeof secret === 'string' ? parseSigningSecret(secret) : secret;
  } catch (err) {
    return { ok: false, reason: `bad secret: ${err.message}` };
  }
  if (!timestamp || !signature) {
    return { ok: false, reason: 'missing X-Multica-Timestamp / X-Multica-Signature' };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid timestamp' };
  if (Math.abs(nowMs / 1000 - ts) > skew) {
    return { ok: false, reason: `timestamp outside ±${skew}s window` };
  }
  const expected = computeSignature(key, timestamp, rawBody);
  const given = String(signature).startsWith('v1=') ? String(signature).slice(3) : String(signature);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(given, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true, installation: installation ?? '' };
}
