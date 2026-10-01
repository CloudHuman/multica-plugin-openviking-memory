"""Observe the actual OpenViking SDK HTTP boundary, including streamed calls.

Covers HTTPX, sync and async (OV's OpenAI-compatible embedding and VLM
clients), and requests (OV's rerank client).
"""
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

_lock = threading.Lock()
_RESPONSE_IDS = ['x-request-id', 'request-id', 'x-openrouter-request-id', 'cf-ray']


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


def _httpx_target(request):
    return request.url.host, request.url.path, request.method, request.headers.get('authorization', '')


def _requests_target(request):
    url = urlsplit(request.url or '')
    return url.hostname, url.path, request.method, request.headers.get('authorization', '') or ''


def metadata(request, response=None, target=_httpx_target):
    host, path, method, auth = target(request)
    result = dict(host=host, path=path, method=method, **authorization_shape(auth))
    if response is not None:
        ids = {}
        # An empty token is '' and '' is in every string: keep only real secrets, or a
        # blank-token request (the failure being diagnosed) would lose its request IDs.
        secrets = [s for s in (auth, auth.split(' ', 1)[-1]) if s.strip()] if auth else []
        for name in _RESPONSE_IDS:
            value = response.headers.get(name, '') or ''
            if re.fullmatch(r'[a-zA-Z0-9._:/-]{1,128}', value) and not any(s in value for s in secrets):
                ids[name] = value
        redirects = []
        for hop in response.history:
            hop_host, hop_path, _, hop_auth = target(hop.request)
            redirects.append(dict(host=hop_host, path=hop_path, http_status=hop.status_code,
                                  **authorization_shape(hop_auth)))
        result.update(http_status=response.status_code, response_ids=ids, redirects=redirects)
    return result


def _start(request, target, client):
    try:
        if target(request)[0] != 'openrouter.ai':
            return None
        base = dict(id=str(uuid.uuid4()), runtime='openviking', client=client, ts=time.time())
        write(dict(base, event='request', **metadata(request, target=target)))
        return base, time.monotonic()
    except Exception:
        return None  # Observability must not affect model calls.


def _finish(observation, request, target, response=None, error=None):
    if observation is None:
        return
    try:
        base, started = observation
        write(dict(base, event='transport-error' if error else 'response',
                   duration_ms=round((time.monotonic() - started) * 1000),
                   **({'error_type': type(error).__name__} if error else metadata(request, response, target))))
    except Exception:
        pass


def install():
    _install_httpx()
    _install_requests()


def _install_httpx():
    import httpx
    if getattr(httpx.Client.send, '_ovmem_observer', False):
        return
    sync_send, async_send = httpx.Client.send, httpx.AsyncClient.send

    def send(self, request, *args, **kwargs):
        observation = _start(request, _httpx_target, 'httpx')
        try:
            response = sync_send(self, request, *args, **kwargs)
        except Exception as error:
            _finish(observation, request, _httpx_target, error=error)
            raise
        _finish(observation, request, _httpx_target, response)
        return response

    async def asend(self, request, *args, **kwargs):
        observation = _start(request, _httpx_target, 'httpx')
        try:
            response = await async_send(self, request, *args, **kwargs)
        except Exception as error:
            _finish(observation, request, _httpx_target, error=error)
            raise
        _finish(observation, request, _httpx_target, response)
        return response

    send._ovmem_observer = True
    httpx.Client.send, httpx.AsyncClient.send = send, asend


def _install_requests():
    """OV's rerank client posts with requests, which HTTPX never sees."""
    try:
        import requests
    except ImportError:
        return
    if getattr(requests.Session.send, '_ovmem_observer', False):
        return
    original = requests.Session.send

    def send(self, request, **kwargs):
        observation = _start(request, _requests_target, 'requests')
        try:
            response = original(self, request, **kwargs)
        except Exception as error:
            _finish(observation, request, _requests_target, error=error)
            raise
        _finish(observation, request, _requests_target, response)
        return response

    send._ovmem_observer = True
    requests.Session.send = send
