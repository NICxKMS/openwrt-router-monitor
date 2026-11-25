"""Host-only setup security tests; never contacts Telegram, Cloudflare or a router."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[2] / 'scripts/configure-telegram.py'
spec = importlib.util.spec_from_file_location('telegram_setup', PATH)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

class HostSetup(unittest.TestCase):
    def test_detects_only_private_chats(self):
        updates = [{'message': {'chat': {'id': 123, 'type': 'private'}}},
                   {'message': {'chat': {'id': -10, 'type': 'group'}}}, {'edited_message': {}}, {}]
        self.assertEqual(setup.private_chats(updates), ['123'])

    def test_secret_values_are_stdin_only(self):
        calls = []
        def runner(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(returncode=0)
        secret = '123456:fixture-not-a-real-telegram-token'
        owner = '00000000-0000-4000-8000-000000000001'
        with patch.dict('os.environ', {'WRANGLER_WRITE_LOGS': 'true', 'WRANGLER_LOG_SANITIZE': 'false'}):
            setup.store_secrets(secret, '123', owner, runner)
        self.assertEqual(len(calls), 1)
        command, options = calls[0]
        self.assertEqual(command[-2:], ['secret', 'bulk'])
        self.assertEqual(json.loads(options['input']), {
            'TELEGRAM_BOT_TOKEN': secret, 'TELEGRAM_CHAT_ID': '123', 'TELEGRAM_OWNER_ID': owner,
        })
        self.assertNotIn(secret, ' '.join(str(x) for x in command))
        self.assertNotIn(secret, str(options['env']))
        self.assertEqual(options['env']['WRANGLER_WRITE_LOGS'], 'false')
        self.assertEqual(options['env']['WRANGLER_LOG_SANITIZE'], 'true')
