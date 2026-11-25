// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  monitor: {} as Record<string, unknown>,
  clientNames: [] as { client_id: string; name: string }[],
}));

vi.mock('../lib/client', () => ({
  ownerApi: vi.fn(),
  db: {
    from: (table: string) => {
      const data = table === 'client_names' ? fixture.clientNames : [];
      const builder: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
      };
      for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'limit']) builder[m] = () => builder;
      return builder;
    },
  },
}));

vi.mock('../lib/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/data')>()),
  useMonitor: () => fixture.monitor,
}));

import { CPU, DNS, Overview, WiFi } from './Telemetry';
import { ActionProvider } from '../components/Actions';

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
  fixture.clientNames = [{ client_id: 'salt_client_abc', name: 'Workstation' }];
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

afterEach(() => cleanup());

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
  });
});
