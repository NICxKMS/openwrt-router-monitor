"""Native host jshn + shell/curl fixtures; does not use hardware or cloud."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
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
        self.env = dict(os.environ, NICX_STATE=str(self.state), NICX_LIB=str(LIB), NICX_JSHN=str(STAGING/'share/libubox/jshn.sh'), NICX_AGENT_LIBRARY_ONLY='1', PATH=str(self.bin)+':'+str(STAGING/'bin')+':'+os.environ['PATH'])
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

    def test_live_host_collectors_produce_bounded_sample(self):
        output=self.shell('collect_detail;collect_processes;collect_wifi;collect_connectivity;collect_sample;cat "$STATE/sample"')
        sample=json.loads(output)
        self.assertGreater(sample['mem_total_kb'],0)
        self.assertIsNone(sample['cpu_pct'])
        self.assertIsNone(sample['observed_at'])
        self.assertIn('cores',sample['detail']['cpu'])
        self.assertIn('processes',sample['detail'])
        self.assertLess(len(json.dumps(sample['detail']).encode()),16384)

    def test_slow_detail_is_sparse_on_subsequent_samples(self):
        output=self.shell('collect_detail;collect_processes;collect_wifi;collect_connectivity;collect_sample;collect_sample;cat "$STATE/sample"')
        sample=json.loads(output)
        self.assertEqual(set(sample['detail']),{'cpu','meminfo'})
        self.assertLess(len(output.encode()),1800)

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

    def test_http_success_requires_positive_acceptance(self):
        self.write_tool('curl', '''#!/usr/bin/env python3
import sys,json,os
from pathlib import Path
a=sys.argv[1:];s=Path(os.environ['NICX_STATE']);(s/'args.json').write_text(json.dumps(a))
Path(a[a.index('--output')+1]).write_text('{"accepted":false}')
print('200',end='')
''')
        cred=self.state/'credential';cred.write_text('a'*64+'\n');cred.chmod(0o600)
        output=self.shell('credential="$STATE/credential"; endpoint=https://fixture.workers.dev; echo "{}" > "$STATE/pending"; upload_batch; test -s "$STATE/pending"; echo retained')
        self.assertIn('retained',output)
        self.assertNotIn('a'*64,(self.state/'args.json').read_text())
        self.assertFalse((self.state/'auth').exists())

    def test_rpc_enroll_accepts_created_and_private_credential_rotation(self):
        config=self.state/'config';config.mkdir()
        self.env['NICX_CONFIG_DIR']=str(config)
        self.write_tool('uci','#!/bin/sh\ncase "$*" in *get*enabled*)echo 1;;esac\nexit 0\n')
        self.write_tool('timeout','#!/bin/sh\nif [ "$2" = /etc/init.d/nicx-telemetry ];then : > "$NICX_STATE/restarted";exit 0;fi\nexec /usr/bin/timeout "$@"\n')
        self.write_tool('curl', '#!/usr/bin/env python3\nimport sys,json,os\nfrom pathlib import Path\na=sys.argv[1:]\nPath(os.environ["NICX_STATE"],"enrollment-request.json").write_text(Path(a[a.index("--data-binary")+1][1:]).read_text())\nopen(a[a.index("--output")+1],"w").write(json.dumps({"device_id":"11111111-1111-4111-8111-111111111111","token":"'+'c'*64+'"}))\nprint("201",end="")\n')
        rpc=ROOT/'openwrt/nicx-telemetry/files/usr/libexec/rpcd/nicx.telemetry'
        shell=([os.environ['NICX_BUSYBOX'],'ash'] if os.environ.get('NICX_BUSYBOX') else ['bash','--posix'])
        payload={'endpoint':'https://fixture.workers.dev','enrollment_token':'e'*64,'name':'Fixture'}
        result=subprocess.run(shell+[str(rpc),'call','enroll'],input=json.dumps(payload)+'\n',env=self.env,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'],result.stdout)
        self.assertEqual((config/'token').read_text().strip(),'c'*64)
        self.assertEqual(json.loads((self.state/'enrollment-request.json').read_text())['model'],'Fixture router')
        self.assertEqual((config/'token').stat().st_mode & 0o777,0o600)
        if os.environ.get('NICX_BUSYBOX'):
            # Standalone ash can prefer its timeout applet over the PATH fixture.
            # The host has no router init script, so the attempted restart is explicit.
            response=json.loads(result.stdout)
            self.assertTrue(response['restarted'] or response['restart_required'])
        else:
            self.assertTrue((self.state/'restarted').exists())
            self.assertTrue(json.loads(result.stdout)['restarted'])
        rotated=subprocess.run(shell+[str(rpc),'call','set_token'],input=json.dumps({'token':'d'*64})+'\n',env=self.env,text=True,capture_output=True)
        self.assertTrue(json.loads(rotated.stdout)['ok'])
        self.assertEqual((config/'token').read_text().strip(),'d'*64)
        self.assertNotIn('d'*64,rotated.stdout)

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
        stat=Path(f'/proc/{pid}/stat')
        if stat.exists():self.assertEqual(stat.read_text().split(') ')[1].split()[0],'Z')
        self.assertFalse((self.state/'late-writer').exists())
        self.assertFalse((self.state/'auth').exists())

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
