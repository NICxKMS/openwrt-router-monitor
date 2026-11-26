import { lazy, Suspense, useCallback, useState, type ReactNode } from 'react';
import { Download, RotateCcw } from 'lucide-react';
import { useMonitor } from '../lib/data';
import {
  bucketCadenceLabel,
  bytes,
  date,
  download,
  fmt,
  formatMbps,
  mib,
  num,
  object,
  rate,
  relativeAge,
  rows,
  sentenceCase,
  sumTrafficBytes,
  type Row,
  type Sample,
} from '../lib/model';
import { Button, Card, Empty } from './ui/primitives';
import { ActionButton } from './Actions';
import { resetChartZoom } from '../lib/chartZoom';
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
  allowMemoryToggle = false,
}: {
  metric: ChartMode | keyof Sample;
  title: string;
  unit?: string;
  description?: string;
  height?: number;
  allowMemoryToggle?: boolean;
}) {
  const { history, latest } = useMonitor();
  const [memMode, setMemMode] = useState<'mem_available_mib' | 'mem_used_pct'>('mem_available_mib');
  const [zoomScope, setZoomScope] = useState<string | null>(null);
  const memTotalKb = num(latest?.mem_total_kb);

  const activeMetric: ChartMode | keyof Sample =
    allowMemoryToggle && memTotalKb && memTotalKb > 0
      ? memMode
      : metric === 'mem_available_kb'
        ? 'mem_available_mib'
        : metric;

  const handleZoomChange = useCallback((zoomed: boolean, scopeKey: string) => {
    setZoomScope(zoomed ? scopeKey : null);
  }, []);

  const cadence = bucketCadenceLabel(history);
  const trafficTotals = activeMetric === 'network_mbps' || activeMetric === 'network_mib' ? sumTrafficBytes(history) : null;

  let summaryContent: ReactNode = null;
  if (history.length) {
    if (activeMetric === 'cpu_pct') {
      const s = summarizeValues(history.map((d) => num(d.cpu_pct)));
      const peak = summarizeValues(history.map((d) => num(d.cpu_max) ?? num(d.cpu_pct)));
      const minimum = summarizeValues(history.map((d) => num(d.cpu_min) ?? num(d.cpu_pct)));
      if (s) {
        summaryContent = (
          <>
            <span>Min <strong>{fmt(minimum?.min ?? s.min, '%')}</strong></span>
            <span>Avg <strong>{fmt(s.avg, '%')}</strong></span>
            <span>Max <strong>{fmt(peak?.max ?? s.max, '%')}</strong></span>
            {s.latest !== null && <span>Latest <strong>{fmt(s.latest, '%')}</strong></span>}
          </>
        );
      }
    } else if (activeMetric === 'mem_available_mib') {
      const s = summarizeValues(history.map((d) => { const v = num(d.mem_available_kb); return v !== null ? v / 1024 : null; }));
      if (s) {
        summaryContent = (
          <>
            <span>Min <strong>{fmt(s.min, ' MiB')}</strong></span>
            <span>Avg <strong>{fmt(s.avg, ' MiB')}</strong></span>
            <span>Max <strong>{fmt(s.max, ' MiB')}</strong></span>
            {s.latest !== null && <span>Latest <strong>{fmt(s.latest, ' MiB')}</strong></span>}
          </>
        );
      }
    } else if (activeMetric === 'mem_used_pct' && memTotalKb) {
      const s = summarizeValues(
        history.map((d) => { const v = num(d.mem_available_kb); return v !== null ? ((memTotalKb - v) / memTotalKb) * 100 : null; }),
      );
      if (s) {
        summaryContent = (
          <>
            <span>Min <strong>{fmt(s.min, '%')}</strong></span>
            <span>Avg <strong>{fmt(s.avg, '%')}</strong></span>
            <span>Max <strong>{fmt(s.max, '%')}</strong></span>
            {s.latest !== null && <span>Latest <strong>{fmt(s.latest, '%')}</strong></span>}
          </>
        );
      }
    } else if (activeMetric === 'temp_c') {
      const s = summarizeValues(history.map((d) => num(d.temp_c)));
      if (s) {
        summaryContent = (
          <>
            <span>Min <strong>{fmt(s.min, ' °C')}</strong></span>
            <span>Avg <strong>{fmt(s.avg, ' °C')}</strong></span>
            <span>Max <strong>{fmt(s.max, ' °C')}</strong></span>
            {s.latest !== null && <span>Latest <strong>{fmt(s.latest, ' °C')}</strong></span>}
          </>
        );
      }
    } else if (activeMetric === 'network_mbps') {
      const rx = summarizeValues(history.map((d) => rate(d.rx_bytes_delta, d.elapsed_s)));
      const tx = summarizeValues(history.map((d) => rate(d.tx_bytes_delta, d.elapsed_s)));
      if (rx || tx) {
        summaryContent = (
          <>
            {rx && (
              <>
                <span>Avg ↓ <strong>{formatMbps(rx.avg)}</strong></span>
                <span>Peak ↓ <strong>{formatMbps(rx.max)}</strong></span>
                {rx.latest !== null && <span>Latest ↓ <strong>{formatMbps(rx.latest)}</strong></span>}
              </>
            )}
            {tx && (
              <>
                <span>Avg ↑ <strong>{formatMbps(tx.avg)}</strong></span>
                <span>Peak ↑ <strong>{formatMbps(tx.max)}</strong></span>
              </>
            )}
            {trafficTotals && (
              <span>Window volume <strong>{bytes(trafficTotals.total)}</strong>{trafficTotals.total === null && ' (incomplete data)'}</span>
            )}
          </>
        );
      }
    } else if (activeMetric === 'network_mib' && trafficTotals) {
      summaryContent = (
        <>
          <span>Downloaded (↓) <strong>{bytes(trafficTotals.rx)}</strong></span>
          <span>Uploaded (↑) <strong>{bytes(trafficTotals.tx)}</strong></span>
          <span>Combined total <strong>{bytes(trafficTotals.total)}</strong>{trafficTotals.total === null && ' (incomplete data)'}</span>
          {cadence && <span>Resolution <strong>{cadence}</strong></span>}
        </>
      );
    }
  }

  const controls = (
    <div className="chart-actions">
      {zoomScope && (
        <Button type="button" variant="ghost" className="sm" onClick={() => resetChartZoom(zoomScope)}>
          <RotateCcw size={13} /> Reset zoom
        </Button>
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
      ? 'Transfer speed in Mbps. Line series show rate over time; drag or scroll to zoom.'
      : activeMetric === 'network_mib'
        ? 'Bytes transferred in each interval bucket. Bars show volume consumed, not speed.'
        : 'Observed history. Drag to zoom; gaps mark missing intervals.';

  return (
    <Card title={title} description={description || defaultDesc} action={controls}>
      {summaryContent && (
        <div className="chart-summary" aria-label="Window summary">
          {summaryContent}
        </div>
      )}
      {history.length ? (
        <Suspense fallback={<div className="loading">Loading chart…</div>}>
          <Chart
            data={history}
            metric={activeMetric}
            label={title}
            unit={unit}
            memTotalKb={memTotalKb}
            height={height}
            onZoomStateChange={handleZoomChange}
          />
        </Suspense>
      ) : (
        <Empty title="No history in this window">Try a wider time range, or check that the agent is sending observations.</Empty>
      )}
    </Card>
  );
}

export function DailyTrafficChart({ rows: dailyRows }: { rows: Row[] }) {
  return (
    <Suspense fallback={<div className="loading">Loading chart…</div>}>
      <Chart data={[]} dailyRows={dailyRows} metric="daily_traffic" label="Daily internet consumption" height={220} group="daily" />
    </Suspense>
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

export function Interfaces({ wanOnly = false }: { wanOnly?: boolean }) {
  const { latest, range } = useMonitor();
  const allRows = rows(latest?.interfaces);
  const filtered = wanOnly ? allRows.filter((i) => i.role === 'wan' || i.role === 'usbwan') : allRows;
  const data = [...filtered].sort((a, b) => {
    const rank = (role: unknown) => (role === 'wan' ? 0 : role === 'usbwan' ? 1 : role === 'lan' ? 2 : 3);
    return rank(a.role) - rank(b.role);
  });

  return (
    <Card
      title={wanOnly ? 'WAN uplink interfaces' : 'Network interfaces'}
      description={
        wanOnly
          ? 'Designated internet uplinks only. Session byte counters reflect kernel totals since boot or interface reset.'
          : 'WAN uplinks drive Internet speed and consumption totals. LAN is tracked separately; session counters reflect totals since boot or reset.'
      }
    >
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
                const label = r === 'wan' ? 'Ethernet WAN' : r === 'usbwan' ? 'USB WAN' : r === 'lan' ? 'LAN (excluded)' : r;
                return <span className={`badge ${r === 'wan' || r === 'usbwan' ? 'good' : ''}`}>{label}</span>;
              },
            },
            {
              key: 'rx_delta',
              label: 'Rx speed',
              render: (v, row) => <span className="mono" style={{ whiteSpace: 'nowrap' }}>{formatMbps(rate(v, row.elapsed_s))}</span>,
            },
            {
              key: 'tx_delta',
              label: 'Tx speed',
              render: (v, row) => <span className="mono" style={{ whiteSpace: 'nowrap' }}>{formatMbps(rate(v, row.elapsed_s))}</span>,
            },
            {
              key: 'rx_bytes',
              label: 'Session Rx (boot)',
              render: (v) => <span className="mono" style={{ whiteSpace: 'nowrap' }}>{bytes(v)}</span>,
            },
            {
              key: 'tx_bytes',
              label: 'Session Tx (boot)',
              render: (v) => <span className="mono" style={{ whiteSpace: 'nowrap' }}>{bytes(v)}</span>,
            },
            {
              key: 'reset',
              label: 'Counter state',
              render: (v) => <span className={`badge ${v ? 'warn' : ''}`}>{v ? 'Reset' : 'Continuous'}</span>,
            },
          ]}
        />
      ) : (
        <Empty title="No interface counters reported">
          {range.live
            ? 'Data will appear after this router sends its first observation.'
            : 'No per-interface breakdown was stored for this historical observation.'}
        </Empty>
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
  valueLabel,
}: {
  percent: number | null;
  label?: string;
  tone?: 'good' | 'warn' | 'bad' | 'accent';
  valueLabel?: string;
}) {
  if (percent === null || !Number.isFinite(percent)) return <span className="muted">—</span>;
  const clamped = Math.max(0, Math.min(100, percent));
  const resolved = tone || (clamped >= 90 ? 'bad' : clamped >= 75 ? 'warn' : 'accent');
  return (
    <div className={`meter ${resolved}`} aria-label={label}>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: clamped > 0 ? `max(3px, ${clamped}%)` : '0%' }} />
      </div>
      <span>{valueLabel ?? fmt(clamped, '%')}</span>
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
