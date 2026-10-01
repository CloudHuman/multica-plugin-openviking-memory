import { randomUUID } from 'node:crypto';
import { requestDiagnostic } from './diagnostics.mjs';

export function observedFetch(fetchImpl, record, hosts = ['openrouter.ai']) {
  return async function(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!hosts.includes(url.hostname)) return fetchImpl(input, init);
    const id = randomUUID();
    const method = init?.method ?? input.method ?? 'GET';
    const headers = init?.headers ?? input.headers ?? {};
    const started = Date.now();
    const base = { id, runtime: 'opencode', ts: new Date().toISOString() };
    const emit = data => { try { record({ ...base, ...data }); } catch { /* observability cannot fail a request */ } };
    emit({ event: 'request', ...requestDiagnostic(url, { method, headers, phase: 'headers' }) });
    try {
      const response = await fetchImpl(input, init);
      emit({ event: 'response', ...requestDiagnostic(url, { method, headers, response, phase: 'response' }), duration_ms: Date.now() - started,
        redirected: response.redirected, response_host: response.url ? new URL(response.url).hostname : url.hostname });
      return response;
    } catch (err) {
      emit({ event: 'transport-error', host: url.hostname, error_type: err?.name ?? 'Error', duration_ms: Date.now() - started });
      throw err;
    }
  };
}
