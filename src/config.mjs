import { readJsonIfExists } from './util.mjs';

/**
 * Configuration sources, lowest to highest precedence:
 *   built-in defaults < environment < per-installation manifest config (per hook call)
 * The manifest config arrives in each hook body (`config` field, non-secret values only);
 * the service merges it per request. OV credentials never travel through manifest
 * config (multica never delivers secret-typed values to hooks), so they live here.
 */
export const DEFAULTS = {
  port: 8790,
  bind: '0.0.0.0',
  stateDir: './state',
  // OpenViking
  ovBaseUrl: '',
  ovRootKey: '',
  // Multica hook signature secret (whsec_…, from the plugin token rotation response)
  signingSecret: '',
  // Additional per-installation signing secrets (one per workspace installation):
  //   OVMEM_SIGNING_SECRETS='{"<installation_id>":"whsec_…"}'
  //   OVMEM_SIGNING_SECRETS='{"<installation_id>":{"secret":"whsec_…","workspace_id":"<uuid>"}}'
  // Normalized to { [installationId]: { secret, workspaceId } }.
  signingSecrets: {},
  // The multica Plugin API base (…/v1). When set, callbacks go here instead of the
  // callback_url a hook body names, and an installation's workspace is verified
  // through GET /v1/context before the installation is first trusted.
  multicaApiUrl: '',
  // Bearer token guarding /internal/* and /admin/* endpoints
  pluginToken: '',
  tlsCert: '',
  tlsKey: '',
  // Recall tuning
  recallEntries: 5,
  recallPerScopeLimit: 10,
  recallContentMaxChars: 2400,
  // Archive tuning
  includeThinking: false,
  textPartMaxChars: 4000,
  toolOutputMaxChars: 8000,
  dropToolPrefixes: [],
  // Everything memory-archive fetches while the callback token is alive must fit in
  // this budget: multica abandons (and retries) a hook that outlives its timeout_ms.
  archiveFetchBudgetMs: 12_000,
  transcriptMaxMessages: 2_000,
  // Extraction watch (runs beside the queue, never inside a job)
  extractPollIntervalMs: 5_000,
  extractPollMaxIntervalMs: 60_000,
  extractMaxWatchMs: 6 * 60 * 60_000,
  extractMaxRedrives: 2,
  extractRedriveDelayMs: 60_000,
  // Queue
  queueMaxAttempts: 8,
  queueBaseDelayMs: 10_000,
  // Network
  callbackTimeoutMs: 5_000,
  ovTimeoutMs: 30_000,
  // Agent tools must answer inside their manifest timeout_ms (memory-recall 20s,
  // ov-* 30s), or multica drops the call and the agent only sees "hook endpoint
  // did not answer". OV searches and index waits call the model provider, which
  // can be slower than that, so these hooks stop waiting at a budget instead.
  recallBudgetMs: 15_000,
  facadeBudgetMs: 25_000,
  // Status log
  statusLogMaxBytes: 4 * 1024 * 1024,
};

const toNumber = (v) => Number(v);

const ENV_MAP = {
  port: ['OVMEM_PORT', toNumber],
  bind: ['OVMEM_BIND'],
  stateDir: ['OVMEM_STATE_DIR'],
  ovBaseUrl: ['OVMEM_OV_BASE_URL'],
  ovRootKey: ['OVMEM_OV_ROOT_KEY'],
  signingSecret: ['OVMEM_SIGNING_SECRET'],
  signingSecrets: ['OVMEM_SIGNING_SECRETS', parseSigningSecrets],
  multicaApiUrl: ['OVMEM_MULTICA_API_URL', (v) => v.replace(/\/+$/, '')],
  pluginToken: ['OVMEM_PLUGIN_TOKEN'],
  tlsCert: ['OVMEM_TLS_CERT'],
  tlsKey: ['OVMEM_TLS_KEY'],
  recallEntries: ['OVMEM_RECALL_ENTRIES', toNumber],
};

/**
 * Accepts both shapes of OVMEM_SIGNING_SECRETS. A malformed value does not throw
 * here: it is reported by validateStartupConfig with a readable message instead
 * of crashing the process with a JSON parse stack.
 */
export function parseSigningSecrets(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return { __invalid: `OVMEM_SIGNING_SECRETS is not valid JSON (${err.message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { __invalid: 'OVMEM_SIGNING_SECRETS must be a JSON object keyed by installation id' };
  }
  const out = {};
  for (const [installationId, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[installationId] = { secret: value, workspaceId: '' };
    else if (value && typeof value === 'object') {
      out[installationId] = { secret: String(value.secret ?? ''), workspaceId: String(value.workspace_id ?? value.workspaceId ?? '') };
    } else {
      return { __invalid: `OVMEM_SIGNING_SECRETS["${installationId}"] must be a whsec_ string or {"secret","workspace_id"}` };
    }
  }
  return out;
}

export function loadConfig(env = process.env, { stateDir } = {}) {
  const cfg = { ...DEFAULTS };
  for (const [key, [envName, parse]] of Object.entries(ENV_MAP)) {
    const raw = env[envName];
    if (raw !== undefined && raw !== '') {
      cfg[key] = parse ? parse(raw) : raw;
    }
  }
  // Persistent overrides written by the admin (state/config.json), e.g. after tuning.
  if (stateDir || cfg.stateDir) {
    const persisted = readJsonIfExists(`${stateDir ?? cfg.stateDir}/config.json`, {});
    Object.assign(cfg, persisted);
  }
  if (cfg.signingSecrets && !cfg.signingSecrets.__invalid) cfg.signingSecrets = parseSigningSecrets(cfg.signingSecrets);
  return cfg;
}

/**
 * Merge manifest config fields (per hook call) onto service config. The result is
 * also snapshotted into archive payloads, so a job archives with the settings its
 * installation had when the event arrived, not whatever the service defaults are
 * when the queue gets to it.
 */
export function mergeCallConfig(cfg, callConfig = {}) {
  const merged = { ...cfg };
  if (callConfig == null) return merged;
  if (callConfig.recall_entries !== undefined && Number.isFinite(Number(callConfig.recall_entries))) {
    merged.recallEntries = Math.min(10, Math.max(1, Number(callConfig.recall_entries)));
  }
  if (typeof callConfig.include_thinking === 'boolean') merged.includeThinking = callConfig.include_thinking;
  if (typeof callConfig.drop_tool_prefixes === 'string') {
    merged.dropToolPrefixes = callConfig.drop_tool_prefixes
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return merged;
}

/** The archive-relevant slice of a merged config, small enough to store per job. */
export function archiveSettings(merged) {
  return {
    includeThinking: Boolean(merged.includeThinking),
    dropToolPrefixes: [...(merged.dropToolPrefixes ?? [])],
    textPartMaxChars: merged.textPartMaxChars,
    toolOutputMaxChars: merged.toolOutputMaxChars,
  };
}

const WHSEC_RE = /^whsec_[0-9a-f]{64}$/i;

export function validateStartupConfig(cfg) {
  const problems = [];
  if (!cfg.ovBaseUrl) problems.push('OVMEM_OV_BASE_URL is required (OpenViking base URL, e.g. https://ov.example.com)');
  if (!cfg.ovRootKey) problems.push('OVMEM_OV_ROOT_KEY is required (OpenViking root key, used only to provision accounts/users)');
  if (!cfg.pluginToken) problems.push('OVMEM_PLUGIN_TOKEN is required (bearer token for /internal and /admin endpoints)');
  const extras = cfg.signingSecrets ?? {};
  if (extras.__invalid) {
    problems.push(extras.__invalid);
  } else {
    if (!cfg.signingSecret && !Object.keys(extras).length) {
      problems.push('OVMEM_SIGNING_SECRET (or OVMEM_SIGNING_SECRETS) is required (whsec_… from the multica plugin token rotation)');
    }
    if (cfg.signingSecret && !WHSEC_RE.test(cfg.signingSecret)) {
      problems.push('OVMEM_SIGNING_SECRET must be whsec_ followed by 64 hex characters');
    }
    for (const [installationId, entry] of Object.entries(extras)) {
      if (!WHSEC_RE.test(entry.secret)) problems.push(`OVMEM_SIGNING_SECRETS["${installationId}"] is not a whsec_ secret`);
    }
    // Serving several installations from one service is only safe when each
    // installation's workspace is known before it is trusted: without that, whoever
    // holds any one installation's secret can name another workspace in a body they
    // sign. Either declare the workspace per secret, or let the service verify it.
    const unbound = Object.entries(extras).filter(([, entry]) => !entry.workspaceId).map(([id]) => id);
    if (unbound.length && !cfg.multicaApiUrl) {
      problems.push(
        `OVMEM_SIGNING_SECRETS entries ${unbound.join(', ')} have no workspace_id; with several installations set ` +
        'OVMEM_MULTICA_API_URL (workspaces are then verified via GET /v1/context) or use {"secret":"whsec_…","workspace_id":"…"}',
      );
    }
  }
  if (cfg.multicaApiUrl && !/^https?:\/\//.test(cfg.multicaApiUrl)) {
    problems.push('OVMEM_MULTICA_API_URL must be an http(s) URL such as https://multica.example.com/v1');
  }
  if (!Number.isFinite(cfg.port) || cfg.port <= 0) problems.push('OVMEM_PORT must be a port number');
  return problems;
}
