"""Native host jshn + shell/curl fixtures; does not use hardware or cloud."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT/'openwrt/nicx-telemetry/files/usr/lib/nicx-telemetry'
STAGING = Path(os.environ.get('NICX_TEST_STAGING', ROOT.parent/'openwrt/staging_dir/host'))

@unittest.skipUnless((STAGING/'bin/jshn').exists(), 'requires native jshn from local OpenWrt host staging')
class Envelope(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.bin = self.state/'bin';self.bin.mkdir()
        self.env = dict(os.environ, NICX_STATE=str(self.state), NICX_CONFIG_DIR=str(self.state/'config'), NICX_LIB=str(LIB), NICX_JSHN=str(STAGING/'share/libubox/jshn.sh'), NICX_AGENT_LIBRARY_ONLY='1', PATH=str(self.bin)+':'+str(STAGING/'bin')+':'+os.environ['PATH'])
        self.env['LD_LIBRARY_PATH'] = str(STAGING/'lib')
        self.write_tool('jsonfilter', r'''#!/usr/bin/env python3
import json,sys,re
args=sys.argv[1:];data=json.load(open(args[args.index('-i')+1])) if '-i' in args else (json.loads(args[args.index('-s')+1]) if '-s' in args else json.load(sys.stdin))
query=args[args.index('-e')+1]
keys=re.findall(r'\.([a-zA-Z0-9_-]+)|\["([^"]+)"\]',query)
for match in keys:
    key=match[0] or match[1]
    if key not in data:sys.exit(0)
    data=data[key]
if data is not None: print(json.dumps(data,separators=(',',':')) if isinstance(data,(dict,list,bool)) else data)
''')
        self.write_tool('uci', '#!/bin/sh\nexit 1\n')
        self.write_tool('ubus', '#!/bin/sh\necho \'{"l3_device":"lo","model":"Fixture router","kernel":"6.18","release":{"version":"fixture"}}\'\n')

    def write_tool(self,name,body):
        p=self.bin/name;p.write_text(body);p.chmod(0o755)

    def shell(self,body):
        result=subprocess.run(([os.environ['NICX_BUSYBOX'],'ash'] if os.environ.get('NICX_BUSYBOX') else ['bash','--posix']) + ['-c','. "$NICX_LIB/agent.sh"; init_state; '+body],env=self.env,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        return result.stdout

    def test_sealed_replay_is_identical_and_contains_wire_fields(self):
        output=self.shell('''device_id=11111111-1111-4111-8111-111111111111;boot_id=22222222-2222-4222-8222-222222222222
printf '%s\\n' '{"seq":1,"uptime_s":10,"observed_at":null,"cpu_pct":null,"load1":0,"mem_total_kb":100,"mem_available_kb":50,"temp_c":null,"rx_bytes_delta":null,"tx_bytes_delta":null,"elapsed_s":null}' > "$STATE/item"
enqueue s "$STATE/item";seal_batch;cat "$STATE/pending";echo;seal_batch;cat "$STATE/pending"''')
        lines=[line for line in output.splitlines() if line]
        # Body is multi-line because source records retain trailing newline.
        decoder=json.JSONDecoder();first,end=decoder.raw_decode(output);second=json.loads(output[end:])
        self.assertEqual(first,second)
        self.assertEqual(first['schema_version'],1)
        self.assertEqual(len(first['samples']),1)
        self.assertIsNone(first['samples'][0]['observed_at'])
        self.assertEqual(first['logs'],[])
        self.assertEqual(list((self.state/'queue').glob('*')),[])

    def test_failed_seal_keeps_queue_and_snapshot_for_retry(self):
        for fault in ('part_write', 'body_write', 'rename'):
            with self.subTest(fault=fault):
                self.env['NICX_SEAL_FAULT']=fault
                output=self.shell('''device_id=11111111-1111-4111-8111-111111111111;boot_id=22222222-2222-4222-8222-222222222222
diagnostics_enabled=1;remote_diagnostics_enabled=1
echo '{}' > "$STATE/snapshot";echo '{}' > "$STATE/queue/0000000001.s"
mv() {
    case "$NICX_SEAL_FAULT:$1" in
        rename:*/pending.new)return 1;;
    esac
    command mv "$@"
}
cat() {
    case "$NICX_SEAL_FAULT:$1" in
        part_write:*/queue/*|body_write:*/samples.part)printf '{';return 1;;
    esac
    command cat "$@"
}
if seal_batch;then exit 41;fi
test -s "$STATE/queue/0000000001.s" && test -s "$STATE/snapshot" && test ! -e "$STATE/pending" || exit 42
NICX_SEAL_FAULT=;seal_batch || exit 43
command cat "$STATE/pending"
rm -f "$STATE/pending" "$STATE/snapshot.pending"
''')
                self.assertEqual(json.loads(output)['diagnostics'],{})
                self.assertEqual(json.loads(output)['samples'],[{}])

    def test_collector_timestamps_all_interfaces_in_one_sweep(self):
        output=self.shell('''ud=0
uptime_now() { ud=$((ud+1));uptime=$ud; }
collect_network
printf '%s\n' "$ud"
''')
        self.assertEqual(output.strip(),'1')

    def test_live_host_collectors_produce_bounded_sample(self):
        output=self.shell('collect_detail;collect_processes;collect_wifi;collect_connectivity;collect_sample;cat "$STATE/sample"')
        sample=json.loads(output)
        self.assertGreater(sample['mem_total_kb'],0)
        self.assertIsNone(sample['cpu_pct'])
        self.assertIsNone(sample['observed_at'])
        cpu = sample['detail']['cpu']
        self.assertIsInstance(cpu['cores'], dict)
        self.assertRegex(cpu['scheduler']['ctxt'], r'^\d+$')
        self.assertNotIn('cpu_pct', cpu)
        self.assertIn('processes',sample['detail'])
        self.assertLess(len(json.dumps(sample['detail']).encode()),16384)

    def test_device_tree_memory_reports_sizes_without_addresses(self):
        root = self.state/'devicetree'
        config = Path(self.env['NICX_CONFIG_DIR'])
        config.mkdir()
        salt = config/'privacy-salt'
        salt.write_text('a'*64+'\n')
        salt.chmod(0o600)
        region = root/'reserved-memory'/'qcom,q6@4b000000'
        second = root/'reserved-memory'/'qcom,q6@4e000000'
        memory = root/'memory@40000000'
        disabled = root/'reserved-memory'/'unused@4f000000'
        for node in (region, second, memory, disabled):
            node.mkdir(parents=True)
        for node in (root, region.parent):
            for name in ('#address-cells', '#size-cells'):
                (node/name).write_bytes(bytes.fromhex('00000002'))
        (memory/'device_type').write_bytes(b'memory\0')
        (memory/'reg').write_bytes(bytes.fromhex('00000000400000000000000020000000'))
        (region/'reg').write_bytes(bytes.fromhex('000000004b0000000000000002b00000'))
        (region/'no-map').touch()
        (second/'reg').write_bytes(bytes.fromhex('000000004e0000000000000000100000'))
        (disabled/'reg').write_bytes(bytes.fromhex('000000004f0000000000000000100000'))
        (disabled/'status').write_bytes(b'disabled\0')
        result = json.loads(self.shell('json_init; collect_device_tree_memory "$STATE/devicetree"; json_dump'))
        ids = [entry.pop('id') for entry in result['reservations']]
        self.assertEqual(len(set(ids)), 2)
        for key in ids:
            self.assertRegex(key, r'^reservation-[a-f0-9]{16}$')
            self.assertNotIn('4b000000', key)
            self.assertNotIn('4e000000', key)
        self.assertEqual(result, {
            'dt_ram_bytes': 512*1024*1024,
            'reservations': [
                {'name': 'qcom,q6', 'bytes': 43*1024*1024, 'no_map': True},
                {'name': 'qcom,q6', 'bytes': 1024*1024},
            ],
        })

        earlier = region.parent/'a-new-node@42000000'
        earlier.mkdir()
        (earlier/'reg').write_bytes(bytes.fromhex('00000000420000000000000000100000'))
        result = json.loads(self.shell('json_init; collect_device_tree_memory "$STATE/devicetree"; json_dump'))
        self.assertEqual([entry['id'] for entry in result['reservations'][1:]], ids)
        salt.write_text('b'*64+'\n')
        result = json.loads(self.shell('json_init; collect_device_tree_memory "$STATE/devicetree"; json_dump'))
        self.assertTrue(set(entry['id'] for entry in result['reservations'][1:]).isdisjoint(ids))
        salt.chmod(0o644)
        result = json.loads(self.shell('json_init; collect_device_tree_memory "$STATE/devicetree"; json_dump'))
        self.assertTrue(all('id' not in entry for entry in result['reservations']))


    def test_cpu_frequency_and_softirqs_use_fixture_roots(self):
        proc = self.state/'fixture-proc'
        proc.mkdir()
        (proc/'softirqs').write_text('CPU0 CPU1\nNET_RX: 2 11\nTIMER: 0 0\n')
        policy = self.state/'fixture-sys/devices/system/cpu/cpufreq/policy7'
        policy.mkdir(parents=True)
        (policy/'scaling_cur_freq').write_text('1200000\n')
        (policy/'scaling_min_freq').write_text('600000\n')
        (policy/'scaling_max_freq').write_text('unavailable\n')
        detail = json.loads(self.shell('json_init; collect_cpu_diagnostics "$STATE/fixture-proc" "$STATE/fixture-sys"; json_dump'))
        self.assertEqual(detail, {
            'cpu_frequency': [{'policy': 'policy7', 'scaling_cur_freq': 1200000, 'scaling_min_freq': 600000}],
            'cpu_softirq': {'NET_RX': '13', 'TIMER': '0'},
        })

    def test_sockstat_exposes_summary_and_udplite_counters(self):
        proc = self.state/'fixture-proc'
        (proc/'net').mkdir(parents=True)
        (proc/'meminfo').write_text('MemTotal: 1024 kB\n')
        (proc/'net'/'sockstat').write_text('sockets: used 6\nUDPLITE: inuse 2 mem 5\nUNKNOWN: inuse 1\n')
        detail = json.loads(self.shell('json_init; collect_memory_diagnostics "$STATE/fixture-proc" "$STATE/fixture-sys"; json_dump'))
        self.assertEqual(detail['sockets'], {'used': 6, 'UDPLITE': {'inuse': 2, 'mem': 5}})

    def test_slow_detail_is_sparse_on_subsequent_samples(self):
        output=self.shell('collect_detail;collect_processes;collect_wifi;collect_connectivity;collect_sample;cat "$STATE/sample";collect_sample;cat "$STATE/sample"')
        first, end = json.JSONDecoder().raw_decode(output)
        sample = json.loads(output[end:])
        self.assertIn('scheduler', first['detail']['cpu'])
        self.assertEqual(set(sample['detail']),{'meminfo','cadence'})
        self.assertLess(len(json.dumps(sample).encode()),1800)

    def test_each_sample_reports_local_and_adaptive_collection_cadence(self):
        output=self.shell('''sample_interval=120;effective_sample_interval=120;detail_interval=300;adaptive_active=0
collect_sample;cat "$STATE/sample"
adaptive_active=1;effective_sample_interval=300
collect_sample;cat "$STATE/sample"
''')
        normal,end=json.JSONDecoder().raw_decode(output)
        adaptive=json.loads(output[end:])
        self.assertEqual(normal['detail'].get('cadence'),{'sample_s':120,'connectivity_s':30,'detail_s':300})
        self.assertEqual(adaptive['detail'].get('cadence'),{'sample_s':300,'connectivity_s':60,'detail_s':600})

    def test_oversized_detail_fallback_keeps_collection_cadence(self):
        (self.state/'detail.json').write_text(json.dumps({'oversized':'x'*16000}))
        (self.state/'detail.dirty').touch()
        sample=json.loads(self.shell('sample_interval=120;effective_sample_interval=120;detail_interval=3600;adaptive_active=1;collect_sample;cat "$STATE/sample"'))
        self.assertEqual(sample['detail'].get('cadence'),{'sample_s':120,'connectivity_s':60,'detail_s':3600})
        self.assertNotIn('oversized',sample['detail'])

    def test_adaptive_sampling_has_hysteresis_and_hard_bounds(self):
        output=self.shell('''sample_interval=10;adaptive_sampling=1
pressure_update 95 300 1000 0 100000
pressure_update 95 300 1000 0 100000
pressure_update 95 300 1000 0 100000
echo "$adaptive_active:$effective_sample_interval"
n=0;while [ "$n" -lt 6 ];do pressure_update 20 300 1000 0 100000;n=$((n+1));done
echo "$adaptive_active:$effective_sample_interval"
sample_interval=200;pressure_update 99 300 1000 0 100000;pressure_update 99 300 1000 0 100000;pressure_update 99 300 1000 0 100000
echo "$adaptive_active:$effective_sample_interval"
adaptive_sampling=0;pressure_update 99 1 1000 99000 100000
echo "$adaptive_active:$effective_sample_interval"
''')
        self.assertEqual(output.splitlines(),['1:30','0:10','1:300','0:200'])

    def test_status_counts_upload_attempts_and_labels_parent_only_usage(self):
        self.write_tool('curl','''#!/usr/bin/env python3
import os,sys
from pathlib import Path
a=sys.argv[1:];s=Path(os.environ['NICX_STATE'])
Path(a[a.index('--output')+1]).write_text((s/'reply').read_text())
print('200',end='')
''')
        cred=self.state/'credential';cred.write_text('a'*64+'\n');cred.chmod(0o600)
        output=self.shell('''credential="$STATE/credential";endpoint=https://fixture.workers.dev;sample_interval=10;upload_interval=30;retry_delay=0;logs_enabled=1;privacy_addresses=0;clock_synced=false
echo '{}' > "$STATE/pending";echo 0 > "$STATE/pending.drops"
echo '{"accepted":false}' > "$STATE/reply";upload_batch
echo '{"accepted":true}' > "$STATE/reply";upload_batch
write_status;cat "$STATE/status.json"
''')
        status=json.loads(output)
        self.assertEqual(status['failed_uploads'],1);self.assertEqual(status['successful_uploads'],1)
        self.assertGreater(status['parent_rss_kb'],0);self.assertGreaterEqual(status['parent_peak_rss_kb'],status['parent_rss_kb'])
        self.assertIsNone(status['parent_cpu_pct']);self.assertIn('parent only',status['usage_scope'])

    def test_critical_upload_cooldown_preserves_pending_and_backoff(self):
        output=self.shell('''echo '{}' > "$STATE/queue/000000001.c"
last_success=100.5;retry_delay=0;upload_pid=''
critical_upload_due 115 && echo yes || echo no
critical_upload_due 116 && echo yes || echo no
retry_delay=5;critical_upload_due 120 && echo yes || echo no
retry_delay=0;echo '{}' > "$STATE/pending";critical_upload_due 120 && echo yes || echo no
rm -f "$STATE/pending";upload_pid=123;critical_upload_due 120 && echo yes || echo no
upload_pid='';rm -f "$STATE/queue/000000001.c";critical_upload_due 120 && echo yes || echo no
''')
        self.assertEqual(output.splitlines(),['no','yes','no','no','no','no'])

    def test_background_upload_does_not_block_collection_and_acknowledges(self):
        self.write_tool('curl', '''#!/usr/bin/env python3
import json,os,sys,time
from pathlib import Path
s=Path(os.environ['NICX_STATE']);limit=time.monotonic()+5
while not (s/'release').exists() and time.monotonic()<limit:time.sleep(.01)
a=sys.argv[1:];Path(a[a.index('--output')+1]).write_text('{"accepted":true,"config":{"sample_interval":20}}')
print('200',end='')
''')
        cred=self.state/'credential';cred.write_text('a'*64+'\n');cred.chmod(0o600)
        output=self.shell('''credential="$STATE/credential";endpoint=https://fixture.workers.dev;sample_interval=10;local_sample_interval=10
printf '{}\\n' > "$STATE/pending";echo 0 > "$STATE/pending.drops"
(upload_transport) & pid=$!
collect_sample
kill -0 "$pid" || exit 10
test -f "$STATE/pending" || exit 11
: > "$STATE/release";wait "$pid";finish_upload
test ! -e "$STATE/pending" || exit 12
echo "interval=$sample_interval"
''')
        self.assertIn('interval=20',output)
        self.assertTrue(list((self.state/'queue').glob('*.s')))

    def test_wifi_uses_private_client_ids_and_omits_with_unsafe_salt(self):
        config=self.state/'config';config.mkdir();salt=config/'privacy-salt';salt.write_text('e'*64+'\n');salt.chmod(0o600)
        self.env['NICX_CONFIG_DIR']=str(config)
        self.write_tool('iw','''#!/bin/sh
case "$*" in
 dev)printf 'phy#0\\n\\tInterface wlan0\\n';;
 'reg get')echo 'country IN: DFS-UNSET';;
 'dev wlan0 info')echo 'channel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz';;
 'dev wlan0 station dump')printf 'Station aa:bb:cc:dd:ee:ff (on wlan0)\\n\\tsignal: -51 dBm\\n\\trx bytes: 9007199254740993\\n\\ttx bytes: 10\\n\\ttx retries: 2\\n\\ttx failed: 0\\n\\trx bitrate: 600 MBit/s\\n\\ttx bitrate: 600 MBit/s\\n';;
 'dev wlan0 survey dump')printf 'frequency: 5180 MHz [in use]\\nchannel active time: 1000 ms\\nchannel busy time: 120 ms\\nnoise: -95 dBm\\n';;
esac
''')
        output=self.shell('collect_wifi;cat "$STATE/wifi.json"')
        wifi=json.loads(output)['wifi'];radio=wifi['radios'][0]
        self.assertEqual(wifi['country'],'IN');self.assertEqual(radio['frequency'],5180)
        self.assertEqual(radio['clients'][0]['rx_bytes'],'9007199254740993')
        self.assertEqual(len(radio['clients'][0]['client_id']),32)
        self.assertNotIn('aa:bb:cc:dd:ee:ff',output)
        salt.chmod(0o644)
        output=self.shell('collect_wifi;cat "$STATE/wifi.json"')
        self.assertEqual(json.loads(output)['wifi']['radios'][0]['clients'],[])
        salt.chmod(0o600)
        for value in ('', 'e'*64, 'x'*64+'\n', 'abcd\n'):
            with self.subTest(value=value):
                salt.write_text(value)
                output=self.shell('collect_wifi;cat "$STATE/wifi.json"')
                radio=json.loads(output)['wifi']['radios'][0]
                self.assertEqual(radio['stations'],1)
                self.assertEqual(radio['clients'],[])

    def test_http_success_requires_positive_acceptance(self):
        self.write_tool('curl', '''#!/usr/bin/env python3
import sys,json,os
from pathlib import Path
a=sys.argv[1:];s=Path(os.environ['NICX_STATE']);(s/'args.json').write_text(json.dumps(a))
Path(a[a.index('--output')+1]).write_text('{"accepted":false}')
print('200',end='')
''')
        cred=self.state/'credential';cred.write_text('a'*64+'\n');cred.chmod(0o600)
        output=self.shell('credential="$STATE/credential"; endpoint=https://fixture.workers.dev; echo "{}" > "$STATE/pending"; upload_batch; test -s "$STATE/pending" || exit 1; echo retained')
        self.assertIn('retained',output)
        self.assertNotIn('a'*64,(self.state/'args.json').read_text())
        self.assertFalse((self.state/'auth').exists())

    def rpc(self, method, payload):
        rpc=ROOT/'openwrt/nicx-telemetry/files/usr/libexec/rpcd/nicx.telemetry'
        shell=([os.environ['NICX_BUSYBOX'],'ash'] if os.environ.get('NICX_BUSYBOX') else ['bash','--posix'])
        result=subprocess.run(shell+[str(rpc),'call',method],input=json.dumps(payload)+'\n',
                              env=self.env,text=True,capture_output=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)
        return json.loads(result.stdout)

    def setup_enrollment(self):
        config=self.state/'config'
        config.mkdir()
        self.env['NICX_CONFIG_DIR']=str(config)
        self.env['NICX_SERVICE_SCRIPT']=str(self.bin/'telemetry-service')
        self.write_tool('uci', """#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
root=Path(os.environ['NICX_STATE']);args=sys.argv[1:];fault=os.environ.get('NICX_UCI_FAULT')
config=root/'uci.json'
settings=json.loads(config.read_text())
if args[0]=='-q':
    value=settings.get(args[2].rsplit('.',1)[1])
    if value is None:sys.exit(1)
    print(value)
    sys.exit()
delta=Path(args[1])/'settings.json'
staged=json.loads(delta.read_text()) if delta.exists() else {}
if args[2]=='set':
    key,value=args[3].split('=',1);key=key.rsplit('.',1)[1]
    if fault==key:sys.exit(1)
    staged[key]=value;delta.write_text(json.dumps(staged))
elif args[2]=='commit':
    if fault=='commit':sys.exit(1)
    settings.update(staged);config.write_text(json.dumps(settings))
else:sys.exit(1)
""")
        self.write_tool('telemetry-service', """#!/bin/sh
set -e
printf '%s\n' "$1" >> "$NICX_STATE/service-calls"
case "$1" in
    stop)
        read -r old_token < "$NICX_CONFIG_DIR/token"
        printf '%s\n' "$old_token" > "$NICX_STATE/token-at-stop"
        [ "${NICX_STOP_FAULT:-0}" = 0 ] || exit 1
        kill -TERM "$(cat "$NICX_STATE/fake-agent-pid")";;
    start)
        read -r new_token < "$NICX_CONFIG_DIR/token"
        printf '%s\n' "$new_token" > "$NICX_STATE/token-at-start";;
esac
""")
        self.write_tool('curl', """#!/usr/bin/env python3
import sys,json,os
from pathlib import Path
args=sys.argv[1:]
root=Path(os.environ['NICX_STATE'])
(root/'enrollment-request.json').write_text(Path(args[args.index('--data-binary')+1][1:]).read_text())
Path(args[args.index('--output')+1]).write_text(json.dumps({
    'device_id':'11111111-1111-4111-8111-111111111111','token':'c'*64
}))
print('201',end='')
""")
        prior={'endpoint':'https://old.workers.dev','device_id':'22222222-2222-4222-8222-222222222222','enabled':'1'}
        (self.state/'uci.json').write_text(json.dumps(prior))
        with (config/'token').open('w') as token_file:
            token_file.write('a'*64+'\n')
        (config/'token').chmod(0o600)
        return config,prior,{'endpoint':'https://fixture.workers.dev','enrollment_token':'e'*64,'name':'Fixture'}

    def fake_agent(self):
        process=subprocess.Popen(['sh','-c',r'''exec 9>> "$NICX_STATE/agent.lock"
flock -n 9 || exit 1
echo $$ > "$NICX_STATE/fake-agent-pid"
exec sleep 60
'''],env=self.env)
        def cleanup():
            if process.poll() is None:process.terminate()
            process.wait(timeout=5)
        self.addCleanup(cleanup)
        deadline=time.monotonic()+5
        while not (self.state/'fake-agent-pid').exists() and time.monotonic()<deadline:
            time.sleep(.01)
        self.assertIsNone(process.poll())
        self.assertTrue((self.state/'fake-agent-pid').exists())
        return process

    def test_rpc_enroll_accepts_created_and_private_credential_rotation(self):
        config,prior,payload=self.setup_enrollment()
        agent=self.fake_agent()
        result=self.rpc('enroll',payload)
        self.assertTrue(result['ok'],result)
        self.assertTrue(result['restarted'],result)
        self.assertEqual((config/'token').read_text().splitlines(),['c'*64,payload['endpoint'],result['device_id']])
        self.assertEqual(json.loads((self.state/'enrollment-request.json').read_text())['model'],'Fixture router')
        self.assertEqual((config/'token').stat().st_mode & 0o777,0o600)
        self.assertEqual((self.state/'service-calls').read_text().splitlines(),['stop','start'])
        self.assertEqual((self.state/'token-at-stop').read_text().strip(),'a'*64)
        self.assertEqual((self.state/'token-at-start').read_text().strip(),'c'*64)
        self.assertEqual(agent.wait(timeout=5),-15)
        rotated=self.rpc('set_token',{'token':'d'*64})
        self.assertTrue(rotated['ok'],rotated)
        self.assertEqual((config/'token').read_text().splitlines(),['d'*64,payload['endpoint'],result['device_id']])
        self.assertNotIn('d'*64,str(rotated))

    def test_rpc_enroll_restores_old_enrollment_after_local_failure(self):
        config,prior,payload=self.setup_enrollment()
        for error in ('device_id','commit'):
            with self.subTest(error=error):
                self.env['NICX_UCI_FAULT']=error
                result=self.rpc('enroll',payload)
                self.assertEqual(result,{'ok':False,'error':'enrollment_config_write_failed'})
                self.assertEqual((config/'token').read_text().strip(),'a'*64)
                self.assertEqual(json.loads((self.state/'uci.json').read_text()),prior)
                self.assertEqual(list(config.glob('token.*')),[])

    def test_rpc_enroll_cannot_replace_credential_if_service_refuses_to_stop(self):
        config,prior,payload=self.setup_enrollment()
        self.env['NICX_STOP_FAULT']='1'
        agent=self.fake_agent()
        result=self.rpc('enroll',payload)
        self.assertEqual(result,{'ok':False,'error':'enrollment_stop_failed'})
        self.assertEqual((config/'token').read_text().strip(),'a'*64)
        self.assertEqual(json.loads((self.state/'uci.json').read_text()),prior)
        self.assertIsNone(agent.poll())

    def test_rpc_rotation_reports_failed_replacement_and_cleans_temp(self):
        config,_,_=self.setup_enrollment()
        credential=config/'token';credential.rename(config/'saved')
        credential.mkdir()
        result=self.rpc('set_token',{'token':'d'*64})
        self.assertEqual(result,{'ok':False,'error':'credential_write_failed'})
        self.assertTrue(credential.is_dir())
        self.assertEqual(list(config.glob('token.*')),[])

    def test_bound_credential_rejects_wrong_origin_or_device(self):
        config,prior,payload=self.setup_enrollment()
        self.assertTrue(self.rpc('enroll',payload)['ok'])
        self.shell('''load_config
make_curl_config "$STATE/auth" || exit 51
rm -f "$STATE/auth"
enrolled_endpoint=$endpoint
endpoint=https://old.workers.dev
if make_curl_config "$STATE/auth";then exit 52;fi
endpoint=$enrolled_endpoint;device_id=22222222-2222-4222-8222-222222222222
if make_curl_config "$STATE/auth";then exit 53;fi
test ! -e "$STATE/auth"
''')

    def test_agent_refuses_second_owner_before_first_publishes_pid(self):
        agent=self.fake_agent()
        (self.state/'lock').mkdir()
        self.shell('''if (main);then exit 54;fi
test -d "$STATE/lock" && test ! -e "$STATE/lock/pid"
''')
        agent.terminate()
        agent.wait(timeout=5)
        self.shell('''if (main);then exit 55;fi
test ! -e "$STATE/lock"
''')

    def test_firewall_policy_presence_is_distinct_from_daemon_running(self):
        self.write_tool('nft','#!/bin/sh\nprintf \'%s\\n\' "$*" > "$NICX_STATE/nft.args"\nexit 0\n')
        detail=json.loads(self.shell('collect_detail;cat "$STATE/detail.json"'))
        self.assertIs(detail['services'].get('firewall'),True)
        self.assertEqual((self.state/'nft.args').read_text().strip(),'list table inet fw4')
        self.write_tool('nft','#!/bin/sh\necho "Error: No such file or directory" >&2\nexit 1\n')
        detail=json.loads(self.shell('collect_detail;cat "$STATE/detail.json"'))
        self.assertIs(detail['services'].get('firewall'),False)
        self.write_tool('nft','#!/bin/sh\necho "Operation not permitted" >&2\nexit 1\n')
        detail=json.loads(self.shell('collect_detail;cat "$STATE/detail.json"'))
        self.assertIn('firewall',detail['services'])
        self.assertIsNone(detail['services']['firewall'])

    def test_service_status_distinguishes_confirmed_states_from_failed_check(self):
        self.write_tool('ubus', """#!/bin/sh
case "$NICX_SERVICE_STATUS" in
    failed) printf '{}\n';exit 1;;
    missing) printf '{}\n';;
    *) printf '{"dnsmasq":{"instances":{"main":{"running":%s}}}}\n' "$NICX_SERVICE_STATUS";;
esac
""")
        self.write_tool('jsonfilter', """#!/usr/bin/env python3
import json,sys
status=json.load(sys.stdin)['dnsmasq']['instances']['main']['running']
print('true' if status else 'false')
""")
        for case,expected in (('true','true'),('false','false'),('missing','false'),('failed','unknown')):
            with self.subTest(case=case):
                self.env['NICX_SERVICE_STATUS']=case
                output=self.shell('procd_service_status dnsmasq || echo unknown')
                self.assertEqual(output.strip(),expected)

    def test_adblock_status_uses_allowlisted_procd_state(self):
        for status,expected in [('statusSuccess',True),('statusStopped',False),('statusFail',False),('statusDownloading',None),('unknown-new-version',None)]:
            payload={'adblock-fast':{'data':{'status':status,'message':'private token=sensitive','errors':[{'info':'private.example'}]}}}
            self.write_tool('ubus',"#!/bin/sh\ncat <<'EOF'\n"+json.dumps(payload)+'\nEOF\n')
            detail=json.loads(self.shell('collect_detail;cat "$STATE/detail.json"'))
            self.assertIn('adblock-fast',detail['services'])
            self.assertIs(detail['services']['adblock-fast'],expected,status)
            self.assertNotIn('sensitive',json.dumps(detail))
            self.assertNotIn('private.example',json.dumps(detail))

    def test_absent_wifi_fields_remain_absent_and_known_zero_is_preserved(self):
        config=self.state/'config';config.mkdir();salt=config/'privacy-salt';salt.write_text('e'*64+'\n');salt.chmod(0o600)
        self.env['NICX_CONFIG_DIR']=str(config)
        self.write_tool('iw','''#!/bin/sh
case "$*" in
 dev)printf 'phy#0\\n\\tInterface wlan0\\n';;
 'dev wlan0 station dump')printf 'Station aa:bb:cc:dd:ee:ff (on wlan0)\\n\\tsignal: -50 dBm\\n\\trx bytes: 0\\nStation aa:bb:cc:dd:ee:00 (on wlan0)\\n';;
esac
''')
        radio=json.loads(self.shell('collect_wifi;cat "$STATE/wifi.json"'))['wifi']['radios'][0]
        self.assertEqual(radio['signal_avg_dbm'],-50)
        self.assertEqual(radio['clients'][0]['rx_bytes'],'0')
        self.assertNotIn('tx_bytes',radio['clients'][0])
        self.assertEqual(set(radio['clients'][1]),{'client_id'})

    def test_snapshot_progress_waits_for_matching_positive_ack(self):
        self.write_tool('curl','''#!/usr/bin/env python3
import os,sys,time
from pathlib import Path
s=Path(os.environ['NICX_STATE']);(s/'started').touch();limit=time.monotonic()+5
while not (s/'release').exists() and time.monotonic()<limit:time.sleep(.01)
a=sys.argv[1:];Path(a[a.index('--output')+1]).write_text((s/'reply').read_text())
print('200',end='')
''')
        cred=self.state/'credential';cred.write_text('a'*64+'\n');cred.chmod(0o600)
        output=self.shell('''credential="$STATE/credential";endpoint=https://fixture.workers.dev
request=11111111-1111-4111-8111-111111111111
snapshot_create "$request" memory
echo '{"request_id":"11111111-1111-4111-8111-111111111111"}' > "$STATE/snapshot.pending"
echo '{}' > "$STATE/pending";echo 0 > "$STATE/pending.drops";echo '{"accepted":false}' > "$STATE/reply"
(upload_transport) & transport_job=$!
n=0;while [ ! -f "$STATE/started" ] && [ "$n" -lt 100 ];do sleep .01;n=$((n+1));done
jsonfilter -i "$STATE/snapshot-status.json" -e '@.state'
: > "$STATE/release";wait "$transport_job";finish_upload
jsonfilter -i "$STATE/snapshot-status.json" -e '@.state'
echo '{"accepted":true,"diagnostics_accepted":true,"diagnostics_request_id":"11111111-1111-4111-8111-111111111111"}' > "$STATE/reply";upload_batch
jsonfilter -i "$STATE/snapshot-status.json" -e '@.state'
# A restart/duplicate transport cannot turn a confirmed upload back into in-flight.
snapshot_mark uploading '' "$request"
jsonfilter -i "$STATE/snapshot-status.json" -e '@.state'
# An old acknowledgment must not mark another request as uploaded.
snapshot_create 22222222-2222-4222-8222-222222222222 wifi
snapshot_mark uploaded '' "$request"
jsonfilter -i "$STATE/snapshot-status.json" -e '@.state'
''')
        self.assertEqual(output.splitlines(),['uploading','retrying','uploaded','uploaded','queued'])

    def test_snapshot_requires_explicit_matching_storage_receipt(self):
        self.write_tool('curl','''#!/usr/bin/env python3
import os,sys
from pathlib import Path
s=Path(os.environ['NICX_STATE']);a=sys.argv[1:]
Path(a[a.index('--output')+1]).write_text((s/'reply').read_text());print('200',end='')
''')
        cred=self.state/'credential';cred.write_text('a'*64+'\n');cred.chmod(0o600)
        request='11111111-1111-4111-8111-111111111111'
        cases=[
            ({'accepted':True,'diagnostics_accepted':True,'diagnostics_request_id':request},'uploaded','removed'),
            ({'accepted':True,'diagnostics_accepted':False,'diagnostics_request_id':request,'diagnostics_reason':'storage_budget'},'failed','removed'),
            ({'accepted':True},'retrying','retained'),
            ({'accepted':True,'diagnostics_accepted':True,'diagnostics_request_id':'22222222-2222-4222-8222-222222222222'},'retrying','retained'),
            ({'accepted':True,'diagnostics_accepted':1,'diagnostics_request_id':request},'retrying','retained'),
        ]
        for response,expected_state,expected_pending in cases:
            (self.state/'reply').write_text(json.dumps(response))
            output=self.shell('''credential="$STATE/credential";endpoint=https://fixture.workers.dev
request=11111111-1111-4111-8111-111111111111;snapshot_create "$request" memory
echo '{"request_id":"11111111-1111-4111-8111-111111111111"}' > "$STATE/snapshot.pending"
echo '{}' > "$STATE/pending";echo 0 > "$STATE/pending.drops"
upload_batch
cat "$STATE/snapshot-status.json"
if [ -s "$STATE/pending" ];then echo retained;else echo removed;fi
''')
            lines=output.splitlines();meta=json.loads(lines[0])
            self.assertEqual(meta['state'],expected_state,response);self.assertEqual(lines[1],expected_pending,response)
            if expected_state=='failed':self.assertEqual(meta['reason'],'diagnostic_storage_budget')
            if expected_state=='retrying':self.assertEqual(meta['reason'],'diagnostic_receipt_unconfirmed')

    def test_rpc_snapshot_uuid_and_second_request_rejection(self):
        self.write_tool('uci','#!/bin/sh\necho 1\n')
        self.shell('echo \'{"cloud_diagnostics_enabled":true}\' > "$STATE/status.json";echo \'{"memory":{}}\' > "$STATE/detail.json"')
        rpc=ROOT/'openwrt/nicx-telemetry/files/usr/libexec/rpcd/nicx.telemetry'
        shell=([os.environ['NICX_BUSYBOX'],'ash'] if os.environ.get('NICX_BUSYBOX') else ['bash','--posix'])
        def request():
            result=subprocess.run(shell+[str(rpc),'call','snapshot'],input='{"kind":"memory"}\n',env=self.env,text=True,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr);return json.loads(result.stdout)
        first=request();self.assertTrue(first['ok']);self.assertEqual(first['state'],'queued')
        self.assertEqual(json.loads((self.state/'snapshot').read_text())['request_id'],first['request_id'])
        self.assertEqual(json.loads((self.state/'snapshot-status.json').read_text())['request_id'],first['request_id'])
        second=request();self.assertFalse(second['ok']);self.assertEqual(second['error'],'snapshot_in_progress')
        self.assertEqual(json.loads((self.state/'snapshot').read_text())['request_id'],first['request_id'])

    def test_network_snapshot_reads_complete_cache_during_refresh(self):
        self.write_tool('uci','#!/bin/sh\necho 1\n')
        previous={'interfaces':[], 'rx_bytes_delta':None, 'tx_bytes_delta':None, 'elapsed_s':None}
        (self.state/'status.json').write_text('{"cloud_diagnostics_enabled":true}')
        (self.state/'network.json').write_text(json.dumps(previous))
        shell=([os.environ['NICX_BUSYBOX'],'ash'] if os.environ.get('NICX_BUSYBOX') else ['bash','--posix'])
        # Pause after the collector opens its output, before awk writes it.
        # A concurrent RPC must still see the previously committed cache.
        collector=subprocess.Popen(shell+['-c','''
. "$NICX_LIB/agent.sh"
awk() {
    case "$*" in *network.awk*)
        : > "$STATE/network-refresh-started"
        while [ ! -e "$STATE/network-refresh-release" ];do sleep .01;done;;
    esac
    command awk "$@"
}
collect_network
'''],env=self.env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            deadline=time.monotonic()+5
            while not (self.state/'network-refresh-started').exists() and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertTrue((self.state/'network-refresh-started').exists(),'collector did not reach refresh barrier')
            rpc=ROOT/'openwrt/nicx-telemetry/files/usr/libexec/rpcd/nicx.telemetry'
            result=subprocess.run(shell+[str(rpc),'call','snapshot'],input='{"kind":"network"}\n',env=self.env,text=True,capture_output=True,timeout=5)
            self.assertTrue(json.loads(result.stdout)['ok'],result.stdout)
            try:
                snapshot=json.loads((self.state/'snapshot').read_text())
            except json.JSONDecodeError:
                self.fail('snapshot RPC queued incomplete JSON during network refresh')
            self.assertEqual(snapshot['snapshot'],previous)
        finally:
            (self.state/'network-refresh-release').touch()
            stdout,stderr=collector.communicate(timeout=5)
        self.assertEqual(collector.returncode,0,stderr)

    def test_rpc_snapshot_rejects_corrupt_cached_json(self):
        self.write_tool('uci','#!/bin/sh\necho 1\n')
        (self.state/'status.json').write_text('{"cloud_diagnostics_enabled":true}')
        rpc=ROOT/'openwrt/nicx-telemetry/files/usr/libexec/rpcd/nicx.telemetry'
        shell=([os.environ['NICX_BUSYBOX'],'ash'] if os.environ.get('NICX_BUSYBOX') else ['bash','--posix'])
        for cache in ('', 'null', '[]', '{"interfaces":['):
            with self.subTest(cache=cache):
                (self.state/'network.json').write_text(cache)
                result=subprocess.run(shell+[str(rpc),'call','snapshot'],input='{"kind":"network"}\n',env=self.env,text=True,capture_output=True,timeout=5)
                response=json.loads(result.stdout)
                self.assertFalse(response['ok'],'corrupt cache must not enter the upload queue')
                self.assertEqual(response['error'],'snapshot_not_yet_available')
                self.assertFalse((self.state/'snapshot').exists())
                self.assertFalse((self.state/'snapshot-status.json').exists())

    def test_snapshot_failed_discard_and_status_attachment(self):
        self.write_tool('curl', '#!/usr/bin/env python3\nimport sys\na=sys.argv[1:]\nopen(a[a.index("--output")+1],"w").write("{}")\nprint("400",end="")\n')
        cred=self.state/'credential';cred.write_text('a'*64+'\n');cred.chmod(0o600)
        output=self.shell('''credential="$STATE/credential";endpoint=https://fixture.workers.dev
request=11111111-1111-4111-8111-111111111111;snapshot_create "$request" memory
echo '{"request_id":"11111111-1111-4111-8111-111111111111"}' > "$STATE/snapshot.pending"
echo '{"samples":[{}],"logs":[]}' > "$STATE/pending";echo 0 > "$STATE/pending.drops"
upload_batch
echo '{"running":true}' > "$STATE/base";attach_snapshot_status "$STATE/base"
''')
        status=json.loads(output)
        self.assertTrue(status['running']);self.assertEqual(status['snapshot']['state'],'failed')
        self.assertEqual(status['snapshot']['reason'],'invalid_payload_discarded')
        self.assertFalse((self.state/'pending').exists())

    def test_critical_log_survives_notice_storm(self):
        (self.state/'logs').mkdir()
        data=('Wed Nov 25 10:00:00 2026 daemon.notice daemon: storm\n'*100)+ 'Wed Nov 25 10:00:01 2026 kern.crit kernel: OOM killed worker\n__NICX_TICK__\n'
        args=([os.environ['NICX_BUSYBOX'],'awk'] if os.environ.get('NICX_BUSYBOX') else ['awk'])
        r=subprocess.run(args+['-v','stream=1','-v',f'spool={self.state}/logs','-v','uptime=10','-v','threshold=5','-v','budget=100','-f',str(LIB/'logs.awk')],input=data,text=True,capture_output=True)
        self.assertEqual(r.returncode,0,r.stderr)
        rows=[json.loads(row) for p in (self.state/'logs').glob('*.ready') for row in p.read_text().splitlines()]
        self.assertTrue(any('OOM' in row['message'] for row in rows))
        self.assertLessEqual(sum(row['count'] for row in rows),100)
        self.assertEqual(rows[0]['severity'],2)

    def test_permanent_payload_failure_is_counted_and_unblocks_queue(self):
        self.write_tool('curl', '#!/usr/bin/env python3\nimport sys\na=sys.argv[1:]\nopen(a[a.index("--output")+1],"w").write("{}")\nprint("400",end="")\n')
        cred=self.state/'credential';cred.write_text('a'*64+'\n');cred.chmod(0o600)
        output=self.shell('''credential="$STATE/credential";endpoint=https://fixture.workers.dev
printf '{"samples":[{},{}],"logs":[{}]}\\n' > "$STATE/pending";echo 0 > "$STATE/pending.drops"
upload_batch
test ! -e "$STATE/pending" || exit 12
cat "$STATE/dropped"
''')
        self.assertEqual(output.strip(),'3')

    def test_log_disable_purges_staging_queue_and_pending(self):
        output=self.shell('''echo '{}' > "$STATE/queue/000000001.c";echo '{}' > "$STATE/queue/000000002.l"
echo '{}' > "$STATE/queue/000000003.s";echo '{}' > "$STATE/logs/1.ready"
echo '{"samples":[{}],"logs":[{}]}' > "$STATE/pending";echo 0 > "$STATE/pending.drops"
purge_logs
find "$STATE/queue" -type f
cat "$STATE/dropped"
test ! -s "$STATE/pending" && test ! -e "$STATE/logs/1.ready"
''')
        self.assertNotIn('.c',output);self.assertNotIn('.l',output);self.assertIn('.s',output)
        self.assertEqual(output.splitlines()[-1],'4')

    def test_cloud_diagnostic_permission_is_required_for_batch(self):
        output=self.shell('''device_id=11111111-1111-4111-8111-111111111111;boot_id=22222222-2222-4222-8222-222222222222
diagnostics_enabled=1;remote_diagnostics_enabled=0
echo '{}' > "$STATE/snapshot";echo '{}' > "$STATE/queue/000000001.s"
seal_batch;cat "$STATE/pending"
''')
        self.assertNotIn('diagnostics',json.loads(output))
        self.assertTrue((self.state/'snapshot').exists())

    def test_cleanup_waits_for_transport_descendants(self):
        self.write_tool('curl','''#!/usr/bin/env python3
import os,time
from pathlib import Path
s=Path(os.environ['NICX_STATE']);(s/'transport.pid').write_text(str(os.getpid()))
time.sleep(20)
(s/'late-writer').write_text('bad')
''')
        cred=self.state/'credential';cred.write_text('a'*64+'\n');cred.chmod(0o600)
        self.shell('''credential="$STATE/credential";endpoint=https://fixture.workers.dev
echo '{}' > "$STATE/pending"
(upload_transport) & upload_pid=$!
n=0;while [ ! -s "$STATE/transport.pid" ] && [ "$n" -lt 100 ];do sleep .01;n=$((n+1));done
test -s "$STATE/transport.pid" || exit 20
terminate_children
rm -f "$STATE/auth"
''')
        pid=int((self.state/'transport.pid').read_text())
        # A reparented zombie cannot write; a live descendant is a regression.
        try:
            stat = Path(f'/proc/{pid}/stat').read_text()
        except FileNotFoundError:
            pass
        else:
            self.assertEqual(stat.rsplit(') ', 1)[1].split()[0], 'Z')
        self.assertFalse((self.state/'late-writer').exists())
        self.assertFalse((self.state/'auth').exists())

    def test_cleanup_stops_root_if_process_enumeration_fails(self):
        self.shell('''sleep 20 & child=$!
awk() { return 1; }
terminate_roots "$child"
kill -0 "$child" 2>/dev/null && exit 1
:''')

    def test_critical_log_evicts_full_notice_group_map(self):
        (self.state/'logs').mkdir()
        data=''.join(f'Wed Nov 25 10:00:00 2026 daemon.notice daemon: storm{i}\n' for i in range(12))+ 'Wed Nov 25 10:00:01 2026 kern.crit kernel: OOM killed worker\n__NICX_TICK__\n'
        args=([os.environ['NICX_BUSYBOX'],'awk'] if os.environ.get('NICX_BUSYBOX') else ['awk'])
        r=subprocess.run(args+['-v','stream=1','-v',f'spool={self.state}/logs','-v','uptime=10','-v','threshold=5','-v','budget=100','-f',str(LIB/'logs.awk')],input=data,text=True,capture_output=True)
        self.assertEqual(r.returncode,0,r.stderr)
        rows=[json.loads(row) for p in (self.state/'logs').glob('*.ready') for row in p.read_text().splitlines()]
        self.assertEqual(len(rows),12)
        self.assertTrue(any('OOM' in row['message'] for row in rows))

    def test_log_stream_spool_is_bounded_and_redacted(self):
        data='Wed Nov 25 10:00:00 2026 daemon.err hostapd: peer 10.1.2.3 aa:bb:cc:dd:ee:ff failed\n'*1000+'__NICX_TICK__\n'
        (self.state/'logs').mkdir()
        r=subprocess.run(([os.environ['NICX_BUSYBOX'],'awk'] if os.environ.get('NICX_BUSYBOX') else ['awk']) + ['-v','stream=1','-v',f'spool={self.state}/logs','-v','uptime=10','-v','threshold=5','-v','budget=100','-f',str(LIB/'logs.awk')],input=data,text=True,capture_output=True)
        self.assertEqual(r.returncode,0,r.stderr)
        paths=list((self.state/'logs').glob('*.ready'))
        self.assertEqual(len(paths),1)
        log=json.loads(paths[0].read_text());self.assertEqual(log['count'],100)
        self.assertNotIn('10.1.2.3',log['message']);self.assertNotIn('aa:bb',log['message'])
        self.assertLess(paths[0].stat().st_size,16384)

if __name__=='__main__':unittest.main()
