import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { observedFetch } from '../../src/provider-observer.mjs';


function write(record) {
  const path = process.env.OVMEM_PROVIDER_DIAGNOSTICS_FILE;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  try { if (statSync(path).size > 4 * 1024 * 1024) renameSync(path, path + '.1'); } catch { /* first record */ }
  appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 });
}

/** OpenCode 1.x's config hook supplies the provider's existing fetch channel. */
export default async function ProviderObserver() {
  if (process.env.OVMEM_PROVIDER_DIAGNOSTICS !== '1') return {};
  return { config: async config => {
    config.provider ??= {};
    const provider = config.provider.openrouter ??= {};
    provider.options ??= {};
    provider.options.fetch = observedFetch(provider.options.fetch ?? globalThis.fetch, write);
  } };
}
