"""Validate actionable local UI errors without a router or browser deployment."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
VIEW = ROOT/'openwrt/luci-app-nicx-telemetry/htdocs/luci-static/resources/view/nicx-telemetry.js'

@unittest.skipUnless(shutil.which('node'), 'requires host Node for LuCI source evaluation')
class LuciCopy(unittest.TestCase):
    def test_actions_show_pending_block_duplicates_and_keep_result(self):
        script=r'''
const source=require('fs').readFileSync(process.argv[1],'utf8');
const prefix=source.slice(0,source.indexOf('return view.extend('));
const run=new Function('rpc','ui','E','_',prefix+';return runAction;')({declare:()=>()=>{}},{},()=>{},s=>s);
(async()=>{
  const classes=new Set(),attrs={},button={disabled:false,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},setAttribute:(k,v)=>attrs[k]=v,removeAttribute:k=>delete attrs[k]};
  const feedback={textContent:'',dataset:{}},modal={textContent:'',dataset:{}};
  let release,calls=0;const request=new Promise(resolve=>release=resolve);
  const first=run(button,[feedback,modal],()=>{calls++;return request},'Working…','Confirmed complete');
  if(!button.disabled || feedback.textContent!=='Working…' || !classes.has('spinning') || attrs['aria-busy']!=='true')throw Error('pending feedback missing');
  await run(button,feedback,()=>{calls++;return Promise.resolve({ok:true})},'duplicate','bad');
  await Promise.resolve();if(calls!==1)throw Error('duplicate request dispatched');
  release({ok:true});await first;
  if(button.disabled || feedback.textContent!=='Confirmed complete' || modal.textContent!=='Confirmed complete' || classes.size || attrs['aria-busy'])throw Error('completion missing');
  await run(button,feedback,()=>Promise.reject(Error('offline')),'Working…','not confirmed');
  if(button.disabled || feedback.dataset.state!=='error' || !feedback.textContent.includes('did not confirm'))throw Error('uncertain failure hidden');
})().catch(error=>{console.error(error);process.exitCode=1});
'''
        subprocess.check_call(['node','-e',script,str(VIEW)])

    def test_snapshot_polling_reconciles_new_requests_without_regression(self):
        script=r'''
const source=require('fs').readFileSync(process.argv[1],'utf8');
const prefix=source.slice(0,source.indexOf('return view.extend('));
const accept=new Function('rpc','ui','E','_',prefix+';return acceptSnapshotStatus;')({declare:()=>()=>{}},{},()=>{},s=>s);
const oldDone={request_id:'a',state:'uploaded',requested_uptime_s:10,updated_uptime_s:20};
const otherBrowser={request_id:'b',state:'queued',requested_uptime_s:30,updated_uptime_s:30};
if(!accept(oldDone,otherBrowser,false))throw Error('terminal ID pins another browser forever');
if(!accept(oldDone,otherBrowser,false))throw Error('unconfirmed RPC cannot reconcile server request');
const ownNew={request_id:'c',state:'queued',requested_uptime_s:40,updated_uptime_s:40};
if(accept(ownNew,oldDone,true))throw Error('old polling overwrites owned pending request');
if(!accept(ownNew,{...otherBrowser,request_id:'d',requested_uptime_s:50,updated_uptime_s:50},true))throw Error('newer server slot cannot reconcile a missed terminal update');
if(accept(oldDone,{...oldDone,state:'retrying',updated_uptime_s:19},false))throw Error('old polling regresses acknowledged upload');
'''
        subprocess.check_call(['node','-e',script,str(VIEW)])

    def test_snapshot_errors_explain_both_permissions_and_collection(self):
        script = r'''
const source = require('fs').readFileSync(process.argv[1], 'utf8');
const prefix = source.slice(0, source.indexOf('return view.extend('));
const texts = [];
const notify = new Function('rpc','ui','E','_', prefix + ';return notify;')(
  {declare:()=>()=>{}}, {addNotification:(_,text)=>texts.push(text)}, (_,attrs,text)=>text, text=>text
);
for (const error of ['diagnostics_disabled','cloud_diagnostics_disabled','snapshot_not_yet_available','future_unknown_error']) notify({ok:false,error}, '');
process.stdout.write(JSON.stringify(texts));
'''
        messages=json.loads(subprocess.check_output(['node','-e',script,str(VIEW)],text=True))
        self.assertIn('Allow requested snapshots',messages[0]);self.assertIn('Save & Apply',messages[0])
        self.assertIn('Settings',messages[1]);self.assertIn('Permit locally enabled diagnostics',messages[1]);self.assertIn('30 seconds',messages[1])
        self.assertIn('next collection',messages[2])
        self.assertIn('future_unknown_error',messages[3])

if __name__=='__main__':unittest.main()
