import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, TooltipComponent, LegendComponent, AxisPointerComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts } from 'echarts/core';
import { useMonitor } from '../lib/data';
import { axisTimeLabel, compactAxisTime, durationShort, rate, type Sample } from '../lib/model';

echarts.use([LineChart, DataZoomComponent, GridComponent, TooltipComponent, LegendComponent, AxisPointerComponent, CanvasRenderer]);

export type ChartMode =
  | 'cpu_pct'
  | 'mem_available_mib'
  | 'mem_used_pct'
  | 'temp_c'
  | 'network_mbps'
  | 'network_mib'
  | 'rx_bytes_delta'
  | 'tx_bytes_delta'
  | 'mem_available_kb';

export interface CompareData {
  baseline: Sample[];
  comparison: Sample[];
  metric: 'cpu_pct' | 'mem_available_kb' | 'temp_c';
}

function seriesPoints(
  data: Sample[],
  extract: (d: Sample) => number | null,
  xMode: 'time' | 'uptime' = 'time',
): [number, number | null][] {
  const values = data
    .map((d) => {
      const x = xMode === 'uptime' ? (typeof d.uptime_s === 'number' ? d.uptime_s : NaN) : Date.parse(String(d.bucket || d.observed_at || d.received_at));
      return [x, extract(d)] as [number, number | null];
    })
    .filter((v) => Number.isFinite(v[0]))
    .sort((a, b) => a[0] - b[0]);
  const intervals = values
    .slice(1)
    .map((p, i) => p[0] - values[i][0])
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const cadence = intervals[Math.floor(intervals.length / 2)] || 0;
  return values.flatMap((p, i) => (i && cadence && p[0] - values[i - 1][0] > cadence * 3 ? [[values[i - 1][0] + cadence, null], p] : [p]));
}

export default function Chart({
  data,
  metric = 'cpu_pct',
  label = 'CPU',
  unit = '%',
  memTotalKb,
  compare,
  height,
}: {
  data: Sample[];
  metric: ChartMode | keyof Sample;
  label?: string;
  unit?: string;
  memTotalKb?: number | null;
  compare?: CompareData;
  height?: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<ECharts | null>(null);
  const { zone, theme } = useMonitor();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!element.current) return;
    let observer: ResizeObserver | undefined;
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
      const chart = echarts.init(element.current, undefined, { renderer: 'canvas' });
      instance.current = chart;
      const isCompare = Boolean(compare);
      const timestamps = data.map((d) => Date.parse(String(d.bucket || d.observed_at || d.received_at))).filter(Number.isFinite);
      const spanMs = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 6 * 3600000;

      const makeLine = (
        name: string,
        color: string,
        pts: [number, number | null][],
        opts: { dashed?: boolean; area?: boolean; width?: number } = {},
      ) => ({
        name,
        type: 'line' as const,
        showSymbol: pts.filter((p) => p[1] !== null).length <= 3,
        symbolSize: 6,
        connectNulls: false,
        sampling: 'lttb' as const,
        lineStyle: { width: opts.width ?? (opts.dashed ? 1.25 : 2), type: opts.dashed ? ('dashed' as const) : ('solid' as const) },
        itemStyle: { color },
        ...(opts.area ? { areaStyle: { color: palette.areaFill } } : {}),
        data: pts,
      });

      let effectiveUnit = unit;
      let yBounds: { min?: number; max?: number } = {};
      let series: ReturnType<typeof makeLine>[] = [];
      let showLegend = false;

      if (compare) {
        const key = compare.metric;
        const extract = (d: Sample) => {
          const val = d[key];
          if (typeof val !== 'number' || !Number.isFinite(val)) return null;
          return key === 'mem_available_kb' ? Number((val / 1024).toFixed(2)) : val;
        };
        effectiveUnit = key === 'cpu_pct' ? '%' : key === 'mem_available_kb' ? ' MiB' : ' °C';
        if (key === 'cpu_pct') yBounds = { min: 0, max: 100 };
        showLegend = true;
        series = [
          makeLine('Baseline boot', palette.mutedLine, seriesPoints(compare.baseline, extract, 'uptime'), { dashed: true }),
          makeLine('Comparison boot', palette.primary, seriesPoints(compare.comparison, extract, 'uptime'), { area: true }),
        ];
      } else if (metric === 'cpu_pct') {
        effectiveUnit = '%';
        yBounds = { min: 0, max: 100 };
        showLegend = true;
        series = [
          makeLine('Minimum', palette.mutedLine, seriesPoints(data, (d) => (typeof d.cpu_min === 'number' ? d.cpu_min : null)), { dashed: true }),
          makeLine('Maximum', palette.secondary, seriesPoints(data, (d) => (typeof d.cpu_max === 'number' ? d.cpu_max : null)), { dashed: true }),
          makeLine(label, palette.primary, seriesPoints(data, (d) => (typeof d.cpu_pct === 'number' ? d.cpu_pct : null)), { area: true }),
        ];
      } else if (metric === 'mem_available_mib' || metric === 'mem_available_kb') {
        effectiveUnit = ' MiB';
        showLegend = false;
        series = [
          makeLine(
            label || 'Available RAM',
            palette.primary,
            seriesPoints(data, (d) => (typeof d.mem_available_kb === 'number' ? Number((d.mem_available_kb / 1024).toFixed(2)) : null)),
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
            seriesPoints(data, (d) =>
              typeof d.mem_available_kb === 'number' ? Number((((memTotalKb - d.mem_available_kb) / memTotalKb) * 100).toFixed(2)) : null,
            ),
            { area: true },
          ),
        ];
      } else if (metric === 'network_mbps') {
        effectiveUnit = ' Mbps';
        showLegend = true;
        series = [
          makeLine(
            'Download (Rx)',
            palette.primary,
            seriesPoints(data, (d) => {
              const r = rate(d.rx_bytes_delta, d.elapsed_s);
              return r === null ? null : Number(r.toFixed(3));
            }),
            { area: true },
          ),
          makeLine(
            'Upload (Tx)',
            palette.secondary,
            seriesPoints(data, (d) => {
              const r = rate(d.tx_bytes_delta, d.elapsed_s);
              return r === null ? null : Number(r.toFixed(3));
            }),
          ),
        ];
      } else if (metric === 'network_mib') {
        effectiveUnit = ' MiB';
        showLegend = true;
        series = [
          makeLine(
            'Download (Rx)',
            palette.primary,
            seriesPoints(data, (d) => (typeof d.rx_bytes_delta === 'number' ? Number((d.rx_bytes_delta / 1048576).toFixed(3)) : null)),
            { area: true },
          ),
          makeLine(
            'Upload (Tx)',
            palette.secondary,
            seriesPoints(data, (d) => (typeof d.tx_bytes_delta === 'number' ? Number((d.tx_bytes_delta / 1048576).toFixed(3)) : null)),
          ),
        ];
      } else {
        const key = metric as keyof Sample;
        series = [
          makeLine(
            label,
            palette.primary,
            seriesPoints(data, (d) => (typeof d[key] === 'number' ? Number(d[key]) : null)),
            { area: true },
          ),
        ];
      }

      chart.setOption({
        animation: false,
        backgroundColor: 'transparent',
        grid: { left: 52, right: 16, top: showLegend ? 34 : 22, bottom: 52 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: palette.tooltipBg,
          borderColor: palette.tooltipBorder,
          borderWidth: 1,
          textStyle: { color: palette.tooltipText, fontSize: 12 },
          axisPointer: { type: 'cross', lineStyle: { color: palette.axisLine }, crossStyle: { color: palette.axisLine } },
          valueFormatter: (v: unknown) =>
            typeof v === 'number' ? `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${effectiveUnit}` : 'Unavailable',
        },
        legend: {
          show: showLegend,
          top: 0,
          right: 0,
          textStyle: { color: palette.text, fontSize: 11 },
          itemWidth: 14,
          itemHeight: 4,
        },
        axisPointer: { link: [{ xAxisIndex: 'all' }] },
        xAxis: isCompare
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
              axisLabel: { color: palette.text, hideOverlap: true, formatter: (v: number) => durationShort(v) },
              axisLine: { lineStyle: { color: palette.axisLine } },
            }
          : {
              type: 'time',
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
                formatter: (v: number) => compactAxisTime(v, zone, spanMs),
              },
              axisLine: { lineStyle: { color: palette.axisLine } },
            },
        yAxis: {
          type: 'value',
          name: effectiveUnit.trim(),
          nameTextStyle: { color: palette.text, fontSize: 11 },
          axisLabel: { color: palette.text },
          splitLine: { lineStyle: { color: palette.split } },
          ...yBounds,
        },
        dataZoom: [
          { type: 'inside', filterMode: 'none' },
          {
            type: 'slider',
            height: 15,
            bottom: 8,
            borderColor: 'transparent',
            fillerColor: palette.areaFill,
            handleStyle: { color: palette.primary },
            textStyle: { color: palette.text, fontSize: 10 },
          },
        ],
        series,
      });

      observer = new ResizeObserver(() => chart.resize());
      observer.observe(element.current);
    } catch {
      setError('Chart could not load. Refresh to retry.');
    }

    return () => {
      observer?.disconnect();
      instance.current?.dispose();
      instance.current = null;
    };
  }, [data, metric, label, unit, memTotalKb, compare, zone, theme]);

  return (
    <>
      <div
        role="img"
        aria-label={`${label} history. Drag to zoom, scroll to adjust range.`}
        className="chart"
        style={height ? { height } : undefined}
        ref={element}
      />
      {error && <p role="alert">{error}</p>}
      <span className="sr-only">{data.length} recorded observations. Use CSV export for accessible values.</span>
    </>
  );
}
