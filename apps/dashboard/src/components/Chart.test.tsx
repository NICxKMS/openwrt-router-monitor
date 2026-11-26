// @vitest-environment jsdom
import React from 'react';
import {cleanup,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({setOption:vi.fn(),dispose:vi.fn(),connect:vi.fn(),on:vi.fn(),getOption:vi.fn(),instances:[] as Array<{group?:string}>}));
vi.mock('echarts/core',()=>({use:vi.fn(),connect:mock.connect,init:()=>{const inst={group:undefined as string|undefined,setOption:mock.setOption,dispose:mock.dispose,resize:vi.fn(),on:mock.on,getOption:mock.getOption};mock.instances.push(inst);return inst;}}));
vi.mock('echarts/charts',()=>({LineChart:{},BarChart:{}}));
vi.mock('echarts/components',()=>({DataZoomComponent:{},GridComponent:{},TooltipComponent:{},LegendComponent:{},AxisPointerComponent:{}}));
vi.mock('echarts/renderers',()=>({CanvasRenderer:{}}));
vi.mock('../lib/data',()=>({useMonitor:()=>({zone:'Asia/Kolkata',theme:'dark'})}));
import Chart from './Chart';
beforeEach(()=>{vi.clearAllMocks();mock.instances.length=0;vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('configures the tooltip and crosshair header in the display timezone',()=>{render(<Chart data={[]} metric="cpu_pct"/>);const option=mock.setOption.mock.calls[0][0];const ts=Date.parse('2026-11-25T00:00:00Z');const formatted=option.xAxis.axisPointer.label.formatter({value:ts});expect(formatted).toContain('5:30:00');expect(formatted).toContain('25 Nov 2026');const tooltipHtml=option.tooltip.formatter([{axisValue:ts,seriesName:'CPU',marker:'<span></span>',value:[ts,42]}]);expect(tooltipHtml).toContain('5:30:00');expect(tooltipHtml).toContain('25 Nov 2026');});
it('connects overview telemetry charts in one group and isolates firmware comparison charts',()=>{render(<><Chart data={[]} metric="cpu_pct"/><Chart data={[]} metric="temp_c"/><Chart data={[]} metric="cpu_pct" compare={{baseline:[],comparison:[],metric:'cpu_pct'}}/></>);expect(mock.instances[0].group).toBe('telemetry');expect(mock.instances[1].group).toBe('telemetry');expect(mock.instances[2].group).toBe('compare');expect(mock.connect).toHaveBeenCalledWith('telemetry');expect(mock.connect).toHaveBeenCalledWith('compare');});

it('keeps the chart and its zoom when new samples arrive', () => {
  const view = render(<Chart data={[]} metric="cpu_pct" group="zoom-retention" />);
  mock.getOption.mockReturnValueOnce({dataZoom: [{start: 12, end: 84}]});
  mock.on.mock.calls.find(([name]) => name === 'datazoom')?.[1]();
  const sample = {received_at: '2026-01-01T00:00:00Z', cpu_pct: 15, mem_available_kb: null,
    temp_c: null, rx_bytes_delta: null, tx_bytes_delta: null, elapsed_s: null};
  view.rerender(<Chart data={[sample]} metric="cpu_pct" group="zoom-retention" />);
  expect(mock.instances).toHaveLength(1);
  expect(mock.dispose).not.toHaveBeenCalled();
  expect(mock.setOption.mock.lastCall?.[0].dataZoom[0]).toMatchObject({start: 12, end: 84});
});

it('omits redundant min/max CPU series on raw single-sample windows and plots bars for consumed traffic volume', () => {
  const rawSample = {received_at: '2026-11-25T01:00:00Z', cpu_pct: 22, cpu_min: 22, cpu_max: 22, sample_count: 1, mem_available_kb: null, temp_c: null, rx_bytes_delta: 5_242_880, tx_bytes_delta: 1_048_576, elapsed_s: 10};
  render(<Chart data={[rawSample]} metric="cpu_pct" />);
  expect(mock.setOption.mock.lastCall?.[0].series).toHaveLength(1);
  render(<Chart data={[rawSample]} metric="network_mib" />);
  const volSeries = mock.setOption.mock.lastCall?.[0].series;
  expect(volSeries).toHaveLength(2);
  expect(volSeries[0].type).toBe('bar');
  expect(volSeries[1].type).toBe('bar');
});

it('aggregates daily_traffic rows per UTC day into a dual bar chart', () => {
  render(<Chart data={[]} metric="daily_traffic" dailyRows={[
    {day: '2026-11-25', interface_name: 'eth0', role: 'wan', rx_bytes: 1_048_576 * 100, tx_bytes: 1_048_576 * 20},
    {day: '2026-11-25', interface_name: 'usb0', role: 'usbwan', rx_bytes: 1_048_576 * 50, tx_bytes: 1_048_576 * 10},
  ]} />);
  const option = mock.setOption.mock.lastCall?.[0];
  expect(option.xAxis.data).toEqual(['2026-11-25']);
  expect(option.series[0].data).toEqual([150]);
  expect(option.series[1].data).toEqual([30]);
});

it('keeps an isolated point visible in a dense series', () => {
  const data = Array.from({ length: 16 }, (_, index) => ({
    received_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 10)).toISOString(),
    cpu_pct: index === 13 || index === 15 ? null : 20,
    mem_available_kb: null, temp_c: null, rx_bytes_delta: null, tx_bytes_delta: null, elapsed_s: null,
  }));
  render(<Chart data={data} metric="cpu_pct" />);
  const series = mock.setOption.mock.lastCall?.[0].series[0];
  expect(series.showSymbol).toBe(true);
  expect(series.data[0].symbolSize).toBe(0);
  expect(series.data[14].symbolSize).toBe(5);
});

it('keeps uptime labels after zooming a comparison', () => {
  render(<Chart data={[]} metric="cpu_pct" compare={{baseline: [], comparison: [], metric: 'cpu_pct'}} />);
  mock.getOption.mockReturnValueOnce({dataZoom: [{start: 12, end: 84}]});
  mock.on.mock.calls.find(([name]) => name === 'datazoom')?.[1]();
  expect(mock.setOption.mock.lastCall?.[0].xAxis.axisLabel.formatter(3600)).toBe('1h');
});

it('retains unknown days, measured zero, and small volumes next to GiB values', () => {
  const mixed = { received_at: '2026-11-25T00:00:00Z', cpu_pct: null, mem_available_kb: null,
    temp_c: null, rx_bytes_delta: 1024 ** 3, tx_bytes_delta: 100000, elapsed_s: 10 };
  render(<Chart data={[mixed]} metric="network_mib" />);
  expect(mock.setOption.mock.lastCall?.[0].series[1].data[0].value[1]).toBe(100000 / 1024 ** 3);
  render(<Chart data={[]} metric="daily_traffic" dailyRows={[
    {day: '2026-11-25', rx_bytes: mixed.rx_bytes_delta, tx_bytes: mixed.tx_bytes_delta},
    {day: '2026-11-26', rx_bytes: null, tx_bytes: 0},
    {day: '2026-11-27', rx_bytes: 0, tx_bytes: null},
    {day: '2026-11-26', rx_bytes: 512, tx_bytes: 0},
    {day: '2026-11-27', rx_bytes: 0, tx_bytes: 512},
  ]} />);
  const series = mock.setOption.mock.lastCall?.[0].series;
  expect(series[0].data).toEqual([1, null, 0]);
  expect(series[1].data).toEqual([100000 / 1024 ** 3, 0, null]);
  expect(series.map((bar: { barMinHeight: number }) => bar.barMinHeight)).toEqual([0, 0]);
  const tooltip = mock.setOption.mock.lastCall?.[0].tooltip.formatter;
  expect(tooltip([{axisValue: '2026-11-25', value: series[1].data[0]}])).toContain('97.7 KiB');
  expect(tooltip([{axisValue: '2026-11-27', value: null}])).toContain('—');
});
