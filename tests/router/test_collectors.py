"""Host fixture tests, not router performance or deployment evidence."""
import csv
import os
import runpy
import json
import pathlib
import subprocess
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIB = ROOT / 'openwrt/nicx-telemetry/files/usr/lib/nicx-telemetry'

class Collectors(unittest.TestCase):
    def run_awk(self, name, data, **variables):
        self.assertTrue((LIB / name).exists(), 'collector has not been implemented')
        args = [os.environ['NICX_BUSYBOX'], 'awk'] if os.environ.get('NICX_BUSYBOX') else ['awk']
        for key, value in variables.items():
            args += ['-v', f'{key}={value}']
        return subprocess.check_output(args + ['-f', str(LIB / name)], input=data, text=True)

    def test_cpu_guest_excluded_and_per_core(self):
        with tempfile.TemporaryDirectory() as d:
            state = str(pathlib.Path(d) / 'cpu')
            first = 'cpu 100 0 50 800 20 10 20 0 30 0\ncpu0 100 0 50 800 20 10 20 0 30 0\n'
            second = 'cpu 120 0 60 860 25 10 25 0 40 0\ncpu0 120 0 60 860 25 10 25 0 40 0\n'
            a = json.loads(self.run_awk('cpu.awk', first, state=state))
            self.assertIsNone(a['cpu_pct'])
            b = json.loads(self.run_awk('cpu.awk', second, state=state))
            self.assertAlmostEqual(b['cpu_pct'], 35)
            self.assertEqual(b['cores']['cpu0'], 35)

    def test_counter_exact_above_float_precision_and_reset(self):
        with tempfile.TemporaryDirectory() as d:
            state = str(pathlib.Path(d) / 'net')
            a = 'eth1 wan 2 100 18446744073709551000 9007199254740993\n'
            b = 'eth1 wan 2 110 18446744073709551091 9007199254741000\n'
            self.run_awk('network.awk', a, state=state)
            result = json.loads(self.run_awk('network.awk', b, state=state))
            self.assertEqual(result['interfaces'][0]['rx_delta'], 91)
            self.assertEqual(result['interfaces'][0]['tx_delta'], 7)
            self.assertEqual(result['interfaces'][0]['rx_bytes'], '18446744073709551091')
            self.assertEqual(result['rx_bytes_delta'], 91)
            reset = json.loads(self.run_awk('network.awk', 'eth1 wan 3 120 100 200\n', state=state))
            self.assertTrue(reset['interfaces'][0]['reset'])
            self.assertIsNone(reset['rx_bytes_delta'])

    def test_lan_excluded_from_uplink_and_elapsed_monotonic(self):
        with tempfile.TemporaryDirectory() as d:
            state = str(pathlib.Path(d) / 'net')
            self.run_awk('network.awk', 'wan0 wan 1 50 20 30\nusb0 usbwan 2 50 30 40\nbr-lan lan 3 50 80 90\n', state=state)
            r = json.loads(self.run_awk('network.awk', 'wan0 wan 1 60 30 50\nusb0 usbwan 2 60 60 80\nbr-lan lan 3 60 180 190\n', state=state))
            self.assertEqual((r['rx_bytes_delta'], r['tx_bytes_delta'], r['elapsed_s']), (40, 60, 10))
            self.assertEqual([i['role'] for i in r['interfaces']], ['wan', 'usbwan', 'lan'])

    def test_lan_counters_are_not_reused_for_a_wan_total(self):
        with tempfile.TemporaryDirectory() as d:
            state = str(pathlib.Path(d) / 'net')
            self.run_awk('network.awk', 'eth1 lan 3 10 1000 2000\n', state=state)
            changed = json.loads(self.run_awk('network.awk', 'eth1 wan 3 20 1020 2030\n', state=state))
            self.assertEqual(changed['interfaces'][0]['rx_delta'], 20)
            self.assertIsNone(changed['rx_bytes_delta'])
            continued = json.loads(self.run_awk('network.awk', 'eth1 wan 3 30 1030 2040\n', state=state))
            self.assertEqual(continued['rx_bytes_delta'], 10)

    def test_benchmark_omits_a_reset_or_changed_uplink_window(self):
        analyze = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[2] / 'benchmarks/analyze-router.py'))['analyze']
        fields = ('uptime_s', 'cpu_total_ticks', 'cpu_idle_ticks', 'mem_available_kb', 'agent_rss_kb', 'queue_disk_kb',
                  'wan_device', 'wan_rx_bytes', 'wan_tx_bytes', 'usbwan_device', 'usbwan_rx_bytes', 'usbwan_tx_bytes')
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d) / 'observations.csv'
            for interruption in (('wan0', 100, 120), ('wan1', 1100, 1200), ('', '', '')):
                with self.subTest(interruption=interruption):
                    with path.open('w', newline='') as output:
                        writer = csv.writer(output)
                        writer.writerow(fields)
                        writer.writerow((1, 100, 80, 100, 10, 2, 'wan0', 1000, 1000, 'usb0', 10, 20))
                        writer.writerow((2, 200, 150, 100, 12, 2, *interruption, 'usb0', 20, 30))
                        writer.writerow((3, 300, 220, 100, 11, 2, 'wan0', 1500, 1500, 'usb0', 30, 40))
                    report = analyze(path)
                    self.assertEqual(report['observations'], 3)
                    self.assertEqual(report['agent_rss_kb_max'], 12)
                    self.assertEqual(set(report['uplinks']), {'usbwan'})
                    self.assertEqual(report['uplinks']['usbwan']['rx_bytes_delta'], 20)

    def test_parent_usage_is_machine_cpu_share_and_real_rss(self):
        with tempfile.TemporaryDirectory() as d:
            parent=pathlib.Path(d)/'parent';system=pathlib.Path(d)/'system';status=pathlib.Path(d)/'status';state=str(pathlib.Path(d)/'previous')
            def write_sample(user,sys_ticks,system_line,rss,hwm):
                fields=['S']+['0']*21;fields[1]='1';fields[11]=str(user);fields[12]=str(sys_ticks)
                parent.write_text('123 (ash worker) '+' '.join(fields)+'\n')
                system.write_text(system_line+'\n')
                status.write_text(f'VmRSS: {rss} kB\nVmHWM: {hwm} kB\n')
            def collect():
                self.assertTrue((LIB/'parent-usage.awk').exists(),'parent usage collector missing')
                args=[os.environ['NICX_BUSYBOX'],'awk'] if os.environ.get('NICX_BUSYBOX') else ['awk']
                return subprocess.check_output(args+['-v',f'state={state}','-f',str(LIB/'parent-usage.awk'),str(parent),str(system),str(status)],text=True).split()
            write_sample(100,20,'cpu 100 0 50 800 20 10 20 0 5000 0',2048,3072)
            self.assertEqual(collect(),['null','2048','3072'])
            write_sample(120,25,'cpu 200 0 100 1100 30 20 50 0 9000 0',2500,4096)
            self.assertEqual(collect(),['5.000','2500','4096'])
            write_sample(1,0,'cpu 1 0 1 10 0 0 0 0 0 0',1000,1000)
            self.assertEqual(collect(),['null','1000','1000'])

    def test_memory_and_pressure(self):
        r = json.loads(self.run_awk('memory.awk', 'MemTotal: 500000 kB\nMemFree: 12000 kB\nMemAvailable: 140000 kB\nSlab: 12000 kB\nSReclaimable: 8000 kB\nSUnreclaim: 4000 kB\nCached: 30000 kB\n'))
        self.assertEqual(r['mem_available_kb'], 140000)
        self.assertEqual(r['sunreclaim_kb'], 4000)

    def test_logs_redact_and_group_and_burst_bound(self):
        data = ('Wed Nov 25 10:00:00 2026 daemon.err hostapd: failed peer 192.168.1.25 aa:bb:cc:dd:ee:ff password=hunter2\n' * 20)
        rows = [json.loads(x) for x in self.run_awk('logs.awk', data, uptime=50, threshold=5, budget=8).splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['count'], 8)
        self.assertNotIn('hunter2', rows[0]['message'])
        self.assertNotIn('192.168.1.25', rows[0]['message'])
        self.assertNotIn('aa:bb', rows[0]['message'])
        self.assertEqual(rows[0]['severity'], 3)

    def test_log_json_escapes_and_ipv6_redaction(self):
        line = 'Wed Nov 25 10:00:00 2026 daemon.err test: peer 2001:db8::42 says "failed" at C:\\tmp\\name\n'
        row = json.loads(self.run_awk('logs.awk', line, uptime=10, threshold=7, budget=100))
        self.assertNotIn('2001:db8::42', row['message'])
        self.assertIn('"failed"', row['message'])
        self.assertIn('C:\\tmp', row['message'])

    def test_trusted_utc_log_first_last_timestamps(self):
        lines='Wed Nov 25 10:00:00 2026 daemon.err test: failed\nWed Nov 25 10:00:03 2026 daemon.err test: failed\n'
        row=json.loads(self.run_awk('logs.awk',lines,uptime=10,threshold=5,budget=100,synced=1))
        self.assertEqual(row['first_at'],'2026-11-25T10:00:00Z')
        self.assertEqual(row['last_at'],'2026-11-25T10:00:03Z')
        self.assertEqual(row['count'],2)

    def test_ntp_events_clear_invalid_stratum_marker(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        hook = root/'openwrt/nicx-telemetry/files/etc/hotplug.d/ntp/90-nicx-telemetry'
        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory)/'sync-marker'
            script = hook.read_text().replace('/tmp/nicx-telemetry-clock-synced', str(marker))
            shell = [os.environ['NICX_BUSYBOX'], 'ash'] if os.environ.get('NICX_BUSYBOX') else ['sh']
            for action, stratum in (('step',''), ('periodic','16'), ('stratum','0'), ('stratum','invalid'), ('unsync','1')):
                with self.subTest(action=action, stratum=stratum):
                    subprocess.run(shell+['-c',script],env=dict(os.environ,ACTION='periodic',stratum='3'),check=True)
                    self.assertTrue(marker.exists())
                    subprocess.run(shell+['-c',script],env=dict(os.environ,ACTION=action,stratum=stratum),check=True)
                    self.assertFalse(marker.exists())

    def test_stream_rechecks_clock_before_every_timestamp(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = pathlib.Path(directory)
            marker = spool/'sync-marker'
            marker.touch()
            awk = [os.environ['NICX_BUSYBOX'], 'awk'] if os.environ.get('NICX_BUSYBOX') else ['awk']
            args = awk + ['-v', 'stream=1', '-v', f'spool={spool}', '-v', f'clock_marker={marker}',
                          '-v', 'threshold=7', '-f', str(LIB/'logs.awk')]
            with subprocess.Popen(args, stdin=subprocess.PIPE, text=True) as process:
                process.stdin.write('Wed Nov 25 10:00:00 2026 daemon.err test: before\n__NICX_TICK__\n')
                process.stdin.flush()
                first = spool/'1.ready'
                deadline = time.monotonic()+5
                while not first.exists() and time.monotonic()<deadline:
                    time.sleep(.01)
                if not first.exists():
                    process.kill()
                    self.fail('log collector did not emit its first group')
                marker.unlink()
                process.communicate('Wed Nov 25 10:00:03 2026 daemon.err test: after\n__NICX_TICK__\n', timeout=5)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(json.loads(first.read_text())['first_at'], '2026-11-25T10:00:00Z')
                after = json.loads((spool/'2.ready').read_text())
                self.assertIsNone(after['first_at'])
                self.assertIsNone(after['last_at'])

    def test_sensitive_dns_logs_omitted(self):
        prefix = 'Wed Nov 25 10:00:00 2026 daemon.info '
        data = ''.join(prefix + line + '\n' for line in (
            'dnsmasq[1]: query[A] secret.example from 1.2.3.4',
            'dnsmasq[1]: config secret.example is 1.2.3.4',
            'dnsmasq[1]: /etc/hosts secret.example is 1.2.3.4',
            'dnsmasq[1]: CNAME secret.example is target.example',
            'dnsmasq-dhcp[1]: DHCPACK(br-lan) 192.0.2.1 00:00:00:00:00:01 private-host',
            'dnsmasq[1]: started, version 2.91 cachesize 1000',
            'dnsmasq[1]: exiting on receipt of SIGTERM',
        ))
        rows = [json.loads(row) for row in self.run_awk('logs.awk', data, uptime=10, threshold=7).splitlines()]
        self.assertEqual([row['message'] for row in rows], [
            'started, version 2.91 cachesize 1000', 'exiting on receipt of SIGTERM',
        ])


if __name__ == '__main__':
    unittest.main()
