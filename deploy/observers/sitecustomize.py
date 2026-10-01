"""Opt-in HTTPX observation; no credential, body, proxy or trust changes."""
import os

if os.environ.get('OVMEM_PROVIDER_DIAGNOSTICS') == '1':
    from ovmem_httpx import install
    install()
