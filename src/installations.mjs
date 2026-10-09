import { createHash } from 'node:crypto';
import { atomicWriteJson, readJsonIfExists, nowIso, fetchJson } from './util.mjs';
import { verifyHookDelivery } from './hmac.mjs';

/**
 * Installation binding: which multica installation a hook delivery comes from,
 * and which workspace that installation belongs to.
 *
 * multica derives one signing secret per installation, so a valid signature
 * proves which installation's secret signed the body — and nothing about the
 * workspace_id inside it, which whoever holds that secret (the admin who rotated
 * it) can set to anything. A delivery is therefore trusted only when
 *   1. it verifies with THE secret configured for the installation it names, and
 *   2. the workspace it names is the one that installation is bound to.
 *
 * Bindings persist in {stateDir}/installations.json. An installation's first
 * binding comes, in order of preference, from a workspace_id configured with its
 * secret, from GET /v1/context on the multica Plugin API (OVMEM_MULTICA_API_URL),
 * or — only for the single primary secret — from first use.
 */
export class InstallationRegistry {
  constructor({ stateDir, cfg, fetchImpl, log = () => {} }) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.path = `${stateDir}/installations.json`;
    this.data = readJsonIfExists(this.path, { bindings: {}, primaryInstallation: null });
    this.data.bindings ??= {};
    this.pending = new Map();
  }

  save() {
    atomicWriteJson(this.path, this.data, { mode: 0o600 });
  }

  /** The one secret a delivery naming this installation must verify with. */
  secretFor(installationId) {
    const keyed = this.cfg.signingSecrets?.[installationId];
    if (keyed?.secret) return { secret: keyed.secret, source: 'installation', workspaceId: keyed.workspaceId || '' };
    if (this.cfg.signingSecret) return { secret: this.cfg.signingSecret, source: 'primary', workspaceId: '' };
    return null;
  }

  binding(installationId) {
    return this.data.bindings[installationId] ?? null;
  }

  /**
   * Authenticate a hook delivery. Resolves to the trusted delivery context or
   * throws an error carrying httpStatus (401 unsigned/unknown, 403 wrong
   * workspace, 400 malformed).
   */
  async authenticate({ headers, rawBody }) {
    const installationId = String(headers['x-multica-plugin-installation'] ?? '');
    if (!installationId) throw denied(401, 'missing X-Multica-Plugin-Installation');
    const entry = this.secretFor(installationId);
    if (!entry) throw denied(401, 'no signing secret is configured for this installation');
    const v = verifyHookDelivery({
      secret: entry.secret,
      timestamp: headers['x-multica-timestamp'],
      signature: headers['x-multica-signature'],
      rawBody,
      installation: installationId,
    });
    if (!v.ok) throw denied(401, `hook signature verification failed: ${v.reason}`);

    let body;
    try {
      body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } catch {
      throw denied(400, 'body is not valid JSON', 'invalid_request');
    }
    if (body.installation_id && body.installation_id !== installationId) {
      throw denied(401, 'body installation_id does not match the signing installation');
    }
    const workspaceId = String(body.workspace_id ?? '');
    if (!workspaceId) throw denied(400, 'hook body has no workspace_id', 'invalid_request');

    if (entry.source === 'primary' && this.data.primaryInstallation && this.data.primaryInstallation !== installationId) {
      throw denied(401, `the primary signing secret belongs to installation ${this.data.primaryInstallation}`);
    }

    const bound = this.binding(installationId) ?? await this.#bind({ installationId, workspaceId, body, entry });
    if (bound.workspaceId !== workspaceId) {
      throw denied(403, `installation ${installationId} is bound to a different workspace`, 'forbidden');
    }
    let callbackBase = this.cfg.multicaApiUrl || String(body.callback_url ?? '');
    if (!this.cfg.multicaApiUrl && bound.callbackUrl && body.callback_url && body.callback_url !== bound.callbackUrl) {
      // A secret holder could otherwise point the service's callbacks (and what
      // they archive) at a server of their choosing.
      throw denied(403, `callback_url changed from ${bound.callbackUrl}; set OVMEM_MULTICA_API_URL or reset the binding in installations.json`, 'forbidden');
    }
    callbackBase = callbackBase.replace(/\/+$/, '');
    return { installationId, workspaceId, callbackBase, body };
  }

  async #bind({ installationId, workspaceId, body, entry }) {
    if (this.pending.has(installationId)) return this.pending.get(installationId);
    const p = (async () => {
      let via;
      if (entry.workspaceId) {
        if (entry.workspaceId !== workspaceId) {
          throw denied(403, `installation ${installationId} is configured for a different workspace`, 'forbidden');
        }
        via = 'configured';
      } else if (this.cfg.multicaApiUrl) {
        const verified = await this.#workspaceFromContext(body.callback_token);
        if (verified !== workspaceId) {
          throw denied(403, `multica reports installation ${installationId} in a different workspace`, 'forbidden');
        }
        via = 'context';
      } else if (entry.source === 'primary') {
        via = 'first-use';
        this.log(`installation ${installationId} bound to workspace ${workspaceId} on first use; set OVMEM_MULTICA_API_URL to verify bindings`);
      } else {
        throw denied(403, 'cannot verify this installation\'s workspace', 'forbidden');
      }
      const record = {
        workspaceId,
        via,
        secretFingerprint: fingerprint(entry.secret),
        callbackUrl: this.cfg.multicaApiUrl ? undefined : (body.callback_url || undefined),
        boundAt: nowIso(),
      };
      this.data.bindings[installationId] = record;
      if (entry.source === 'primary') this.data.primaryInstallation = installationId;
      this.save();
      this.log(`installation ${installationId} bound to workspace ${workspaceId} (${via})`);
      return record;
    })().finally(() => this.pending.delete(installationId));
    this.pending.set(installationId, p);
    return p;
  }

  async #workspaceFromContext(callbackToken) {
    if (!callbackToken) throw denied(401, 'first delivery carried no callback token to verify the workspace with');
    try {
      const ctx = await fetchJson(`${this.cfg.multicaApiUrl}/context`, {
        headers: { Authorization: `Bearer ${callbackToken}` },
        timeoutMs: this.cfg.callbackTimeoutMs,
        fetchImpl: this.fetchImpl,
      });
      return String(ctx?.workspace?.id ?? '');
    } catch (err) {
      throw denied(503, `could not verify the installation's workspace: ${err.message}`, 'unavailable');
    }
  }

  /** Status view for operators (no secrets, only fingerprints). */
  list() {
    return Object.entries(this.data.bindings).map(([installationId, b]) => ({
      installation_id: installationId, workspace_id: b.workspaceId, via: b.via, bound_at: b.boundAt,
      primary: this.data.primaryInstallation === installationId,
    }));
  }
}

function fingerprint(secret) {
  return createHash('sha256').update(String(secret)).digest('hex').slice(0, 12);
}

function denied(status, message, code = 'invalid_signature') {
  const e = new Error(message);
  e.httpStatus = status;
  e.code = code;
  return e;
}
