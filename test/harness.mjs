import { createServer } from 'node:http';
import { loadConfig, parseSigningSecrets } from '../src/config.mjs';
import { OvClient } from '../src/ov-client.mjs';
import { ScopeRegistry } from '../src/scopes.mjs';
import { JobQueue } from '../src/queue.mjs';
import { makeArchiveHandler } from '../src/pipeline.mjs';
import { ExtractionWatcher } from '../src/extraction-watch.mjs';
import { Ledger, ArchiveStatusLog } from '../src/ledger.mjs';
import { InstallationRegistry } from '../src/installations.mjs';
import { createApp, buildRequestListener } from '../src/server.mjs';
import { makeSigningSecret, signDelivery, postJson, tempStateDir, FIXTURE_INSTALLATION } from './helpers.mjs';
import { sleep } from '../src/util.mjs';

/** Poll until fn returns a truthy value (or throw after timeoutMs). */
export async function waitFor(fn, { timeoutMs = 4000, intervalMs = 15, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch { /* keep polling */ }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * The whole service over the fakes, wired as main() wires it. `secret` is the
 * primary signing secret; `extraSecrets` maps installation → secret (or
 * {secret, workspace_id}).
 */
export async function bootService({ ov, stateDir = tempStateDir(), cfg: overrides = {}, secret = makeSigningSecret(), extraSecrets = {}, fetchImpl } = {}) {
  const cfg = {
    ...loadConfig({}, { stateDir }),
    stateDir,
    ovBaseUrl: ov.baseUrl,
    ovRootKey: 'root',
    signingSecret: secret,
    signingSecrets: parseSigningSecrets(extraSecrets),
    pluginToken: 'test-admin-token',
    callbackTimeoutMs: 2000,
    archiveFetchBudgetMs: 5000,
    extractPollIntervalMs: 20,
    extractPollMaxIntervalMs: 40,
    extractRedriveDelayMs: 0,
    extractMaxWatchMs: 10_000,
    includeThinking: false,
    dropToolPrefixes: ['multica issue list'],
    ...overrides,
  };
  const log = () => {};
  const ovClient = new OvClient({ baseUrl: ov.baseUrl, timeoutMs: 3000 });
  const registry = new ScopeRegistry({ ov: ovClient, rootKey: 'root', stateDir, log });
  const installations = new InstallationRegistry({ stateDir, cfg, fetchImpl, log });
  const ledger = new Ledger({ stateDir });
  const statusLog = new ArchiveStatusLog({ stateDir });
  let extractions = null;
  const queue = new JobQueue({
    stateDir,
    handler: makeArchiveHandler({ ov: ovClient, registry, statusLog, extractions: { watch: (e) => extractions.watch(e) }, cfg, log }),
    maxAttempts: 3, baseDelayMs: 5, pollMs: 10, log,
    isPinned: (id) => extractions?.isPinned(id) ?? false,
  });
  extractions = new ExtractionWatcher({ ov: ovClient, registry, queue, statusLog, stateDir, cfg, log });
  queue.start();
  extractions.start();
  const app = createApp({ cfg, ov: ovClient, registry, queue, ledger, statusLog, installations, extractions, fetchImpl });
  const server = createServer(await buildRequestListener({ cfg, app }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  /** A delivery exactly as multica signs it. */
  const signedPost = (path, body, { secret: s = secret, installation = body?.installation_id ?? FIXTURE_INSTALLATION, raw } = {}) => {
    const payload = raw ?? JSON.stringify(body);
    const { timestamp, signature } = signDelivery({ secret: s, body: payload });
    return postJson(port, path, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Multica-Timestamp': timestamp,
        'X-Multica-Signature': signature,
        'X-Multica-Plugin-Installation': installation,
      },
    });
  };
  const admin = (path, body) => postJson(port, path, body ?? {}, { headers: { Authorization: 'Bearer test-admin-token' } });

  return {
    app, server, port, queue, cfg, registry, statusLog, extractions, installations, ledger, ovClient, stateDir, secret,
    signedPost, admin,
    async stop() {
      extractions.stop();
      await queue.stop({ drainMs: 500 }).catch(() => {});
      await new Promise((r) => server.close(r));
    },
  };
}
