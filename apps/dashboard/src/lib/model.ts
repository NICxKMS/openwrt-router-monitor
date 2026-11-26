export type Row = Record<string, unknown>;
export interface Device {
  id: string;
  name: string;
  model: string | null;
  created_at?: string;
  last_seen_at: string | null;
  last_boot_id?: string | null;
  revoked_at: string | null;
  dropped_samples?: number;
  dropped_logs?: number;
  storage_degraded_at?: string | null;
  config: Record<string, unknown>;
}
export interface AlertRecord {
  id: string;
  device_id: string;
  rule_key: string;
  severity: 'info' | 'warning' | 'critical' | string;
  message: string;
  opened_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
}
export interface Sample {
  bucket?: string;
  received_at?: string;
  observed_at?: string;
  effective_at?: string;
  boot_id?: string;
  seq?: number;
  uptime_s?: number;
  cpu_pct: number | null;
  cpu_min?: number | null;
  cpu_max?: number | null;
  load1?: number | null;
  mem_available_kb: number | null;
  mem_total_kb?: number | null;
  mem_free_kb?: number | null;
  cached_kb?: number | null;
  slab_kb?: number | null;
  sreclaimable_kb?: number | null;
  sunreclaim_kb?: number | null;
  temp_c: number | null;
  rx_bytes_delta: number | null;
  tx_bytes_delta: number | null;
  elapsed_s: number | null;
  detail?: Row;
  interfaces?: Row[];
  sample_count?: number;
  rx_delta_count?: number | null;
  tx_delta_count?: number | null;
  traffic_window_exact?: boolean;
}
export interface TimeRange { from: string; to: string; live: boolean; hours: number }

export const nowRange = (hours = 6): TimeRange => ({
  from: new Date(Date.now() - hours * 3600000).toISOString(),
  to: new Date().toISOString(),
  live: true,
  hours,
});

export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;

export const fmt = (v: unknown, suffix = '', digits = 1): string => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : null;
  return n === null ? '—' : `${n.toLocaleString(undefined, { maximumFractionDigits: digits })}${suffix}`;
};

export function bytes(v: unknown): string {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' && Number.isFinite(v) ? v : null;
  if (n === null || !Number.isFinite(n)) return '—';
  const unit = n === 0 ? 0 : Math.min(4, Math.max(0, Math.floor(Math.log(Math.abs(n)) / Math.log(1024))));
  return `${(n / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}

export function mib(kb: unknown, digits = 1): string {
  const n = typeof kb === 'number' && Number.isFinite(kb) ? kb : null;
  return n === null ? '—' : `${(n / 1024).toLocaleString(undefined, { maximumFractionDigits: digits })} MiB`;
}

export const rate = (delta: unknown, seconds: unknown): number | null => {
  const d = num(delta);
  const s = num(seconds);
  return d !== null && s !== null && s > 0 ? (d * 8) / s / 1e6 : null;
};

export function formatMbps(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (v === 0) return '0 Mbps';
  if (v > 0 && v < 0.001) return '<1 Kbps';
  if (v > 0 && v < 0.01) return fmt(v * 1000, ' Kbps', 0);
  if (v < 1) return fmt(v, ' Mbps', 2);
  return fmt(v, ' Mbps', 1);
}

type TrafficSample = Pick<Sample, 'rx_bytes_delta' | 'tx_bytes_delta' | 'rx_delta_count' | 'tx_delta_count' | 'sample_count'>;

export function trafficDelta(sample: TrafficSample, direction: 'rx' | 'tx'): number | null {
  const count = num(sample[`${direction}_delta_count`]);
  const expected = num(sample.sample_count) ?? 1;
  // Older rollups lack validity counts. Only one-sample buckets are unambiguous.
  if ((count ?? (expected === 1 ? 1 : 0)) !== expected) return null;
  return num(sample[`${direction}_bytes_delta`]);
}

export function sumTrafficBytes(samples: TrafficSample[]): { rx: number | null; tx: number | null; total: number | null } | null {
  let rx = 0;
  let tx = 0;
  let rxComplete = true;
  let txComplete = true;
  let seen = false;
  for (const sample of samples) {
    const received = trafficDelta(sample, 'rx');
    const transmitted = trafficDelta(sample, 'tx');
    if (received === null) rxComplete = false;
    else { rx += received; seen = true; }
    if (transmitted === null) txComplete = false;
    else { tx += transmitted; seen = true; }
  }
  if (!seen) return null;
  return { rx: rxComplete ? rx : null, tx: txComplete ? tx : null, total: rxComplete && txComplete ? rx + tx : null };
}

export function sumWindowTraffic(samples: Sample[]) {
  const totals = sumTrafficBytes(samples);
  if (!totals) return null;
  return {
    ...totals,
    approximate: samples.some((sample) => sample.traffic_window_exact !== true),
  };
}

export function bucketCadenceLabel(samples: Sample[]): string {
  if (!samples.length) return '';
  const hasRollup = samples.some((s) => (num(s.sample_count) ?? 1) > 1);
  if (!hasRollup && samples.length > 1) {
    const times = samples
      .map((s) => Date.parse(String(s.bucket || s.observed_at || s.received_at)))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const diffs = times.slice(1).map((t, i) => (t - times[i]) / 1000).filter((d) => d > 0);
    if (diffs.length) {
      const median = diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)];
      return median < 55 ? `${Math.round(median)}s raw samples` : `${durationShort(median)} samples`;
    }
    return 'Raw samples';
  }
  const times = samples
    .map((s) => Date.parse(String(s.bucket || s.observed_at || s.received_at)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const diffs = times.slice(1).map((t, i) => (t - times[i]) / 1000).filter((d) => d > 0);
  const median = diffs.length ? diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)] : null;
  if (median !== null && median >= 55) return `${durationShort(median)} buckets`;
  return hasRollup ? 'Aggregated buckets' : 'Raw samples';
}

export function date(v: unknown, zone: string, full = false): string {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: zone,
    ...(full
      ? { dateStyle: 'medium' as const, timeStyle: 'medium' as const }
      : { hour: '2-digit' as const, minute: '2-digit' as const, second: '2-digit' as const }),
  }).format(new Date(v));
}

export function compactAxisTime(value: unknown, zone: string, spanMs = 6 * 3600000): string {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return '';
  const d = new Date(time);
  if (spanMs <= 20 * 60000) {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d);
  }
  if (spanMs > 14 * 86400000) {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      ...(spanMs > 365 * 86400000 ? { year: 'numeric' as const } : {}),
    }).format(d);
  }
  if (spanMs > 36 * 3600000) {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  }
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export function relativeAge(v: unknown, nowMs = Date.now()): string {
  if (typeof v !== 'string') return '—';
  const ts = Date.parse(v);
  if (!Number.isFinite(ts)) return '—';
  const diffS = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffS < 15) return 'just now';
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 48) return `${diffH}h ${diffM % 60}m ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export function durationShort(seconds: unknown): string {
  const n = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : null;
  if (n === null) return '—';
  if (n < 60) return `${n}s`;
  if (n < 3600) {
    const m = Math.floor(n / 60);
    const s = n % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export const uptime = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v)
    ? `${Math.floor(v / 86400)}d ${Math.floor((v % 86400) / 3600)}h ${Math.floor((v % 3600) / 60)}m`
    : '—';

export function toLocalDateTimeInput(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function safeCsv(rows: Row[]): string {
  if (!rows.length) return '';
  const keys = Array.from(new Set(rows.flatMap(Object.keys)));
  const cell = (v: unknown) => {
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return [keys.map(cell).join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\r\n');
}

export function download(rows: Row[], name: string, type: 'csv' | 'json') {
  const a = document.createElement('a');
  const url = URL.createObjectURL(
    new Blob([type === 'csv' ? safeCsv(rows) : JSON.stringify(rows, null, 2)], {
      type: type === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
    }),
  );
  a.href = url;
  a.download = `${name}.${type}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readPreference<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem('nicx:' + key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(key: string, value: unknown) {
  try {
    localStorage.setItem('nicx:' + key, JSON.stringify(value));
  } catch {
    /* Browser storage may be disabled. */
  }
}

export const object = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};

export const rows = (v: unknown): Row[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Row[]) : [];

export function matchUptimeWindows(a: Sample[], b: Sample[], start: number, end: number) {
  const from = Math.max(start, a[0]?.uptime_s ?? Infinity, b[0]?.uptime_s ?? Infinity);
  const to = Math.min(end, a.at(-1)?.uptime_s ?? -Infinity, b.at(-1)?.uptime_s ?? -Infinity);
  if (from >= to) return null;
  return {
    a: a.filter((v) => v.uptime_s! >= from && v.uptime_s! <= to),
    b: b.filter((v) => v.uptime_s! >= from && v.uptime_s! <= to),
    from,
    to,
  };
}

export const timeRangeKey = (range: TimeRange) => (range.live ? 'live:' + range.hours : range.from + ':' + range.to);
export const MAX_RAW_SAMPLES = 30000;
export const retainedSampleEstimate = (sampleInterval: number, days: number) =>
  Math.min(MAX_RAW_SAMPLES, Math.ceil((days * 86400) / sampleInterval));

export function cloudConfig(config: Row): Row {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !['buffer_kb', 'log_severity', 'privacy_addresses'].includes(key)),
  );
}

export function axisTimeLabel(value: unknown, zone: string): string {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? date(new Date(time).toISOString(), zone, true) : '—';
}

export function memoryCategories(sample: Partial<Sample> | null): Row[] {
  const info = object(object(sample?.detail).meminfo);
  return [
    ['mem_free_kb', 'Free pages'],
    ['cached_kb', 'File cache'],
    ['slab_kb', 'Total slab'],
    ['sreclaimable_kb', 'Reclaimable slab'],
    ['sunreclaim_kb', 'Unreclaimable slab'],
  ].map(([key, name]) => ({
    key,
    name,
    bytes:
      typeof info[key] === 'number' && Number.isFinite(info[key])
        ? Number(info[key]) * 1024
        : typeof sample?.[key as keyof Sample] === 'number' && Number.isFinite(sample?.[key as keyof Sample])
          ? Number(sample?.[key as keyof Sample]) * 1024
          : null,
  }));
}

export function wifiBand(freqMhz: unknown): string {
  const f = typeof freqMhz === 'number' ? freqMhz : null;
  if (f === null) return '';
  if (f >= 2400 && f < 2500) return '2.4 GHz';
  if (f >= 5000 && f < 5925) return '5 GHz';
  if (f >= 5925 && f <= 7125) return '6 GHz';
  return `${f} MHz`;
}

export function serviceCheckLabel(code: unknown): string {
  const map: Record<string, string> = {
    nft_table_present: 'fw4 table active',
    nft_table_absent: 'fw4 table missing',
    nft_unavailable: 'nft tool unavailable',
    nft_query_unknown: 'fw4 check inconclusive',
    procd_status_success: 'Active (procd)',
    procd_status_stopped: 'Stopped (procd)',
    procd_status_failed: 'Failed (procd)',
    procd_status_transition: 'Transitioning (procd)',
    procd_status_unavailable: 'Status unavailable (procd)',
  };
  return typeof code === 'string' ? map[code] || code.replaceAll('_', ' ') : 'Not checked';
}

export const ALERT_METRICS: Record<
  string,
  { label: string; unit: string; defaultOperator: 'gt' | 'lt'; defaultThreshold: string; defaultHysteresis: string; hint: string }
> = {
  cpu_pct: {
    label: 'CPU utilization (%)',
    unit: '%',
    defaultOperator: 'gt',
    defaultThreshold: '90',
    defaultHysteresis: '5',
    hint: 'Percentage of total CPU capacity (0–100%).',
  },
  temp_c: {
    label: 'Temperature (°C)',
    unit: '°C',
    defaultOperator: 'gt',
    defaultThreshold: '80',
    defaultHysteresis: '3',
    hint: 'Primary thermal sensor reading in degrees Celsius.',
  },
  mem_available_kb: {
    label: 'Available RAM (KiB)',
    unit: 'KiB',
    defaultOperator: 'lt',
    defaultThreshold: '65536',
    defaultHysteresis: '8192',
    hint: '65,536 KiB = 64 MiB. Alert when available memory drops below threshold.',
  },
  latency_ms: {
    label: 'IPv4 latency (ms)',
    unit: 'ms',
    defaultOperator: 'gt',
    defaultThreshold: '150',
    defaultHysteresis: '20',
    hint: 'Requires optional connectivity probes enabled on the router.',
  },
  loss_pct: {
    label: 'IPv4 packet loss (%)',
    unit: '%',
    defaultOperator: 'gt',
    defaultThreshold: '10',
    defaultHysteresis: '5',
    hint: 'Percentage of lost ping probes on IPv4 target.',
  },
  memory_psi_full_avg10: {
    label: 'Memory pressure, full avg10 (%)',
    unit: '%',
    defaultOperator: 'gt',
    defaultThreshold: '10',
    defaultHysteresis: '2',
    hint: 'Linux PSI full stall percentage over 10s (if kernel exposes /proc/pressure).',
  },
  conntrack_pct: {
    label: 'Connection table use (%)',
    unit: '%',
    defaultOperator: 'gt',
    defaultThreshold: '80',
    defaultHysteresis: '5',
    hint: 'Percentage of nf_conntrack_max currently allocated.',
  },
};

export function ruleCategoryLabel(ruleKey: unknown): string {
  if (typeof ruleKey !== 'string') return 'Rule';
  if (ruleKey === 'offline') return 'Heartbeat';
  if (ruleKey === 'cloud_gap') return 'Cloud maintenance';
  if (ruleKey === 'monthly_quota') return 'Traffic quota';
  if (ruleKey.startsWith('reboot:')) return 'Reboot';
  if (ruleKey.startsWith('oom:')) return 'Kernel OOM';
  if (ruleKey.startsWith('ath11k:')) return 'Wi-Fi driver';
  if (ruleKey.startsWith('reachability:')) return 'Reachability';
  return 'Threshold';
}

export function capabilityLabel(key: string): string {
  const labels: Record<string, string> = {
    psi: 'Linux PSI (/proc/pressure)',
    wifi: 'Wi-Fi survey & stations (iw)',
    ppe: 'Hardware PPE offload counters',
    debugfs: 'Kernel debugfs inspection',
    slab_attribution: 'Per-slab memory attribution',
    dns_counters: 'DNS query counters',
    dns_queries: 'DNS query logging',
  };
  return labels[key] || sentenceCase(key);
}

export function sentenceCase(key: string): string {
  const spaced = key.replaceAll('_', ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
}

export function vmstatLabel(key: string): string {
  const labels: Record<string, string> = {
    pgfault: 'Page faults',
    pgmajfault: 'Major page faults',
    pswpin: 'Pages swapped in',
    pswpout: 'Pages swapped out',
    oom_kill: 'OOM kills',
    pgscan_kswapd: 'kswapd page scans',
    pgsteal_kswapd: 'kswapd page steals',
  };
  return labels[key] || key;
}
