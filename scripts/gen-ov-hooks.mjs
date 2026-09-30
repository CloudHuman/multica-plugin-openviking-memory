#!/usr/bin/env node
/**
 * Generate the ov-* facade hooks for multica.plugin.json from the LIVE
 * OpenViking instance's tools/list, so tool names, descriptions and input
 * schemas always match the deployed OV exactly.
 *
 *   node scripts/gen-ov-hooks.mjs <ov-base-url> <space-key> [--out multica.plugin.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { OvMcpClient } from '../src/ov-mcp.mjs';

const [baseUrl, key, , out = 'multica.plugin.json'] = process.argv.slice(2);
if (!baseUrl || !key) {
  console.error('usage: gen-ov-hooks.mjs <ov-base-url> <space-key> [--out manifest]');
  process.exit(2);
}

const SKIP = new Set(); // expose the full native surface; own-space confinement is enforced by the facade
const PREFIX = '[OpenViking 原生工具·仅限你自己的记忆空间:URI 须位于 viking://~/ 下,默认即此处;viking://resources 等共享命名空间不可用] ';

function capBytes(text, max) {
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch, 'utf8') > max) break;
    out += ch;
  }
  return out;
}
const SHORT_TIMEOUT = new Set(['health']);

const client = new OvMcpClient({ baseUrl, key });
const tools = await client.listTools();

const manifest = JSON.parse(readFileSync(out, 'utf8'));
const hooks = (manifest.contributes.hooks ?? []).filter((h) => !h.key.startsWith('ov-'));
for (const tool of tools) {
  if (SKIP.has(tool.name)) continue;
  // hook keys must be [a-z0-9-]; OV tool names are snake_case — map _ → -
  const hookKey = `ov-${tool.name.replace(/_/g, '-')}`;
  hooks.push({
    key: hookKey,
    name: `OV ${tool.name}`,
    // multica caps descriptions at 2000 BYTES; cut on a character boundary.
    description: capBytes(`${PREFIX}${String(tool.description ?? tool.name)}`, 2000),
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
    triggers: ['agent'],
    transport: { type: 'http', url: `https://host.docker.internal:8790/hooks/${hookKey}` },
    timeout_ms: SHORT_TIMEOUT.has(tool.name) ? 15000 : 30000,
  });
}
manifest.contributes.hooks = hooks;
manifest.version = manifest.version; // version bumps are deliberate, not automatic
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${hooks.filter((h) => h.key.startsWith('ov-')).length} ov-* facade hooks to ${out}`);
