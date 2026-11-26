// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from '../lib/model';

const fixture = vi.hoisted(() => ({
  monitor: {} as Record<string, unknown>,
  clientNames: [] as { device_id: string; client_id: string; name: string }[],
  bandwidthDaily: [] as Row[],
}));

vi.mock('../lib/client', () => ({
  ownerApi: vi.fn(),
  db: {
    from: (table: string) => {
      let data: Row[] = table === 'client_names' ? fixture.clientNames : table === 'bandwidth_daily' ? fixture.bandwidthDaily : [];
      const builder = {
        select: () => builder,
        eq: (column: string, value: string) => {
          data = data.filter((row) => row[column] === value);
          return builder;
        },
        gte: (column: string, value: string) => {
          data = data.filter((row) => String(row[column]) >= value);
          return builder;
        },
        lte: (column: string, value: string) => {
          data = data.filter((row) => String(row[column]) <= value);
          return builder;
        },
        order: () => builder,
        limit: (count: number) => {
          data = data.slice(0, count);
          return builder;
        },
        range: (from: number, to: number) => {
          data = data.slice(from, to + 1);
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
      };
      return builder;
    },
  },
}));

vi.mock('../lib/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/data')>()),
  useMonitor: () => fixture.monitor,
}));

// Page tests verify telemetry around the chart. Canvas rendering runs in Playwright.
vi.mock('../components/Chart', () => ({ default: () => null }));

import { CPU, DNS, Network, Overview, WiFi } from './Telemetry';
import { ActionProvider } from '../components/Actions';
import { Interfaces } from '../components/Shared';

const sample = {
  uptime_s: 3600,
  cpu_pct: 42.5,
  load1: 0.75,
  mem_total_kb: 409600,
  mem_available_kb: 204800,
  temp_c: 58.2,
  rx_bytes_delta: 2500000,
  tx_bytes_delta: 500000,
  elapsed_s: 10,
  detail: {
    cpu: { cores: { cpu0: 40, cpu1: 45 } },
    thermal: [{ name: 'thermal_zone0', temp_c: 58.2 }],
    storage: { overlay: { total_kb: 102400, used_kb: 20480, available_kb: 81920 } },
    firewall: { conntrack_count: 320, conntrack_max: 65536, flow_offloading: true, flow_offloading_hw: false },
    services: { dnsmasq: true, 'https-dns-proxy': true, 'adblock-fast': true },
    service_checks: { firewall: 'nft_table_present', 'adblock-fast': 'procd_status_success' },
    capabilities: { psi: 'unavailable', wifi: 'available' },
    wifi: {
      available: true,
      country: 'IN',
      radios: [
        {
          name: 'phy1-ap0',
          stations: 1,
          frequency: 5180,
          width_mhz: 80,
          signal_avg_dbm: -52,
          rx_bytes: '1048576',
          tx_bytes: '2097152',
          survey: { active_ms: 1000, busy_ms: 150, noise_dbm: -95 },
          clients: [
            {
              client_id: 'salt_client_abc',
              signal_dbm: -52,
              rx_bytes: '1048576',
              tx_bytes: '2097152',
              tx_retries: 4,
              tx_failed: 0,
              rx_rate_mbps: 866.7,
              tx_rate_mbps: 780.0,
            },
          ],
        },
      ],
    },
    connectivity: {
      dns: { available: true, reachable: true, latency_ms: 14.5 },
    },
  },
  interfaces: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.clientNames = [{ device_id: 'dev-1', client_id: 'salt_client_abc', name: 'Workstation' }];
  fixture.bandwidthDaily = [];
  fixture.monitor = {
    device: { id: 'dev-1', name: 'JIDU6111', model: 'JioRouter AX6000', config: {} },
    latest: sample,
    history: [sample],
    openAlerts: [
      {
        id: 'alert-1',
        device_id: 'dev-1',
        rule_key: 'oom:boot-1',
        severity: 'critical',
        message: 'Kernel reported an out-of-memory event',
        opened_at: '2026-11-25T11:00:00Z',
        resolved_at: null,
        acknowledged_at: null,
      },
    ],
    range: { from: '2026-11-25T06:00:00Z', to: '2026-11-25T12:00:00Z', live: true, hours: 6 },
    zone: 'Asia/Kolkata',
    theme: 'dark',
    tick: 0,
    refresh: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('structured telemetry views', () => {
  it('surfaces open alerts and core KPIs on Overview', () => {
    render(
      <ActionProvider>
        <Overview />
      </ActionProvider>,
    );
    expect(screen.getByRole('region', { name: 'Active alerts' })).toHaveTextContent('Kernel reported an out-of-memory event');
    expect(screen.getAllByText('42.5%').length).toBeGreaterThan(0);
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('↓ 2 Mbps')).toBeInTheDocument();
  });

  it('extracts associated Wi-Fi stations from radio clients and joins friendly names', async () => {
    render(<WiFi />);
    expect(screen.getAllByText('5 GHz').length).toBeGreaterThan(0);
    expect(screen.getByText('5,180 MHz · 80 MHz')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Workstation')).toBeInTheDocument());
    expect(screen.getAllByText('-52 dBm').length).toBeGreaterThan(0);
  });

  it.each([
    { reported: [0, undefined], expected: '—' },
    { reported: [2, -1], expected: '—' },
    { reported: [0, 0], expected: '0' },
    { reported: [1, 2], expected: '3' },
  ])('shows $expected associated stations for radio counts $reported', async ({ reported, expected }) => {
    fixture.monitor.latest = {
      ...sample,
      detail: {
        ...sample.detail,
        wifi: { ...sample.detail.wifi, radios: reported.map((stations, index) => ({ name: `wlan${index}`, stations })) },
      },
    };
    await act(async () => {
      render(<WiFi />);
    });
    const stationStat = screen.getByText('Associated stations', { selector: '.eyebrow' }).closest('.stat');
    expect(stationStat?.querySelector('strong')?.textContent).toBe(expected);
  });

  it('renders AdBlock Fast status from services and service_checks on DNS page', () => {
    render(<DNS />);
    expect(screen.getByText('Ad blocking (AdBlock Fast)')).toBeInTheDocument();
    expect(screen.getByText('Active (procd)')).toBeInTheDocument();
    expect(screen.getByText('14.5 ms')).toBeInTheDocument();
  });

  it('renders structured thermal, overlay storage, and conntrack telemetry on CPU page', () => {
    render(<CPU />);
    expect(screen.getByText('/overlay')).toBeInTheDocument();
    expect(screen.getAllByText('320 / 65,536').length).toBeGreaterThan(0);
    expect(screen.getByText('fw4 table active')).toBeInTheDocument();
    expect(screen.getAllByText('58.2 °C').length).toBe(3);
    expect(screen.queryByText('58.2%')).not.toBeInTheDocument();
  });

  it('keeps omitted firewall offload flags as Unknown while showing explicit false as Disabled', () => {
    fixture.monitor = {
      ...fixture.monitor,
      latest: {
        ...sample,
        detail: {
          ...sample.detail,
          firewall: { conntrack_count: 100, conntrack_max: 65536, flow_offloading: false },
        },
      },
    };
    render(<CPU />);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('loads monthly quota usage independently of the selected chart range', async () => {
    vi.setSystemTime(new Date('2026-01-31T12:00:00Z'));
    const range = { from: '2026-01-31T06:00:00Z', to: '2026-01-31T12:00:00Z', live: false, hours: 6 };
    fixture.monitor = {
      ...fixture.monitor,
      device: { id: 'dev-1', name: 'JIDU6111', model: 'JioRouter AX6000', config: { monthly_quota_gb: 200, billing_day: 1 } },
      range,
    };
    fixture.bandwidthDaily = Array.from({ length: 31 }, (_, day) =>
      ['eth0', 'eth1', 'usb0', 'usb1'].map((name) => ({
        device_id: 'dev-1',
        day: `2026-01-${String(day + 1).padStart(2, '0')}`,
        interface_name: name,
        role: name.startsWith('eth') ? 'wan' : 'usbwan',
        rx_bytes: 900_000_000,
        tx_bytes: 100_000_000,
      })),
    ).flat();
    fixture.bandwidthDaily.push(
      { ...fixture.bandwidthDaily[0], day: '2025-12-31' },
      { ...fixture.bandwidthDaily[0], day: '2026-02-01' },
      { ...fixture.bandwidthDaily[0], device_id: 'dev-2' },
    );

    const { rerender } = render(<Network />);
    expect(await screen.findByText('124 GB used of 200 GB')).toBeInTheDocument();
    expect(screen.getAllByText('2026-01-31')).toHaveLength(4);
    expect(screen.queryByText('2026-01-30')).toBeNull();

    fixture.monitor.range = { ...range, from: '2026-01-30T12:00:00Z', hours: 24 };
    rerender(<Network />);
    await waitFor(() => expect(screen.getAllByText('2026-01-30')).toHaveLength(4));
    expect(screen.getByText('124 GB used of 200 GB')).toBeInTheDocument();

    fixture.bandwidthDaily[0].rx_bytes = 1_900_000_000;
    fixture.monitor.tick = 1;
    rerender(<Network />);
    expect(await screen.findByText('125 GB used of 200 GB')).toBeInTheDocument();
  });

  it('separates speed and consumed traffic stats on Network without flashing quota loading on poll', async () => {
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    fixture.monitor = {
      ...fixture.monitor,
      device: { id: 'dev-1', name: 'JIDU6111', model: 'JioRouter AX6000', config: { monthly_quota_gb: 200, billing_day: 1 } },
      history: [
        { ...sample, rx_bytes_delta: 5_242_880, tx_bytes_delta: 1_048_576, elapsed_s: 10 },
        { ...sample, rx_bytes_delta: 5_242_880, tx_bytes_delta: 1_048_576, elapsed_s: 10 },
      ],
    };
    fixture.bandwidthDaily = [{ device_id: 'dev-1', day: '2026-11-25', interface_name: 'eth0', role: 'wan', rx_bytes: 2_000_000_000, tx_bytes: 0 }];
    const { rerender } = render(<Network />);
    expect(await screen.findByText('2 GB used of 200 GB')).toBeInTheDocument();
    expect(screen.getAllByText('12 MiB').length).toBeGreaterThan(0);
    expect(screen.getByText('Approx. consumed in window')).toBeInTheDocument();
    expect(screen.getByText('Approx. downloaded (↓)')).toBeInTheDocument();
    expect(screen.getByText('Approx. uploaded (↑)')).toBeInTheDocument();
    expect(screen.getByText('Internet speed (Rx & Tx)')).toBeInTheDocument();
    expect(screen.getByText('Data consumed per interval')).toBeInTheDocument();

    fixture.monitor = { ...fixture.monitor, tick: 1 };
    rerender(<Network />);
    expect(screen.queryByText('Loading billing-cycle quota usage…')).toBeNull();
    expect(screen.getByText('2 GB used of 200 GB')).toBeInTheDocument();
  });

  it('shows a WAN-specific empty state when only LAN counters are reported', () => {
    fixture.monitor.latest = { ...sample, interfaces: [{ name: 'br-lan', role: 'lan' }] };
    render(<Interfaces wanOnly />);
    expect(screen.getByText('No WAN uplink counters reported')).toBeInTheDocument();
  });

  it('loads daily traffic past one API page and keeps incomplete current-day totals unavailable', async () => {
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    fixture.monitor.range = {from: '2026-11-24T12:00:00Z', to: '2026-11-25T12:00:00Z', live: false, hours: 24};
    fixture.bandwidthDaily = Array.from({ length: 1000 }, (_, index) => ({
      device_id: 'dev-1', day: '2026-11-24', interface_name: `fixture-${index}`, role: 'wan', rx_bytes: 0, tx_bytes: 0,
    }));
    fixture.bandwidthDaily.push({
      device_id: 'dev-1', day: '2026-11-25', interface_name: 'fixture-last', role: 'wan', rx_bytes: 1024, tx_bytes: null,
    });
    render(<Network />);
    expect(await screen.findByText('fixture-last')).toBeInTheDocument();
    expect(screen.getByText('↓ 1 KiB · ↑ — · incomplete data')).toBeInTheDocument();
  });

  it('hides the previous quota usage from the first render for another router', async () => {
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    const router = { id: 'dev-1', name: 'JIDU6111', model: 'JioRouter AX6000', config: { monthly_quota_gb: 200 } };
    fixture.monitor.device = router;
    fixture.bandwidthDaily = [
      { device_id: 'dev-1', day: '2026-11-25', rx_bytes: 2_000_000_000 },
      { device_id: 'dev-2', day: '2026-11-25', rx_bytes: 1_000_000_000 },
    ];
    const commits: string[] = [];

    function QuotaRender() {
      const root = React.useRef<HTMLDivElement>(null);
      // Observe the DOM commit before useQuery's effect starts the next read.
      React.useLayoutEffect(() => {
        commits.push(root.current?.textContent ?? '');
      });
      return <div ref={root}><Network /></div>;
    }

    const { rerender } = render(<QuotaRender />);
    expect(await screen.findByText('2 GB used of 200 GB')).toBeInTheDocument();

    fixture.monitor.device = { ...router, id: 'dev-2', config: { monthly_quota_gb: 100 } };
    rerender(<QuotaRender />);
    expect(commits.at(-1)).toContain('— used of 100 GB');
    expect(await screen.findByText('1 GB used of 100 GB')).toBeInTheDocument();
  });
});
