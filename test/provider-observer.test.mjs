import { test } from 'node:test';
import assert from 'node:assert/strict';
import Observer from '../deploy/observers/opencode.mjs';
import { observedFetch } from '../src/provider-observer.mjs';

test('provider observer preserves request, stream and error identity while logging only metadata', async () => {
  const records = [];
  const init = { method: 'POST', headers: { Authorization: 'Bearer credential' }, body: 'private-business-input' };
  const response = new Response('data: private-answer\n', { status: 401, headers: { 'cf-ray': 'request-401' } });
  const wrapped = observedFetch(async (url, options) => { assert.equal(options, init); return response; }, r => records.push(r));
  assert.equal(await wrapped('https://openrouter.ai/api/v1/chat/completions?secret=query', init), response);
  assert.equal(await response.text(), 'data: private-answer\n');
  assert.equal(records[0].authorization_present, true);
  assert.equal(records[1].http_status, 401);
  for (const secret of ['credential', 'private-business-input', 'private-answer', 'secret=query']) assert.ok(!JSON.stringify(records).includes(secret));
  const original = new Error('private provider payload');
  await assert.rejects(observedFetch(async () => { throw original; }, r => records.push(r))('https://openrouter.ai/api/v1/chat/completions'), error => error === original);
  assert.ok(!JSON.stringify(records).includes('private provider payload'));
});

test('observer logging failures do not affect model response and other hosts are untouched', async () => {
  const response = new Response('ok');
  const wrapped = observedFetch(async () => response, () => { throw new Error('disk unavailable'); });
  assert.equal(await wrapped('https://openrouter.ai/api/v1/chat/completions'), response);
  let records = 0;
  await observedFetch(async () => response, () => records++)('https://other.example/api');
  assert.equal(records, 0);
});

test('OpenCode observer installs through config without changing API key or custom transport', async () => {
  const before = process.env.OVMEM_PROVIDER_DIAGNOSTICS;
  try {
    process.env.OVMEM_PROVIDER_DIAGNOSTICS = '1';
    const transport = async () => new Response('ok');
    const config = { provider: { openrouter: { options: { apiKey: 'existing-key', fetch: transport } } } };
    await (await Observer()).config(config);
    assert.equal(config.provider.openrouter.options.apiKey, 'existing-key');
    assert.equal(await (await config.provider.openrouter.options.fetch('https://openrouter.ai/api')).text(), 'ok');
  } finally { if (before === undefined) delete process.env.OVMEM_PROVIDER_DIAGNOSTICS; else process.env.OVMEM_PROVIDER_DIAGNOSTICS = before; }
});
