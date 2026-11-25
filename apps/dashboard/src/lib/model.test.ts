import { describe, expect, it } from 'vitest';
import {
  ALERT_METRICS,
  axisTimeLabel,
  bytes,
  cloudConfig,
  compactAxisTime,
  date,
  durationShort,
  fmt,
  matchUptimeWindows,
  memoryCategories,
  mib,
  rate,
  relativeAge,
  retainedSampleEstimate,
  ruleCategoryLabel,
  safeCsv,
  sentenceCase,
  serviceCheckLabel,
  toLocalDateTimeInput,
  uptime,
  vmstatLabel,
  wifiBand,
  type Sample,
} from './model';

describe('honest measurement formatting', () => {
  it('does not convert missing or invalid readings to zero', () => {
    expect(fmt(null, '%')).toBe('—');
    expect(fmt(undefined)).toBe('—');
    expect(bytes(null)).toBe('—');
    expect(mib(null)).toBe('—');
    expect(rate(null, 10)).toBeNull();
    expect(rate(30, 0)).toBeNull();
    expect(uptime(null)).toBe('—');
    expect(date('invalid', 'Asia/Kolkata')).toBe('—');
    expect(relativeAge('invalid')).toBe('—');
    expect(durationShort(null)).toBe('—');
  });

  it('preserves valid zero and calculates throughput with elapsed time', () => {
    expect(fmt(0, '%')).toBe('0%');
    expect(bytes('1099511627776')).toBe('1 TiB');
    expect(mib(2048)).toBe('2 MiB');
    expect(rate(12500000, 10)).toBe(10);
  });

  it('escapes spreadsheet formulas, quotes, multiline fields, and union columns', () => {
    const csv = safeCsv([{ message: '=HYPERLINK("bad")', service: 'dns\nline' }, { message: ' \t+CMD()', count: 3 }]);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).toContain('"\' \t+CMD()"');
    expect(csv).toContain('"dns\nline"');
    expect(csv.split('\r\n')[0]).toBe('"message","service","count"');
  });

  it('uses the selected timezone rather than the browser timezone', () => {
    expect(date('2026-11-25T00:00:00Z', 'Asia/Kolkata')).toContain('05:30');
    expect(compactAxisTime(Date.parse('2026-11-25T00:00:00Z'), 'Asia/Kolkata', 6 * 3600000)).toBe('05:30');
  });
});

describe('firmware uptime alignment', () => {
  const sample = (uptime_s: number, cpu_pct = 10) => ({ uptime_s, cpu_pct }) as Sample;

  it('clips both groups to their actual shared observation window', () => {
    const result = matchUptimeWindows([sample(600), sample(1200), sample(1800)], [sample(1000), sample(1200), sample(1600)], 600, 1800);
    expect(result?.from).toBe(1000);
    expect(result?.to).toBe(1600);
    expect(result?.a.map((s) => s.uptime_s)).toEqual([1200]);
    expect(result?.b.map((s) => s.uptime_s)).toEqual([1000, 1200, 1600]);
  });

  it('refuses comparisons with missing or disjoint data', () => {
    expect(matchUptimeWindows([], [], 0, 3600)).toBeNull();
    expect(matchUptimeWindows([sample(10), sample(20)], [sample(30), sample(40)], 0, 3600)).toBeNull();
  });
});

describe('review regression guards', () => {
  it('protects formulas after every ASCII control character', () => {
    for (let code = 0; code < 32; code++) {
      const value = String.fromCharCode(code) + '=SUM(1,1)';
      expect(safeCsv([{ value }])).toContain('"\'' + value + '"');
    }
  });

  it('limits retained sample planning to the enforced device cap', () => {
    expect(retainedSampleEstimate(10, 7)).toBe(30000);
    expect(retainedSampleEstimate(300, 1)).toBe(288);
  });

  it('never sends router-local controls as cloud changes', () => {
    expect(
      cloudConfig({
        buffer_kb: 2048,
        log_severity: 5,
        privacy_addresses: true,
        diagnostics_enabled: true,
        logs_enabled: false,
        sample_interval: 30,
      }),
    ).toEqual({ diagnostics_enabled: true, logs_enabled: false, sample_interval: 30 });
  });

  it('formats tooltip timestamps in the selected timezone', () => {
    const timestamp = Date.parse('2026-11-25T00:00:00Z');
    expect(axisTimeLabel(timestamp, 'Asia/Kolkata')).toContain('5:30:00');
    expect(axisTimeLabel(timestamp, 'UTC')).toContain('12:00:00');
  });

  it('shows independent cache/slab counters, preserving zero and unknown values', () => {
    const data = memoryCategories({ mem_free_kb: 0, cached_kb: 100, slab_kb: 50, sreclaimable_kb: 20, sunreclaim_kb: 30 } as Sample);
    expect(data.map((v) => v.bytes)).toEqual([0, 102400, 51200, 20480, 30720]);
    expect(memoryCategories(null).every((v) => v.bytes === null)).toBe(true);
    const merged = memoryCategories({ detail: { meminfo: { cached_kb: 7 } } });
    expect(merged.find((v) => v.key === 'cached_kb')?.bytes).toBe(7168);
  });
});

describe('telemetry presentation helpers', () => {
  it('formats durations, relative ages, Wi-Fi bands, and service checks', () => {
    const base = Date.parse('2026-11-25T12:00:00Z');
    expect(relativeAge('2026-11-25T11:59:55Z', base)).toBe('just now');
    expect(relativeAge('2026-11-25T11:55:00Z', base)).toBe('5m ago');
    expect(durationShort(90)).toBe('1m 30s');
    expect(durationShort(3600)).toBe('1h');
    expect(wifiBand(2437)).toBe('2.4 GHz');
    expect(wifiBand(5180)).toBe('5 GHz');
    expect(wifiBand(6115)).toBe('6 GHz');
    expect(serviceCheckLabel('procd_status_success')).toBe('Active (procd)');
    expect(ruleCategoryLabel('oom:boot-1')).toBe('Kernel OOM');
    expect(ruleCategoryLabel('reachability:ipv4')).toBe('Reachability');
    expect(ALERT_METRICS.mem_available_kb.defaultOperator).toBe('lt');
    expect(toLocalDateTimeInput('2026-11-25T00:00:00Z')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(sentenceCase('sample_interval')).toBe('Sample interval');
    expect(vmstatLabel('pgmajfault')).toBe('Major page faults');
    expect(vmstatLabel('oom_kill')).toBe('OOM kills');
  });
});
