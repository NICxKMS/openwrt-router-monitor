"""Emit the actual agent-generated fixture sample to stdout for cross-stack tests."""
import json
from test_envelope import Envelope

fixture=Envelope('test_live_host_collectors_produce_bounded_sample')
fixture.setUp()
try:
    raw=fixture.shell('collect_detail;collect_processes;collect_wifi;collect_connectivity;collect_sample;cat "$STATE/sample"')
    print(json.dumps(json.loads(raw),separators=(',',':')))
finally:
    fixture.doCleanups()
