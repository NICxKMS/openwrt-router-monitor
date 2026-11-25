import { test, expect, type Page } from '@playwright/test';

async function navigate(page: Page, name: string, mobile: boolean) {
  if (mobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name, exact: true }).click();
  if (mobile) await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
}

async function expectChart(page: Page, name: RegExp) {
  await expect(page.getByRole('img', { name }).locator('canvas').first()).toBeVisible();
}

// Synthetic network responses exist only in this browser-test harness. Never bundled.
test('owner can log in, inspect real-query pages and use mobile navigation', async ({ page }, testInfo) => {
  const owner = '00000000-0000-4000-8000-000000000001';
  const device = '10000000-0000-4000-8000-000000000001';
  const boot = '20000000-0000-4000-8000-000000000001';
  const now = new Date().toISOString();
  const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: now };
  const token = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    Buffer.from(JSON.stringify({ sub: owner, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })).toString('base64url'),
    'fixture-signature',
  ].join('.');
  const router = { id: device, name: 'SIMULATED FIXTURE · JIDU6111', model: 'JIDU6111 · browser test data', last_seen_at: now, created_at: now, revoked_at: null, config: { upload_interval: 30, sample_interval: 10, billing_day: 1, monthly_quota_gb: 0 } };
  const sample = {
    device_id: device, boot_id: boot, seq: 1, observed_at: now, received_at: now, bucket: now, uptime_s: 3600,
    cpu_pct: 25, load1: 0.5, mem_total_kb: 400000, mem_available_kb: 200000, temp_c: 55,
    rx_bytes_delta: 100000, tx_bytes_delta: 20000, elapsed_s: 10,
    detail: { capabilities: { fixture: 'SIMULATED ONLY' }, cpu: { cores: { cpu0: 25 } }, processes: [{ name: 'dnsmasq', pid: 100, rss_kb: 2048 }], services: { dnsmasq: true }, wifi: { radios: [] } },
    interfaces: [],
  };

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/usage') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total_devices: 1,
          total_samples: 8640,
          database_size_bytes: 14_680_064,
          latest_observation_at: now,
        }),
      });
      return;
    }
    if (path === '/api/v1/enrollment') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'ENROLL-ABCD-1234-EFGH-5678', expires_at: iso(-10) }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('https://fixture.supabase.co/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (path.includes('/auth/v1/token')) body = { access_token: token, refresh_token: 'fixture-refresh-token', token_type: 'bearer', expires_in: 3600, user };
    else if (path.includes('/auth/v1/user')) body = user;
    else if (path.endsWith('/devices')) body = [router];
    else if (path.endsWith('/device_latest')) body = sample;
    else if (path.endsWith('/metric_samples') || path.endsWith('/rpc/history')) body = [sample];
    else if (path.endsWith('/boot_sessions')) body = [{ device_id: device, boot_id: boot, first_seen_at: now, last_seen_at: now, inventory: { firmware: 'SIMULATED FIXTURE' } }];
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Content-Range': '0-0/1' }, body: JSON.stringify(body) });
  });
  await page.routeWebSocket('wss://fixture.supabase.co/**', (socket) => socket.close());

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await page.screenshot({ path: `test-results/${testInfo.project.name}-login.png`, fullPage: true });
  await page.getByLabel('Email address').fill('fixture@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in securely' }).click();

  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.locator('.device-strip strong')).toHaveText('SIMULATED FIXTURE · JIDU6111');

  const mobile = testInfo.project.name === 'mobile';
  await navigate(page, 'Memory', mobile);
  await expect(page.getByRole('heading', { name: 'Memory', exact: true })).toBeVisible();

  await navigate(page, 'Logs', mobile);
  await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible();

  await navigate(page, 'Overview', mobile);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expectChart(page, /^Processor utilization history/);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-simulated-fixture.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('rich telemetry walkthrough across charts, wifi, logs, alerts, and light theme', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  const owner = '00000000-0000-4000-8000-000000000001';
  const device = '10000000-0000-4000-8000-000000000001';
  const boot = '20000000-0000-4000-8000-000000000001';
  const comparisonBoot = '20000000-0000-4000-8000-000000000002';
  const nowMs = Date.now();
  const iso = (offsetMin: number) => new Date(nowMs - offsetMin * 60000).toISOString();
  const now = iso(0);
  const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: now };
  const token = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    Buffer.from(JSON.stringify({ sub: owner, role: 'authenticated', exp: Math.floor(nowMs / 1000) + 3600, iat: Math.floor(nowMs / 1000) })).toString('base64url'),
    'fixture-signature',
  ].join('.');
  const router = {
    id: device, name: 'JIDU6111 · Home', model: 'JioRouter AX6000 (IPQ9574)',
    last_seen_at: now, created_at: iso(1440), revoked_at: null,
    config: { upload_interval: 30, sample_interval: 10, billing_day: 1, monthly_quota_gb: 500 },
  };
  const firmwareHistory = (cpuStart: number) => Array.from({ length: 12 }, (_, idx) => ({
    uptime_s: 600 + idx * 300,
    cpu_pct: cpuStart + idx,
    mem_available_kb: 200000 - idx * 800,
    temp_c: 53 + (idx % 3),
    rx_bytes_delta: 3_000_000,
    tx_bytes_delta: 600_000,
    elapsed_s: 10,
  }));
  const firmwareBoots = new Map([
    [`eq.${boot}`, firmwareHistory(20)],
    [`eq.${comparisonBoot}`, firmwareHistory(35)],
  ]);
  const history = Array.from({ length: 24 }, (_, idx) => {
    const minsAgo = (23 - idx) * 15;
    const cpu = 18 + Math.round(Math.sin(idx / 3) * 14 + idx * 0.4);
    return {
      bucket: iso(minsAgo), received_at: iso(minsAgo), observed_at: iso(minsAgo), uptime_s: 86400 - minsAgo * 60,
      cpu_pct: cpu, cpu_min: Math.max(5, cpu - 6), cpu_max: Math.min(100, cpu + 12),
      mem_available_kb: 210000 - idx * 1400, temp_c: 52 + (idx % 5) * 1.1,
      rx_bytes_delta: 4_500_000 + idx * 350_000, tx_bytes_delta: 900_000 + idx * 80_000, elapsed_s: 10, sample_count: 15,
    };
  });
  const latest = {
    device_id: device, boot_id: boot, seq: 120, observed_at: now, received_at: now, uptime_s: 86400,
    cpu_pct: 31.4, load1: 0.62, mem_total_kb: 444272, mem_available_kb: 176400, mem_free_kb: 82000,
    cached_kb: 64000, slab_kb: 28000, sreclaimable_kb: 14000, sunreclaim_kb: 14000,
    temp_c: 55.8, rx_bytes_delta: 8_200_000, tx_bytes_delta: 1_900_000, elapsed_s: 10,
    interfaces: [
      { name: 'eth0', role: 'wan', rx_bytes: '94581293012', tx_bytes: '18293012931', rx_delta: 8200000, tx_delta: 1900000, elapsed_s: 10, reset: false },
      { name: 'br-lan', role: 'lan', rx_bytes: '18293012931', tx_bytes: '94581293012', rx_delta: 1900000, tx_delta: 8200000, elapsed_s: 10, reset: false },
    ],
    detail: {
      detail_uptime_s: 86350, processes_uptime_s: 86380, wifi_uptime_s: 86390, connectivity_uptime_s: 86390,
      cpu: { cores: { cpu0: 28.4, cpu1: 34.1, cpu2: 29.8, cpu3: 33.2 } },
      processes: [
        { name: 'dnsmasq', pid: 1412, rss_kb: 6144 },
        { name: 'hostapd', pid: 1890, rss_kb: 9216 },
        { name: 'uhttpd', pid: 2104, rss_kb: 4096 },
      ],
      memory: {
        vmstat: { pgfault: '142810', pgmajfault: '12', pswpin: '0', pswpout: '0', oom_kill: '0' },
        psi: { memory: { some: { avg10: 0.12, avg60: 0.08, avg300: 0.05 }, full: { avg10: 0.0, avg60: 0.0, avg300: 0.0 } } },
      },
      thermal: [{ name: 'thermal_zone0', temp_c: 55.8 }, { name: 'thermal_zone1', temp_c: 59.1 }],
      storage: { overlay: { total_kb: 98304, used_kb: 24576, available_kb: 73728 }, tmp: { total_kb: 222136, used_kb: 18432, available_kb: 203704 } },
      firewall: { conntrack_count: 1420, conntrack_max: 65536, flow_offloading: true, flow_offloading_hw: true },
      services: { dnsmasq: true, odhcpd: true, firewall: true, 'adblock-fast': true, 'https-dns-proxy': true },
      service_checks: { firewall: 'nft_table_present', 'adblock-fast': 'procd_status_success' },
      capabilities: { psi: 'available', wifi: 'available', ppe: 'unavailable: no stable driver-independent counter ABI' },
      wifi: {
        available: true, country: 'IN',
        radios: [
          {
            name: 'phy1-ap0', stations: 2, frequency: 5180, width_mhz: 80, signal_avg_dbm: -53,
            rx_bytes: '4294967296', tx_bytes: '12884901888',
            survey: { frequency: 5180, active_ms: 10000, busy_ms: 1450, noise_dbm: -94 },
            clients: [
              { client_id: 'c_living_laptop', signal_dbm: -49, rx_bytes: '2147483648', tx_bytes: '8589934592', tx_retries: 12, tx_failed: 0, rx_rate_mbps: 1201, tx_rate_mbps: 1080 },
              { client_id: 'c_phone_pixel', signal_dbm: -57, rx_bytes: '536870912', tx_bytes: '2147483648', tx_retries: 4, tx_failed: 1, rx_rate_mbps: 866.7, tx_rate_mbps: 780 },
            ],
          },
        ],
      },
      connectivity: {
        ipv4: { available: true, reachable: true, latency_ms: 12.4, loss_pct: 0, jitter_ms: 1.1 },
        ipv6: { available: true, reachable: true, latency_ms: 14.8, loss_pct: 0, jitter_ms: 1.4 },
        gateway: { available: true, reachable: true, latency_ms: 2.1, loss_pct: 0, jitter_ms: 0.3 },
        dns: { available: true, reachable: true, latency_ms: 11.2 },
      },
    },
  };

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/usage') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total_devices: 1,
          total_samples: 8640,
          database_size_bytes: 14_680_064,
          latest_observation_at: now,
        }),
      });
      return;
    }
    if (path === '/api/v1/enrollment') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'ENROLL-ABCD-1234-EFGH-5678', expires_at: iso(-10) }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('https://fixture.supabase.co/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const isSingle = url.searchParams.get('limit') === '1' || (req.headers()['accept'] || '').includes('vnd.pgrst.object');
    let body: unknown = [];
    if (path.includes('/auth/v1/token')) body = { access_token: token, refresh_token: 'fixture-refresh-token', token_type: 'bearer', expires_in: 3600, user };
    else if (path.includes('/auth/v1/user')) body = user;
    else if (path.endsWith('/devices')) body = [router];
    else if (path.endsWith('/device_latest')) body = latest;
    else if (path.endsWith('/rpc/history')) body = history;
    else if (path.endsWith('/metric_samples')) {
      const bootSamples = firmwareBoots.get(url.searchParams.get('boot_id') ?? '') ?? [];
      const uptimeFilters = url.searchParams.getAll('uptime_s');
      const minUptime = Number(uptimeFilters.find((filter) => filter.startsWith('gte.'))?.slice(4));
      const maxUptime = Number(uptimeFilters.find((filter) => filter.startsWith('lte.'))?.slice(4));
      body = isSingle ? history[history.length - 1] : bootSamples.filter(({ uptime_s }) => uptime_s >= minUptime && uptime_s <= maxUptime);
    }
    else if (path.endsWith('/boot_sessions')) body = [
      { device_id: device, boot_id: boot, first_seen_at: iso(1440), last_seen_at: now, inventory: { model: 'JIDU6111', release: 'OpenWrt SNAPSHOT 6.18.60', kernel: '6.18.60' } },
      { device_id: device, boot_id: comparisonBoot, first_seen_at: iso(4320), last_seen_at: iso(1445), inventory: { model: 'JIDU6111', release: 'OpenWrt SNAPSHOT 6.18.59', kernel: '6.18.59' } },
    ];
    else if (path.endsWith('/alerts')) body = [{ id: 'a1', device_id: device, rule_key: 'reachability:ipv6', severity: 'warning', message: 'IPv6 probe latency elevated briefly', opened_at: iso(45), resolved_at: null, acknowledged_at: null }];
    else if (path.endsWith('/alert_rules')) body = [{ id: 'r1', device_id: device, metric: 'cpu_pct', operator: 'gt', threshold: 90, sustain_s: 120, hysteresis: 5, cooldown_s: 900, enabled: true }];
    else if (path.endsWith('/client_names')) body = [{ device_id: device, client_id: 'c_living_laptop', name: 'Living Room Laptop' }];
    else if (path.endsWith('/bandwidth_daily')) body = [{ device_id: device, day: now.slice(0, 10), interface_name: 'eth0', role: 'wan', rx_bytes: 58_000_000_000, tx_bytes: 12_000_000_000, coverage_s: 82800 }];
    else if (path.endsWith('/system_logs')) body = [{ id: 'l1', device_id: device, boot_id: boot, seq: 10, received_at: iso(5), uptime_s: 86100, severity: 4, service: 'dnsmasq', message: 'nameserver 1.1.1.1 resumed normal response', count: 3, first_at: iso(8), last_at: iso(5) }];
    else if (path.endsWith('/diagnostics')) body = [{ id: 'd1', device_id: device, boot_id: boot, created_at: iso(30), object_path: null, payload: { request_id: 'req-1234', memory: { mem_available_kb: 176400 }, packages: 'base-files - 1.0\ndnsmasq - 2.90\nnicx-telemetry - 1.0.0-r3' } }];
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Content-Range': '0-0/1' }, body: JSON.stringify(body) });
  });
  await page.routeWebSocket('wss://fixture.supabase.co/**', (socket) => socket.close());

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  async function compareFirmware() {
    await navigate(page, 'Firmware comparison', mobile);
    await page.getByLabel('Baseline boot').selectOption(boot);
    await page.getByLabel('Comparison boot').selectOption(comparisonBoot);
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await expect(page.getByText(/Matched uptime:/)).toBeVisible();
    const processor = page.getByRole('row', { name: /Processor utilization/ }).getByRole('cell');
    await expect(processor.nth(1)).toHaveText('25% (20–30)');
    await expect(processor.nth(2)).toHaveText('40% (35–45)');
    await expectChart(page, /^Uptime-aligned cpu_pct history/);
  }

  await page.goto('/');
  await expect(page.getByLabel('Email address')).toBeVisible();
  await page.screenshot({ path: `test-results/${testInfo.project.name}-login.png`, fullPage: true });
  await page.getByLabel('Email address').fill('fixture@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in securely' }).click();

  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Active alerts' })).toBeVisible();
  await expectChart(page, /^Processor utilization history/);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-rich-overview.png`, fullPage: true });

  // Visit Wi-Fi and verify friendly client label join + station table
  await navigate(page, 'Wi-Fi', mobile);
  await expect(page.getByText('Living Room Laptop')).toBeVisible();
  await page.screenshot({ path: `test-results/${testInfo.project.name}-rich-wifi.png`, fullPage: true });

  // Visit CPU & system
  await navigate(page, 'CPU & system', mobile);
  await expect(page.getByText('/overlay')).toBeVisible();
  await expectChart(page, /^Processor utilization history/);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-rich-cpu.png`, fullPage: true });

  // Test light theme + historical window banner on Network
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await navigate(page, 'Network', mobile);
  await page.getByRole('button', { name: 'Previous time window' }).click();
  await expect(page.getByRole('button', { name: 'Return to Live' })).toBeVisible();
  await expectChart(page, /^Internet speed/);
  await expectChart(page, /^Data consumed per interval/);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-light-network-history.png`, fullPage: true });
  await page.getByRole('button', { name: 'Return to Live' }).click();

  // Inspect Memory, Logs, Diagnostics, Alerts on desktop
  if (testInfo.project.name === 'desktop') {
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await page.getByRole('link', { name: 'Memory', exact: true }).click();
    await expect(page.getByText('Kernel memory categories')).toBeVisible();
    await expectChart(page, /^Available memory history/);
    await page.screenshot({ path: `test-results/desktop-rich-memory.png`, fullPage: true });

    await page.getByRole('link', { name: 'Logs', exact: true }).click();
    await expect(page.getByText('nameserver 1.1.1.1 resumed normal response')).toBeVisible();
    await page.screenshot({ path: `test-results/desktop-rich-logs.png`, fullPage: true });

    await page.getByRole('link', { name: 'Alerts', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Threshold rules' })).toBeVisible();
    await page.screenshot({ path: `test-results/desktop-rich-alerts.png`, fullPage: true });

    await page.getByRole('link', { name: 'Diagnostics', exact: true }).click();
    await expect(page.getByText('Snapshot only')).toBeVisible();
    await page.locator('.record summary').first().click();
    await page.getByText(/Installed packages/).click();
    await expect(page.locator('.pkg-list')).toBeVisible();
    await page.getByRole('button', { name: 'Refresh observations' }).click();
    await expect(page.locator('.pkg-list')).toBeVisible();
    await page.screenshot({ path: `test-results/desktop-rich-diagnostics.png`, fullPage: true });

    await page.getByRole('link', { name: 'Internet & ISP', exact: true }).click();
    await expect(page.getByText('Internet reachability')).toBeVisible();
    await page.screenshot({ path: `test-results/desktop-rich-internet.png`, fullPage: true });

    await page.getByRole('link', { name: 'DNS & adblock', exact: true }).click();
    await expect(page.getByText('Ad blocking (AdBlock Fast)')).toBeVisible();
    await page.screenshot({ path: `test-results/desktop-rich-dns.png`, fullPage: true });

    await compareFirmware();
    await page.screenshot({ path: `test-results/desktop-rich-firmware.png`, fullPage: true });

    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Name for c_living_laptop')).toHaveValue('Living Room Laptop');
    await page.getByRole('button', { name: 'Read measured project usage' }).click();
    await expect(page.getByText('Database size bytes')).toBeVisible();
    await page.screenshot({ path: `test-results/desktop-light-settings.png`, fullPage: true });

    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await page.getByRole('button', { name: 'Revoke / delete' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke uploads' })).toBeDisabled();
    await page.screenshot({ path: `test-results/desktop-revoke-dialog.png`, fullPage: false });
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await page.getByRole('button', { name: 'Custom' }).click();
    await expect(page.getByRole('button', { name: 'Apply to all pages' })).toBeVisible();
    await page.screenshot({ path: `test-results/desktop-custom-range.png`, fullPage: false });
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Add router' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByLabel('Router name').fill('Home · Lab');
    await page.getByRole('button', { name: 'Create enrollment code' }).click();
    await expect(page.getByLabel('One-use enrollment code')).toHaveValue('ENROLL-ABCD-1234-EFGH-5678');
    await page.screenshot({ path: `test-results/desktop-enrollment-dialog.png`, fullPage: false });
    await page.getByRole('button', { name: 'Close' }).click();
  }

  if (mobile) {
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await navigate(page, 'Memory', mobile);
    await expect(page.getByText('Kernel memory categories')).toBeVisible();
    await expectChart(page, /^Available memory history/);
    await page.screenshot({ path: `test-results/mobile-rich-memory.png`, fullPage: true });

    await navigate(page, 'Diagnostics', mobile);
    await page.locator('.record summary').first().click();
    await expect(page.getByText(/Installed packages/)).toBeVisible();
    await page.screenshot({ path: `test-results/mobile-rich-diagnostics.png`, fullPage: true });

    await compareFirmware();
    await page.screenshot({ path: `test-results/mobile-rich-firmware.png`, fullPage: true });

    await navigate(page, 'Logs', mobile);
    await expect(page.getByText('nameserver 1.1.1.1 resumed normal response')).toBeVisible();
    await page.screenshot({ path: `test-results/mobile-rich-logs.png`, fullPage: true });

    await navigate(page, 'Alerts', mobile);
    await expect(page.getByRole('heading', { name: 'Threshold rules' })).toBeVisible();
    await page.screenshot({ path: `test-results/mobile-rich-alerts.png`, fullPage: true });

    await navigate(page, 'Settings', mobile);
    await page.getByRole('button', { name: 'Read measured project usage' }).click();
    await expect(page.getByText('Database size bytes')).toBeVisible();
    await page.screenshot({ path: `test-results/mobile-rich-settings.png`, fullPage: true });
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('offline stale banner and empty router state render cleanly', async ({ page }, testInfo) => {
  const owner = '00000000-0000-4000-8000-000000000001';
  const device = '10000000-0000-4000-8000-000000000001';
  const boot = '20000000-0000-4000-8000-000000000001';
  const nowMs = Date.now();
  const iso = (offsetMin: number) => new Date(nowMs - offsetMin * 60000).toISOString();
  const now = iso(0);
  const stale = iso(15);
  const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: now };
  const token = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    Buffer.from(JSON.stringify({ sub: owner, role: 'authenticated', exp: Math.floor(nowMs / 1000) + 3600, iat: Math.floor(nowMs / 1000) })).toString('base64url'),
    'fixture-signature',
  ].join('.');
  let devicesBody: unknown[] = [
    { id: device, name: 'JIDU6111 · Offline', model: 'JioRouter AX6000', last_seen_at: stale, created_at: iso(1440), revoked_at: null, config: { upload_interval: 30, sample_interval: 10 } },
  ];
  const sample = {
    device_id: device, boot_id: boot, seq: 1, observed_at: stale, received_at: stale, bucket: stale, uptime_s: 3600,
    cpu_pct: 12, load1: 0.2, mem_total_kb: 400000, mem_available_kb: 240000, temp_c: 48,
    rx_bytes_delta: 10000, tx_bytes_delta: 5000, elapsed_s: 10, detail: {}, interfaces: [],
  };

  await page.route('https://fixture.supabase.co/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (path.includes('/auth/v1/token')) body = { access_token: token, refresh_token: 'fixture-refresh-token', token_type: 'bearer', expires_in: 3600, user };
    else if (path.includes('/auth/v1/user')) body = user;
    else if (path.endsWith('/devices')) body = devicesBody;
    else if (path.endsWith('/device_latest')) body = sample;
    else if (path.endsWith('/metric_samples') || path.endsWith('/rpc/history')) body = [sample];
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Content-Range': '0-0/1' }, body: JSON.stringify(body) });
  });
  await page.routeWebSocket('wss://fixture.supabase.co/**', (socket) => socket.close());

  await page.goto('/');
  await page.getByLabel('Email address').fill('fixture@example.test');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in securely' }).click();

  await expect(page.getByText(/Router offline or delayed/i)).toBeVisible();
  if (testInfo.project.name === 'desktop') {
    await page.screenshot({ path: 'test-results/desktop-offline-banner.png', fullPage: false });
  }

  devicesBody = [];
  await page.getByRole('button', { name: 'Refresh observations' }).click();
  await expect(page.getByText('No router enrolled yet')).toBeVisible();
  if (testInfo.project.name === 'desktop') {
    await page.screenshot({ path: 'test-results/desktop-empty-routers.png', fullPage: false });
  }
});
