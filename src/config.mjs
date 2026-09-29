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
  // Additional per-installation signing secrets (one per workspace
  // installation): OVMEM_SIGNING_SECRETS='{"<installation_id>":"whsec_…"}'
  signingSecrets: {},
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
  // Extraction watch
  extractWatchTimeoutMs: 120_000,
  extractWatchIntervalMs: 5_000,
  reextractAttempts: 3,
  reextractBaseDelayMs: 20_000,
  // Queue
  queueMaxAttempts: 8,
  queueBaseDelayMs: 10_000,
  // Network
  callbackTimeoutMs: 15_000,
  ovTimeoutMs: 30_000,
};

const ENV_MAP = {
  port: ['OVMEM_PORT', (v) => Number(v)],
  bind: ['OVMEM_BIND'],
  stateDir: ['OVMEM_STATE_DIR'],
  ovBaseUrl: ['OVMEM_OV_BASE_URL'],
  ovRootKey: ['OVMEM_OV_ROOT_KEY'],
  signingSecret: ['OVMEM_SIGNING_SECRET'],
  signingSecrets: ['OVMEM_SIGNING_SECRETS', (v) => JSON.parse(v)],
  pluginToken: ['OVMEM_PLUGIN_TOKEN'],
  tlsCert: ['OVMEM_TLS_CERT'],
  tlsKey: ['OVMEM_TLS_KEY'],
  recallEntries: ['OVMEM_RECALL_ENTRIES', (v) => Number(v)],
};

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
  return cfg;
}

/** Merge manifest config fields (per hook call) onto service config. */
export function mergeCallConfig(cfg, callConfig = {}) {
  const merged = { ...cfg };
  if (callConfig == null) return merged;
  if (Number.isFinite(Number(callConfig.recall_entries))) {
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

export function validateStartupConfig(cfg) {
  const problems = [];
  if (!cfg.ovBaseUrl) problems.push('OVMEM_OV_BASE_URL is required (OpenViking base URL, e.g. https://ov.example.com)');
  if (!cfg.ovRootKey) problems.push('OVMEM_OV_ROOT_KEY is required (OpenViking root key, used only to provision accounts/users)');
  if (!cfg.signingSecret) problems.push('OVMEM_SIGNING_SECRET is required (whsec_… from the multica plugin token rotation)');
  if (!cfg.pluginToken) problems.push('OVMEM_PLUGIN_TOKEN is required (bearer token for /internal and /admin endpoints)');
  return problems;
}
