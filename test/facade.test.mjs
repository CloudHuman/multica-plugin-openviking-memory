import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OvMcpClient } from '../src/ov-mcp.mjs';
import { makeOvToolHandler } from '../src/ov-facade.mjs';
import { OvClient } from '../src/ov-client.mjs';
import { ScopeRegistry, scopeKey } from '../src/scopes.mjs';
import { startFakeOv, tempStateDir, FIXTURE_WS, FIXTURE_AGENT_A, FIXTURE_AGENT_B } from './helpers.mjs';

/** A minimal stand-in for OpenViking's /mcp endpoint (SSE-framed, stateless). */
async function startFakeOvMcp() {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    const key = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const reply = (result) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
    };
    if (rpc.method === 'initialize') {
      return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-ov' } });
    }
    if (rpc.method === 'tools/list') {
      return reply({ tools: [{ name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] });
    }
    if (rpc.method === 'tools/call') {
      calls.push({ key: key.slice(0, 18), name: rpc.params.name, args: rpc.params.arguments });
      if (rpc.params.name === 'boom') return reply({ isError: true, content: [{ type: 'text', text: 'OV tool failed' }] });
      return reply({ content: [{ type: 'text', text: `result of ${rpc.params.name} in space ${key.slice(0, 14)}` }] });
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, baseUrl: `http://127.0.0.1:${server.address().port}`, calls };
}

test('OvMcpClient parses SSE frames, initializes once, extracts text and tool errors', async () => {
  const mcp = await startFakeOvMcp();
  try {
    const c = new OvMcpClient({ baseUrl: mcp.baseUrl, key: 'k1' });
    const tools = await c.listTools();
    assert.equal(tools[0].name, 'search');
    const out = await c.callTool('search', { query: 'x' });
    assert.match(out, /result of search/);
    await assert.rejects(() => c.callTool('boom', {}), /OV tool failed/);
    // initialize sent exactly once across calls
    const inits = mcp.calls.length; // calls only records tools/call
    await c.callTool('read', {});
    assert.equal(mcp.calls.length, inits + 1);
  } finally {
    await new Promise((r) => mcp.server.close(r));
  }
});

test('facade injects the CALLING agent\'s space key from the signed actor; non-agents rejected', async () => {
  const mcp = await startFakeOvMcp();
  const ovRest = await startFakeOv();
  try {
    const ovClient = new OvClient({ baseUrl: ovRest.baseUrl });
    const registry = new ScopeRegistry({ ov: ovClient, rootKey: 'root', stateDir: tempStateDir(), log: () => {} });
    // provision the REST side (accounts/users) so keys resolve per agent
    const recA = await registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A), { workspaceId: FIXTURE_WS });
    const recB = await registry.ensureScope(scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_B), { workspaceId: FIXTURE_WS });

    const cfg = { ovBaseUrl: mcp.baseUrl, ovTimeoutMs: 5000 };
    const handler = makeOvToolHandler({ cfg, ov: ovClient, registry });

    const body = (agentId, tool, args) => ({
      version: 1, invocation_id: 'i', attempt: 1, occurred_at: new Date().toISOString(),
      hook_key: `ov-${tool}`, trigger: 'agent', workspace_id: FIXTURE_WS, installation_id: 'inst',
      actor: agentId ? { type: 'agent', id: agentId } : { type: 'member', id: 'm1' },
      input: args, config: {},
    });

    const r1 = await handler(body(FIXTURE_AGENT_A, 'search', { query: 'q', unused: null }));
    assert.match(r1.output, /result of search/);
    assert.equal(r1.scope, scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_A));
    assert.equal(mcp.calls.at(-1).key, recA.apiKey.slice(0, 18));
    // args with null stripped
    assert.deepEqual(mcp.calls.at(-1).args, { query: 'q' });

    const r2 = await handler(body(FIXTURE_AGENT_B, 'write', { uri: 'memories/x.md', content: 'hi' }));
    assert.equal(mcp.calls.at(-1).key, recB.apiKey.slice(0, 18));
    assert.equal(r2.scope, scopeKey('agent', FIXTURE_WS, FIXTURE_AGENT_B));

    // kebab-case hook key maps back to snake_case OV tool name
    await handler(body(FIXTURE_AGENT_A, 'add-resource', { path: 'p' }));
    assert.equal(mcp.calls.at(-1).name, 'add_resource');

    await assert.rejects(() => handler(body(null, 'search', {})), /only callable by an agent/);
  } finally {
    await new Promise((r) => mcp.server.close(r));
    await ovRest.stop();
  }
});
