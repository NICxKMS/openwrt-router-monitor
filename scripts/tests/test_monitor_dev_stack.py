import fcntl
import importlib.util
import os
import signal
import subprocess
import sys
import time
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[2] / "nicx-router-monitor" / "scripts" / "dev-stack.py"
spec = importlib.util.spec_from_file_location("dev_stack", MODULE)
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)


class DevStackTest(unittest.TestCase):
    def test_database_and_worker_config_is_session_local(self):
        with tempfile.TemporaryDirectory() as directory:
            scratch = Path(directory)
            config = stack.supabase_config(scratch, "jidu-dev-random", (44001, 44002, 44003, 44004, 44005), 44006)
            self.assertIn('project_id = "jidu-dev-random"', config)
            self.assertIn("port = 44001", config)
            self.assertIn('site_url = "http://127.0.0.1:44006"', config)
            self.assertNotIn("54321", config)
            worker = stack.worker_config(44001, 44006)
            self.assertEqual(worker["vars"]["SUPABASE_URL"], "http://127.0.0.1:44001")
            self.assertEqual(worker["vars"]["DEV_LOOPBACK_SUPABASE"], "1")
            self.assertNotIn("routes", worker)
            self.assertNotIn("account_id", worker)
            self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", worker["vars"])

    def test_cleanup_stops_a_service_after_its_launcher_exits(self):
        launcher = subprocess.Popen([
            sys.executable, "-c",
            "import subprocess,sys; print(subprocess.Popen([sys.executable, '-c', "
            "'import time; time.sleep(30)'], stdout=subprocess.DEVNULL).pid)",
        ], start_new_session=True, stdout=subprocess.PIPE, text=True)
        pid = int(launcher.communicate(timeout=5)[0])
        self.assertEqual(launcher.returncode, 0)
        def running():
            try:
                return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
            except FileNotFoundError:
                return False
        try:
            self.assertTrue(running())
            stack.stop_process(launcher)
            until = time.monotonic() + 2
            while running() and time.monotonic() < until:
                time.sleep(0.05)
            self.assertFalse(running())
        finally:
            try:
                os.killpg(launcher.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def test_rejects_any_non_loopback_published_supabase_service(self):
        local = {"NetworkSettings": {"Ports": {"8000/tcp": [{"HostIp": "127.0.0.1"}]}}}
        wildcard = {"NetworkSettings": {"Ports": {"5432/tcp": [{"HostIp": "0.0.0.0"}]}}}
        with patch.object(stack.subprocess, "check_output", side_effect=["a", "[%s]" % stack.json.dumps(local)]):
            stack.verify_loopback_ports("jidu-dev-test", {})
        with patch.object(stack.subprocess, "check_output", side_effect=[
            "a b", stack.json.dumps([local, wildcard]),
        ]):
            with self.assertRaisesRegex(ValueError, "outside 127"):
                stack.verify_loopback_ports("jidu-dev-test", {})

    def test_cleanup_preserves_active_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active, stale, foreign = [
                root / name for name in (stack.PREFIX + "active", stack.PREFIX + "stale", "foreign")
            ]
            for path in (active, stale, foreign):
                path.mkdir(mode=0o700)
                (path / "lock").touch()
                (path / "project-id").write_text("jidu-dev-abcd1234abcd")
            with (active / "lock").open() as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                with patch.object(stack.tempfile, "gettempdir", return_value=directory), \
                     patch.object(stack, "stop_database", return_value=True) as stop:
                    stack.reap_abandoned({})
                    stop.assert_called_once_with(stale, "jidu-dev-abcd1234abcd", {})
            self.assertTrue(active.exists())
            self.assertFalse(stale.exists())
            self.assertTrue(foreign.exists())

    def test_environment_discards_host_credentials(self):
        with patch.dict(stack.os.environ, {
            "SUPABASE_ACCESS_TOKEN": "private",
            "VITE_SUPABASE_URL": "https://production",
            "WRANGLER_ENV": "production",
            "CLOUDFLARE_API_TOKEN": "private",
        }):
            self.assertFalse(any(key in stack.clean_env() for key in (
                "SUPABASE_ACCESS_TOKEN", "VITE_SUPABASE_URL", "WRANGLER_ENV", "CLOUDFLARE_API_TOKEN",
            )))


if __name__ == "__main__":
    unittest.main()
