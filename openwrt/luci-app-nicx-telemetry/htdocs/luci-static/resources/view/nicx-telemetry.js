'use strict';
'require view';
'require form';
'require rpc';
'require ui';
'require poll';
'require uci';

var status = rpc.declare({ object: 'nicx.telemetry', method: 'status', expect: {} });
var test = rpc.declare({ object: 'nicx.telemetry', method: 'test', expect: {} });
var enroll = rpc.declare({ object: 'nicx.telemetry', method: 'enroll', params: ['endpoint', 'enrollment_token', 'name'], expect: {} });
var snapshot = rpc.declare({ object: 'nicx.telemetry', method: 'snapshot', params: ['kind'], expect: {} });
var setToken = rpc.declare({ object: 'nicx.telemetry', method: 'set_token', params: ['token'], expect: {} });
var restart = rpc.declare({ object: 'nicx.telemetry', method: 'restart', expect: {} });

function actionError(error) {
    var errors = {
        diagnostics_disabled: _('Enable "Allow requested snapshots" on this page, then Save & Apply before requesting a snapshot.'),
        cloud_diagnostics_disabled: _('In dashboard Settings, enable "Permit locally enabled diagnostics", save, and wait about 30 seconds for the router to receive permission.'),
        snapshot_not_yet_available: _('Telemetry has not collected this snapshot yet. Ensure telemetry is enabled, then wait for its next collection and try again.'),
        snapshot_in_progress: _('A snapshot is already waiting or uploading. Wait for its result below before requesting another.'),
        invalid_https_origin: _('Enter the saved HTTPS Worker origin without a path or trailing slash.'),
        invalid_enrollment_token: _('Paste a valid one-use enrollment token from the dashboard.'),
        enrollment_failed: _('Enrollment was not confirmed. Check the connection and token expiry; create a fresh token if needed.'),
        enrollment_stop_failed: _('The router could not stop telemetry safely. Check the running status and use a fresh enrollment token to try again.'),
        enrollment_config_write_failed: _('The router could not save the new enrollment settings. The previous enrollment was kept. Use a fresh token to try again.'),
        enrollment_credential_write_failed: _('The router could not store the new enrollment credential. Use a fresh enrollment token to try again.'),
        enrollment_rollback_failed: _('The router could not restore its previous enrollment. Re-enroll with a fresh token before restarting telemetry.'),
        credential_operation_in_progress: _('Another credential action is running. Wait for it to finish before trying again.'),
        credential_write_failed: _('The router could not save this credential. The previous credential was kept.'),
        invalid_device_credential: _('The credential format is invalid. Paste the complete credential returned by dashboard rotation.'),
        restart_failed: _('Telemetry could not restart. Check the saved configuration and the running status above.'),
        telemetry_stopped: _('Telemetry stopped before an acknowledgment. Start it again to retry this request.'),
        request_unconfirmed: _('The router did not confirm this action. Check the connection and status before trying again.'),
        authentication_rejected: _('Credentials were rejected. Replace the rotated credential; this snapshot will retry.'),
        credentials_unavailable: _('The device credential is missing or has unsafe permissions. Repair it before retrying.'),
        upload_failed: _('The upload connection failed. Waiting for the scheduled retry.'),
        server_rate_limited: _('The server requested a pause. Waiting for the scheduled retry.'),
        diagnostic_receipt_unconfirmed: _('The server has not confirmed that this snapshot was stored. Waiting to retry.'),
        diagnostic_storage_budget: _('The server storage budget prevented saving this snapshot. Free space or adjust retention, then request a fresh snapshot.'),
        diagnostic_storage_rejected: _('The server did not store this snapshot. Check its storage settings before requesting another.'),
        not_accepted: _('The server has not accepted the snapshot. Waiting to retry.'),
        invalid_response: _('The server response could not be verified. Waiting to retry.'),
        invalid_payload_discarded: _('The server rejected this batch and it was discarded. Request a fresh snapshot after correcting the problem.'),
        privacy_policy_changed: _('This batch was discarded because the local privacy or logging policy changed.'),
        snapshot_interrupted: _('Snapshot preparation was interrupted. Request a fresh snapshot.')
    };
    if(typeof error==='string' && error.indexOf('connection_or_authentication_failed_')===0)return _('Connection test failed. Check the saved Worker origin, DNS, clock and device credential, then try again.');
    return errors[error] || error || _('No response');
}
function notify(result, success) {
    ui.addNotification(null, E('p', {}, result.ok ? success : _('Could not complete the action: ') + actionError(result.error)), result.ok ? 'info' : 'error');
}
function setActionFeedback(nodes, text, state) {
    (Array.isArray(nodes) ? nodes : [nodes]).forEach(function(node) {
        if (!node) return;
        node.textContent = text;
        node.dataset.state = state;
    });
}
function runAction(button, feedback, operation, pending, success) {
    if (button.disabled) return Promise.resolve({ok:false, ignored:true});
    button.disabled = true;
    button.classList.add('spinning');
    button.setAttribute('aria-busy', 'true');
    setActionFeedback(feedback, pending || _('Working…'), 'pending');
    return Promise.resolve().then(operation).then(function(result) {
        result = result || {ok:false, error:'request_unconfirmed'};
        var text = result.ok ? (typeof success === 'function' ? success(result) : success) : actionError(result.error);
        setActionFeedback(feedback, text, result.ok ? 'success' : 'error');
        return result;
    }).catch(function() {
        setActionFeedback(feedback, actionError('request_unconfirmed'), 'error');
        return {ok:false, error:'request_unconfirmed'};
    }).finally(function() {
        button.disabled = false;
        button.classList.remove('spinning');
        button.removeAttribute('aria-busy');
    });
}
function acceptSnapshotStatus(current, incoming, ownPending) {
    if(!incoming || !incoming.request_id)return false;
    if(!current || !current.request_id)return true;
    if(current.boot_id && incoming.boot_id && current.boot_id!==incoming.boot_id)return true;
    var currentTime=Number(current.requested_uptime_s), incomingTime=Number(incoming.requested_uptime_s);
    var hasTimes=Number.isFinite(currentTime) && Number.isFinite(incomingTime);
    if(hasTimes && incomingTime<currentTime)return false;
    if(current.request_id===incoming.request_id){
        if(['uploaded','failed'].indexOf(current.state)>=0 && ['queued','uploading','retrying'].indexOf(incoming.state)>=0)return false;
        if(Number(incoming.updated_uptime_s)<Number(current.updated_uptime_s))return false;
        return true;
    }
    // A newer server request proves the previous slot was released. Older polling
    // must not overwrite a just-confirmed local request before status catches up.
    return !ownPending || (hasTimes && incomingTime>currentTime);
}
function statusText(s) {
    if (!s.running) return s.enrolled ? _('Stopped. Enable telemetry and save to start.') : _('Not enrolled. Connect this router with a one-use enrollment token.');
    return [
        _('Running'),
        _('RAM queue: %s KiB').format(Math.ceil((s.queue_bytes || 0) / 1024)),
        _('Dropped items: %s').format(s.dropped_items || 0),
        _('Uploads: %s successful, %s failed').format(s.successful_uploads || 0, s.failed_uploads || 0),
        _('Agent parent only: %s KiB RSS, %s KiB peak, CPU share of total machine %s').format(s.parent_rss_kb == null ? '—' : s.parent_rss_kb, s.parent_peak_rss_kb == null ? '—' : s.parent_peak_rss_kb, s.parent_cpu_pct == null ? '—' : Number(s.parent_cpu_pct).toFixed(2) + '%'),
        _('Dropped log occurrences: %s').format(s.dropped_logs || 0),
        s.clock_synced ? _('Clock synchronized') : _('Clock unverified; server receipt time will be used'),
        s.last_error ? _('Last upload issue: ') + s.last_error : _('Upload connection ready'),
        s.pending ? _('A batch is waiting for acknowledgment') : '',
        s.adaptive_sampling ? _('Reduced collection under %s pressure (%s second samples)').format(s.pressure_reason || _('system'), s.effective_sample_interval) : ''
    ].filter(Boolean).join(' · ');
}

return view.extend({
    load: function() { return Promise.all([uci.load('nicx-telemetry'), status()]); },
    render: function(data) {
        var m = new form.Map('nicx-telemetry', _('Router telemetry'), _('Private router health, traffic totals and redacted system logs are sent over verified HTTPS. Queues stay in RAM and disappear on reboot. Router networking continues independently.'));
        var s = m.section(form.NamedSection, 'main', 'telemetry', _('Collection settings'));
        var o = s.option(form.Flag, 'enabled', _('Enable telemetry')); o.rmempty = false;
        o = s.option(form.Value, 'endpoint', _('Worker HTTPS origin'), _('For example https://router.example.workers.dev. No path, query string or trailing slash.'));
        o.placeholder = 'https://router.example.workers.dev';
        o.validate = function(section, value) {
            if (!value) return true;
            return /^https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z][a-zA-Z0-9.-]*$/.test(value) && value.indexOf('..') < 0 ? true : _('Enter an HTTPS origin with a public domain name.');
        };
        o = s.option(form.Flag, 'adaptive_sampling', _('Reduce collection under sustained pressure'), _('Slows collection when CPU, memory or buffer pressure persists; restores normal intervals after recovery.'));o.rmempty = false;
        o = s.option(form.Value, 'device_id', _('Device ID')); o.readonly = true;
        [['sample_interval', _('System samples (seconds)'), 5, 300],
         ['upload_interval', _('Uploads (seconds)'), 10, 900],
         ['wifi_interval', _('Wi-Fi detail (seconds)'), 15, 900],
         ['process_interval', _('Process memory (seconds)'), 30, 1800],
         ['detail_interval', _('Extended detail (seconds)'), 60, 3600],
         ['buffer_kb', _('Maximum RAM buffer (KiB)'), 1024, 2048]].forEach(function(item) {
            var opt = s.option(form.Value, item[0], item[1]); opt.datatype = 'range(%s,%s)'.format(item[2], item[3]); opt.rmempty = false;
        });
        o = s.option(form.Flag, 'logs_enabled', _('Export redacted system logs'));o.rmempty = false;
        o = s.option(form.ListValue, 'log_severity', _('Log threshold'));o.depends('logs_enabled','1');
        [['0',_('Emergency')],['1',_('Alert')],['2',_('Critical')],['3',_('Error')],['4',_('Warning')],['5',_('Notice')],['6',_('Information')],['7',_('Debug')]].forEach(function(item) {o.value(item[0],item[1]);});
        o = s.option(form.Flag, 'privacy_addresses', _('Include addresses in log messages'), _('Off by default. Wi-Fi client IDs remain salted hashes. DNS queries, URLs and credential-bearing messages are always suppressed.'));o.rmempty = false;
        o = s.option(form.Flag, 'diagnostics_enabled', _('Allow requested snapshots'), _('Requires permission here and in the dashboard. Only cached summaries or the installed-package list; no arbitrary files, commands or debugfs changes.'));o.rmempty = false;
        o = s.option(form.Flag, 'probes_enabled', _('Optional internet reachability checks'), _('Two bounded IPv4/IPv6 and gateway pings plus a fixed DNS lookup every 30 seconds. ICMP filtering can look like packet loss.'));o.rmempty = false;
        o = s.option(form.Value, 'probe_ipv4', _('IPv4 probe address'));o.datatype = 'ip4addr';o.depends('probes_enabled','1');
        o = s.option(form.Value, 'probe_ipv6', _('IPv6 probe address'));o.datatype = 'ip6addr';o.depends('probes_enabled','1');

        var statusNode = E('p', {'role':'status', 'aria-live':'polite'}, statusText(data[1]));
        function feedbackNode() { return E('p', {'class':'cbi-value-description', 'role':'status', 'aria-live':'polite'}, ''); }
        function actionRow(label, operation, pending, success) {
            var feedback = feedbackNode();
            var button = E('button', {'type':'button', 'class':'cbi-button cbi-button-action', 'click':function() {
                return runAction(button, feedback, operation, pending, success);
            }}, label);
            return {button:button, feedback:feedback, row:E('div', {'class':'cbi-value'}, [button,feedback])};
        }
        var enrollFeedback = feedbackNode();
        var enrollButton = E('button', {'type':'button','class':'cbi-button cbi-button-action','click':function() {
            var endpointInput = E('input', {'class':'cbi-input-text','type':'url','value':uci.get('nicx-telemetry','main','endpoint') || '', 'aria-label':_('Worker HTTPS origin')});
            var nameInput = E('input', {'class':'cbi-input-text','type':'text','value':'JIDU6111','maxlength':'64','aria-label':_('Device name')});
            var tokenInput = E('input', {'class':'cbi-input-text','type':'password','autocomplete':'off','maxlength':'128','aria-label':_('One-use enrollment token')});
            var modalFeedback = feedbackNode();
            var cancel = E('button', {'type':'button','class':'cbi-button','click':function() {
                tokenInput.value='';ui.hideModal();setActionFeedback(enrollFeedback,_('Enrollment cancelled.'),'cancelled');
            }},_('Cancel'));
            var submit = E('button', {'type':'button','class':'cbi-button cbi-button-positive','click':function() {
                var submittedOrigin = endpointInput.value, submittedName = nameInput.value;
                var token = tokenInput.value;tokenInput.value='';cancel.disabled=true;enrollButton.disabled=true;
                return runAction(submit,[modalFeedback,enrollFeedback],function() {
                    return enroll(submittedOrigin,token,submittedName).finally(function(){token='';});
                },_('Enrolling router…'),function(result) {
                    return result.restart_required ? _('Enrollment saved. Restart telemetry to use the new device ID.') : (result.restarted ? _('Router enrolled; telemetry restarted with the new device ID.') : _('Router enrolled. Enable telemetry and Save & Apply to start.'));
                }).then(function(result) {
                    if(result.ok) {
                        uci.set('nicx-telemetry','main','endpoint',submittedOrigin);
                        uci.set('nicx-telemetry','main','device_id',result.device_id);
                        ['endpoint','device_id'].forEach(function(key) {
                            var option=m.lookupOption(key,'main')[0];
                            var widget=option && option.getUIElement('main');
                            if(widget)widget.setValue(key==='endpoint'?submittedOrigin:result.device_id);
                        });
                        ui.hideModal();
                    }
                }).finally(function(){cancel.disabled=false;enrollButton.disabled=false;});
            }},_('Enroll'));
            ui.showModal(_('Connect this router'),[
                E('p',{},_('Create a short-lived enrollment token in the dashboard. The device credential is stored privately and never displayed.')),
                E('label',{},[_('Worker origin'),endpointInput]),E('label',{},[_('Device name'),nameInput]),E('label',{},[_('One-use token'),tokenInput]),
                modalFeedback,E('div',{'class':'right'},[cancel,submit])
            ]);
        }},_('Enroll router'));
        var testAction=actionRow(_('Test connection'),test,_('Testing saved HTTPS connection and credentials…'),_('Connection verified: HTTPS and device authentication succeeded.'));
        var restartAction=actionRow(_('Restart telemetry'),restart,_('Restarting telemetry using saved settings…'),_('Restart completed. The status above will confirm whether telemetry is running.'));
        var tokenFeedback=feedbackNode();
        var tokenButton=E('button',{'type':'button','class':'cbi-button','click':function(){
            var tokenInput=E('input',{'type':'password','autocomplete':'off','maxlength':'128','class':'cbi-input-text','aria-label':_('New device credential')});
            var modalFeedback=feedbackNode();
            var cancel=E('button',{'type':'button','class':'cbi-button','click':function(){tokenInput.value='';ui.hideModal();setActionFeedback(tokenFeedback,_('Credential replacement cancelled.'),'cancelled');}},_('Cancel'));
            var submit=E('button',{'type':'button','class':'cbi-button cbi-button-positive','click':function(){
                var token=tokenInput.value;tokenInput.value='';cancel.disabled=true;tokenButton.disabled=true;
                return runAction(submit,[modalFeedback,tokenFeedback],function(){return setToken(token).finally(function(){token='';});},_('Saving the new credential…'),_('Credential saved. The next upload will use it.'))
                    .then(function(result){if(result.ok)ui.hideModal();})
                    .finally(function(){cancel.disabled=false;tokenButton.disabled=false;});
            }},_('Replace credential'));
            ui.showModal(_('Replace device credential'),[E('p',{},_('Paste the credential returned by dashboard rotation. The router ID is kept.')),tokenInput,modalFeedback,E('div',{'class':'right'},[cancel,submit])]);
        }},_('Replace rotated credential'));
        var snapshotNode=feedbackNode();
        snapshotNode.textContent=_('No snapshot requested in this session.');
        var snapshotBoot=null, snapshotBusy=false, ownSnapshotActive=false, latestSnapshot=null, snapshotButtons=[], snapshotFeedback={};
        function syncSnapshotButtons(){snapshotButtons.forEach(function(button){button.disabled=snapshotBusy;});}
        function showSnapshot(meta){
            if(!acceptSnapshotStatus(latestSnapshot,meta,ownSnapshotActive))return;
            if(latestSnapshot && latestSnapshot.request_id!==meta.request_id)ownSnapshotActive=false;
            latestSnapshot=meta;
            snapshotBusy=['queued','uploading','retrying'].indexOf(meta.state)>=0;
            if(!snapshotBusy)ownSnapshotActive=false;
            var messages={queued:_('Queued locally; waiting for the next upload.'),uploading:_('Uploading snapshot…'),retrying:_('Waiting to retry: ')+actionError(meta.reason),uploaded:_('Uploaded and accepted by the server.'),failed:_('Snapshot failed: ')+actionError(meta.reason)};
            var text=(meta.kind || _('Snapshot'))+': '+(messages[meta.state] || _('Waiting for status.'));
            snapshotNode.title=meta.request_id;
            setActionFeedback(snapshotNode,text,meta.state);
            if(snapshotFeedback[meta.kind])setActionFeedback(snapshotFeedback[meta.kind],text,meta.state);
            syncSnapshotButtons();
        }
        function showSnapshotStatus(result){
            if(result.boot_id && result.boot_id!==snapshotBoot){
                if(snapshotBoot){
                    latestSnapshot=null;ownSnapshotActive=false;snapshotBusy=false;
                    snapshotNode.title='';
                    setActionFeedback(snapshotNode,_('No snapshot requested since the router restarted.'),'');
                    Object.keys(snapshotFeedback).forEach(function(kind){setActionFeedback(snapshotFeedback[kind],'','');});
                    syncSnapshotButtons();
                }
                snapshotBoot=result.boot_id;
            }
            showSnapshot(result.snapshot);
        }
        var snapshots=E('div',{},['memory','network','wifi','packages'].map(function(kind){
            var names={memory:_('Memory'),network:_('Interfaces'),wifi:_('Wi-Fi'),packages:_('Installed packages')};
            var feedback=feedbackNode();snapshotFeedback[kind]=feedback;
            var button=E('button',{'type':'button','class':'cbi-button','click':function(){
                if(snapshotBusy)return;
                var requestBoot=snapshotBoot;
                return runAction(button,feedback,function(){
                    snapshotBusy=true;syncSnapshotButtons();
                    return snapshot(kind);
                },_('Requesting snapshot…'),_('Queued locally. Waiting for the upload result below.')).then(function(result){
                    if(result.ignored)return;
                    if(result.ok){
                        if(snapshotBoot && result.boot_id && snapshotBoot!==result.boot_id)return;
                        ownSnapshotActive=true;showSnapshot(result);
                    }
                    else if(requestBoot===snapshotBoot){ownSnapshotActive=false;snapshotBusy=result.error==='snapshot_in_progress';}
                }).finally(syncSnapshotButtons);
            }},_('Snapshot: ')+names[kind]);
            snapshotButtons.push(button);return E('div',{'class':'cbi-value'},[button,feedback]);
        }));
        showSnapshotStatus(data[1]);
        poll.add(function(){return status().then(function(result){statusNode.textContent=statusText(result);showSnapshotStatus(result);}).catch(function(){statusNode.textContent=_('Could not refresh router status. The last action result remains below.');});},5);
        var controls=E('div',{'class':'cbi-section'},[
            E('h3',{},_('Connection and privacy')),statusNode,
            E('div',{'class':'cbi-value'},[enrollButton,enrollFeedback]),testAction.row,restartAction.row,
            E('div',{'class':'cbi-value'},[tokenButton,tokenFeedback]),
            E('p',{},_('Save & Apply collection settings below before restarting. A connection test failure can reflect DNS, clock, TLS, internet access or credentials; it does not prove an ISP outage.')),
            E('h4',{},_('Requested snapshots')),snapshots,snapshotNode
        ]);
        return m.render().then(function(node){return E('div', {}, [controls,node]);});
    }
});
