import asyncio
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

import httpx
import requests
from requests.adapters import BaseAdapter
from requests.structures import CaseInsensitiveDict

spec = importlib.util.spec_from_file_location('observer', Path(__file__).resolve().parents[1] / 'deploy/observers/ovmem_httpx.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class FakeAdapter(BaseAdapter):
    """A requests transport that answers locally, as httpx.MockTransport does."""

    def __init__(self, status=200, headers=None, error=None):
        super().__init__()
        self.status, self.headers, self.error = status, headers or {}, error

    def send(self, request, **kwargs):
        if self.error:
            raise self.error
        response = requests.Response()
        response.status_code, response.headers = self.status, CaseInsensitiveDict(self.headers)
        response._content, response.url, response.request = b'private-response', request.url, request
        return response

    def close(self):
        pass


class ProviderObservation(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'provider.jsonl'
        self.original_log = os.environ.get('OVMEM_PROVIDER_DIAGNOSTICS_FILE')
        os.environ['OVMEM_PROVIDER_DIAGNOSTICS_FILE'] = str(self.path)
        self.sync, self.async_send = httpx.Client.send, httpx.AsyncClient.send
        self.requests_send = requests.Session.send
        observer.install()

    def tearDown(self):
        httpx.Client.send, httpx.AsyncClient.send = self.sync, self.async_send
        requests.Session.send = self.requests_send
        if self.original_log is None:
            os.environ.pop('OVMEM_PROVIDER_DIAGNOSTICS_FILE', None)
        else:
            os.environ['OVMEM_PROVIDER_DIAGNOSTICS_FILE'] = self.original_log
        self.directory.cleanup()

    def rows(self):
        return [json.loads(x) for x in self.path.read_text().splitlines()]

    def test_sync_stream_auth_failure_is_observed_without_consuming_or_logging_data(self):
        transport = httpx.MockTransport(lambda request: httpx.Response(401, headers={'cf-ray': 'response-401'}, stream=httpx.ByteStream(b'private-response')))
        with httpx.Client(transport=transport) as client:
            with client.stream('POST', 'https://openrouter.ai/api/v1/chat/completions?token=private-query', headers={'Authorization':'Bearer private-key'}, content=b'private-input') as response:
                self.assertFalse(response.is_stream_consumed)
                self.assertEqual(response.read(), b'private-response')
        rows = self.rows()
        self.assertTrue(rows[0]['authorization_present'])
        self.assertEqual(rows[0]['authorization_scheme'], 'bearer')
        self.assertTrue(rows[0]['authorization_token_present'])
        self.assertEqual(rows[-1]['http_status'], 401)
        self.assertEqual(rows[-1]['response_ids']['cf-ray'], 'response-401')
        for secret in ['private-key', 'private-input', 'private-response', 'private-query']:
            self.assertNotIn(secret, self.path.read_text())

    def test_async_missing_auth_is_observed_and_nonprovider_calls_are_excluded(self):
        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'ok'))) as client:
                await client.get('https://openrouter.ai/api/v1/key')
                await client.get('https://other.example/api')
        asyncio.run(run())
        rows = self.rows()
        self.assertEqual(len(rows), 2)
        self.assertFalse(rows[0]['authorization_present'])
        self.assertEqual(rows[-1]['http_status'], 200)

    def test_blank_bearer_token_is_distinguished_from_a_sent_key(self):
        transport = httpx.MockTransport(lambda request: httpx.Response(401, headers={'cf-ray': 'blank-401'}, content=b'{}'))
        with httpx.Client(transport=transport) as client:
            for value in ['Bearer ', 'Bearer', 'Bearer private-key', 'private-schemeless']:
                client.post('https://openrouter.ai/api/v1/embeddings', headers={'Authorization': value})
        shapes = [(r['authorization_present'], r.get('authorization_scheme'), r.get('authorization_token_present'))
                  for r in self.rows() if r['event'] == 'request']
        self.assertEqual(shapes, [(True, 'bearer', False), (True, 'bearer', False),
                                  (True, 'bearer', True), (True, 'other', True)])
        # A blank token must not cost the request ID that ties the failure to the provider's logs.
        self.assertEqual([r['response_ids'] for r in self.rows() if r['event'] == 'response'],
                         [{'cf-ray': 'blank-401'}] * 4)
        for secret in ['private-key', 'private-schemeless']:
            self.assertNotIn(secret, self.path.read_text())

    def test_requests_rerank_calls_are_observed_like_httpx(self):
        with requests.Session() as session:
            session.mount('https://', FakeAdapter(401, {'cf-ray': 'rerank-401'}))
            response = session.post('https://openrouter.ai/api/v1/rerank?key=private-query',
                                    headers={'Authorization': 'Bearer '}, json={'query': 'private-input'})
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.content, b'private-response')
            session.post('https://other.example/api', headers={'Authorization': 'Bearer private-key'})
        rows = self.rows()
        self.assertEqual([r['event'] for r in rows], ['request', 'response'])
        self.assertEqual(rows[0]['client'], 'requests')
        self.assertEqual(rows[0]['path'], '/api/v1/rerank')
        self.assertEqual((rows[0]['authorization_scheme'], rows[0]['authorization_token_present']), ('bearer', False))
        self.assertEqual(rows[1]['http_status'], 401)
        self.assertEqual(rows[1]['response_ids'], {'cf-ray': 'rerank-401'})
        for secret in ['private-key', 'private-input', 'private-response', 'private-query']:
            self.assertNotIn(secret, self.path.read_text())

    def test_requests_transport_error_is_recorded_and_still_raised(self):
        with requests.Session() as session:
            session.mount('https://', FakeAdapter(error=requests.ConnectionError('private detail')))
            with self.assertRaises(requests.ConnectionError):
                session.post('https://openrouter.ai/api/v1/rerank', headers={'Authorization': 'Bearer private-key'})
        rows = self.rows()
        self.assertEqual(rows[-1]['event'], 'transport-error')
        self.assertEqual(rows[-1]['error_type'], 'ConnectionError')
        self.assertNotIn('private', self.path.read_text())

    def test_recording_failure_does_not_break_the_model_request(self):
        os.environ['OVMEM_PROVIDER_DIAGNOSTICS_FILE'] = '/proc/ovmem-impossible/log.jsonl'
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'ok'))) as client:
            self.assertEqual(client.get('https://openrouter.ai/api/v1/key').text, 'ok')
        with requests.Session() as session:
            session.mount('https://', FakeAdapter(200))
            self.assertEqual(session.post('https://openrouter.ai/api/v1/rerank').status_code, 200)


if __name__ == '__main__':
    unittest.main()
