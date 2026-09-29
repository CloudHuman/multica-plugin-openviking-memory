import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteJson, readJsonIfExists } from './util.mjs';

/**
 * Delivery ledger: remembers which multica deliveries were already accepted,
 * so retries (same invocation) and schedule redeliveries never double-archive.
 */
export class Ledger {
  constructor({ stateDir, maxKeys = 20_000 } = {}) {
    this.path = `${stateDir}/ledger.json`;
    this.maxKeys = maxKeys;
    const data = readJsonIfExists(this.path, { keys: {} });
    this.keys = data.keys ?? {};
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.keys, key);
  }

  add(key) {
    this.keys[key] = new Date().toISOString();
    const entries = Object.entries(this.keys);
    if (entries.length > this.maxKeys) {
      entries.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
      for (const [k] of entries.slice(0, entries.length - this.maxKeys)) delete this.keys[k];
    }
    atomicWriteJson(this.path, this.keys);
  }
}

/** Append-only archive status log feeding the memory-status tool and /admin/status. */
export class ArchiveStatusLog {
  constructor({ stateDir, keep = 200 } = {}) {
    this.path = `${stateDir}/archives.jsonl`;
    this.keep = keep;
    this.entries = [];
  }

  append(entry) {
    const record = { ts: new Date().toISOString(), ...entry };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    } catch { /* status log is best-effort */ }
    this.entries.push(record);
    if (this.entries.length > this.keep) this.entries = this.entries.slice(-this.keep);
    return record;
  }

  recent({ limit = 20 } = {}) {
    if (this.entries.length) return this.entries.slice(-limit).reverse();
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  }
}
