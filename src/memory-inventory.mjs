// Enumerate only this key's own user namespace, including peer-owned memories.
// Missing optional roots are normal; other errors and bounds are reported so a
// partial audit cannot be mistaken for a clean audit.
export async function listMemoryFiles({ ov, key, userId, includePeers = true, kinds, maxDepth = 10, maxFiles = 3000 }) {
  const root = `viking://user/${userId}`;
  const files = [];
  const errors = [];
  const visited = new Set();
  const isDir = e => e.isDir || e.is_dir || e.type === 'directory';
  const missing = err => err.status === 404 || /not.?found/i.test(String(err.code ?? ''));
  const walk = async (uri, depth = 0, optional = false) => {
    if (visited.has(uri)) return;
    visited.add(uri);
    if (depth > maxDepth || files.length >= maxFiles) { errors.push({ uri, reason: 'inventory-limit' }); return; }
    let entries;
    try { entries = await ov.listDir(key, uri); }
    catch (err) {
      if (!optional || !missing(err)) errors.push({ uri, reason: String(err.message ?? err) });
      return;
    }
    for (const entry of entries) {
      const child = entry.uri ?? `${uri.replace(/\/$/, '')}/${entry.name}`;
      if (!child.startsWith(`${uri.replace(/\/$/, '')}/`) || /%2e|%2f|%5c|\\|\/(?:\.|\.\.)(?:\/|$)/i.test(child)) {
        errors.push({ uri: child, reason: 'outside-inventory-directory' }); continue;
      }
      if (isDir(entry)) await walk(child, depth + 1);
      else if (child.endsWith('.md') && !/\/\.(?:overview|abstract)\.md$/.test(child) && !/\/memories\/(?:identity|soul)\.md$/.test(child)) {
        if (files.length >= maxFiles) { errors.push({ uri: child, reason: 'inventory-limit' }); return; }
        files.push({ ...entry, uri: child });
      }
    }
  };
  const roots = kinds ? kinds.map(kind => `${root}/memories/${kind}`) : [`${root}/memories`];
  for (const uri of roots) await walk(uri, 0, true);
  if (includePeers) {
    let peers;
    try { peers = await ov.listDir(key, `${root}/peers`); }
    catch (err) { if (!missing(err)) errors.push({ uri: `${root}/peers`, reason: String(err.message ?? err) }); peers = []; }
    for (const peer of peers) {
      const uri = peer.uri ?? `${root}/peers/${peer.name}`;
      if (!isDir(peer) || !uri.startsWith(`${root}/peers/`) || uri.slice(`${root}/peers/`.length).includes('/') || /%|\\|^\.{1,2}$/.test(uri.slice(`${root}/peers/`.length))) continue;
      const peerRoots = kinds ? kinds.map(kind => `${uri}/memories/${kind}`) : [`${uri}/memories`];
      roots.push(...peerRoots);
      for (const peerRoot of peerRoots) await walk(peerRoot, 0, true);
    }
  }
  return { files, roots, errors, complete: errors.length === 0 };
}
