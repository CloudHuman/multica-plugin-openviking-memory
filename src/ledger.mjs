import { appendFileSync, existsSync, readFileSync, mkdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteJson, readJsonIfExists } from './util.mjs';

function atomicWriteText(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Delivery ledger: remembers which multica deliveries were already accepted,
 * so retries (same invocation) and schedule redeliveries never double-archive.
 */
export class Ledger {
  constructor({ stateDir, maxKeys = 20_000 } = {}) {
    this.path = `${stateDir}/ledger.json`;
    this.maxKeys = maxKeys;
    const data = readJsonIfExists(this.path, { keys: {} });
    // Older versions wrote the bare map; retain those delivery IDs on upgrade.
    this.keys = data.keys ?? data;
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.keys, key);
  }

  add(key) {
    const keys = { ...this.keys, [key]: new Date().toISOString() };
    const entries = Object.entries(keys);
    if (entries.length > this.maxKeys) {
      entries.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
      for (const [k] of entries.slice(0, entries.length - this.maxKeys)) delete keys[k];
    }
    atomicWriteJson(this.path, { keys });
    this.keys = keys;
  }
}

/**
 * Append-only archive status log feeding memory-status and /admin/status.
 * Every record carries its workspace, so a tool call only ever sees its own
 * workspace's records. The file is rotated (last `keep` lines retained) once it
 * outgrows maxBytes.
 */
export class ArchiveStatusLog {
  constructor({ stateDir, keep = 2000, maxBytes = 4 * 1024 * 1024 } = {}) {
    this.path = `${stateDir}/archives.jsonl`;
    this.keep = keep;
    this.maxBytes = maxBytes;
    this.entries = [];
    this.#load();
  }

  #load() {
    if (!existsSync(this.path)) return;
    try {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      this.entries = lines.slice(-this.keep).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      if (statSync(this.path).size > this.maxBytes) this.#rewrite();
    } catch { /* status log is best-effort */ }
  }

  #rewrite() {
    atomicWriteText(this.path, this.entries.map((e) => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : ''));
  }

  append(entry) {
    const record = { ts: new Date().toISOString(), ...entry };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    } catch { /* status log is best-effort */ }
    this.entries.push(record);
    if (this.entries.length > this.keep * 1.5) {
      this.entries = this.entries.slice(-this.keep);
      try { this.#rewrite(); } catch { /* best-effort */ }
    }
    return record;
  }

  recent({ limit = 20, workspaceId } = {}) {
    const pool = workspaceId ? this.entries.filter((e) => e.workspace === workspaceId) : this.entries;
    return pool.slice(-limit).reverse();
  }
}
