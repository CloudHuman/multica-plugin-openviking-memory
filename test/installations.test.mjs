import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStartupConfig, parseSigningSecrets } from '../src/config.mjs';
import { scopeKey } from '../src/scopes.mjs';
import {
  startFakeOv, startFakeMultica, fixtureIssue, hookBody, commentEvent, makeSigningSecret, postJson, getJson,
  FIXTURE_WS, FIXTURE_WS2, FIXTURE_ISSUE_ID, FIXTURE_AGENT_A, FIXTURE_INSTALLATION, FIXTURE_INSTALLATION2,
} from './helpers.mjs';
import { bootService, waitFor } from './harness.mjs';

// One service serving several workspace installations. Each installation's
// admin legitimately holds that installation's whsec_ — so a signature proves
// which installation signed, never which workspace the body may name.

const recallBody = ({ ws, installation, agent = FIXTURE_AGENT_A, cb, query = '死信队列 告警 阈值', issueId = FIXTURE_ISSUE_ID }) => hookBody({
  hookKey: 'memory-recall', trigger: 'agent', workspaceId: ws, installationId: installation,
  actor: { type: 'agent', id: agent }, callbackUrl: cb, input: { query, issue_id: issueId },
});

test('an installation\'s secret cannot reach another workspace (the reproduced cross-tenant read)', async () => {
  const ov = await startFakeOv();
  const multica = await startFakeMultica({ issue: fixtureIssue() });
  const secret1 = makeSigningSecret();
  const secret2 = makeSigningSecret();
  const svc = await bootService({
    ov,
    secret: secret1,
    extraSecrets: { [FIXTURE_INSTALLATION2]: { secret: secret2, workspace_id: FIXTURE_WS2 } },
  });
  const cb = multica.baseUrl + '/v1';
  try {
    // workspace 1 archives a comment through its own (primary) installation
    const ok = await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'comment.created', callbackUrl: cb,
      input: commentEvent({ id: 'cm-ws1', content: '客户 X 的报价底线是 ¥3800/月' }) }));
    assert.equal(ok.json.result.status, 'queued', ok.text);
    const rec = await waitFor(() => svc.registry.get(scopeKey('task', FIXTURE_WS, FIXTURE_ISSUE_ID)));
    await waitFor(() => ov.filesOf(rec.apiKey).size, { label: 'ws1 memory distilled' });

    // workspace 2's admin signs with THEIR secret but names workspace 1
    const forged = await svc.signedPost('/hooks/memory-recall',
      recallBody({ ws: FIXTURE_WS, installation: FIXTURE_INSTALLATION2, cb }), { secret: secret2 });
    assert.equal(forged.status, 403, forged.text);
    assert.equal(JSON.stringify(forged.json).includes('3800'), false);

    // … or names installation 1 while holding only secret 2
    const impersonated = await svc.signedPost('/hooks/memory-recall',
      recallBody({ ws: FIXTURE_WS, installation: FIXTURE_INSTALLATION, cb }), { secret: secret2 });
    assert.equal(impersonated.status, 401);

    // the same secret used legitimately for its own workspace works
    const own = await svc.signedPost('/hooks/memory-recall',
      recallBody({ ws: FIXTURE_WS2, installation: FIXTURE_INSTALLATION2, cb }), { secret: secret2 });
    assert.equal(own.status, 200, own.text);
    assert.equal(own.json.status, 'ok');
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});

test('the primary secret binds to its first installation and workspace; later mismatches are refused', async () => {
  const ov = await startFakeOv();
  const multica = await startFakeMultica({ issue: fixtureIssue() });
  const svc = await bootService({ ov });
  const cb = multica.baseUrl + '/v1';
  try {
    const first = await svc.signedPost('/hooks/memory-status', hookBody({ hookKey: 'memory-status', trigger: 'agent', callbackUrl: cb, input: {} }));
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(svc.installations.list().map((b) => [b.installation_id, b.workspace_id, b.via]), [[FIXTURE_INSTALLATION, FIXTURE_WS, 'first-use']]);

    const otherWorkspace = await svc.signedPost('/hooks/memory-status', hookBody({ hookKey: 'memory-status', trigger: 'agent', callbackUrl: cb, input: {}, workspaceId: FIXTURE_WS2 }));
    assert.equal(otherWorkspace.status, 403);
    const otherInstallation = await svc.signedPost('/hooks/memory-status',
      hookBody({ hookKey: 'memory-status', trigger: 'agent', callbackUrl: cb, input: {}, installationId: FIXTURE_INSTALLATION2 }),
      { installation: FIXTURE_INSTALLATION2 });
    assert.equal(otherInstallation.status, 401, 'the primary secret belongs to one installation');
    const movedCallback = await svc.signedPost('/hooks/memory-status', hookBody({ hookKey: 'memory-status', trigger: 'agent', callbackUrl: 'http://attacker.example/v1', input: {} }));
    assert.equal(movedCallback.status, 403, 'callbacks cannot be redirected after binding');
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});

test('with OVMEM_MULTICA_API_URL, a new installation is bound only after multica confirms its workspace', async () => {
  const ov = await startFakeOv();
  // multica says this token's installation lives in workspace 2
  const multica = await startFakeMultica({ issue: fixtureIssue(), workspaceId: FIXTURE_WS2 });
  const secret2 = makeSigningSecret();
  const svc = await bootService({
    ov,
    extraSecrets: { [FIXTURE_INSTALLATION2]: secret2 },
    cfg: { multicaApiUrl: multica.baseUrl + '/v1' },
  });
  try {
    const lie = await svc.signedPost('/hooks/memory-status',
      hookBody({ hookKey: 'memory-status', trigger: 'agent', input: {}, workspaceId: FIXTURE_WS, installationId: FIXTURE_INSTALLATION2, callbackUrl: 'http://ignored/v1' }),
      { secret: secret2, installation: FIXTURE_INSTALLATION2 });
    assert.equal(lie.status, 403, 'a first delivery naming the wrong workspace cannot establish the binding');
    assert.equal(svc.installations.list().length, 0);

    const truth = await svc.signedPost('/hooks/memory-status',
      hookBody({ hookKey: 'memory-status', trigger: 'agent', input: {}, workspaceId: FIXTURE_WS2, installationId: FIXTURE_INSTALLATION2 }),
      { secret: secret2, installation: FIXTURE_INSTALLATION2 });
    assert.equal(truth.status, 200, truth.text);
    assert.equal(svc.installations.list()[0].via, 'context');
    assert.ok(multica.requests.some((r) => r.path === '/v1/context'), 'verified through GET /v1/context');
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});

test('memory-status shows only the calling workspace\'s records', async () => {
  const ov = await startFakeOv();
  const multica = await startFakeMultica({ issue: fixtureIssue() });
  const secret2 = makeSigningSecret();
  const svc = await bootService({ ov, extraSecrets: { [FIXTURE_INSTALLATION2]: { secret: secret2, workspace_id: FIXTURE_WS2 } } });
  const cb = multica.baseUrl + '/v1';
  try {
    await svc.signedPost('/hooks/memory-archive', hookBody({ eventType: 'comment.created', callbackUrl: cb, input: commentEvent({ id: 'cm-ws1-status', content: 'ws1 only' }) }));
    await waitFor(() => svc.statusLog.recent({ workspaceId: FIXTURE_WS }).some((e) => e.type === 'comment' || e.type === 'archive-comment'), { label: 'ws1 archive' });

    const st = await svc.signedPost('/hooks/memory-status',
      hookBody({ hookKey: 'memory-status', trigger: 'agent', input: {}, workspaceId: FIXTURE_WS2, installationId: FIXTURE_INSTALLATION2, callbackUrl: cb }),
      { secret: secret2, installation: FIXTURE_INSTALLATION2 });
    assert.equal(st.status, 200, st.text);
    const text = JSON.stringify(st.json.result);
    assert.equal(text.includes(FIXTURE_WS), false, 'no workspace-1 ids leak into workspace 2\'s status');
    assert.deepEqual(st.json.result.recent_archives, []);
    assert.equal(st.json.result.archive_queue.done, 0);
  } finally {
    await svc.stop();
    await multica.stop();
    await ov.stop();
  }
});

test('startup refuses a multi-installation config it could not bind safely, and malformed secrets', () => {
  const base = { ovBaseUrl: 'http://ov', ovRootKey: 'r', pluginToken: 't', port: 8790, signingSecret: makeSigningSecret() };
  assert.deepEqual(validateStartupConfig({ ...base, signingSecrets: {} }), []);
  const unbound = validateStartupConfig({ ...base, signingSecrets: parseSigningSecrets({ inst: makeSigningSecret() }) });
  assert.ok(unbound.some((p) => /workspace_id/.test(p) && /OVMEM_MULTICA_API_URL/.test(p)), unbound.join('\n'));
  assert.deepEqual(validateStartupConfig({ ...base, multicaApiUrl: 'https://mc/v1', signingSecrets: parseSigningSecrets({ inst: makeSigningSecret() }) }), []);
  const broken = validateStartupConfig({ ...base, signingSecrets: parseSigningSecrets('{not json') });
  assert.ok(broken.some((p) => /not valid JSON/.test(p)));
  const badSecret = validateStartupConfig({ ...base, signingSecret: 'whsec_deadbeef', signingSecrets: {} });
  assert.ok(badSecret.some((p) => /64 hex/.test(p)));
});

test('healthz answers without auth and leaks no queue or tenant data', async () => {
  const ov = await startFakeOv();
  const svc = await bootService({ ov });
  try {
    const h = await getJson(svc.port, '/healthz');
    assert.equal(h.status, 200);
    assert.deepEqual(Object.keys(h.json.result).sort(), ['ov', 'service', 'version']);
    const noAuth = await postJson(svc.port, '/admin/status', {});
    assert.equal(noAuth.status, 401);
  } finally {
    await svc.stop();
    await ov.stop();
  }
});

