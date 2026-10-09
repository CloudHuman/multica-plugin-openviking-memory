// Multica's daemon keeps only an 8 KB preview of each tool result in the task
// transcript (`output_truncated: true`); the agent itself receives the whole
// output. A memory-recall result with several long entries outgrows that
// preview, so the checks recover what they read (status, the run binding, the
// entries and searched scopes that arrived whole) instead of losing the call.

export function toolResultData(message) {
  const output = message?.output;
  if (typeof output !== 'string') return output ?? null;
  try { return JSON.parse(output); } catch { /* not JSON, or a cut-off preview */ }
  return message.output_truncated ? recoverTruncatedResult(output) : null;
}

/** The parts of a cut-off `{"status":…,"result":{…}}` that arrived complete. */
export function recoverTruncatedResult(preview) {
  const status = preview.match(/^\{"status":"([^"]+)"/)?.[1];
  if (!status) return null;
  const run = objectAfter(preview, '"run":');
  const query = preview.match(/"query":"((?:[^"\\]|\\.)*)"/)?.[1];
  return {
    status,
    truncated: true,
    result: {
      ...(run ? { run } : {}),
      ...(query !== undefined ? { query: JSON.parse(`"${query}"`) } : {}),
      entries: completeItems(preview, '"entries":['),
      scopesSearched: completeItems(preview, '"scopesSearched":['),
      truncated: true,
    },
  };
}

// End index (exclusive) of the JSON object or array opening at `start`, or -1 when cut off.
function scanValue(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function objectAfter(text, key) {
  const at = text.indexOf(key);
  if (at < 0 || text[at + key.length] !== '{') return null;
  const end = scanValue(text, at + key.length);
  return end < 0 ? null : JSON.parse(text.slice(at + key.length, end));
}

// The array items that arrived whole; the one cut off and any after it are dropped.
function completeItems(text, key) {
  const at = text.indexOf(key);
  if (at < 0) return [];
  const items = [];
  let i = at + key.length;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] !== '{') break;
    const end = scanValue(text, i);
    if (end < 0) break;
    items.push(JSON.parse(text.slice(i, end)));
    i = end;
  }
  return items;
}
