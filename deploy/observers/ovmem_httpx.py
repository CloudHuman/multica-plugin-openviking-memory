"""Observe the actual OpenViking SDK HTTP boundary, including streamed calls."""
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

_lock = threading.Lock()


def write(record):
    try:
        path = os.environ.get('OVMEM_PROVIDER_DIAGNOSTICS_FILE')
        if not path:
            return
        target = Path(path)
        with _lock:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and target.stat().st_size > 4 * 1024 * 1024:
                target.replace(str(target) + '.1')
            fd = os.open(target, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, 'a') as stream:
                stream.write(json.dumps(record) + '\n')
    except Exception:
        pass  # Observability must not affect model calls.


def authorization_shape(value):
    """Scheme and token presence of an Authorization header, never its value.

    `Bearer` with an empty token is still a present header; OpenRouter answers
    it with "Missing Authentication header", so presence alone is not enough.
    """
    parts = (value or '').split()
    if not parts:
        return dict(authorization_present=False)
    scheme = parts[0].lower() if parts[0].lower() in ('bearer', 'basic') else None
    return dict(authorization_present=True, authorization_scheme=scheme or 'other',
                authorization_token_present=len(parts) > 1 if scheme else True)


def metadata(request, response=None):
    auth = request.headers.get('authorization', '')
    result = dict(host=request.url.host, path=request.url.path, method=request.method,
                  **authorization_shape(auth))
    if response is not None:
        ids = {}
        secrets = [auth, auth.split(' ', 1)[-1]] if auth else []
        for name in ['x-request-id', 'request-id', 'x-openrouter-request-id', 'cf-ray']:
            value = response.headers.get(name, '')
            if re.fullmatch(r'[a-zA-Z0-9._:/-]{1,128}', value) and not any(s in value for s in secrets):
                ids[name] = value
        result.update(http_status=response.status_code, response_ids=ids,
                      redirects=[dict(host=r.request.url.host, path=r.request.url.path,
                                      http_status=r.status_code,
                                      **authorization_shape(r.request.headers.get('authorization')))
                                 for r in response.history])
    return result


def install():
    import httpx
    if getattr(httpx.Client.send, '_ovmem_observer', False):
        return
    sync_send, async_send = httpx.Client.send, httpx.AsyncClient.send

    def start(request):
        if request.url.host != 'openrouter.ai':
            return None
        base = dict(id=str(uuid.uuid4()), runtime='openviking', ts=time.time())
        write(dict(base, event='request', **metadata(request)))
        return base, time.monotonic()

    def finish(observation, request, response=None, error=None):
        if observation is None:
            return
        base, started = observation
        write(dict(base, event='transport-error' if error else 'response',
                   duration_ms=round((time.monotonic()-started)*1000),
                   **({'error_type':type(error).__name__} if error else metadata(request, response))))

    def send(self, request, *args, **kwargs):
        observation = start(request)
        try:
            response = sync_send(self, request, *args, **kwargs)
        except Exception as error:
            finish(observation, request, error=error)
            raise
        finish(observation, request, response)
        return response

    async def asend(self, request, *args, **kwargs):
        observation = start(request)
        try:
            response = await async_send(self, request, *args, **kwargs)
        except Exception as error:
            finish(observation, request, error=error)
            raise
        finish(observation, request, response)
        return response

    send._ovmem_observer = True
    httpx.Client.send, httpx.AsyncClient.send = send, asend
