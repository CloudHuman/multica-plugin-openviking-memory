import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchJson, withRetry } from '../src/util.mjs';
import { failureDiagnostic } from '../src/diagnostics.mjs';

test('HTTP timeout still aborts a body stalled after response headers', { timeout: 3000 }, async (t) => {
  let closed = false;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': 'slow-body-1' });
    res.write('{"status":');
    res.on('close', () => { closed = true; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await assert.rejects(fetchJson(`http://127.0.0.1:${server.address().port}/slow`, { timeoutMs: 600 }), err => {
    assert.equal(err.code, 'ETIMEDOUT');
    assert.equal(err.diagnostic.phase, 'body');
    assert.equal(err.diagnostic.http_status, 200);
    assert.equal(err.diagnostic.response_ids['x-request-id'], 'slow-body-1');
    return true;
  });
  // Aborting must release the socket, not just stop awaiting the result.
  for (let i = 0; i < 20 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, true);
});

test('HTTP auth diagnostics retain safe IDs and omit credentials, URL queries and userinfo', async () => {
  const err = await fetchJson('https://user:password@ov.example/api/v1/search/search?token=secret-query', {
    method: 'POST', headers: { authorization: 'Bearer test-credential' }, body: { query: 'private-business-fact' },
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'refused test-credential and Bearer test-credential' } }), {
      status: 401, headers: { 'x-request-id': 'request-123', 'cf-ray': 'a439-test', 'request-id': 'Bearer echoed-secret', 'x-openrouter-request-id': 'test-credential' },
    }),
  }).catch(error => error);
  assert.equal(err.status, 401);
  assert.equal(err.diagnostic.authorization_present, true);
  assert.deepEqual(err.diagnostic.response_ids, { 'x-request-id': 'request-123', 'cf-ray': 'a439-test' });
  const visible = JSON.stringify({ message: err.message, diagnostic: failureDiagnostic(err) });
  for (const secret of ['user:', 'password', 'secret-query', 'test-credential', 'echoed-secret', 'private-business-fact']) assert.ok(!visible.includes(secret));
});

test('OpenRouter 401 texts map to what actually reached the provider', () => {
  const reason = message => failureDiagnostic(new Error(`Error code: 401 - {'error': {'message': '${message}', 'code': 401}}`)).provider_auth_reason;
  assert.equal(reason('Missing Authentication header'), 'no_bearer_token');
  assert.equal(reason('No cookie auth credentials found'), 'missing_authorization');
  assert.equal(reason('User not found.'), 'unknown_api_key');
  assert.equal(reason('something else'), undefined);
  // Only a 401 is classified; the same words in another failure are not auth evidence.
  assert.equal(failureDiagnostic(Object.assign(new Error('User not found'), { status: 404 })).provider_auth_reason, undefined);
});

test('local auth rejection and a nested model auth failure retain different status evidence', async () => {
  for (const [status, message] of [[401, 'unauthorized'], [500, "OpenAI API error: Error code: 401 - Missing Authentication header"]]) {
    let calls = 0;
    const error = await withRetry(() => fetchJson('https://ov.example/api/v1/search/search', {
      fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: { message } }), { status }); },
    }), { attempts: 2, baseDelayMs: 0 }).catch(err => err);
    const diagnostic = failureDiagnostic(error);
    assert.equal(diagnostic.http_status, status);
    assert.equal(diagnostic.provider_status, status === 500 ? 401 : undefined);
    assert.equal(diagnostic.category, 'authentication');
    assert.equal(calls, status === 401 ? 1 : 2, 'direct 401 keeps the existing non-retry policy');
  }
});
