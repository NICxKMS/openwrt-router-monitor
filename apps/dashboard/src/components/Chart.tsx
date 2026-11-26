import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, TooltipComponent, LegendComponent, AxisPointerComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts } from 'echarts/core';
import { useMonitor } from '../lib/data';
import { getSavedZoom, setSavedZoom, subscribeZoomReset } from '../lib/chartZoom';
import { axisTimeLabel, bytes, compactAxisTime, durationShort, fmt, num, rate, timeRangeKey, trafficDelta, type Row, type Sample } from '../lib/model';

echarts.use([LineChart, BarChart, DataZoomComponent, GridComponent, TooltipComponent, LegendComponent, AxisPointerComponent, CanvasRenderer]);

export type ChartMode =
  | 'cpu_pct'
  | 'mem_available_mib'
  | 'mem_used_pct'
  | 'temp_c'
  | 'network_mbps'
  | 'network_mib'
  | 'daily_traffic'
  | 'rx_mbps'
  | 'rx_bytes_delta'
  | 'tx_bytes_delta'
  | 'mem_available_kb';

export interface CompareData {
  baseline: Sample[];
  comparison: Sample[];
  metric: 'cpu_pct' | 'mem_available_kb' | 'temp_c' | 'rx_mbps';
}

interface SeriesPointMeta {
  value: [number, number | null];
  sampleCount?: number;
  elapsedS?: number | null;
  symbolSize?: number;
  showSymbol?: boolean;
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function seriesPoints(
  data: Sample[],
  extract: (d: Sample) => number | null,
  xMode: 'time' | 'uptime' = 'time',
): (SeriesPointMeta | [number, null])[] {
  const sorted = data
    .map((d) => {
      const x = xMode === 'uptime' ? (typeof d.uptime_s === 'number' ? d.uptime_s : NaN) : Date.parse(String(d.bucket || d.observed_at || d.received_at));
      return {
        x,
        y: extract(d),
        sampleCount: num(d.sample_count) ?? undefined,
        elapsedS: num(d.elapsed_s),
      };
    })
    .filter((v) => Number.isFinite(v.x))
    .sort((a, b) => a.x - b.x);

  const intervals = sorted
    .slice(1)
    .map((p, i) => p.x - sorted[i].x)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)] || 0;
  const gapThreshold = median > 0 ? (xMode === 'uptime' ? median * 3 : Math.max(median * 2.5, 35000)) : 0;

  const out: (SeriesPointMeta | [number, null])[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i];
    if (i > 0 && gapThreshold && curr.x - sorted[i - 1].x > gapThreshold) {
      out.push([sorted[i - 1].x + (median || 10000), null]);
    }
    const prevValid = i > 0 && sorted[i - 1].y !== null && (!gapThreshold || curr.x - sorted[i - 1].x <= gapThreshold);
    const nextValid = i < sorted.length - 1 && sorted[i + 1].y !== null && (!gapThreshold || sorted[i + 1].x - curr.x <= gapThreshold);
    const isolated = curr.y !== null && !prevValid && !nextValid;
    out.push({
      value: [curr.x, curr.y],
      sampleCount: curr.sampleCount,
      elapsedS: curr.elapsedS,
      ...(isolated ? { showSymbol: true, symbolSize: 5 } : {}),
    });
  }
  return out;
}

export default function Chart({
  data,
  dailyRows,
  metric = 'cpu_pct',
  label = 'CPU',
  unit = '%',
  memTotalKb,
  compare,
  height,
  group,
  onZoomStateChange,
}: {
  data: Sample[];
  dailyRows?: Row[];
  metric: ChartMode | keyof Sample;
  label?: string;
  unit?: string;
  memTotalKb?: number | null;
  compare?: CompareData;
  height?: number;
  group?: string;
  onZoomStateChange?: (zoomed: boolean, scopeKey: string) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<ECharts | null>(null);
  const { zone, theme, device, range } = useMonitor();
  const [error, setError] = useState('');
  const chartGroup = group || (compare ? 'compare' : metric === 'daily_traffic' ? 'daily' : 'telemetry');
  const zoomScopeKey = `${device?.id || 'none'}:${range ? timeRangeKey(range) : 'default'}:${chartGroup}`;
  const fullSpanRef = useRef<number>(6 * 3600000);
  const zoneRef = useRef(zone);
  useEffect(() => { zoneRef.current = zone; }, [zone]);

  useEffect(() => {
    const host = element.current;
    if (!host) return;
    let observer: ResizeObserver | undefined;
    try {
      const chart = echarts.init(host, undefined, { renderer: 'canvas' });
      instance.current = chart;
      chart.group = chartGroup;
      echarts.connect?.(chartGroup);
      chart.on?.('datazoom', () => {
        const currentOption = chart.getOption?.() as { dataZoom?: Array<{ start?: number; end?: number }> } | undefined;
        const zoom = currentOption?.dataZoom?.[0];
        if (zoom && typeof zoom.start === 'number' && typeof zoom.end === 'number') {
          const isZoomed = zoom.start > 0.5 || zoom.end < 99.5;
          setSavedZoom(zoomScopeKey, isZoomed ? { start: zoom.start, end: zoom.end } : undefined);
          onZoomStateChange?.(isZoomed, zoomScopeKey);
          const visibleSpan = Math.max(60000, ((zoom.end - zoom.start) / 100) * fullSpanRef.current);
          chart.setOption({
            xAxis: {
              axisLabel: {
                formatter: (v: number) => compare ? durationShort(v) : compactAxisTime(v, zoneRef.current, visibleSpan),
              },
            },
          });
        }
      });
      observer = new ResizeObserver(() => chart.resize());
      observer.observe(host);
    } catch {
      setError('Chart could not load. Refresh to retry.');
    }
    const unsubscribeReset = subscribeZoomReset(zoomScopeKey, () => {
      const chart = instance.current;
      if (!chart) return;
      onZoomStateChange?.(false, zoomScopeKey);
      chart.setOption({
        dataZoom: [
          { id: 'x-zoom-inside', start: 0, end: 100 },
          { id: 'x-zoom-slider', start: 0, end: 100 },
        ],
        xAxis: {
          axisLabel: {
            formatter: (v: number) => compare ? durationShort(v) : compactAxisTime(v, zoneRef.current, fullSpanRef.current),
          },
        },
      });
    });
    return () => {
      unsubscribeReset();
      observer?.disconnect();
      instance.current?.dispose();
      instance.current = null;
    };
  }, [chartGroup, zoomScopeKey, !!compare, onZoomStateChange]);

  useEffect(() => {
    const chart = instance.current;
    if (!chart) return;
    const dark = theme === 'dark';
    const palette = {
      text: dark ? '#8f96a0' : '#5c626d',
      split: dark ? '#25282e' : '#e6e6e1',
      axisLine: dark ? '#343942' : '#c8c8c0',
      tooltipBg: dark ? '#181a1d' : '#ffffff',
      tooltipBorder: dark ? '#2b3036' : '#dcdcd6',
      tooltipText: dark ? '#f0f1f3' : '#16181c',
      primary: dark ? '#4f8ff7' : '#1d5fd6',
      secondary: dark ? '#e5993e' : '#b85d00',
      tertiary: dark ? '#2ec27e' : '#127a4d',
      mutedLine: dark ? '#6e7681' : '#7b818c',
      areaFill: dark ? 'rgba(79, 143, 247, 0.10)' : 'rgba(29, 95, 214, 0.08)',
    };

    try {
      const savedZoom = getSavedZoom(zoomScopeKey);
      onZoomStateChange?.(Boolean(savedZoom && ((savedZoom.start ?? 0) > 0.5 || (savedZoom.end ?? 100) < 99.5)), zoomScopeKey);
      const isCompare = Boolean(compare);
      const isDaily = metric === 'daily_traffic';

      const rangeFromMs = range ? Date.parse(range.from) : NaN;
      const rangeToMs = range ? Date.parse(range.to) : NaN;
      const timestamps = data.map((d) => Date.parse(String(d.bucket || d.observed_at || d.received_at))).filter(Number.isFinite);
      const hasPointsInsideRange =
        Number.isFinite(rangeFromMs) &&
        Number.isFinite(rangeToMs) &&
        (!timestamps.length || timestamps.some((ts) => ts >= rangeFromMs - 60000 && ts <= rangeToMs + 60000));
      const hasValidRangeBounds = !isCompare && !isDaily && hasPointsInsideRange && rangeToMs > rangeFromMs;

      const extent = timestamps.reduce(
        ([min, max], timestamp) => [Math.min(min, timestamp), Math.max(max, timestamp)],
        [Infinity, -Infinity],
      );
      const fullSpanMs = hasValidRangeBounds
        ? rangeToMs - rangeFromMs
        : timestamps.length > 1
          ? extent[1] - extent[0]
          : 6 * 3600000;
      fullSpanRef.current = fullSpanMs;
      const zoomFraction = savedZoom && typeof savedZoom.start === 'number' && typeof savedZoom.end === 'number' ? (savedZoom.end - savedZoom.start) / 100 : 1;
      const visibleSpanMs = Math.max(60000, fullSpanMs * zoomFraction);

      const makeLine = (
        name: string,
        color: string,
        pts: (SeriesPointMeta | [number, null])[],
        opts: { dashed?: boolean; area?: boolean; width?: number } = {},
      ) => {
        const validCount = pts.filter((p) => !Array.isArray(p) && p.value[1] !== null).length;
        return {
          name,
          type: 'line' as const,
          showSymbol: true,
          symbol: 'circle',
          symbolSize: 5,
          connectNulls: false,
          lineStyle: { width: opts.width ?? (opts.dashed ? 1.25 : 2), type: opts.dashed ? ('dashed' as const) : ('solid' as const) },
          itemStyle: { color },
          ...(opts.area ? { areaStyle: { color: palette.areaFill } } : {}),
          data: pts.map((point) => !Array.isArray(point) && validCount > 12 && !point.showSymbol ? { ...point, symbolSize: 0 } : point),
        };
      };

      const makeBar = (name: string, color: string, pts: (SeriesPointMeta | [number, null])[] | (number | null)[]) => ({
        name,
        type: 'bar' as const,
        barMaxWidth: isDaily ? 28 : 16,
        barMinHeight: 2,
        itemStyle: { color, borderRadius: [2, 2, 0, 0] },
        data: pts,
      });

      let effectiveUnit = unit;
      let yBounds: { min: number | null; max: number | null } = { min: null, max: null };
      let series: Array<ReturnType<typeof makeLine> | ReturnType<typeof makeBar>> = [];
      let showLegend = false;
      let categories: string[] = [];

      if (compare) {
        const key = compare.metric;
        const extract = (d: Sample) => {
          if (key === 'rx_mbps') {
            const r = rate(trafficDelta(d, 'rx'), d.elapsed_s);
            return r === null ? null : Number(r.toFixed(3));
          }
          const val = num(d[key]);
          if (val === null) return null;
          return key === 'mem_available_kb' ? Number((val / 1024).toFixed(2)) : val;
        };
        effectiveUnit = key === 'cpu_pct' ? '%' : key === 'mem_available_kb' ? ' MiB' : key === 'rx_mbps' ? ' Mbps' : ' °C';
        if (key === 'cpu_pct') yBounds = { min: 0, max: 100 };
        if (key === 'rx_mbps') yBounds = { min: 0, max: null };
        showLegend = true;
        series = [
          makeLine('Baseline boot', palette.mutedLine, seriesPoints(compare.baseline, extract, 'uptime'), { dashed: true }),
          makeLine('Comparison boot', palette.primary, seriesPoints(compare.comparison, extract, 'uptime'), { area: true }),
        ];
      } else if (isDaily) {
        const byDay = new Map<string, { rx: number | null; tx: number | null }>();
        for (const row of dailyRows || []) {
          const day = String(row.day || '');
          if (!day) continue;
          const prev = byDay.get(day) || { rx: null, tx: null };
          const rx = num(row.rx_bytes);
          const tx = num(row.tx_bytes);
          if (rx !== null) prev.rx = (prev.rx ?? 0) + rx;
          if (tx !== null) prev.tx = (prev.tx ?? 0) + tx;
          byDay.set(day, prev);
        }
        categories = Array.from(byDay.keys()).sort((a, b) => a.localeCompare(b));
        let maxDayBytes = 0;
        for (const { rx, tx } of byDay.values()) maxDayBytes = Math.max(maxDayBytes, rx ?? 0, tx ?? 0);
        const useGib = maxDayBytes >= 1024 ** 3;
        const divisor = useGib ? 1024 ** 3 : 1048576;
        effectiveUnit = useGib ? ' GiB' : ' MiB';
        yBounds = { min: 0, max: null };
        showLegend = true;
        const values = (direction: 'rx' | 'tx') => categories.map((day) => {
          const value = byDay.get(day)?.[direction];
          return value == null ? null : value / divisor;
        });
        series = [
          makeBar('Downloaded (Rx)', palette.primary, values('rx')),
          makeBar('Uploaded (Tx)', palette.secondary, values('tx')),
        ];
      } else if (metric === 'cpu_pct') {
        effectiveUnit = '%';
        yBounds = { min: 0, max: 100 };
        const hasSpread = data.some(
          (d) =>
            (num(d.sample_count) ?? 1) > 1 ||
            (num(d.cpu_min) !== null && num(d.cpu_max) !== null && num(d.cpu_min) !== num(d.cpu_max)),
        );
        showLegend = hasSpread;
        series = hasSpread
          ? [
              makeLine('Minimum', palette.mutedLine, seriesPoints(data, (d) => num(d.cpu_min)), { dashed: true }),
              makeLine('Maximum', palette.secondary, seriesPoints(data, (d) => num(d.cpu_max)), { dashed: true }),
              makeLine(label, palette.primary, seriesPoints(data, (d) => num(d.cpu_pct)), { area: true }),
            ]
          : [makeLine(label, palette.primary, seriesPoints(data, (d) => num(d.cpu_pct)), { area: true })];
      } else if (metric === 'mem_available_mib' || metric === 'mem_available_kb') {
        effectiveUnit = ' MiB';
        showLegend = false;
        series = [
          makeLine(
            label || 'Available RAM',
            palette.primary,
            seriesPoints(data, (d) => {
              const v = num(d.mem_available_kb);
              return v !== null ? Number((v / 1024).toFixed(2)) : null;
            }),
            { area: true },
          ),
        ];
      } else if (metric === 'mem_used_pct' && memTotalKb && memTotalKb > 0) {
        effectiveUnit = '%';
        yBounds = { min: 0, max: 100 };
        series = [
          makeLine(
            label || 'Memory in use',
            palette.primary,
            seriesPoints(data, (d) => {
              const v = num(d.mem_available_kb);
              return v !== null ? Number((((memTotalKb - v) / memTotalKb) * 100).toFixed(2)) : null;
            }),
            { area: true },
          ),
        ];
      } else if (metric === 'network_mbps') {
        effectiveUnit = ' Mbps';
        yBounds = { min: 0, max: null };
        showLegend = true;
        series = [
          makeLine(
            'Download speed (Rx)',
            palette.primary,
            seriesPoints(data, (d) => {
              const r = rate(trafficDelta(d, 'rx'), d.elapsed_s);
              return r === null ? null : Number(r.toFixed(3));
            }),
            { area: true },
          ),
          makeLine(
            'Upload speed (Tx)',
            palette.secondary,
            seriesPoints(data, (d) => {
              const r = rate(trafficDelta(d, 'tx'), d.elapsed_s);
              return r === null ? null : Number(r.toFixed(3));
            }),
          ),
        ];
      } else if (metric === 'network_mib') {
        const peakBytes = data.reduce(
          (peak, sample) => Math.max(peak, trafficDelta(sample, 'rx') ?? 0, trafficDelta(sample, 'tx') ?? 0),
          0,
        );
        const useGib = peakBytes >= 1024 ** 3;
        const divisor = useGib ? 1024 ** 3 : 1048576;
        effectiveUnit = useGib ? ' GiB' : ' MiB';
        yBounds = { min: 0, max: null };
        showLegend = true;
        series = [
          makeBar(
            'Downloaded volume (Rx)',
            palette.primary,
            seriesPoints(data, (d) => {
              const v = trafficDelta(d, 'rx');
              return v !== null ? v / divisor : null;
            }),
          ),
          makeBar(
            'Uploaded volume (Tx)',
            palette.secondary,
            seriesPoints(data, (d) => {
              const v = trafficDelta(d, 'tx');
              return v !== null ? v / divisor : null;
            }),
          ),
        ];
      } else {
        const key = metric as keyof Sample;
        series = [
          makeLine(
            label,
            palette.primary,
            seriesPoints(data, (d) => num(d[key])),
            { area: true },
          ),
        ];
      }

      const isVolume = isDaily || metric === 'network_mib';
      const volumeDivisor = effectiveUnit === ' GiB' ? 1024 ** 3 : 1048576;
      const formatValue = (v: unknown) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return isVolume ? '—' : 'Unavailable';
        if (isVolume) return bytes(v * volumeDivisor);
        if (effectiveUnit === ' Mbps' && v > 0 && v < 1) {
          return v < 0.01 ? `${fmt(v * 1000, ' Kbps', 0)}` : `${fmt(v, ' Mbps', 2)}`;
        }
        return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${effectiveUnit}`;
      };

      chart.setOption(
        {
          animation: false,
          backgroundColor: 'transparent',
          grid: {
            left: 12,
            right: 16,
            top: showLegend ? 36 : 24,
            bottom: isDaily ? 28 : 48,
            containLabel: true,
          },
          tooltip: {
            trigger: 'axis',
            backgroundColor: palette.tooltipBg,
            borderColor: palette.tooltipBorder,
            borderWidth: 1,
            extraCssText: 'box-shadow: none;',
            textStyle: { color: palette.tooltipText, fontSize: 12 },
            axisPointer: { type: isDaily ? 'shadow' : 'cross', lineStyle: { color: palette.axisLine }, crossStyle: { color: palette.axisLine } },
            valueFormatter: formatValue,
            formatter: (params: unknown) => {
              const items = Array.isArray(params) ? params : [params];
              const first = items[0] as {
                axisValue?: unknown;
                data?: SeriesPointMeta;
              } | undefined;
              if (!first) return '';
              const xVal = first.axisValue;
              const header = isDaily
                ? `${escapeHtml(String(xVal ?? ''))} (UTC)`
                : isCompare
                  ? `Uptime ${escapeHtml(durationShort(Number(xVal)))}`
                  : escapeHtml(axisTimeLabel(xVal, zone));
              const sampleCount = first.data?.sampleCount;
              const elapsedS = first.data?.elapsedS;
              const metaParts: string[] = [];
              if (sampleCount && sampleCount > 1) metaParts.push(`${sampleCount} samples in bucket`);
              if (elapsedS && elapsedS > 0 && (metric === 'network_mbps' || metric === 'network_mib')) {
                metaParts.push(`interval ${durationShort(elapsedS)}`);
              }
              const rowsHtml = items
                .map((item) => {
                  const p = item as { marker?: string; seriesName?: string; value?: unknown; data?: SeriesPointMeta };
                  const rawVal = Array.isArray(p.value) ? p.value[1] : p.data?.value?.[1] ?? p.value;
                  const formatted = formatValue(typeof rawVal === 'number' ? rawVal : null);
                  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:3px"><span>${p.marker || ''}${escapeHtml(String(p.seriesName || ''))}</span><strong style="font-family:JetBrains Mono,ui-monospace,monospace">${escapeHtml(formatted)}</strong></div>`;
                })
                .join('');
              const metaLine = metaParts.length ? `<div style="opacity:.72;font-size:11px;margin-top:2px">${escapeHtml(metaParts.join(' · '))}</div>` : '';
              return `<div style="font-weight:600;margin-bottom:2px">${header}</div>${metaLine}${rowsHtml}`;
            },
          },
          legend: {
            show: showLegend,
            top: 0,
            right: 0,
            icon: 'rect',
            textStyle: { color: palette.text, fontSize: 11 },
            itemWidth: 12,
            itemHeight: isDaily || metric === 'network_mib' ? 8 : 3,
            itemGap: 14,
          },
          axisPointer: { link: [{ xAxisIndex: 'all' }] },
          xAxis: isDaily
            ? {
                type: 'category',
                data: categories,
                axisLabel: { color: palette.text, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11 },
                axisLine: { lineStyle: { color: palette.axisLine } },
              }
            : isCompare
              ? {
                  type: 'value',
                  name: 'Uptime',
                  nameTextStyle: { color: palette.text, fontSize: 11 },
                  axisPointer: {
                    label: {
                      backgroundColor: palette.tooltipBg,
                      borderColor: palette.tooltipBorder,
                      borderWidth: 1,
                      color: palette.tooltipText,
                      formatter: (params: { value: unknown }) => `Uptime ${durationShort(Number(params.value))}`,
                    },
                  },
                  axisLabel: {
                    color: palette.text,
                    hideOverlap: true,
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 11,
                    formatter: (v: number) => durationShort(v),
                  },
                  axisLine: { lineStyle: { color: palette.axisLine } },
                  splitLine: { show: true, lineStyle: { color: palette.split } },
                }
              : {
                  type: 'time',
                  ...(hasValidRangeBounds ? { min: rangeFromMs, max: rangeToMs } : {}),
                  axisPointer: {
                    label: {
                      backgroundColor: palette.tooltipBg,
                      borderColor: palette.tooltipBorder,
                      borderWidth: 1,
                      color: palette.tooltipText,
                      formatter: (params: { value: unknown }) => axisTimeLabel(params.value, zone),
                    },
                  },
                  axisLabel: {
                    color: palette.text,
                    hideOverlap: true,
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 11,
                    formatter: (v: number) => compactAxisTime(v, zone, visibleSpanMs),
                  },
                  axisLine: { lineStyle: { color: palette.axisLine } },
                },
          yAxis: {
            type: 'value',
            name: effectiveUnit.trim(),
            nameTextStyle: { color: palette.text, fontSize: 11 },
            splitNumber: 4,
            axisLabel: { color: palette.text, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11 },
            splitLine: { lineStyle: { color: palette.split } },
            ...yBounds,
          },
          dataZoom: isDaily
            ? []
            : [
                {
                  id: 'x-zoom-inside',
                  type: 'inside',
                  filterMode: 'none',
                  ...(savedZoom?.start !== undefined ? { start: savedZoom.start } : {}),
                  ...(savedZoom?.end !== undefined ? { end: savedZoom.end } : {}),
                },
                {
                  id: 'x-zoom-slider',
                  type: 'slider',
                  height: 12,
                  bottom: 6,
                  ...(savedZoom?.start !== undefined ? { start: savedZoom.start } : {}),
                  ...(savedZoom?.end !== undefined ? { end: savedZoom.end } : {}),
                  backgroundColor: 'transparent',
                  borderColor: palette.tooltipBorder,
                  fillerColor: palette.areaFill,
                  dataBackground: {
                    lineStyle: { color: palette.split, width: 1 },
                    areaStyle: { color: 'transparent' },
                  },
                  selectedDataBackground: {
                    lineStyle: { color: palette.primary, width: 1 },
                    areaStyle: { color: palette.areaFill },
                  },
                  showDetail: false,
                  moveHandleSize: 0,
                  handleSize: '85%',
                  handleStyle: { color: palette.text, borderColor: palette.tooltipBorder, borderWidth: 1 },
                },
              ],
          series,
        },
        { replaceMerge: ['series', 'dataZoom'] },
      );
      setError('');
    } catch {
      setError('Chart could not load. Refresh to retry.');
    }
  }, [data, dailyRows, metric, label, unit, memTotalKb, compare, zone, theme, range, chartGroup, zoomScopeKey]);

  return (
    <>
      <div
        role="img"
        aria-label={`${label} history. ${metric === 'daily_traffic' ? 'Daily breakdown by interface volume.' : 'Drag to zoom, scroll to adjust range.'}`}
        className="chart"
        style={height ? { height } : undefined}
        ref={element}
      />
      {error && <p role="alert">{error}</p>}
      <span className="sr-only">
        {metric === 'daily_traffic' ? `${dailyRows?.length || 0} daily rows.` : `${data.length} recorded observations.`} Use CSV export for accessible values.
      </span>
    </>
  );
}
