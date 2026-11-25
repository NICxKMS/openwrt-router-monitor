#!/usr/bin/env python3
"""Host-only private Telegram setup. Tokens travel to Wrangler through stdin, never argv/files."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None

def telegram(token, method, values=None):
    body = json.dumps(values or {}).encode()
    request = urllib.request.Request('https://api.telegram.org/bot' + token + '/' + method,
                                    data=body, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
            result = json.loads(response.read(65536))
    except Exception:
        raise RuntimeError('Telegram could not be reached or rejected the request. Check the bot token and internet access.') from None
    if not result.get('ok'):
        raise RuntimeError('Telegram rejected this bot request. Verify the bot token and send /start to the bot.')
    return result.get('result')

def private_chats(updates):
    return sorted({str(update['message']['chat']['id']) for update in updates
                   if isinstance(update, dict) and isinstance(update.get('message'), dict)
                   and update['message'].get('chat', {}).get('type') == 'private'})

def store_secrets(token, chat_id, owner_id, runner=subprocess.run):
    cli = ROOT / 'apps/worker/node_modules/wrangler/bin/wrangler.js'
    node = shutil.which('node')
    if not node or not cli.is_file():
        raise RuntimeError('Install the project dependencies and sign into Cloudflare first.')
    environment = dict(os.environ, WRANGLER_SEND_METRICS='false',
                       WRANGLER_WRITE_LOGS='false', WRANGLER_LOG_SANITIZE='true')
    secrets = {'TELEGRAM_BOT_TOKEN': token, 'TELEGRAM_CHAT_ID': chat_id, 'TELEGRAM_OWNER_ID': owner_id}
    print('Saving the Telegram configuration in Cloudflare…', flush=True)
    result = runner([node, str(cli), 'secret', 'bulk'], cwd=ROOT / 'apps/worker',
                    input=json.dumps(secrets) + '\n', text=True, capture_output=True,
                    env=environment, timeout=90)
    if result.returncode:
        raise RuntimeError('Cloudflare could not confirm the Telegram configuration. Run Wrangler login, then retry.')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner-id', help='Your Supabase Auth user UUID; not a password')
    parser.add_argument('--chat-id', help='Existing private chat ID; omit to detect after sending /start')
    args = parser.parse_args()
    owner = args.owner_id
    state = ROOT / '.setup-state.json'
    if not owner and state.is_file():
        owner = json.loads(state.read_text()).get('owner_id')
    if not owner:
        owner = input('Supabase owner user ID: ').strip()
    owner = str(uuid.UUID(owner))
    token = getpass.getpass('Telegram bot token (hidden; never paste into chat): ').strip()
    if not re.fullmatch(r'[0-9]{5,20}:[A-Za-z0-9_-]{20,100}', token):
        raise RuntimeError('That is not a Telegram bot token. Copy it from BotFather.')
    print('Checking the bot…', flush=True)
    telegram(token, 'getMe')
    chat = args.chat_id
    if not chat:
        input('Send /start to your bot in Telegram, then press Enter here. ')
        chats = private_chats(telegram(token, 'getUpdates', {'limit': 100, 'timeout': 0, 'allowed_updates': ['message']}))
        if not chats:
            raise RuntimeError('No private chat found. Send /start to the bot and run this setup again.')
        if len(chats) == 1:
            chat = chats[0]
        else:
            print('Private chat IDs: ' + ', '.join(chats))
            chat = input('Choose your private chat ID: ').strip()
            if chat not in chats:
                raise RuntimeError('Choose one of the detected private chats.')
    if not re.fullmatch(r'[0-9]{1,20}', chat):
        raise RuntimeError('A private Telegram chat ID must contain only digits.')
    confirmation = telegram(token, 'getChat', {'chat_id': chat})
    if confirmation.get('type') != 'private':
        raise RuntimeError('Choose a private chat for personal router alerts.')
    store_secrets(token, chat, owner)
    token = ''
    print('Telegram configured for your owner account. No token was stored in project files. Cloud alerts will use this private chat.')

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError) as error:
        print('Setup failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        print('\nSetup cancelled.', file=sys.stderr)
        sys.exit(1)
