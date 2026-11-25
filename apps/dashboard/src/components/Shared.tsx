import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { useMonitor } from '../lib/data';
import { bytes, date, download, fmt, mib, num, object, rate, relativeAge, rows, sentenceCase, type Row, type Sample } from '../lib/model';
import { Card, Empty } from './ui/primitives';
import { ActionButton } from './Actions';
import type { ChartMode, CompareData } from './Chart';

const Chart = lazy(() => import('./Chart'));

export function Export({ data, name = 'observations' }: { data: unknown[]; name?: string }) {
  return (
    <div className="button-group">
      <ActionButton
        disabled={!data.length}
        pendingLabel="Preparing CSV…"
        successMessage="CSV file prepared and handed to your browser. Check its downloads; completion is not tracked."
        onAction={() => download(data as Row[], name, 'csv')}
      >
        <Download size={14} /> CSV
      </ActionButton>
      <ActionButton
        disabled={!data.length}
        pendingLabel="Preparing JSON…"
        successMessage="JSON file prepared and handed to your browser. Check its downloads; completion is not tracked."
        onAction={() => download(data as Row[], name, 'json')}
      >
        JSON
      </ActionButton>
    </div>
  );
}

function summarizeValues(values: (number | null)[]) {
  const valid = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!valid.length) return null;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const latest = valid.at(-1) ?? null;
  return { min, max, avg, latest, count: valid.length };
}

export function HistoryChart({
  metric,
  title,
  unit = '%',
  description,
  height,
  allowNetworkToggle = false,
  allowMemoryToggle = false,
}: {
  metric: ChartMode | keyof Sample;
  title: string;
  unit?: string;
  description?: string;
  height?: number;
  allowNetworkToggle?: boolean;
  allowMemoryToggle?: boolean;
}) {
  const { history, latest } = useMonitor();
  const [netMode, setNetMode] = useState<'network_mbps' | 'network_mib'>('network_mbps');
  const [memMode, setMemMode] = useState<'mem_available_mib' | 'mem_used_pct'>('mem_available_mib');
  const memTotalKb = num(latest?.mem_total_kb);

  const activeMetric: ChartMode | keyof Sample = allowNetworkToggle
    ? netMode
    : allowMemoryToggle && memTotalKb && memTotalKb > 0
      ? memMode
      : metric === 'mem_available_kb'
        ? 'mem_available_mib'
        : metric;

  let summaryStats: { min: number; max: number; avg: number; latest: number | null; unit: string; txAvg?: number | null; txUnit?: string } | null = null;
  if (history.length) {
    if (activeMetric === 'cpu_pct') {
      const s = summarizeValues(history.map((d) => d.cpu_pct));
      if (s) summaryStats = { ...s, unit: '%' };
    } else if (activeMetric === 'mem_available_mib') {
      const s = summarizeValues(history.map((d) => (typeof d.mem_available_kb === 'number' ? d.mem_available_kb / 1024 : null)));
      if (s) summaryStats = { ...s, unit: ' MiB' };
    } else if (activeMetric === 'mem_used_pct' && memTotalKb) {
      const s = summarizeValues(
        history.map((d) => (typeof d.mem_available_kb === 'number' ? ((memTotalKb - d.mem_available_kb) / memTotalKb) * 100 : null)),
      );
      if (s) summaryStats = { ...s, unit: '%' };
    } else if (activeMetric === 'temp_c') {
      const s = summarizeValues(history.map((d) => d.temp_c));
      if (s) summaryStats = { ...s, unit: ' °C' };
    } else if (activeMetric === 'network_mbps') {
      const s = summarizeValues(history.map((d) => rate(d.rx_bytes_delta, d.elapsed_s)));
      const tx = summarizeValues(history.map((d) => rate(d.tx_bytes_delta, d.elapsed_s)));
      if (s) summaryStats = { ...s, unit: ' Mbps Rx', txAvg: tx?.avg ?? null, txUnit: ' Mbps Tx' };
    } else if (activeMetric === 'network_mib') {
      const s = summarizeValues(history.map((d) => (typeof d.rx_bytes_delta === 'number' ? d.rx_bytes_delta / 1048576 : null)));
      const tx = summarizeValues(history.map((d) => (typeof d.tx_bytes_delta === 'number' ? d.tx_bytes_delta / 1048576 : null)));
      if (s) summaryStats = { ...s, unit: ' MiB Rx', txAvg: tx?.avg ?? null, txUnit: ' MiB Tx' };
    }
  }

  const controls = (
    <div className="chart-actions">
      {allowNetworkToggle && (
        <div className="segmented compact-seg" role="group" aria-label="Network unit">
          <button type="button" aria-pressed={netMode === 'network_mbps'} onClick={() => setNetMode('network_mbps')}>
            Mbps
          </button>
          <button type="button" aria-pressed={netMode === 'network_mib'} onClick={() => setNetMode('network_mib')}>
            MiB
          </button>
        </div>
      )}
      {allowMemoryToggle && memTotalKb && memTotalKb > 0 ? (
        <div className="segmented compact-seg" role="group" aria-label="Memory unit">
          <button type="button" aria-pressed={memMode === 'mem_available_mib'} onClick={() => setMemMode('mem_available_mib')}>
            Avail MiB
          </button>
          <button type="button" aria-pressed={memMode === 'mem_used_pct'} onClick={() => setMemMode('mem_used_pct')}>
            Used %
          </button>
        </div>
      ) : null}
      <Export data={history} name={title.toLowerCase().replaceAll(/\s+/g, '-')} />
    </div>
  );

  const defaultDesc =
    activeMetric === 'network_mbps'
      ? 'Average rate per bucket (bytes × 8 ÷ elapsed_s). Drag to zoom.'
      : 'Observed history. Drag to zoom; gaps mark missing intervals.';

  return (
    <Card title={title} description={description || defaultDesc} action={controls}>
      {summaryStats && (
        <div className="chart-summary" aria-label="Window summary">
          <span>
            Min <strong>{fmt(summaryStats.min, summaryStats.unit)}</strong>
          </span>
          <span>
            Avg <strong>{fmt(summaryStats.avg, summaryStats.unit)}</strong>
          </span>
          <span>
            Max <strong>{fmt(summaryStats.max, summaryStats.unit)}</strong>
          </span>
          {summaryStats.latest !== null && (
            <span>
              Latest <strong>{fmt(summaryStats.latest, summaryStats.unit)}</strong>
            </span>
          )}
          {summaryStats.txAvg != null && (
            <span>
              Avg upload <strong>{fmt(summaryStats.txAvg, summaryStats.txUnit || '')}</strong>
            </span>
          )}
        </div>
      )}
      {history.length ? (
        <Suspense fallback={<div className="loading">Loading chart…</div>}>
          <Chart data={history} metric={activeMetric} label={title} unit={unit} memTotalKb={memTotalKb} height={height} />
        </Suspense>
      ) : (
        <Empty title="No history in this window">Try a wider time range, or check that the agent is sending observations.</Empty>
      )}
    </Card>
  );
}

export function ComparisonChart({ compare, title }: { compare: CompareData; title: string }) {
  return (
    <Suspense fallback={<div className="loading">Loading comparison chart…</div>}>
      <Chart data={compare.baseline} metric={compare.metric} label={title} compare={compare} height={260} />
    </Suspense>
  );
}

export function Stat({
  label,
  value,
  sub,
  accent,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
  tone?: 'default' | 'accent' | 'good' | 'warn' | 'bad';
}) {
  const effectiveTone = accent && tone === 'default' ? 'accent' : tone;
  return (
    <div className={`stat ${effectiveTone !== 'default' ? effectiveTone : ''}`}>
      <span className="eyebrow">{label}</span>
      <strong>{value}</strong>
      <span className="muted small">{sub || 'Unsupported values appear as —'}</span>
    </div>
  );
}

export function Fields({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    const data = rows(value);
    if (!data.length) return <Empty title="No entries reported" />;
    const keys = Array.from(new Set(data.flatMap(Object.keys)));
    return (
      <DataTable
        data={data}
        columns={keys.map((key) => ({
          key,
          label: sentenceCase(key),
          render: (v: unknown) =>
            v && typeof v === 'object' ? (
              <details>
                <summary>View details</summary>
                <Fields value={v} />
              </details>
            ) : v == null ? (
              '—'
            ) : (
              String(v)
            ),
        }))}
      />
    );
  }
  const entries = Object.entries(object(value));
  return entries.length ? (
    <dl className="fields">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{sentenceCase(k)}</dt>
          <dd>
            {v && typeof v === 'object' ? (
              <details open={Array.isArray(v) ? v.length < 5 : Object.keys(object(v)).length <= 8}>
                <summary>{Array.isArray(v) ? `${v.length} entries` : 'View details'}</summary>
                <Fields value={v} />
              </details>
            ) : typeof v === 'number' ? (
              fmt(v, '', 3)
            ) : v === null ? (
              'Unknown'
            ) : (
              String(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <Empty title="Not reported">This capability may be unavailable or its collection may be disabled on this router.</Empty>
  );
}

export function DetailCard({ title, keys, note }: { title: string; keys: string[]; note?: string }) {
  const { latest } = useMonitor();
  const detail = object(latest?.detail);
  const value = keys.map((k) => k.split('.').reduce<unknown>((v, part) => object(v)[part], detail)).find((v) => v !== undefined);
  return (
    <Card title={title} description={note}>
      <Fields value={value} />
    </Card>
  );
}

export function DataTable({
  data,
  columns,
}: {
  data: Row[];
  columns: { key: string; label: string; render?: (value: unknown, row: Row) => ReactNode }[];
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={String(row.id || row.client_id || row.name || i)}>
              {columns.map((c) => (
                <td key={c.key}>
                  {c.render
                    ? c.render(row[c.key], row)
                    : row[c.key] == null
                      ? '—'
                      : typeof row[c.key] === 'object'
                        ? JSON.stringify(row[c.key])
                        : String(row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Interfaces() {
  const { latest } = useMonitor();
  const data = rows(latest?.interfaces);
  return (
    <Card title="Interfaces" description="Ethernet WAN and USB WAN are measured separately; LAN is excluded from Internet totals.">
      {data.length ? (
        <DataTable
          data={data}
          columns={[
            { key: 'name', label: 'Interface', render: (v) => <code>{String(v ?? '—')}</code> },
            {
              key: 'role',
              label: 'Role',
              render: (v) => {
                const r = String(v ?? 'other');
                const label = r === 'wan' ? 'Ethernet WAN' : r === 'usbwan' ? 'USB WAN' : r === 'lan' ? 'LAN' : r;
                return <span className={`badge ${r === 'wan' || r === 'usbwan' ? 'good' : ''}`}>{label}</span>;
              },
            },
            {
              key: 'rx_delta',
              label: 'Rx rate',
              render: (v, row) => fmt(rate(v, row.elapsed_s), ' Mbps', 2),
            },
            {
              key: 'tx_delta',
              label: 'Tx rate',
              render: (v, row) => fmt(rate(v, row.elapsed_s), ' Mbps', 2),
            },
            { key: 'rx_bytes', label: 'Rx total', render: bytes },
            { key: 'tx_bytes', label: 'Tx total', render: bytes },
            {
              key: 'reset',
              label: 'State',
              render: (v) => <span className={`badge ${v ? 'warn' : ''}`}>{v ? 'Reset' : 'Continuous'}</span>,
            },
          ]}
        />
      ) : (
        <Empty title="No interface counters reported" />
      )}
    </Card>
  );
}

export function ObservationTime() {
  const { latest, zone, range } = useMonitor();
  const stamp = (range.live ? latest?.observed_at : latest?.effective_at) || latest?.received_at;
  const age = relativeAge(stamp);
  const unsynced = latest && !latest.observed_at;
  return (
    <span className="obs-time">
      {unsynced && (
        <span className="badge warn" title="Router clock was not NTP-synced when this sample was collected; time is estimated from cloud receipt.">
          Est. clock
        </span>
      )}
      <span className="muted small">
        {range.live ? 'Last observation' : 'Historical snapshot'} {date(stamp, zone, true)}
        {age !== '—' && range.live ? ` (${age})` : ''}
      </span>
    </span>
  );
}

export function CollectorLag({ uptimeKey, label }: { uptimeKey: string; label: string }) {
  const { latest } = useMonitor();
  const detail = object(latest?.detail);
  const collectorUptime = num(detail[uptimeKey]);
  const sampleUptime = num(latest?.uptime_s);
  if (collectorUptime === null || sampleUptime === null) return null;
  const lagS = Math.max(0, Math.round(sampleUptime - collectorUptime));
  return (
    <span className="badge" title={`${label} collector ran ${lagS}s before the latest core sample`}>
      {lagS <= 5 ? 'Fresh snapshot' : `Sampled ${lagS}s earlier`}
    </span>
  );
}

export function ProgressBar({
  percent,
  label,
  tone,
}: {
  percent: number | null;
  label?: string;
  tone?: 'good' | 'warn' | 'bad' | 'accent';
}) {
  if (percent === null || !Number.isFinite(percent)) return <span className="muted">—</span>;
  const clamped = Math.max(0, Math.min(100, percent));
  const resolved = tone || (clamped >= 90 ? 'bad' : clamped >= 75 ? 'warn' : 'accent');
  return (
    <div className={`meter ${resolved}`} aria-label={label}>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${clamped}%` }} />
      </div>
      <span>{fmt(clamped, '%')}</span>
    </div>
  );
}

export function MemorySummaryStrip({ sample }: { sample: Sample | null }) {
  const total = num(sample?.mem_total_kb);
  const avail = num(sample?.mem_available_kb);
  if (!total || avail === null) return null;
  const usedPct = Math.max(0, Math.min(100, ((total - avail) / total) * 100));
  return (
    <div className="mem-bar-wrap">
      <div className="mem-bar-head">
        <span className="small muted">
          Used <strong>{mib(total - avail)}</strong> ({fmt(usedPct, '%')})
        </span>
        <span className="small muted">
          Available <strong>{mib(avail)}</strong> of {mib(total)}
        </span>
      </div>
      <div className="mem-bar-track" role="img" aria-label={`Memory usage ${fmt(usedPct, '%')}`}>
        <div
          className={`mem-bar-used ${usedPct >= 90 ? 'bad' : usedPct >= 80 ? 'warn' : ''}`}
          style={{ width: `${usedPct}%` }}
        />
      </div>
    </div>
  );
}
