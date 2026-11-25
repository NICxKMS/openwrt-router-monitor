// @vitest-environment jsdom
import {cleanup, render} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import Chart from './Chart';

const chart = vi.hoisted(() => ({
  init: vi.fn(), setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn(),
}));
vi.mock('echarts/core', () => ({use: vi.fn(), init: chart.init}));
vi.mock('../lib/data', () => ({useMonitor: () => ({zone: 'UTC', theme: 'dark'})}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('updates a live chart without disposing its zoom state', () => {
  chart.init.mockReturnValue(chart);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const view = render(<Chart metric="cpu_pct" data={[]} />);
  view.rerender(<Chart metric="cpu_pct" data={[{received_at: '2026-01-01T00:00:00Z', cpu_pct: 15, mem_available_kb: null, temp_c: null, rx_bytes_delta: null, tx_bytes_delta: null, elapsed_s: null}]} />);
  expect(chart.init).toHaveBeenCalledTimes(1);
  expect(chart.dispose).not.toHaveBeenCalled();
  expect(chart.setOption).toHaveBeenCalledTimes(2);
});
