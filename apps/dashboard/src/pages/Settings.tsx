import { useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, Plus, ShieldAlert } from 'lucide-react';
import { ownerApi, db } from '../lib/client';
import { copyText } from '../lib/async';
import { useMonitor, useQuery } from '../lib/data';
import { bytes, cloudConfig, date, fmt, retainedSampleEstimate, sentenceCase, type Row } from '../lib/model';
import { Button, Card, Dialog, Input, Notice, QueryState } from '../components/ui/primitives';
import { ActionButton, ActionForm, ActionSubmit } from '../components/Actions';
import { DataTable, Fields } from '../components/Shared';

const cadenceFields = [
  ['sample_interval', 'Sample interval (s)', 5, 300, 10],
  ['upload_interval', 'Upload interval (s)', 15, 900, 30],
  ['wifi_interval', 'Wi-Fi interval (s)', 15, 900, 30],
  ['process_interval', 'Process interval (s)', 30, 1800, 60],
  ['detail_interval', 'Detail interval (s)', 60, 3600, 300],
] as const;

const retentionFields = [
  ['retention_raw_days', 'Raw retention (days)', 1, 7, 3],
  ['retention_logs_days', 'Log retention (days)', 1, 14, 7],
  ['monthly_quota_gb', 'Internet quota (GB; 0 disables)', 0, 100000, 0],
  ['billing_day', 'Billing-cycle start day', 1, 28, 1],
] as const;

export function Enrollment() {
  const { zone } = useMonitor();
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [expires, setExpires] = useState('');
  const dialogVersion = useRef(0);
  const dialogOpen = useRef(false);

  useEffect(
    () => () => {
      dialogVersion.current++;
      dialogOpen.current = false;
    },
    [],
  );

  return (
    <Dialog
      onOpenChange={(open) => {
        dialogVersion.current++;
        dialogOpen.current = open;
        if (!open) {
          setToken('');
          setExpires('');
        }
      }}
      title="Enroll a router"
      description="Create a short-lived, one-use code and enter it in the router's Nicx Monitor setup. The router initiates every connection."
      trigger={
        <Button variant="default">
          <Plus size={15} /> Add router
        </Button>
      }
    >
      <ActionForm
        className="stack"
        pending="Creating a one-use enrollment code…"
        success="Enrollment code created. Copy it into the router's local setup before it expires."
        onSubmit={async (_form, action) => {
          const generation = dialogVersion.current;
          setToken('');
          const result = await ownerApi('/api/v1/enrollment', { name }, 'POST', action.signal);
          action.signal.throwIfAborted();
          if (!dialogOpen.current || dialogVersion.current !== generation) {
            throw new Error('An enrollment code was created after this dialog closed. Create a fresh code; the unused code will expire automatically.');
          }
          setToken(result.token);
          setExpires(result.expires_at);
        }}
      >
        <label>
          Router name
          <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Home · JIDU6111" />
        </label>
        <ActionSubmit variant="default" pendingLabel="Creating code…">Create enrollment code</ActionSubmit>
      </ActionForm>
      {token && (
        <div className="secret">
          <label>
            One-use enrollment code
            <textarea readOnly value={token} />
          </label>
          <ActionButton pendingLabel="Copying code…" successMessage="Enrollment code copied to your clipboard." onAction={() => copyText(token)}>
            <Copy size={14} /> Copy code
          </ActionButton>
          <p>
            Expires {date(expires, zone, true)}. Keep this code private — it is shown only in this open dialog. Enter it in LuCI → Services → Nicx
            Telemetry to pair your router.
          </p>
        </div>
      )}
    </Dialog>
  );
}

export function Settings() {
  const { device, zone, setZone, theme, setTheme, refresh, tick, refreshSeconds, setRefreshSeconds } = useMonitor();
  const context = useRef({ deviceId: device!.id, generation: 0 });
  if (context.current.deviceId !== device!.id) context.current = { deviceId: device!.id, generation: context.current.generation + 1 };
  useEffect(
    () => () => {
      context.current.generation++;
    },
    [],
  );

  const [name, setName] = useState(device?.name || '');
  const [config, setConfig] = useState<Row>({});
  const [credential, setCredential] = useState<{ deviceId: string; token: string } | null>(null);
  const [confirmation, setConfirmation] = useState('');

  const token = credential?.deviceId === device!.id ? credential.token : '';
  const setToken = (value: string) => setCredential(value ? { deviceId: context.current.deviceId, token: value } : null);

  useEffect(() => {
    setName(device?.name || '');
    setConfig({ ...device?.config });
    setToken('');
    setConfirmation('');
  }, [device?.id]);

  const clients = useQuery(
    () => db!.from('client_names').select('*').eq('device_id', device!.id).order('client_id').limit(200),
    [device?.id, tick],
  );

  const path = `/api/v1/devices/${device!.id}`;
  async function mutate(endpoint: string, body?: unknown, method = 'POST', signal?: AbortSignal) {
    const result = await ownerApi(endpoint, body, method, signal);
    signal?.throwIfAborted();
    refresh();
    return result;
  }

  return (
    <>
      <div className="two-col">
        <Card title="Display preferences" description="Saved immediately in this browser. All timestamps are stored in UTC.">
          <div className="stack">
            <label>
              Timezone
              <select value={zone} onChange={(e) => setZone(e.target.value)}>
                {Array.from(new Set(['Asia/Kolkata', 'UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/New_York', 'Europe/London', 'Asia/Singapore'])).map(
                  (z) => (
                    <option key={z}>{z}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              Polling fallback
              <select value={refreshSeconds} onChange={(e) => setRefreshSeconds(Number(e.target.value))}>
                {[10, 30, 60, 300].map((n) => (
                  <option value={n} key={n}>
                    {n} seconds
                  </option>
                ))}
              </select>
            </label>
            <label>
              Appearance
              <select value={theme} onChange={(e) => setTheme(e.target.value)}>
                <option value="dark">Dark (Obsidian)</option>
                <option value="light">Light (Architectural)</option>
              </select>
            </label>
          </div>
        </Card>

        <Card title="Router identity">
          <ActionForm
            className="stack"
            pending="Saving the router name…"
            success="Router name saved in the cloud."
            onSubmit={(_form, action) => mutate(path, { name }, 'PATCH', action.signal)}
          >
            <label>
              Friendly name
              <Input value={name} required maxLength={80} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="small muted">
              Device ID <code>{device?.id}</code>
            </p>
            <ActionSubmit pendingLabel="Saving name…">Save router name</ActionSubmit>
          </ActionForm>
        </Card>
      </div>

      <Card
        title="Agent collection and retention"
        description="Defaults are shown for unconfigured cloud values. The router applies the slower of its local and cloud collection intervals."
      >
        <ActionForm
          className="stack"
          pending="Saving collection permissions and intervals…"
          success="Cloud configuration saved. The router receives it with its next successful upload; local permissions still apply."
          onSubmit={(_form, action) => mutate(path + '/config', cloudConfig(config), 'POST', action.signal)}
        >
          <p className="form-section-title">Collection cadence</p>
          <div className="form-grid">
            {cadenceFields.map(([key, label, min, max, fallback]) => (
              <label key={key}>
                {label}
                <Input
                  type="number"
                  required
                  min={min}
                  max={max}
                  step="1"
                  value={String(config[key] ?? fallback)}
                  onChange={(e) => setConfig((c) => ({ ...c, [key]: Number(e.target.value) }))}
                />
              </label>
            ))}
          </div>

          <p className="form-section-title">Retention &amp; bandwidth quota</p>
          <div className="form-grid">
            {retentionFields.map(([key, label, min, max, fallback]) => (
              <label key={key}>
                {label}
                <Input
                  type="number"
                  required
                  min={min}
                  max={max}
                  step="1"
                  value={String(config[key] ?? fallback)}
                  onChange={(e) => setConfig((c) => ({ ...c, [key]: Number(e.target.value) }))}
                />
              </label>
            ))}
          </div>

          <div className="check-group">
            {[
              ['logs_enabled', 'Permit locally enabled logs', true],
              ['diagnostics_enabled', 'Permit locally enabled diagnostics', false],
            ].map(([key, label, fallback]) => (
              <label className="check" key={String(key)}>
                <input
                  type="checkbox"
                  checked={Boolean(config[String(key)] ?? fallback)}
                  onChange={(e) => setConfig((c) => ({ ...c, [String(key)]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
          </div>
          <Notice>
            Cloud permission can stop logs or diagnostics. Enabling either here also requires permission in the router's local setup. Faster sampling
            than the local limits is not enabled remotely.
          </Notice>
          <ActionSubmit pendingLabel="Saving settings…">Save collection settings</ActionSubmit>
        </ActionForm>
      </Card>

      <Card
        title="Router-local controls"
        description="Change these in the router's local monitor setup. The dashboard does not report their current local values."
      >
        <div className="form-grid">
          {['Memory queue limit', 'Log severity threshold', 'Address privacy'].map((label) => (
            <label key={label}>
              {label}
              <Input readOnly value="Managed on the router" aria-readonly="true" />
            </label>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          These fields are not sent with cloud configuration updates. The cloud additionally redacts addresses before storage.
        </p>
      </Card>

      <Usage config={config} zone={zone} />

      <Card
        title="Client names"
        description="Friendly names refer only to the local anonymized client identifier seen on the Wi-Fi page. Up to 200 names shown."
      >
        <ActionForm
          className="filters"
          pending="Saving the client name…"
          success="Client name saved."
          onSubmit={async (form, action, values) => {
            await mutate(`${path}/client-names/${encodeURIComponent(String(values.get('client')))}`, { name: values.get('name') }, 'PUT', action.signal);
            form.reset();
          }}
        >
          <label>
            Local client identifier
            <Input name="client" required maxLength={128} pattern="[a-zA-Z0-9_-]+" placeholder="Anonymized ID from local agent" />
          </label>
          <label>
            Friendly name
            <Input name="name" required maxLength={80} placeholder="Living room laptop" />
          </label>
          <ActionSubmit pendingLabel="Saving client…">Save client name</ActionSubmit>
        </ActionForm>
        <QueryState
          {...clients}
          empty={!clients.data?.length}
          emptyTitle="No client names saved"
          emptyMessage="Save a friendly name above to label anonymized Wi-Fi stations on the Wi-Fi page."
        >
          <DataTable
            data={clients.data || []}
            columns={[
              { key: 'client_id', label: 'Client identifier', render: (v) => <code>{String(v ?? '')}</code> },
              {
                key: 'name',
                label: 'Friendly name',
                render: (v, row) => (
                  <ActionForm
                    className="inline-form"
                    pending="Saving this client name…"
                    success="Client name updated."
                    onSubmit={(_form, action, values) =>
                      mutate(`${path}/client-names/${encodeURIComponent(String(row.client_id))}`, { name: values.get('name') }, 'PUT', action.signal)
                    }
                  >
                    <Input name="name" defaultValue={String(v || '')} maxLength={80} required aria-label={`Name for ${row.client_id}`} />
                    <ActionSubmit pendingLabel="Saving…">Save</ActionSubmit>
                  </ActionForm>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>

      <Card
        title="Credentials and removal"
        description="Rotating immediately invalidates the old credential. Update the agent afterward to resume uploads. Credentials are never stored in dashboard preferences."
      >
        <div className="action-row">
          <ActionButton
            actionKey={`rotate:${device!.id}`}
            pendingLabel="Rotating credential…"
            successMessage={`Credential rotated for ${device!.name}. Replace it on that router before uploads can resume.`}
            onAction={async (action) => {
              const generation = context.current.generation;
              setToken('');
              const result = await mutate(path + '/rotate', undefined, 'POST', action.signal);
              action.signal.throwIfAborted();
              if (context.current.generation !== generation) {
                throw new Error('The previous router credential was rotated after you changed routers. Switch back and rotate again to obtain a fresh credential.');
              }
              setToken(result.token);
            }}
          >
            <KeyRound size={15} /> Rotate device credential
          </ActionButton>
          <Dialog
            title="Revoke or remove this router"
            description="Revocation stops new uploads immediately. Deletion also removes the router and its stored history. This cannot be undone."
            trigger={
              <Button variant="destructive">
                <ShieldAlert size={15} /> Revoke / delete
              </Button>
            }
          >
            <label>
              Type {device?.name} to confirm
              <Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" />
            </label>
            <div className="action-row">
              <ActionButton
                variant="destructive"
                disabled={confirmation !== device?.name}
                pendingLabel="Revoking uploads…"
                successMessage="Uploads revoked. This router can no longer send telemetry with its current credential."
                onAction={(action) => mutate(path + '/revoke', undefined, 'POST', action.signal)}
              >
                Revoke uploads
              </ActionButton>
              <ActionButton
                variant="destructive"
                disabled={confirmation !== device?.name}
                pendingLabel="Deleting router and history…"
                successMessage="Router and its stored database history deleted. Private archive cleanup is processed separately."
                onAction={(action) => mutate(path, undefined, 'DELETE', action.signal)}
              >
                Delete router and history
              </ActionButton>
            </div>
          </Dialog>
        </div>
        {token && (
          <div className="secret">
            <label>
              New device credential · replace the agent's stored credential now
              <textarea readOnly value={token} />
            </label>
            <div className="action-row">
              <ActionButton pendingLabel="Copying credential…" successMessage="Device credential copied to your clipboard." onAction={() => copyText(token)}>
                Copy credential
              </ActionButton>
              <Button onClick={() => setToken('')}>Dismiss permanently</Button>
            </div>
            <p>The previous credential was invalidated. Uploads resume after updating the router.</p>
          </div>
        )}
      </Card>
    </>
  );
}

function Usage({ config, zone }: { config: Row; zone: string }) {
  const [data, setData] = useState<Row | null>(null);
  const interval = Number(config.sample_interval || 10);
  const upload = Number(config.upload_interval || 30);
  const retention = Number(config.retention_raw_days || 3);

  return (
    <Card title="Monitoring budget" description="Planning estimates are not provider metering or billing. Logs and optional diagnostics add variable usage.">
      <div className="stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <span className="eyebrow">Samples / day / router</span>
          <strong className="budget-number">{fmt(86400 / interval, '', 0)}</strong>
        </div>
        <div className="stat">
          <span className="eyebrow">Upload requests / month</span>
          <strong className="budget-number">{fmt((30 * 86400) / upload, '', 0)}</strong>
        </div>
        <div className="stat">
          <span className="eyebrow">Retained raw samples</span>
          <strong className="budget-number">{fmt(retainedSampleEstimate(interval, retention), '', 0)}</strong>
        </div>
      </div>
      <Notice>
        Raw retention is capped at 30,000 samples per router; the estimate uses the lower of that cap and the requested retention window. Actual coverage
        can be lower due to dropped samples or storage limits. At an illustrative 1 KiB per sample, raw payload alone is about{' '}
        {bytes(((30 * 86400) / interval) * 1024)} per 30 days per router. Actual JSON size, database indexes, Realtime fan-out, logs, archives and retries
        vary. Billing cycles and provider free-tier quotas must be checked with the provider.
      </Notice>
      <ActionButton
        pendingLabel="Reading measured project usage…"
        successMessage="Measured project usage received from the service."
        onAction={async (action) => {
          const result = await ownerApi('/api/v1/usage', undefined, 'GET', action.signal);
          action.signal.throwIfAborted();
          setData(result);
        }}
      >
        Read measured project usage
      </ActionButton>
      {data && (
        <div className="kv-grid" style={{ marginTop: 14 }}>
          {Object.entries(data).map(([k, v]) => {
            let formatted = v === null ? 'Unknown' : String(v);
            if (typeof v === 'number') {
              formatted = k.endsWith('_bytes') ? bytes(v) : v.toLocaleString();
            } else if (typeof v === 'string' && k.endsWith('_at')) {
              formatted = date(v, zone, true);
            }
            return (
              <div className="kv-box" key={k}>
                <span>{sentenceCase(k.replaceAll('_', ' '))}</span>
                <strong>{formatted}</strong>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
