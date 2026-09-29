import { fetchJson } from './util.mjs';

/**
 * Minimal stateless MCP client for OpenViking's /mcp endpoint (streamable
 * HTTP, stateless mode). One instance per space key; used by the ov-* facade
 * hooks to forward tool calls verbatim so facade semantics == native MCP
 * semantics for the same key.
 */
export class OvMcpClient {
  constructor({ baseUrl, key, fetchImpl, timeoutMs = 25_000 } = {}) {
    this.url = `${String(baseUrl || '').replace(/\/+$/, '')}/mcp`;
    this.key = key;
    this.fetchImpl = fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.initialized = false;
  }

  async rpc(method, params) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${this.key}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params: params ?? {} }),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const e = new Error(`OV MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
        e.status = res.status;
        throw e;
      }
      return this.#parseFrame(text);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Streamable HTTP returns either plain JSON or an SSE frame stream. */
  #parseFrame(text) {
    let json = null;
    if (text.startsWith('event:') || text.startsWith('data:') || text.includes('\ndata:')) {
      const data = text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      try {
        json = JSON.parse(data);
      } catch { /* fall through */ }
    }
    if (!json) json = JSON.parse(text);
    if (json?.error) {
      const e = new Error(json.error.message ?? 'OV MCP error');
      e.code = json.error.code;
      throw e;
    }
    return json?.result ?? {};
  }

  async initializeOnce() {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'multica-openviking-facade', version: '1' },
    });
    // notifications take no reply in stateless mode
    this.initialized = true;
  }

  async listTools() {
    await this.initializeOnce();
    const result = await this.rpc('tools/list', {});
    return result?.tools ?? [];
  }

  /** Call a tool; returns the first text content (or stringified result). */
  async callTool(name, args) {
    await this.initializeOnce();
    const result = await this.rpc('tools/call', { name, arguments: args ?? {} });
    if (result?.isError) {
      const text = (result?.content ?? []).map((c) => c.text ?? '').join('\n');
      throw new Error(text || `OV tool ${name} failed`);
    }
    const texts = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
    if (texts.length === 1) return texts[0];
    if (texts.length > 1) return texts.join('\n');
    if (result?.structuredContent) return JSON.stringify(result.structuredContent);
    return '';
  }
}
