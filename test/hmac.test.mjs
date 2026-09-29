import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSigningSecret, computeSignature, verifyHookDelivery } from '../src/hmac.mjs';
import { makeSigningSecret, signDelivery } from './helpers.mjs';

const SECRET = makeSigningSecret();

test('whsec secret parses to 32-byte key', () => {
  const key = parseSigningSecret(SECRET);
  assert.equal(key.length, 32);
  assert.throws(() => parseSigningSecret('not-a-secret'));
  assert.throws(() => parseSigningSecret('whsec_deadbeef'));
});

test('verify accepts a correctly signed delivery', () => {
  const body = JSON.stringify({ hello: 'world' });
  const { timestamp, signature } = signDelivery({ secret: SECRET, body });
  const v = verifyHookDelivery({ secret: SECRET, timestamp, signature, rawBody: body, installation: 'inst-1' });
  assert.equal(v.ok, true);
  assert.equal(v.installation, 'inst-1');
});

test('verify rejects tampered body / wrong signature / stale timestamp', () => {
  const body = JSON.stringify({ hello: 'world' });
  const { timestamp, signature } = signDelivery({ secret: SECRET, body });
  assert.equal(verifyHookDelivery({ secret: SECRET, timestamp, signature, rawBody: body + 'x' }).ok, false);
  assert.equal(verifyHookDelivery({ secret: SECRET, timestamp, signature: 'v1=' + '0'.repeat(64), rawBody: body }).ok, false);
  const stale = signDelivery({ secret: SECRET, body, timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(verifyHookDelivery({ secret: SECRET, ...stale, rawBody: body }).ok, false);
  assert.equal(verifyHookDelivery({ secret: SECRET, timestamp: '', signature: '', rawBody: body }).ok, false);
});

test('signature matches reference construction (ts + "." + body, HMAC-SHA256 hex)', () => {
  const key = parseSigningSecret(SECRET);
  const body = 'abc';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = computeSignature(key, ts, Buffer.from(body));
  assert.equal(sig.length, 64);
  const v = verifyHookDelivery({ secret: SECRET, timestamp: ts, signature: `v1=${sig}`, rawBody: Buffer.from(body) });
  assert.equal(v.ok, true);
});
