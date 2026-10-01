/** Diagnostics contain request metadata, never request bodies or credentials. */
export function redactError(message, secrets = []) {
  let text = String(message ?? '');
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]');
  return text
    .replace(/\bBearer\s+[^\s'"<>\]},)]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-or-v1-|whsec_|mpc_|mpi_)[a-zA-Z0-9_-]+/g, '[REDACTED]');
}

export function requestDiagnostic(url, { method, headers, response, phase }) {
  const target = new URL(url);
  const requestHeaders = new Headers(headers);
  const secrets = authorizationSecrets(headers);
  const ids = {};
  for (const name of ['x-request-id', 'request-id', 'x-openrouter-request-id', 'cf-ray']) {
    const value = response?.headers?.get(name);
    if (value && /^[a-zA-Z0-9._:/-]{1,128}$/.test(value) && !secrets.some(secret => value.includes(secret))) ids[name] = value;
  }
  return {
    source: 'http', method, host: target.hostname, path: target.pathname,
    authorization_present: Boolean(requestHeaders.get('Authorization')),
    phase, ...(response ? { http_status: response.status } : {}),
    ...(Object.keys(ids).length ? { response_ids: ids } : {}),
  };
}

export function authorizationSecrets(headers) {
  const authorization = new Headers(headers).get('Authorization');
  return authorization ? [authorization, authorization.replace(/^\S+\s+/, '')].filter(Boolean) : [];
}

/** A nested provider status is evidence from an error, not the local HTTP status. */
export function failureDiagnostic(error, { source = 'unknown' } = {}) {
  const message = String(error?.message ?? error ?? '');
  const httpStatus = Number(error?.status) || undefined;
  const providerStatus = Number(message.match(/Error code:\s*(\d{3})\b/i)?.[1]) || undefined;
  const status = providerStatus ?? httpStatus;
  const category = [401, 403].includes(status) ? 'authentication'
    : status === 429 ? 'rate_limit'
    : error?.code === 'ETIMEDOUT' || /timed?\s*out|time.?out|aborted/i.test(message) ? 'timeout'
    : error?.code === 'NETWORK' ? 'network'
    : status >= 500 ? 'server'
    : 'unknown';
  return {
    source, ...error?.diagnostic, category,
    ...(httpStatus ? { http_status: httpStatus } : {}),
    ...(providerStatus ? { provider_status: providerStatus } : {}),
  };
}
