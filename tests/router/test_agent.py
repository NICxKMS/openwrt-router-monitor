import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIB = ROOT / 'openwrt/nicx-telemetry/files/usr/lib/nicx-telemetry'

class AgentSafety(unittest.TestCase):
    def shell(self, body, state):
        self.assertTrue((LIB/'common.sh').exists(), 'agent not implemented')
        env = dict(os.environ, NICX_STATE=state, NICX_LIB=str(LIB))
        return subprocess.run(([os.environ['NICX_BUSYBOX'], 'ash'] if os.environ.get('NICX_BUSYBOX') else ['sh']) + ['-c', '. "$NICX_LIB/common.sh"; ' + body], env=env, text=True, capture_output=True)

    def test_invalid_endpoint_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            for endpoint in ['http://example.org', 'https://example.org/evil', 'https://example.org@evil.test', 'https://example.org;touch /tmp/pwn', 'https://localhost', 'https://127.0.0.1']:
                r=self.shell('endpoint='+repr(endpoint)+'; valid_endpoint "$endpoint"', d)
                self.assertNotEqual(r.returncode,0,endpoint)
            self.assertEqual(self.shell('valid_endpoint https://router.example.workers.dev',d).returncode,0)

    def test_queue_bounds_and_priority(self):
        with tempfile.TemporaryDirectory() as d:
            r=self.shell('init_state; queue_limit=8192; printf "%04000d" 1 > "$STATE/item"; enqueue s "$STATE/item"; enqueue c "$STATE/item"; enqueue l "$STATE/item"; find "$STATE/queue" -type f; cat "$STATE/dropped"',d)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertIn('.c',r.stdout)
            self.assertNotIn('.l',r.stdout)
            retained=list(pathlib.Path(d,'queue').glob('*'))
            # tmpfs and disk filesystems charge directory blocks differently.
            # Verify exact accounting against retained entries, not a fixed eviction count.
            dropped=int(r.stdout.splitlines()[-1])
            self.assertGreaterEqual(dropped,1)
            self.assertEqual(dropped,3-len(retained))
            size=sum(p.stat().st_size for p in retained)
            self.assertLessEqual(size,8192)

    def test_credentials_never_curl_command_line(self):
        with tempfile.TemporaryDirectory() as d:
            cred=pathlib.Path(d,'credential');cred.write_text('a'*64+'\n');cred.chmod(0o600)
            r=self.shell('init_state; credential="$STATE/credential"; make_curl_config "$STATE/auth"; cat "$STATE/auth"',d)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertIn('Authorization: Bearer '+ 'a'*64,r.stdout)
            self.assertEqual(pathlib.Path(d,'auth').stat().st_mode & 0o777,0o600)

    def test_overbroad_credentials_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            cred=pathlib.Path(d,'credential');cred.write_text('b'*64+'\n');cred.chmod(0o644)
            r=self.shell('init_state; credential="$STATE/credential"; make_curl_config "$STATE/auth"',d)
            self.assertNotEqual(r.returncode,0)

if __name__=='__main__':unittest.main()
