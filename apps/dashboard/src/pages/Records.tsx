import { useEffect, useState } from 'react';
import { db, ownerApi } from '../lib/client';
import { useMonitor, useQuery } from '../lib/data';
import {
  ALERT_METRICS,
  date,
  durationShort,
  fmt,
  matchUptimeWindows,
  mib,
  num,
  object,
  rate,
  relativeAge,
  ruleCategoryLabel,
  sentenceCase,
  timeRangeKey,
  type Row,
  type Sample,
  type TimeRange,
} from '../lib/model';
import { Button, Card, Empty, Input, Notice, QueryState } from '../components/ui/primitives';
import { ComparisonChart, DataTable, Export, Fields } from '../components/Shared';
import { ActionButton, ActionForm, ActionStatus, ActionSubmit, useAction } from '../components/Actions';

const severity = ['Emergency', 'Alert', 'Critical', 'Error', 'Warning', 'Notice', 'Info', 'Debug'];

export function Logs() {
  const { device, range, zone } = useMonitor();
  const [level, setLevel] = useState('7');
  const [service, setService] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState({ level: '7', service: '', search: '' });
  const [cursors, setCursors] = useState<{ time: string; id: string }[]>([]);
  const [pagingRange, setPagingRange] = useState<TimeRange | null>(null);

  const queryRange = pagingRange || range;
  const rangeIdentity = timeRangeKey(range);
  const cursor = cursors.at(-1);

  useEffect(() => {
    setCursors([]);
    setPagingRange(null);
  }, [device?.id, rangeIdentity, applied]);

  const q = useQuery(() => {
    let query = db!
      .from('system_logs')
      .select('*')
      .eq('device_id', device!.id)
      .gte('received_at', queryRange.from)
      .lte('received_at', queryRange.to)
      .lte('severity', Number(applied.level))
      .order('received_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(51);
    if (applied.service) query = query.eq('service', applied.service);
    if (applied.search) query = query.ilike('message', '%' + applied.search.replace(/[\\%_]/g, '\\$&') + '%');
    if (cursor) query = query.or(`received_at.lt.${cursor.time},and(received_at.eq.${cursor.time},id.lt.${cursor.id})`);
    return query;
  }, [device?.id, queryRange, applied, cursor?.id]);

  const data = (q.data || []).slice(0, 50) as Row[];
  const hasFilters = applied.level !== '7' || applied.service !== '' || applied.search !== '';

  const applyQuick = (next: Partial<typeof applied>) => {
    const merged = { level, service, search, ...next };
    setLevel(merged.level);
    setService(merged.service);
    setSearch(merged.search);
    setApplied(merged);
  };

  return (
    <Card
      title="System logs"
      description="Grouped messages · server-receipt date filter · newest first"
      action={<Export data={q.loading || q.error ? [] : data} name="system-logs" />}
    >
      <div className="filter-chips" role="group" aria-label="Quick log filters">
        {[
          ['All (Debug+)', '7'],
          ['Notice+', '5'],
          ['Warning+', '4'],
          ['Error+', '3'],
        ].map(([label, val]) => (
          <button
            type="button"
            className="chip"
            key={val}
            aria-pressed={applied.level === val}
            onClick={() => applyQuick({ level: val })}
          >
            {label}
          </button>
        ))}
        {[
          ['OOM / alloc', 'out of memory'],
          ['ath11k', 'ath11k'],
          ['WAN / link', 'link'],
        ].map(([label, term]) => (
          <button
            type="button"
            className="chip"
            key={term}
            aria-pressed={applied.search.toLowerCase() === term}
            onClick={() => applyQuick({ search: applied.search.toLowerCase() === term ? '' : term })}
          >
            {label}
          </button>
        ))}
        {hasFilters && (
          <Button
            type="button"
            variant="ghost"
            className="sm"
            onClick={() => applyQuick({ level: '7', service: '', search: '' })}
          >
            Clear filters
          </Button>
        )}
      </div>

      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ level, service, search });
        }}
      >
        <label>
          Minimum importance
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {severity.map((s, i) => (
              <option value={i} key={s}>
                {s} and higher
              </option>
            ))}
          </select>
        </label>
        <label>
          Service
          <Input value={service} onChange={(e) => setService(e.target.value)} placeholder="Exact service name" maxLength={64} />
        </label>
        <label className="grow">
          Message contains
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search messages" maxLength={200} />
        </label>
        <Button type="submit" disabled={q.loading} aria-busy={q.loading}>
          {q.loading ? 'Loading logs…' : 'Apply filters'}
        </Button>
      </form>

      <QueryState
        {...q}
        empty={!data.length}
        emptyTitle="No matching logs"
        emptyMessage="Try broadening the time window, severity filter, or search term."
      >
        <DataTable
          data={data}
          columns={[
            {
              key: 'received_at',
              label: 'Received',
              render: (v, row) => (
                <div style={{ whiteSpace: 'nowrap' }}>
                  <div className="mono small">{date(v, zone, true)}</div>
                  {row.boot_id ? (
                    <div className="small muted">
                      Boot <code>{String(row.boot_id).slice(0, 8)}</code>
                      {num(row.uptime_s) !== null ? ` · +${durationShort(row.uptime_s)}` : ''}
                    </div>
                  ) : null}
                </div>
              ),
            },
            {
              key: 'severity',
              label: 'Severity',
              render: (v) => (
                <span className={`badge ${Number(v) <= 3 ? 'bad' : Number(v) === 4 ? 'warn' : ''}`}>
                  {severity[Number(v)] || String(v)}
                </span>
              ),
            },
            {
              key: 'service',
              label: 'Service',
              render: (v) => {
                const svc = String(v ?? '');
                return svc ? (
                  <button
                    type="button"
                    className="badge badge-btn"
                    title={`Filter logs by ${svc}`}
                    onClick={() => applyQuick({ service: applied.service === svc ? '' : svc })}
                  >
                    <code>{svc}</code>
                  </button>
                ) : (
                  '—'
                );
              },
            },
            {
              key: 'message',
              label: 'Message',
              render: (v) => <span className="log-msg">{String(v ?? '')}</span>,
            },
            {
              key: 'count',
              label: 'Occurrences',
              render: (v, row) => {
                const n = Number(v ?? 1);
                return (
                  <div>
                    <span className={`badge ${n >= 10 ? 'warn' : ''}`}>×{n}</span>
                    {n > 1 && row.first_at && row.last_at ? (
                      <div className="small muted" style={{ marginTop: 3 }}>
                        {date(row.first_at, zone)} → {date(row.last_at, zone)}
                      </div>
                    ) : null}
                  </div>
                );
              },
            },
          ]}
        />
      </QueryState>

      <div className="pagination">
        <span className="muted small">
          Page {cursors.length + 1} · exports include this page{pagingRange ? ' · window fixed while paging' : ''}
        </span>
        <Button
          disabled={!cursors.length || q.loading}
          onClick={() => {
            setCursors((c) => c.slice(0, -1));
            if (cursors.length === 1) setPagingRange(null);
          }}
        >
          Previous
        </Button>
        <Button
          disabled={(q.data?.length || 0) <= 50 || q.loading}
          onClick={() => {
            const row = data.at(-1);
            if (row) {
              if (!pagingRange) setPagingRange(range);
              setCursors((c) => [...c, { time: String(row.received_at), id: String(row.id) }]);
            }
          }}
        >
          Next 50
        </Button>
      </div>
    </Card>
  );
}

export function Diagnostics() {
  const { device, zone, range } = useMonitor();
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [links, setLinks] = useState<Record<string, { url: string; expiresAt: number }>>({});
  const [pagingRange, setPagingRange] = useState<TimeRange | null>(null);
  const queryRange = pagingRange || range;
  const rangeIdentity = timeRangeKey(range);

  useEffect(() => {
    setPage(0);
    setPagingRange(null);
    setLinks({});
  }, [device?.id, rangeIdentity]);

  const q = useQuery(
    () =>
      db!
        .from('diagnostics')
        .select('*')
        .eq('device_id', device!.id)
        .gte('created_at', queryRange.from)
        .lte('created_at', queryRange.to)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(page * 20, page * 20 + 20),
    [device?.id, page, queryRange, revision],
  );

  return (
    <>
      <Notice>
        This list contains snapshots already received by the cloud. A snapshot queued on your router appears only after its upload succeeds. Request
        new collection in the router's local monitor page; this dashboard cannot trigger it.
      </Notice>
      <Card
        title="Received diagnostic snapshots"
        description="Cloud receipt and private archive creation are separate stages."
        action={<Export data={q.loading || q.error ? [] : (q.data || []).slice(0, 20)} name="diagnostics" />}
      >
        <p className="record-state">
          Records last checked {date(q.refreshedAt, zone, true)}
          {q.loading ? ' · checking cloud records…' : ''}
        </p>
        <QueryState
          {...q}
          empty={!q.data?.length}
          emptyTitle="No diagnostic snapshots"
          emptyMessage="Snapshots appear here after the router uploads them."
        >
          {(q.data || []).slice(0, 20).map((row: Row) => {
            const id = String(row.id);
            const payload = object(row.payload);
            const link = links[id];
            const packagesText = typeof payload.packages === 'string' ? payload.packages : null;
            const otherPayload = Object.fromEntries(
              Object.entries(payload).filter(([k]) => k !== 'packages' && k !== 'request_id'),
            );

            return (
              <details className="record" key={id}>
                <summary>
                  <span>
                    {date(row.created_at, zone, true)} <span className="badge good">Received in cloud</span>{' '}
                    <span className={`badge ${row.object_path ? 'info' : ''}`}>
                      {row.object_path ? 'Archive stored' : 'Snapshot only'}
                    </span>
                  </span>
                  <span className="muted small">
                    Boot <code>{String(row.boot_id).slice(0, 8)}</code>
                    {typeof payload.request_id === 'string' ? ` · Req ${payload.request_id.slice(0, 8)}` : ''}
                  </span>
                </summary>
                {typeof payload.request_id === 'string' && (
                  <p className="record-state">
                    Router request <code>{String(payload.request_id)}</code>
                  </p>
                )}
                <Fields value={otherPayload} />
                {packagesText && (
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--accent)', fontSize: 13 }}>
                      Installed packages ({packagesText.split('\n').filter(Boolean).length} lines)
                    </summary>
                    <pre className="pkg-list">{packagesText}</pre>
                  </details>
                )}
                <p className="record-state">
                  {row.object_path
                    ? 'Private archive stored. Prepare a short-lived link to download it.'
                    : 'Snapshot received; no private archive has been created yet.'}
                </p>
                <div className="record-actions">
                  {row.object_path ? (
                    <ActionButton
                      actionKey={`download:${device!.id}:${id}`}
                      pendingLabel="Preparing private download link…"
                      successMessage="Private download link prepared for 60 seconds. Open the link below; browser download completion is not tracked."
                      onAction={async (action) => {
                        const result = await db!.storage.from('router-diagnostics').createSignedUrl(String(row.object_path), 60);
                        if (result.error) throw result.error;
                        action.signal.throwIfAborted();
                        setLinks((old) => ({ ...old, [id]: { url: result.data.signedUrl, expiresAt: Date.now() + 60000 } }));
                      }}
                    >
                      Prepare private download
                    </ActionButton>
                  ) : (
                    <ActionButton
                      actionKey={`archive:${device!.id}:${id}`}
                      pendingLabel="Creating private cloud archive…"
                      successMessage="Private archive stored. You can now prepare its download link."
                      onAction={async (action) => {
                        await ownerApi(`/api/v1/devices/${device!.id}/diagnostics/${id}/archive`, undefined, 'POST', action.signal);
                        action.signal.throwIfAborted();
                        setRevision((r) => r + 1);
                      }}
                    >
                      Archive received snapshot
                    </ActionButton>
                  )}
                  {link && <PreparedArchiveLink id={id} link={link} zone={zone} />}
                </div>
              </details>
            );
          })}
        </QueryState>
        <div className="pagination">
          <span className="muted small">
            Page {page + 1}
            {pagingRange ? ' · window fixed while paging' : ''}
          </span>
          <Button
            disabled={!page || q.loading}
            onClick={() => {
              setPage((p) => p - 1);
              if (page === 1) setPagingRange(null);
            }}
          >
            Previous
          </Button>
          <Button
            disabled={(q.data?.length || 0) <= 20 || q.loading}
            onClick={() => {
              if (!pagingRange) setPagingRange(range);
              setPage((p) => p + 1);
            }}
          >
            Next
          </Button>
        </div>
      </Card>
    </>
  );
}

function PreparedArchiveLink({ id, link, zone }: { id: string; link: { url: string; expiresAt: number }; zone: string }) {
  const action = useAction(`open-download:${id}:${link.expiresAt}`);
  return (
    <span className="action-control">
      <a
        className="download-ready"
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          const expired = Date.now() >= link.expiresAt;
          if (expired) event.preventDefault();
          void action.run(
            {
              pending: 'Opening the prepared archive link…',
              success: 'Archive link opened. Your browser handles the transfer; download completion is not tracked.',
            },
            () => {
              if (expired) throw new Error('This private link expired. Prepare a new download link and try again.');
            },
          );
        }}
      >
        Open prepared archive · valid until {date(new Date(link.expiresAt).toISOString(), zone)}
      </a>
      <ActionStatus action={action} compact />
    </span>
  );
}

export function Alerts() {
  const { device, tick, refresh, zone } = useMonitor();
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(0);

  useEffect(() => setPage(0), [device?.id]);

  const q = useQuery(() => {
    let query = db!
      .from('alerts')
      .select('*')
      .eq('device_id', device!.id)
      .order('opened_at', { ascending: false })
      .range(page * 50, page * 50 + 50);
    if (status === 'open') query = query.is('resolved_at', null);
    return query;
  }, [device?.id, tick, status, page]);

  return (
    <Card
      title="Alerts"
      description="Acknowledging an alert silences reminders without marking the underlying condition resolved."
      action={
        <select
          aria-label="Alert status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(0);
          }}
        >
          <option value="open">Open alerts</option>
          <option value="all">All alerts</option>
        </select>
      }
    >
      <QueryState
        {...q}
        empty={!q.data?.length}
        emptyTitle="No alerts in this view"
        emptyMessage="No open or matching alert incidents were recorded for this router."
      >
        <DataTable
          data={(q.data || []).slice(0, 50)}
          columns={[
            {
              key: 'opened_at',
              label: 'Opened',
              render: (v) => (
                <div style={{ whiteSpace: 'nowrap' }}>
                  <div className="mono small">{date(v, zone, true)}</div>
                  <div className="small muted">{relativeAge(v)}</div>
                </div>
              ),
            },
            {
              key: 'severity',
              label: 'Severity',
              render: (v, row) => (
                <div className="button-group">
                  <span className={`badge ${v === 'critical' ? 'bad' : v === 'warning' ? 'warn' : 'info'}`}>
                    {sentenceCase(String(v ?? 'info'))}
                  </span>
                  <span className="badge">{ruleCategoryLabel(row.rule_key)}</span>
                </div>
              ),
            },
            { key: 'message', label: 'Condition' },
            {
              key: 'resolved_at',
              label: 'State',
              render: (v, row) =>
                v ? (
                  <div>
                    <span className="badge good">Resolved</span>
                    <div className="small muted" style={{ marginTop: 3 }}>
                      {date(v, zone, true)}
                    </div>
                  </div>
                ) : row.acknowledged_at ? (
                  <span className="badge info">Acknowledged</span>
                ) : (
                  <span className="badge warn">Open</span>
                ),
            },
            {
              key: 'id',
              label: 'Action',
              render: (v, row) =>
                !row.acknowledged_at && (
                  <ActionButton
                    actionKey={`ack:${v}`}
                    pendingLabel="Acknowledging…"
                    successMessage="Alert acknowledged. The condition remains open until it recovers."
                    onAction={async (action) => {
                      await ownerApi(`/api/v1/alerts/${v}/ack`, undefined, 'POST', action.signal);
                      action.signal.throwIfAborted();
                      refresh();
                    }}
                  >
                    Acknowledge
                  </ActionButton>
                ),
            },
          ]}
        />
      </QueryState>
      <div className="pagination">
        <Button disabled={!page || q.loading} onClick={() => setPage((p) => p - 1)}>
          Previous
        </Button>
        <span className="muted small">Page {page + 1}</span>
        <Button disabled={(q.data?.length || 0) <= 50 || q.loading} onClick={() => setPage((p) => p + 1)}>
          Next
        </Button>
      </div>
      <AlertRules />
    </Card>
  );
}

function AlertRules() {
  const { device, tick, refresh } = useMonitor();
  const [metric, setMetric] = useState('cpu_pct');
  const [threshold, setThreshold] = useState('90');
  const [operator, setOperator] = useState('gt');
  const [sustain, setSustain] = useState('120');
  const [hysteresis, setHysteresis] = useState('5');
  const [cooldown, setCooldown] = useState('900');

  const q = useQuery(() => db!.from('alert_rules').select('*').eq('device_id', device!.id).order('id'), [device?.id, tick]);
  const metricInfo = ALERT_METRICS[metric];

  const handleMetricChange = (nextMetric: string) => {
    setMetric(nextMetric);
    const info = ALERT_METRICS[nextMetric];
    if (info) {
      setOperator(info.defaultOperator);
      setThreshold(info.defaultThreshold);
      setHysteresis(info.defaultHysteresis);
    }
  };

  return (
    <section className="subsection">
      <h3>Threshold rules</h3>
      <QueryState
        {...q}
        empty={!q.data?.length}
        emptyTitle="No threshold rules"
        emptyMessage="Add a rule below to monitor sustained CPU, RAM, temperature, latency, or conntrack thresholds."
      >
        <DataTable
          data={q.data || []}
          columns={[
            {
              key: 'metric',
              label: 'Metric',
              render: (v) => ALERT_METRICS[String(v)]?.label || String(v),
            },
            {
              key: 'operator',
              label: 'Trigger',
              render: (v, row) => {
                const info = ALERT_METRICS[String(row.metric)];
                const unitSuffix = !info?.unit ? '' : info.unit === '%' ? '%' : ` ${info.unit}`;
                return (
                  <span className="mono">
                    {v === 'lt' ? '<' : '>'} {String(row.threshold)}
                    {unitSuffix}
                  </span>
                );
              },
            },
            { key: 'sustain_s', label: 'Sustain', render: (v) => durationShort(num(v)) },
            { key: 'hysteresis', label: 'Hysteresis', render: (v) => <span className="mono">{String(v ?? 0)}</span> },
            { key: 'cooldown_s', label: 'Cooldown', render: (v) => durationShort(num(v)) },
            {
              key: 'enabled',
              label: 'Enabled',
              render: (value, row) => (
                <ActionButton
                  actionKey={`rule-toggle:${row.id}`}
                  pendingLabel="Updating rule…"
                  successMessage={
                    value
                      ? 'Rule disabled. Existing alerts are resolved by the service.'
                      : 'Rule enabled. New observations will be evaluated.'
                  }
                  onAction={async () => {
                    const result = await db!.from('alert_rules').update({ enabled: !value }).eq('id', row.id);
                    if (result.error) throw result.error;
                    refresh();
                  }}
                >
                  {value ? 'Disable' : 'Enable'}
                </ActionButton>
              ),
            },
            {
              key: 'id',
              label: 'Action',
              render: (value) => (
                <ActionButton
                  actionKey={`rule-remove:${value}`}
                  pendingLabel="Removing rule…"
                  successMessage="Alert rule removed and its open condition resolved."
                  onAction={async () => {
                    const result = await db!.from('alert_rules').delete().eq('id', value);
                    if (result.error) throw result.error;
                    refresh();
                  }}
                >
                  Remove
                </ActionButton>
              ),
            },
          ]}
        />
      </QueryState>

      <ActionForm
        className="filters"
        pending="Creating the threshold rule…"
        success="Threshold rule created. It will evaluate newly received observations."
        onSubmit={async () => {
          const result = await db!.from('alert_rules').insert({
            device_id: device!.id,
            metric,
            operator,
            threshold: Number(threshold),
            sustain_s: Number(sustain),
            hysteresis: Number(hysteresis),
            cooldown_s: Number(cooldown),
            enabled: true,
          });
          if (result.error) throw result.error;
          refresh();
        }}
      >
        <label style={{ minWidth: 210 }}>
          Metric
          <select value={metric} onChange={(e) => handleMetricChange(e.target.value)}>
            {Object.entries(ALERT_METRICS).map(([key, info]) => (
              <option value={key} key={key}>
                {info.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Condition
          <select value={operator} onChange={(e) => setOperator(e.target.value)}>
            <option value="gt">Above</option>
            <option value="lt">Below</option>
          </select>
        </label>
        <label>
          Threshold {metricInfo ? `(${metricInfo.unit})` : ''}
          <Input required type="number" min="0" step="any" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </label>
        <label>
          Sustain (s)
          <Input type="number" min="0" max="86400" required value={sustain} onChange={(e) => setSustain(e.target.value)} />
        </label>
        <label>
          Hysteresis
          <Input type="number" min="0" step="any" required value={hysteresis} onChange={(e) => setHysteresis(e.target.value)} />
        </label>
        <label>
          Cooldown (s)
          <Input type="number" min="60" max="604800" required value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
        </label>
        <ActionSubmit pendingLabel="Creating rule…">Add rule</ActionSubmit>
      </ActionForm>
      {metricInfo && <p className="muted small" style={{ marginBottom: 6 }}>{metricInfo.hint}</p>}
      <p className="muted small">
        Sustain delays a new alert. Hysteresis requires recovery beyond the threshold to avoid flapping. Cooldown limits repeated notifications.
      </p>
    </section>
  );
}

interface Comparison {
  a: Sample[];
  b: Sample[];
  from: number;
  to: number;
  truncated: boolean;
}

export function Firmware() {
  const { device, tick, zone } = useMonitor();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [start, setStart] = useState('600');
  const [end, setEnd] = useState('3600');
  const [chartMetric, setChartMetric] = useState<'cpu_pct' | 'mem_available_kb' | 'temp_c'>('cpu_pct');
  const [comparison, setComparison] = useState<Comparison | null>(null);

  const q = useQuery(
    () => db!.from('boot_sessions').select('*').eq('device_id', device!.id).order('first_seen_at', { ascending: false }).limit(30),
    [device?.id, tick],
  );

  useEffect(() => {
    setComparison(null);
    setA('');
    setB('');
  }, [device?.id]);

  const boots = q.data || [];

  const statsFor = (s: Sample[], key: 'cpu_pct' | 'mem_available_kb' | 'temp_c' | 'rx_mbps') => {
    const values =
      key === 'rx_mbps'
        ? s.map((v) => rate(v.rx_bytes_delta, v.elapsed_s)).filter((v): v is number => v !== null)
        : s.map((v) => v[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (!values.length) return { mean: null, min: null, max: null };
    return {
      mean: values.reduce((x, y) => x + y, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  };

  async function compare() {
    setComparison(null);
    if (a === b || !a || !b || Number(start) >= Number(end)) {
      throw new Error('Choose two different boots and an increasing uptime window.');
    }
    const result = await Promise.all(
      [a, b].map((boot) =>
        db!
          .from('metric_samples')
          .select('uptime_s,cpu_pct,mem_available_kb,temp_c,rx_bytes_delta,tx_bytes_delta,elapsed_s', { count: 'exact' })
          .eq('device_id', device!.id)
          .eq('boot_id', boot)
          .gte('uptime_s', Number(start))
          .lte('uptime_s', Number(end))
          .order('uptime_s')
          .limit(3601),
      ),
    );
    if (result.some((r) => r.error)) {
      throw new Error(result.find((r) => r.error)?.error?.message || 'Comparison could not be read. Check your connection and retry.');
    }
    const as = result[0].data as Sample[];
    const bs = result[1].data as Sample[];
    const matched = matchUptimeWindows(as, bs, Number(start), Number(end));
    if (!matched) {
      throw new Error('There are no overlapping retained uptime observations for these boots. Try another window; raw samples may have expired.');
    }
    setComparison({
      ...matched,
      truncated: (result[0].count ?? as.length) > as.length || (result[1].count ?? bs.length) > bs.length || as.length > 3600 || bs.length > 3600,
    });
  }

  const options = boots.map((boot: Row) => {
    const inv = object(boot.inventory);
    const label = String(inv.firmware || inv.release || inv.version || boot.boot_id).slice(0, 60);
    return (
      <option key={String(boot.boot_id)} value={String(boot.boot_id)}>
        {date(boot.first_seen_at, zone, true)} · {label}
      </option>
    );
  });

  return (
    <>
      <Notice>
        Compare the same uptime window after two boots. Traffic, clients, radio conditions, temperature and configuration can confound firmware
        differences. These observations do not establish causation.
      </Notice>
      <Card title="Firmware comparison" description="Uses retained raw samples aligned by uptime, excluding boot warm-up by default.">
        <QueryState
          {...q}
          empty={!boots.length}
          emptyTitle="No boot sessions recorded"
          emptyMessage="Boot sessions appear once the router completes at least one upload cycle."
        >
          <ActionForm
            className="filters"
            pending="Reading both boot windows and comparing observations…"
            success="Firmware comparison prepared from retained observations. Review coverage and confounders below."
            onSubmit={compare}
          >
            <label className="grow">
              Baseline boot
              <select required value={a} onChange={(e) => setA(e.target.value)}>
                <option value="">Select baseline</option>
                {options}
              </select>
            </label>
            <label className="grow">
              Comparison boot
              <select required value={b} onChange={(e) => setB(e.target.value)}>
                <option value="">Select comparison</option>
                {options}
              </select>
            </label>
            <label>
              From uptime (s)
              <Input type="number" min="0" required value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label>
              To uptime (s)
              <Input type="number" min="1" required value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
            <ActionSubmit pendingLabel="Comparing observations…">Compare</ActionSubmit>
          </ActionForm>
        </QueryState>

        {comparison ? (
          <div className="stack">
            <p className="notice">
              Matched uptime: {durationShort(comparison.from)}–{durationShort(comparison.to)} ({comparison.from.toFixed(0)}–{comparison.to.toFixed(0)} s).
              Baseline {comparison.a.length} samples; comparison {comparison.b.length} samples.
              {comparison.truncated ? ' Query limit reached; shorten the window for complete results.' : ''}
            </p>

            <div className="chart-actions">
              <div className="segmented compact-seg" role="group" aria-label="Comparison chart metric">
                {[
                  ['cpu_pct', 'CPU %'],
                  ['mem_available_kb', 'Available RAM (MiB)'],
                  ['temp_c', 'Temperature (°C)'],
                ].map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    aria-pressed={chartMetric === key}
                    onClick={() => setChartMetric(key as 'cpu_pct' | 'mem_available_kb' | 'temp_c')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Export
                data={[
                  ...comparison.a.map((s) => ({ ...s, comparison_group: 'baseline' })),
                  ...comparison.b.map((s) => ({ ...s, comparison_group: 'comparison' })),
                ]}
                name="firmware-comparison"
              />
            </div>

            <ComparisonChart
              compare={{ baseline: comparison.a, comparison: comparison.b, metric: chartMetric }}
              title={`Uptime-aligned ${chartMetric}`}
            />

            <DataTable
              data={[
                { key: 'cpu_pct', label: 'Processor utilization', unit: '%', base: statsFor(comparison.a, 'cpu_pct'), comp: statsFor(comparison.b, 'cpu_pct') },
                { key: 'mem_available_kb', label: 'Available RAM', unit: 'MiB', base: statsFor(comparison.a, 'mem_available_kb'), comp: statsFor(comparison.b, 'mem_available_kb') },
                { key: 'temp_c', label: 'Temperature', unit: '°C', base: statsFor(comparison.a, 'temp_c'), comp: statsFor(comparison.b, 'temp_c') },
                { key: 'rx_mbps', label: 'WAN download rate', unit: 'Mbps', base: statsFor(comparison.a, 'rx_mbps'), comp: statsFor(comparison.b, 'rx_mbps') },
              ]}
              columns={[
                { key: 'label', label: 'Metric' },
                {
                  key: 'base',
                  label: 'Baseline mean (min–max)',
                  render: (_v, row) => {
                    const s = row.base as { mean: number | null; min: number | null; max: number | null };
                    if (s.mean === null) return '—';
                    if (row.key === 'mem_available_kb') return `${mib(s.mean)} (${mib(s.min)}–${mib(s.max)})`;
                    const suffix = row.unit === '%' ? '%' : ` ${String(row.unit)}`;
                    return `${fmt(s.mean, suffix)} (${fmt(s.min)}–${fmt(s.max)})`;
                  },
                },
                {
                  key: 'comp',
                  label: 'Comparison mean (min–max)',
                  render: (_v, row) => {
                    const s = row.comp as { mean: number | null; min: number | null; max: number | null };
                    if (s.mean === null) return '—';
                    if (row.key === 'mem_available_kb') return `${mib(s.mean)} (${mib(s.min)}–${mib(s.max)})`;
                    const suffix = row.unit === '%' ? '%' : ` ${String(row.unit)}`;
                    return `${fmt(s.mean, suffix)} (${fmt(s.min)}–${fmt(s.max)})`;
                  },
                },
                {
                  key: 'delta',
                  label: 'Difference',
                  render: (_v, row) => {
                    const bMean = (row.base as { mean: number | null }).mean;
                    const cMean = (row.comp as { mean: number | null }).mean;
                    if (bMean === null || cMean === null) return '—';
                    const diff = cMean - bMean;
                    const sign = diff > 0 ? '+' : '';
                    if (row.key === 'mem_available_kb') return `${sign}${mib(diff)}`;
                    const suffix = row.unit === '%' ? '%' : ` ${String(row.unit)}`;
                    return `${sign}${fmt(diff, suffix)}`;
                  },
                },
              ]}
            />
            <p className="muted small">Means use observed samples without interpolation. Uneven sampling and missing coverage can bias comparisons.</p>
          </div>
        ) : (
          <Empty title="Select two boots">The comparison uses actual retained observations; missing history is never simulated.</Empty>
        )}
      </Card>
      <div className="two-col">
        {[
          ['Baseline', a],
          ['Comparison', b],
        ]
          .filter((entry): entry is [string, string] => Boolean(entry[1]))
          .map(([role, id]) => (
            <Card key={`${role}-${id}`} title={`${role} · Boot ${id.slice(0, 8)} · reported inventory`}>
              <Fields value={boots.find((v: Row) => v.boot_id === id)?.inventory} />
            </Card>
          ))}
      </div>
    </>
  );
}
