"""Host-only setup security tests; never contacts Telegram, Cloudflare or a router."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

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
        setup.store_secrets(secret, '123', '00000000-0000-4000-8000-000000000001', runner)
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0][1]['input'], secret + '\n')
        self.assertNotIn(secret, ' '.join(str(x) for x in calls[0][0]))
        self.assertNotIn(secret, str(calls[0][1]['env']))
