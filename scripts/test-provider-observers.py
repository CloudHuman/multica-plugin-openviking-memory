import asyncio
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

import httpx

spec = importlib.util.spec_from_file_location('observer', Path(__file__).resolve().parents[1] / 'deploy/observers/ovmem_httpx.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ProviderObservation(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'provider.jsonl'
        self.original_log = os.environ.get('OVMEM_PROVIDER_DIAGNOSTICS_FILE')
        os.environ['OVMEM_PROVIDER_DIAGNOSTICS_FILE'] = str(self.path)
        self.sync, self.async_send = httpx.Client.send, httpx.AsyncClient.send
        observer.install()

    def tearDown(self):
        httpx.Client.send, httpx.AsyncClient.send = self.sync, self.async_send
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

    def test_recording_failure_does_not_break_the_model_request(self):
        os.environ['OVMEM_PROVIDER_DIAGNOSTICS_FILE'] = '/proc/ovmem-impossible/log.jsonl'
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'ok'))) as client:
            self.assertEqual(client.get('https://openrouter.ai/api/v1/key').text, 'ok')


if __name__ == '__main__':
    unittest.main()
