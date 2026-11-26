import { Info, ShieldAlert } from 'lucide-react';
import { useMonitor, useQuery } from '../lib/data';
import { db, ownerApi } from '../lib/client';
import {
  bytes,
  capabilityLabel,
  date,
  fmt,
  memoryCategories,
  mib,
  num,
  object,
  rate,
  relativeAge,
  rows,
  ruleCategoryLabel,
  sentenceCase,
  serviceCheckLabel,
  uptime,
  vmstatLabel,
  wifiBand,
  type Row,
} from '../lib/model';
import { Card, Empty, Notice, QueryState } from '../components/ui/primitives';
import {
  CollectorLag,
  DataTable,
  DetailCard,
  Fields,
  HistoryChart,
  Interfaces,
  MemorySummaryStrip,
  ProgressBar,
  Stat,
} from '../components/Shared';
import { ActionButton } from '../components/Actions';
import { CpuBreakdown, MemoryBreakdown } from '../components/SystemDetail';

function cpuTone(v: number | null): 'accent' | 'warn' | 'bad' {
  if (v === null) return 'accent';
  if (v >= 90) return 'bad';
  if (v >= 75) return 'warn';
  return 'accent';
}

function memTone(pct: number | null): 'default' | 'warn' | 'bad' {
  if (pct === null) return 'default';
  if (pct >= 92) return 'bad';
  if (pct >= 80) return 'warn';
  return 'default';
}

function tempTone(t: number | null): 'default' | 'warn' | 'bad' {
  if (t === null) return 'default';
  if (t >= 85) return 'bad';
  if (t >= 75) return 'warn';
  return 'default';
}

export function Overview() {
  const { latest, device, history, openAlerts, refresh, zone } = useMonitor();
  const memTotal = num(latest?.mem_total_kb);
  const memAvail = num(latest?.mem_available_kb);
  const memPct = memTotal && memAvail !== null ? ((memTotal - memAvail) / memTotal) * 100 : null;
  const cpuPct = num(latest?.cpu_pct);
  const tempC = num(latest?.temp_c);
  const rxMbps = rate(latest?.rx_bytes_delta, latest?.elapsed_s);
  const txMbps = rate(latest?.tx_bytes_delta, latest?.elapsed_s);
  const detail = object(latest?.detail);
  const coreCount = Object.keys(object(object(detail.cpu).cores)).length;
  const hasTempHistory = tempC !== null || history.some((s) => num(s.temp_c) !== null);
  const criticalAlerts = openAlerts.some((a) => a.severity === 'critical');

  return (
    <>
      {openAlerts.length > 0 && (
        <div className={`alert-strip ${criticalAlerts ? '' : 'warn'}`} role="region" aria-label="Active alerts">
          <div className="alert-strip-head">
            <span className="alert-strip-title">
              <ShieldAlert size={16} />
              {openAlerts.length} open {openAlerts.length === 1 ? 'alert' : 'alerts'} on this router
            </span>
            <a className="button sm" href="#Alerts">
              Manage alerts
            </a>
          </div>
          <div className="alert-strip-items">
            {openAlerts.slice(0, 3).map((a) => (
              <div className="alert-strip-item" key={a.id}>
                <div>
                  <span className={`badge ${a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'info'}`}>
                    {sentenceCase(a.severity)}
                  </span>{' '}
                  <span className="badge">{ruleCategoryLabel(a.rule_key)}</span>{' '}
                  <span>{a.message}</span>{' '}
                  <span className="muted small">· {relativeAge(a.opened_at)} ({date(a.opened_at, zone)})</span>
                </div>
                {!a.acknowledged_at && (
                  <ActionButton
                    variant="outline"
                    className="sm"
                    actionKey={`ack:${a.id}`}
                    pendingLabel="Acknowledging…"
                    successMessage="Alert acknowledged. The condition remains open until it recovers."
                    onAction={async (action) => {
                      await ownerApi(`/api/v1/alerts/${a.id}/ack`, undefined, 'POST', action.signal);
                      action.signal.throwIfAborted();
                      refresh();
                    }}
                  >
                    Acknowledge
                  </ActionButton>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {device && (Number(device.dropped_samples || 0) > 0 || Number(device.dropped_logs || 0) > 0 || device.storage_degraded_at) && (
        <div className="notice warn" role="status">
          <strong>Telemetry notice:</strong>{' '}
          {device.storage_degraded_at
            ? `Cloud storage budget guard activated (${date(device.storage_degraded_at, zone, true)}); low-priority detail and logs may be skipped.`
            : `Cumulative router/cloud drops recorded: ${Number(device.dropped_samples || 0)} samples, ${Number(device.dropped_logs || 0)} logs.`}
        </div>
      )}

      <div className="stats">
        <Stat
          label="Processor"
          value={fmt(cpuPct, '%')}
          sub={`Load 1m: ${fmt(latest?.load1, '', 2)}${coreCount ? ` · ${coreCount} cores` : ''}`}
          tone={cpuTone(cpuPct)}
        />
        <Stat
          label="Memory in use"
          value={fmt(memPct, '%')}
          sub={memAvail !== null ? `${mib(memAvail)} free${memTotal ? ` / ${mib(memTotal)}` : ''}` : 'Unavailable'}
          tone={memTone(memPct)}
        />
        <Stat
          label="Internet throughput"
          value={rxMbps !== null ? `↓ ${fmt(rxMbps, ' Mbps')}` : '—'}
          sub={txMbps !== null ? `↑ ${fmt(txMbps, ' Mbps')} upload · WAN uplinks` : 'Designated internet uplinks only'}
        />
        <Stat
          label="Uptime & thermal"
          value={uptime(latest?.uptime_s)}
          sub={tempC !== null ? `${fmt(tempC, ' °C')} · ${device?.model || 'Router'}` : device?.model || 'Model not reported'}
          tone={tempTone(tempC)}
        />
      </div>

      <div className="two-col">
        <HistoryChart metric="cpu_pct" title="Processor utilization" height={240} />
        <HistoryChart metric="mem_available_mib" title="Available memory" unit=" MiB" height={240} allowMemoryToggle />
      </div>

      <div className="two-col">
        <HistoryChart
          metric="network_mbps"
          title="Internet throughput"
          unit=" Mbps"
          height={240}
          allowNetworkToggle
        />
        {hasTempHistory ? (
          <HistoryChart metric="temp_c" title="Thermal sensor" unit=" °C" height={240} />
        ) : (
          <Card title="Thermal sensor" description="Primary thermal zone reported by the router.">
            <Empty title="No thermal readings">This device or snapshot did not report a valid temperature sensor.</Empty>
          </Card>
        )}
      </div>

      <QuickHealthSummary />

      <div className="two-col">
        <Card title="Observation quality" description="Clock source, sample interval, and boot session metadata.">
          <dl className="fields">
            <div>
              <dt>Temperature</dt>
              <dd className="mono">{fmt(tempC, ' °C')}</dd>
            </div>
            <div>
              <dt>Sample interval</dt>
              <dd className="mono">{fmt(latest?.elapsed_s, ' s', 2)}</dd>
            </div>
            {object(detail.cadence).sample_s !== undefined && (
              <div>
                <dt>Effective cadence</dt>
                <dd className="mono small">
                  {String(object(detail.cadence).sample_s)}s sample, {String(object(detail.cadence).connectivity_s ?? '—')}s probes,{' '}
                  {String(object(detail.cadence).detail_s ?? '—')}s detail
                </dd>
              </div>
            )}
            <div>
              <dt>Boot session</dt>
              <dd>
                <code>{String(object(latest).boot_id ?? '—')}</code>
              </dd>
            </div>
            <div>
              <dt>Clock source</dt>
              <dd>
                <span className={`badge ${latest?.observed_at ? 'good' : 'warn'}`}>
                  {latest?.observed_at ? 'Router NTP synced' : 'Server receipt only'}
                </span>
              </dd>
            </div>
          </dl>
        </Card>
        <Identity />
      </div>

      <Interfaces />
    </>
  );
}

function QuickHealthSummary() {
  const { latest } = useMonitor();
  const detail = object(latest?.detail);
  const connectivity = object(detail.connectivity);
  const services = object(detail.services);
  const wifi = object(detail.wifi);
  const radios = rows(wifi.radios);
  const totalStations = radios.reduce((sum, r) => sum + (num(r.stations) ?? 0), 0);
  const probeKeys = ['ipv4', 'ipv6', 'gateway', 'dns'].filter((k) => connectivity[k]);
  const serviceEntries = Object.entries(services);

  if (!probeKeys.length && !serviceEntries.length && !radios.length) return null;

  return (
    <div className="two-col">
      <Card title="Reachability & wireless summary" description="Quick snapshot from the latest extended collectors.">
        <div className="stack">
          {probeKeys.length > 0 ? (
            <div className="probe-grid">
              {probeKeys.map((key) => {
                const probe = object(connectivity[key]);
                return (
                  <div className="kv-box" key={key}>
                    <span>{key === 'dns' ? 'DNS' : key === 'gateway' ? 'Gateway' : key.toUpperCase()}</span>
                    <strong>{fmt(probe.latency_ms, ' ms')}</strong>
                    <span className={`badge ${probe.reachable === true ? 'good' : probe.reachable === false ? 'bad' : ''}`} style={{ marginTop: 6 }}>
                      {probe.reachable === true ? 'Reachable' : probe.reachable === false ? 'Unreachable' : 'Unknown'}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted small">Connectivity probes are not enabled or haven't reported in this boot.</p>
          )}
          {radios.length > 0 && (
            <div className="small muted">
              Wi-Fi: <strong>{radios.length}</strong> {radios.length === 1 ? 'radio' : 'radios'} active,{' '}
              <strong>{totalStations}</strong> associated {totalStations === 1 ? 'station' : 'stations'}.{' '}
              <a href="#Wi-Fi" style={{ color: 'var(--accent)', fontWeight: 500 }}>
                Open Wi-Fi details
              </a>
            </div>
          )}
        </div>
      </Card>

      <Card title="Service health" description="Status of core OpenWrt daemons and policy checks.">
        {serviceEntries.length > 0 ? (
          <div className="service-grid">
            {serviceEntries.map(([name, val]) => (
              <div className="service-tile" key={name}>
                <span>{name}</span>
                <span className={`badge ${val === true ? 'good' : val === false ? 'bad' : ''}`}>
                  {val === true ? 'Running' : val === false ? 'Stopped' : 'Unknown'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No service checks reported" />
        )}
      </Card>
    </div>
  );
}

export function CPU() {
  const { latest } = useMonitor();
  const detail = object(latest?.detail);
  const thermal = rows(detail.thermal);
  const storage = object(detail.storage);
  const firewall = object(detail.firewall);
  const capabilities = object(detail.capabilities);
  const serviceChecks = object(detail.service_checks);
  const cpuPct = num(latest?.cpu_pct);
  const conntrackCount = num(firewall.conntrack_count);
  const conntrackMax = num(firewall.conntrack_max);
  const conntrackPct = conntrackCount !== null && conntrackMax && conntrackMax > 0 ? (conntrackCount / conntrackMax) * 100 : null;
  const maxThermal = thermal.reduce<number | null>((best, t) => {
    const val = num(t.temp_c);
    return val === null ? best : best === null ? val : Math.max(best, val);
  }, num(latest?.temp_c));

  return (
    <>
      <div className="stats">
        <Stat label="Processor" value={fmt(cpuPct, '%')} sub={`1m Load: ${fmt(latest?.load1, '', 2)}`} tone={cpuTone(cpuPct)} />
        <Stat
          label="CPU cores"
          value={Object.keys(object(object(detail.cpu).cores)).length || '—'}
          sub="Active monitored cores"
        />
        <Stat label="Peak thermal" value={fmt(maxThermal, ' °C')} sub={`${thermal.length || 1} sensor(s)`} tone={tempTone(maxThermal)} />
        <Stat
          label="Conntrack table"
          value={conntrackPct !== null ? fmt(conntrackPct, '%') : '—'}
          sub={conntrackCount !== null && conntrackMax ? `${conntrackCount.toLocaleString()} / ${conntrackMax.toLocaleString()}` : 'Not reported'}
        />
      </div>

      <HistoryChart metric="cpu_pct" title="Processor utilization" />

      <div className="two-col">
        <PerCore />
        <Processes />
      </div>

      <CpuBreakdown detail={detail} />

      <div className="two-col">
        <Card
          title="Thermal zones"
          description="Measured sensor temperatures across SoC and radio thermal zones."
          action={<CollectorLag uptimeKey="detail_uptime_s" label="Thermal" />}
        >
          {thermal.length ? (
            <div className="tile-list">
              {thermal.map((z, idx) => {
                const temp = num(z.temp_c);
                return (
                  <div className="tile-row" key={String(z.name || idx)}>
                    <div className="tile-row-top">
                      <code>{String(z.name || `zone_${idx}`)}</code>
                      <span className={`badge ${temp !== null && temp >= 85 ? 'bad' : temp !== null && temp >= 75 ? 'warn' : 'good'}`}>
                        {fmt(temp, ' °C')}
                      </span>
                    </div>
                    <ProgressBar
                      percent={temp}
                      valueLabel={fmt(temp, ' °C')}
                      label={`${String(z.name)} temperature`}
                      tone={temp !== null && temp >= 85 ? 'bad' : temp !== null && temp >= 75 ? 'warn' : 'accent'}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty title="No thermal zones reported" />
          )}
        </Card>

        <Card
          title="Filesystem capacity"
          description="Flash overlay and RAM tmpfs mount utilization."
          action={<CollectorLag uptimeKey="detail_uptime_s" label="Storage" />}
        >
          {Object.keys(storage).length ? (
            <div className="tile-list">
              {Object.entries(storage).map(([mount, raw]) => {
                const fs = object(raw);
                const total = num(fs.total_kb);
                const used = num(fs.used_kb);
                const avail = num(fs.available_kb);
                const pct = total && used !== null ? (used / total) * 100 : null;
                return (
                  <div className="tile-row" key={mount}>
                    <div className="tile-row-top">
                      <strong>/{mount}</strong>
                      <span className="small muted mono">
                        {used !== null ? mib(used) : '—'} used · {avail !== null ? mib(avail) : '—'} free of {total !== null ? mib(total) : '—'}
                      </span>
                    </div>
                    <ProgressBar percent={pct} label={`/${mount} usage`} />
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty title="No filesystem counters reported" />
          )}
        </Card>
      </div>

      <div className="two-col">
        <Card
          title="Firewall & connection tracking"
          description="Netfilter conntrack table utilization and configured flow offloading flags."
          action={<CollectorLag uptimeKey="detail_uptime_s" label="Firewall" />}
        >
          {Object.keys(firewall).length ? (
            <div className="stack">
              <div>
                <div className="tile-row-top" style={{ marginBottom: 8 }}>
                  <span className="small muted">Active conntrack entries</span>
                  <span className="mono small">
                    {conntrackCount !== null ? conntrackCount.toLocaleString() : '—'} /{' '}
                    {conntrackMax !== null ? conntrackMax.toLocaleString() : '—'}
                  </span>
                </div>
                <ProgressBar percent={conntrackPct} label="Conntrack table utilization" />
              </div>
              <div className="service-grid">
                {(
                  [
                    ['flow_offloading', 'Software offload'],
                    ['flow_offloading_hw', 'Hardware offload'],
                  ] as const
                ).map(([flagKey, flagLabel]) => {
                  const val = firewall[flagKey];
                  const label = val === true ? 'Enabled' : val === false ? 'Disabled' : 'Unknown';
                  return (
                    <div className="service-tile" key={flagKey}>
                      <span>{flagLabel}</span>
                      <span className={`badge ${val === true ? 'good' : ''}`}>{label}</span>
                    </div>
                  );
                })}
                {typeof serviceChecks.firewall === 'string' && (
                  <div className="service-tile">
                    <span>fw4 table check</span>
                    <span className="badge info">{serviceCheckLabel(serviceChecks.firewall)}</span>
                  </div>
                )}
              </div>
              <p className="small muted">
                Configured flow-offload flags reflect UCI policy; they do not guarantee every flow is hardware-accelerated.
              </p>
            </div>
          ) : (
            <Empty title="Firewall telemetry not reported" />
          )}
        </Card>

        <Card title="Collector capabilities" description="Explicit feature availability reported by this router agent.">
          {Object.keys(capabilities).length ? (
            <div className="tile-list">
              {Object.entries(capabilities).map(([key, val]) => {
                const text = String(val ?? 'unknown');
                const ok = text === 'available';
                return (
                  <div className="tile-row" key={key}>
                    <div className="tile-row-top">
                      <strong>{capabilityLabel(key)}</strong>
                      <span className={`badge ${ok ? 'good' : ''}`}>{ok ? 'Available' : 'Unavailable / Disabled'}</span>
                    </div>
                    {!ok && <span className="small muted">{text}</span>}
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty title="No capability manifest reported" />
          )}
        </Card>
      </div>
    </>
  );
}

export function Memory() {
  const { latest } = useMonitor();
  const detail = object(latest?.detail);
  const memDetail = object(detail.memory);
  const vmstat = object(memDetail.vmstat);
  const psi = object(memDetail.psi);
  const totalKb = num(latest?.mem_total_kb);
  const availKb = num(latest?.mem_available_kb);
  const usedPct = totalKb && availKb !== null ? ((totalKb - availKb) / totalKb) * 100 : null;
  const memInfo = object(detail.meminfo);
  const cachedKb = num(memInfo.cached_kb) ?? num(latest?.cached_kb);
  const sreclaimKb = num(memInfo.sreclaimable_kb) ?? num(latest?.sreclaimable_kb);
  const reclaimableTotal =
    cachedKb !== null || sreclaimKb !== null ? ((cachedKb ?? 0) + (sreclaimKb ?? 0)) * 1024 : null;
  const oomKills = num(vmstat.oom_kill);

  const categories = memoryCategories(latest);

  return (
    <>
      <div className="stats">
        <Stat label="Total RAM" value={mib(totalKb)} sub="Kernel usable RAM" />
        <Stat label="Memory in use" value={fmt(usedPct, '%')} sub={totalKb && availKb !== null ? mib(totalKb - availKb) : 'Unavailable'} tone={memTone(usedPct)} />
        <Stat label="Available RAM" value={mib(availKb)} sub="Includes memory kernel can reclaim" />
        <Stat
          label="OOM & cache"
          value={oomKills !== null ? `${oomKills} OOM` : bytes(reclaimableTotal)}
          sub={reclaimableTotal !== null ? `${bytes(reclaimableTotal)} cache + reclaimable slab` : 'VM counters at 5m cadence'}
          tone={oomKills !== null && oomKills > 0 ? 'bad' : 'default'}
        />
      </div>

      <MemorySummaryStrip sample={latest} />

      <HistoryChart metric="mem_available_mib" title="Available memory" unit=" MiB" allowMemoryToggle />

      <MemoryBreakdown memory={memDetail} />

      <div className="two-col">
        <Card
          title="Kernel memory categories"
          description="Cache includes shared memory and tmpfs. Total slab includes reclaimable and unreclaimable parts; do not sum rows."
        >
          <DataTable
            data={categories}
            columns={[
              { key: 'name', label: 'Category' },
              { key: 'bytes', label: 'Memory', render: bytes },
              {
                key: 'pct',
                label: 'Share of RAM',
                render: (_v, row) => {
                  const b = num(row.bytes);
                  const pct = totalKb && b !== null ? (b / (totalKb * 1024)) * 100 : null;
                  return <ProgressBar percent={pct} label={`${String(row.name)} share`} />;
                },
              },
            ]}
          />
        </Card>

        <Card
          title="Memory pressure & VM counters"
          description="Pressure-stall counters and virtual-memory totals sampled at detail cadence."
          action={<CollectorLag uptimeKey="detail_uptime_s" label="Memory detail" />}
        >
          {Object.keys(vmstat).length || Object.keys(psi).length ? (
            <div className="stack">
              {Object.keys(vmstat).length > 0 && (
                <div>
                  <h3 style={{ marginBottom: 10 }}>Cumulative kernel VM counters</h3>
                  <div className="kv-grid">
                    {Object.entries(vmstat).map(([k, v]) => (
                      <div className="kv-box" key={k}>
                        <span>{vmstatLabel(k)}</span>
                        <strong style={k === 'oom_kill' && Number(v) > 0 ? { color: 'var(--red)' } : undefined}>
                          {num(v) !== null ? Number(v).toLocaleString() : String(v)}
                        </strong>
                        <code className="small muted">{k}</code>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {Object.keys(psi).length > 0 ? (
                <div>
                  <h3 style={{ marginBottom: 10 }}>Linux PSI (Pressure Stall Information)</h3>
                  <DataTable
                    data={Object.entries(psi).flatMap(([resource, raw]) =>
                      Object.entries(object(raw)).map(([scope, stats]) => ({
                        resource: `${resource.toUpperCase()} (${scope})`,
                        avg10: num(object(stats).avg10),
                        avg60: num(object(stats).avg60),
                        avg300: num(object(stats).avg300),
                        total: object(stats).total,
                      })),
                    )}
                    columns={[
                      { key: 'resource', label: 'Resource' },
                      { key: 'avg10', label: '10s avg', render: (v) => fmt(v, '%', 2) },
                      { key: 'avg60', label: '60s avg', render: (v) => fmt(v, '%', 2) },
                      { key: 'avg300', label: '300s avg', render: (v) => fmt(v, '%', 2) },
                    ]}
                  />
                </div>
              ) : (
                <p className="small muted">PSI (/proc/pressure) is not exposed by this kernel.</p>
              )}
            </div>
          ) : (
            <Empty title="Not reported">VM and PSI counters may be waiting for the next detail interval or disabled.</Empty>
          )}
        </Card>
      </div>

      <Processes />

      {(detail.slab !== undefined || detail.vmalloc !== undefined) && (
        <DetailCard
          title="Slab and virtual allocations"
          keys={['slab', 'vmalloc']}
          note="Sparse optional diagnostics. Counters can overlap; do not sum unrelated kernel views."
        />
      )}
    </>
  );
}

async function readBillingCycleBytes(deviceId: string, cycleStart: string, asOfDay: string) {
  const pageSize = 100;
  let total = 0;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db!
      .from('bandwidth_daily')
      .select('rx_bytes,tx_bytes')
      .eq('device_id', deviceId)
      .gte('day', cycleStart)
      .lte('day', asOfDay)
      .order('day')
      .order('interface_name')
      .order('role')
      .range(offset, offset + pageSize - 1);
    if (error) return { data: null, error };
    for (const row of data) total += (num(row.rx_bytes) ?? 0) + (num(row.tx_bytes) ?? 0);
    if (data.length < pageSize) return { data: total, error: null };
  }
}

export function Network() {
  const { device, tick, range, latest } = useMonitor();
  const q = useQuery(
    () =>
      db!
        .from('bandwidth_daily')
        .select('*')
        .eq('device_id', device!.id)
        .gte('day', range.from.slice(0, 10))
        .lte('day', range.to.slice(0, 10))
        .order('day', { ascending: false })
        .limit(90),
    [device?.id, tick, range],
  );

  const rxMbps = rate(latest?.rx_bytes_delta, latest?.elapsed_s);
  const txMbps = rate(latest?.tx_bytes_delta, latest?.elapsed_s);
  const interfaces = rows(latest?.interfaces);
  const uplinks = interfaces.filter((i) => i.role === 'wan' || i.role === 'usbwan');

  const quotaGb = num(device?.config.monthly_quota_gb) ?? 0;
  const billingDay = Math.min(28, Math.max(1, num(device?.config.billing_day) ?? 1));
  const dailyRows = (q.data || []) as Row[];

  const now = new Date();
  const cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCDate() >= billingDay ? now.getUTCMonth() : now.getUTCMonth() - 1, billingDay));
  const cycleStartStr = cycleStart.toISOString().slice(0, 10);
  const asOfDay = now.toISOString().slice(0, 10);

  const cycleQuery = useQuery(
    () =>
      device && quotaGb > 0
        ? readBillingCycleBytes(device.id, cycleStartStr, asOfDay)
        : Promise.resolve({ data: null, error: null }),
    [device?.id, tick, quotaGb, cycleStartStr, asOfDay],
  );

  const cycleReady = cycleQuery.isCurrent && !cycleQuery.loading && !cycleQuery.error;
  const cycleBytes = cycleReady ? cycleQuery.data : null;
  const quotaPct = quotaGb > 0 && cycleBytes !== null ? (cycleBytes / (quotaGb * 1e9)) * 100 : null;

  return (
    <>
      <div className="stats">
        <Stat label="Download rate (Rx)" value={fmt(rxMbps, ' Mbps', 2)} sub="Designated WAN uplinks" />
        <Stat label="Upload rate (Tx)" value={fmt(txMbps, ' Mbps', 2)} sub="Designated WAN uplinks" />
        <Stat
          label="Latest interval volume"
          value={
            latest?.rx_bytes_delta != null || latest?.tx_bytes_delta != null
              ? bytes((latest?.rx_bytes_delta ?? 0) + (latest?.tx_bytes_delta ?? 0))
              : '—'
          }
          sub={latest?.elapsed_s ? `Over ${fmt(latest.elapsed_s, ' s', 1)}` : 'Interval unavailable'}
        />
        <Stat
          label="Active uplinks"
          value={uplinks.length || '—'}
          sub={uplinks.map((u) => String(u.name)).join(', ') || 'No WAN uplink detected'}
        />
      </div>

      <HistoryChart metric="network_mbps" title="Internet throughput (Rx & Tx)" unit=" Mbps" allowNetworkToggle />

      <Interfaces />

      {quotaGb > 0 && (
        <Card
          title="Monthly internet quota"
          description={`Observed WAN traffic since UTC billing cycle start (${cycleStartStr}).`}
        >
          <div className="tile-row-top" style={{ marginBottom: 10 }}>
            <strong>{fmt(cycleBytes === null ? null : cycleBytes / 1e9, ' GB', 2)} used of {quotaGb} GB</strong>
            <span className="small muted">Observed coverage only · not ISP billing meter</span>
          </div>
          {cycleQuery.loading ? (
            <p className="small muted" role="status">
              Loading billing-cycle quota usage…
            </p>
          ) : cycleQuery.error ? (
            <p className="notice danger" role="alert">
              {cycleQuery.error}
            </p>
          ) : cycleReady ? (
            <ProgressBar percent={quotaPct} label="Monthly quota utilization" />
          ) : null}
        </Card>
      )}

      <Card title="Daily internet usage" description="Observed bytes per UTC day, not your ISP bill. Incomplete coverage understates totals.">
        <QueryState
          {...q}
          empty={!dailyRows.length}
          emptyTitle="No daily traffic totals"
          emptyMessage="Daily WAN byte totals appear after the router uploads observations in this range."
        >
          <DataTable
            data={dailyRows}
            columns={[
              { key: 'day', label: 'Day (UTC)', render: (v) => <code style={{ whiteSpace: 'nowrap' }}>{String(v ?? '—')}</code> },
              { key: 'interface_name', label: 'Interface', render: (v) => <code>{String(v ?? '—')}</code> },
              {
                key: 'role',
                label: 'Uplink',
                render: (v) => <span className="badge good">{v === 'usbwan' ? 'USB WAN' : 'Ethernet WAN'}</span>,
              },
              { key: 'rx_bytes', label: 'Received', render: (v) => <span className="mono">{bytes(v)}</span> },
              { key: 'tx_bytes', label: 'Sent', render: (v) => <span className="mono">{bytes(v)}</span> },
              {
                key: 'total',
                label: 'Total',
                render: (_v, row) => (
                  <span className="mono">
                    {row.rx_bytes != null || row.tx_bytes != null ? bytes((num(row.rx_bytes) ?? 0) + (num(row.tx_bytes) ?? 0)) : '—'}
                  </span>
                ),
              },
              {
                key: 'coverage_s',
                label: 'Coverage',
                render: (v) => {
                  const sec = num(v);
                  const hrs = sec !== null ? sec / 3600 : null;
                  return (
                    <span className="mono">
                      {hrs !== null ? `${fmt(hrs, ' h')} (${fmt(Math.min(100, (sec! / 86400) * 100), '%', 0)})` : '—'}
                    </span>
                  );
                },
              },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}

export function WiFi() {
  const { latest, device, tick } = useMonitor();
  const detail = object(latest?.detail);
  const wifi = object(detail.wifi);
  const radios = rows(wifi.radios);
  const capabilities = object(detail.capabilities);

  const clientNamesQuery = useQuery(
    () => db!.from('client_names').select('*').eq('device_id', device!.id).order('client_id').limit(200),
    [device?.id, tick],
  );
  const nameByClientId = new Map<string, string>(
    (clientNamesQuery.data || []).map((row: Row) => [String(row.client_id), String(row.name)]),
  );

  // Extract associated stations from wifi.radios[*].clients (real collector structure) or legacy fallback keys
  const stationRows: Row[] = radios.flatMap((radio, idx) =>
    rows(radio.clients).map((client) => ({
      ...client,
      radio: String(radio.name || `Radio ${idx + 1}`),
      band: wifiBand(num(object(radio.survey).frequency) ?? num(radio.frequency)),
    })),
  );
  const fallbackStations = rows(detail.stations ?? detail.wifi_stations);
  const allStations = stationRows.length ? stationRows : fallbackStations;

  const stationCounts = radios.map((radio) => num(radio.stations));
  const totalStations = stationCounts.length && stationCounts.every((count): count is number => count !== null && Number.isSafeInteger(count) && count >= 0)
    ? stationCounts.reduce((total, count) => total + count, 0)
    : null;
  const signals = radios.map((r) => num(r.signal_avg_dbm)).filter((v): v is number => v !== null);
  const avgSignal = signals.length ? signals.reduce((a, b) => a + b, 0) / signals.length : null;

  return (
    <>
      <Notice>
        Station details depend on driver support and the router's privacy salt. Missing values mean unreported, not zero.
      </Notice>

      <div className="stats">
        <Stat label="Active radios" value={radios.length || '—'} sub={wifi.available === false ? 'iw unavailable' : 'Monitored wireless interfaces'} />
        <Stat
          label="Associated stations"
          value={totalStations ?? '—'}
          sub={totalStations === null ? 'Requires a count from every radio' : 'Total across radios'}
        />
        <Stat label="Average signal" value={fmt(avgSignal, ' dBm', 0)} sub="Measured station mean" />
        <Stat label="Regulatory domain" value={typeof wifi.country === 'string' ? wifi.country : '—'} sub="Reported by iw reg get" />
      </div>

      <Radios />

      <Card
        title="Associated stations"
        description="Anonymized per-client snapshot (capped at 24 stations). Assign friendly names in Settings."
        action={
          <div className="chart-actions">
            <CollectorLag uptimeKey="wifi_uptime_s" label="Stations" />
            <a className="button sm" href="#Settings">
              Manage client names
            </a>
          </div>
        }
      >
        {allStations.length ? (
          <DataTable
            data={allStations}
            columns={[
              {
                key: 'client_id',
                label: 'Client',
                render: (v) => {
                  const id = String(v ?? '—');
                  const shortId = id.length > 24 ? `${id.slice(0, 22)}…` : id;
                  const friendly = nameByClientId.get(id);
                  return friendly ? (
                    <div style={{ minWidth: 145 }}>
                      <strong>{friendly}</strong>
                      <div className="small muted">
                        <code title={id}>{shortId}</code>
                      </div>
                    </div>
                  ) : (
                    <div style={{ minWidth: 120 }}>
                      <code title={id}>{shortId}</code>
                    </div>
                  );
                },
              },
              {
                key: 'radio',
                label: 'Radio',
                render: (v, row) => (
                  <span style={{ whiteSpace: 'nowrap' }}>
                    <code>{String(v ?? '—')}</code>
                    {row.band ? <span className="badge info" style={{ marginLeft: 6 }}>{String(row.band)}</span> : null}
                  </span>
                ),
              },
              {
                key: 'signal_dbm',
                label: 'Signal',
                render: (v) => {
                  const sig = num(v);
                  if (sig === null) return '—';
                  const tone = sig >= -65 ? 'good' : sig >= -78 ? 'warn' : 'bad';
                  return <span className={`badge ${tone}`}>{fmt(sig, ' dBm', 0)}</span>;
                },
              },
              {
                key: 'rates',
                label: 'PHY Rate (Rx / Tx)',
                render: (_v, row) => (
                  <span className="mono small" style={{ whiteSpace: 'nowrap' }}>
                    {fmt(row.rx_rate_mbps, ' Mbps', 0)} / {fmt(row.tx_rate_mbps, ' Mbps', 0)}
                  </span>
                ),
              },
              {
                key: 'retries',
                label: 'Tx retries / failed',
                render: (_v, row) => {
                  const retries = num(row.tx_retries);
                  const failed = num(row.tx_failed);
                  return (
                    <span className={`mono small ${failed && failed > 0 ? 'error-text' : ''}`} style={{ whiteSpace: 'nowrap' }}>
                      {retries !== null ? retries.toLocaleString() : '—'} / {failed !== null ? failed.toLocaleString() : '—'}
                    </span>
                  );
                },
              },
              { key: 'rx_bytes', label: 'Rx', render: (v) => <span className="mono" style={{ whiteSpace: 'nowrap' }}>{bytes(v)}</span> },
              { key: 'tx_bytes', label: 'Tx', render: (v) => <span className="mono" style={{ whiteSpace: 'nowrap' }}>{bytes(v)}</span> },
            ]}
          />
        ) : (
          <Empty title="No associated stations reported">
            {wifi.available === false
              ? 'Wireless counters unavailable (install iw on the router).'
              : 'No wireless clients were associated or the local privacy salt is absent.'}
          </Empty>
        )}
      </Card>

      <Card title="Wireless & acceleration capabilities" description="Driver-independent limits reported by the agent.">
        <div className="tile-list">
          {(['wifi', 'ppe', 'debugfs'] as const)
            .filter((k) => capabilities[k] !== undefined)
            .map((k) => {
              const val = String(capabilities[k]);
              const ok = val === 'available';
              return (
                <div className="tile-row" key={k}>
                  <div className="tile-row-top">
                    <strong>{capabilityLabel(k)}</strong>
                    <span className={`badge ${ok ? 'good' : ''}`}>{ok ? 'Available' : 'Unavailable'}</span>
                  </div>
                  {!ok && <span className="small muted">{val}</span>}
                </div>
              );
            })}
          {!['wifi', 'ppe', 'debugfs'].some((k) => capabilities[k] !== undefined) && (
            <Empty title="Not reported">Waiting for capability manifest from the router.</Empty>
          )}
        </div>
      </Card>
    </>
  );
}

export function Internet() {
  return (
    <>
      <Notice>
        Only designated WAN interfaces contribute to Internet totals. Ethernet and USB uplinks retain separate counters; LAN traffic is excluded.
        No active speed test runs from this dashboard.
      </Notice>
      <Connectivity />
      <HistoryChart metric="network_mbps" title="Internet throughput (Rx & Tx)" unit=" Mbps" allowNetworkToggle />
      <Interfaces />
    </>
  );
}

export function DNS() {
  const { latest } = useMonitor();
  const detail = object(latest?.detail);
  const services = object(detail.services);
  const serviceChecks = object(detail.service_checks);
  const dnsProbe = object(object(detail.connectivity).dns);
  const capabilities = object(detail.capabilities);

  const adblockRunning = services['adblock-fast'];
  const adblockCheck = serviceChecks['adblock-fast'];

  return (
    <>
      <div className="two-col">
        <Card
          title="DNS resolver health"
          description="Resolver daemon state and optional example.com probe timing."
          action={<CollectorLag uptimeKey="connectivity_uptime_s" label="DNS probe" />}
        >
          <div className="stack">
            <div className="service-grid">
              {['dnsmasq', 'https-dns-proxy', 'odhcpd', ...(services.adguardhome !== undefined ? ['adguardhome'] : [])].map((svc) => {
                const state = services[svc];
                return (
                  <div className="service-tile" key={svc}>
                    <span>{svc}</span>
                    <span className={`badge ${state === true ? 'good' : state === false ? 'bad' : ''}`}>
                      {state === true ? 'Running' : state === false ? 'Stopped' : 'Unknown'}
                    </span>
                  </div>
                );
              })}
            </div>
            {Object.keys(dnsProbe).length > 0 ? (
              <div className="probe">
                <div className="radio-title">
                  <strong>DNS resolution probe</strong>
                  <span className={`badge ${dnsProbe.reachable === true ? 'good' : dnsProbe.reachable === false ? 'bad' : ''}`}>
                    {dnsProbe.reachable === true ? 'Reachable' : dnsProbe.reachable === false ? 'Failed' : 'Not reported'}
                  </span>
                </div>
                <strong className="probe-latency">{fmt(dnsProbe.latency_ms, ' ms')}</strong>
                <p className="muted small">Coarse nslookup timing (includes local resolver cache).</p>
              </div>
            ) : (
              <p className="small muted">Enable optional probes locally on the router to collect DNS resolution timing.</p>
            )}
          </div>
        </Card>

        <Card
          title="Ad blocking (AdBlock Fast)"
          description="Service status via procd data.status API. Package availability and active blocking are distinct."
          action={<CollectorLag uptimeKey="detail_uptime_s" label="Service check" />}
        >
          {adblockRunning !== undefined || adblockCheck !== undefined ? (
            <div className="stack">
              <div className="service-tile">
                <strong>adblock-fast</strong>
                <span className={`badge ${adblockRunning === true ? 'good' : adblockRunning === false ? 'bad' : 'warn'}`}>
                  {adblockRunning === true ? 'Active' : adblockRunning === false ? 'Stopped / Failed' : 'Unknown'}
                </span>
              </div>
              <dl className="fields">
                <div>
                  <dt>Procd status check</dt>
                  <dd>{serviceCheckLabel(adblockCheck)}</dd>
                </div>
                {capabilities.dns_counters !== undefined && (
                  <div>
                    <dt>Query counters</dt>
                    <dd className="muted">{String(capabilities.dns_counters)}</dd>
                  </div>
                )}
                {capabilities.dns_queries !== undefined && (
                  <div>
                    <dt>Domain history</dt>
                    <dd className="muted">{String(capabilities.dns_queries)}</dd>
                  </div>
                )}
              </dl>
            </div>
          ) : (
            <Empty title="AdBlock Fast status not reported" />
          )}
        </Card>
      </div>

      <Card title="All monitored router services" description="Init script and policy checks reported by the agent.">
        {Object.keys(services).length ? (
          <div className="service-grid">
            {Object.entries(services).map(([name, val]) => (
              <div className="service-tile" key={name}>
                <span>{name}</span>
                <span className={`badge ${val === true ? 'good' : val === false ? 'bad' : ''}`}>
                  {val === true ? 'Running' : val === false ? 'Stopped' : 'Unknown'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="Not reported">Service state appears after the detail collector completes.</Empty>
        )}
      </Card>

      <Notice>
        Blocked-query counts and domain logs are intentionally omitted for privacy and ABI stability. This dashboard never infers DNS queries from traffic.
      </Notice>
    </>
  );
}

function Identity() {
  const { device, tick } = useMonitor();
  const q = useQuery(
    () =>
      db!
        .from('boot_sessions')
        .select('inventory,boot_id,first_seen_at')
        .eq('device_id', device!.id)
        .order('first_seen_at', { ascending: false })
        .limit(1),
    [device?.id, tick],
  );
  return (
    <Card title="System identity" description="Reported hardware and firmware inventory from the most recent boot.">
      <QueryState {...q} empty={!q.data?.length}>
        <Fields value={q.data?.[0]?.inventory} />
      </QueryState>
    </Card>
  );
}

function PerCore() {
  const { latest } = useMonitor();
  const cpu = object(object(latest?.detail).cpu);
  const cores = Object.entries(object(cpu.cores)).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  return (
    <Card
      title="CPU cores"
      description="Utilization between detail snapshots, normally collected every 5 minutes."
      action={<CollectorLag uptimeKey="detail_uptime_s" label="Per-core CPU" />}
    >
      {cores.length ? (
        <div className="core-list">
          {cores.map(([name, value]) => {
            const val = num(value);
            const cls = val !== null && val >= 90 ? 'bad' : val !== null && val >= 75 ? 'warn' : '';
            return (
              <div className={`core-row ${cls}`} key={name}>
                <span>{name.toUpperCase()}</span>
                {val !== null ? <progress aria-label={`${name} utilization`} max="100" value={val} /> : <span className="muted">Unavailable</span>}
                <strong>{fmt(val, '%')}</strong>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty title="Per-core readings unavailable" />
      )}
    </Card>
  );
}

function Processes() {
  const { latest } = useMonitor();
  const processes = rows(object(latest?.detail).processes);
  const totalKb = num(latest?.mem_total_kb);
  return (
    <Card
      title="Top processes (RSS)"
      description="Largest processes by RSS. PSS divides shared pages among the processes using them."
      action={<CollectorLag uptimeKey="processes_uptime_s" label="Processes" />}
    >
      {processes.length ? (
        <DataTable
          data={processes}
          columns={[
            { key: 'name', label: 'Process', render: (v) => <code>{String(v ?? '—')}</code> },
            { key: 'pid', label: 'PID', render: (v) => <span className="mono muted">{String(v ?? '—')}</span> },
            { key: 'rss_kb', label: 'Resident RAM', render: (v) => <span className="mono">{mib(num(v))}</span> },
            { key: 'pss_kb', label: 'Proportional RAM', render: (v) => mib(num(v)) },
            { key: 'pss_anon_kb', label: 'Anonymous PSS', render: (v) => mib(num(v)) },
            { key: 'pss_file_kb', label: 'File PSS', render: (v) => mib(num(v)) },
            { key: 'pss_shmem_kb', label: 'Shared memory PSS', render: (v) => mib(num(v)) },
            { key: 'swap_pss_kb', label: 'Swap PSS', render: (v) => mib(num(v)) },
            {
              key: 'share',
              label: '% of RAM',
              render: (_v, row) => {
                const rss = num(row.rss_kb);
                const pct = totalKb && rss !== null ? (rss / totalKb) * 100 : null;
                return <ProgressBar percent={pct} label={`${String(row.name)} RAM share`} />;
              },
            },
          ]}
        />
      ) : (
        <Empty title="No process snapshot" />
      )}
    </Card>
  );
}

function Radios() {
  const { latest } = useMonitor();
  const wifi = object(object(latest?.detail).wifi);
  const radios = rows(wifi.radios);
  return (
    <Card
      title="Radios and channel state"
      description="Survey counters depend on driver support. Channel busy time includes all observed radio activity."
      action={<CollectorLag uptimeKey="wifi_uptime_s" label="Wi-Fi survey" />}
    >
      {radios.length ? (
        <div className="radio-grid">
          {radios.map((radio, index) => {
            const survey = object(radio.survey);
            const freq = num(survey.frequency) ?? num(radio.frequency);
            const width = num(radio.width_mhz);
            const noise = num(survey.noise_dbm);
            const signal = num(radio.signal_avg_dbm);
            const snr = signal !== null && noise !== null ? signal - noise : null;
            const busy = num(survey.busy_ms) !== null && Number(survey.active_ms) > 0 ? (Number(survey.busy_ms) / Number(survey.active_ms)) * 100 : null;
            const band = wifiBand(freq);
            return (
              <div className="radio-tile" key={String(radio.name || index)}>
                <div className="radio-title">
                  <strong>{String(radio.name || 'Radio ' + (index + 1))}</strong>
                  <div className="button-group">
                    {band && <span className="badge info">{band}</span>}
                    <span className="badge">
                      {fmt(freq, ' MHz', 0)}
                      {width ? ` · ${width} MHz` : ''}
                    </span>
                  </div>
                </div>
                <div className="radio-measures">
                  <div>
                    <span className="muted small">Stations</span>
                    <strong>{fmt(radio.stations, '', 0)}</strong>
                  </div>
                  <div>
                    <span className="muted small">Avg signal</span>
                    <strong>{fmt(signal, ' dBm', 0)}</strong>
                  </div>
                  <div>
                    <span className="muted small">Channel busy</span>
                    <strong>{fmt(busy, '%')}</strong>
                  </div>
                </div>
                <div className="small muted">
                  Rx {bytes(radio.rx_bytes)} · Tx {bytes(radio.tx_bytes)}
                  {noise !== null ? ` · Noise ${fmt(noise, ' dBm', 0)}` : ''}
                  {snr !== null ? ` · SNR ${fmt(snr, ' dB', 0)}` : ''}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty title="No radio survey reported">
          {wifi.available === false
            ? 'The agent could not access supported wireless counters. Check driver support and the iw package.'
            : 'Waiting for a Wi-Fi observation.'}
        </Empty>
      )}
    </Card>
  );
}

function Connectivity() {
  const { latest } = useMonitor();
  const connectivity = object(object(latest?.detail).connectivity);
  const probeKeys = ['ipv4', 'ipv6', 'gateway', 'dns'];
  const presentKeys = probeKeys.filter((k) => connectivity[k]);
  return (
    <Card
      title="Internet reachability"
      description="Optional probes run on the router; timing includes local network and resolver conditions."
      action={<CollectorLag uptimeKey="connectivity_uptime_s" label="Probes" />}
    >
      {presentKeys.length ? (
        <>
          <div className="probe-grid">
            {probeKeys.map((key) => {
              const probe = object(connectivity[key]);
              const present = Boolean(connectivity[key]);
              const label = key === 'dns' ? 'DNS' : key === 'gateway' ? 'Gateway' : key.toUpperCase();
              return (
                <div className="probe" key={key}>
                  <div className="radio-title">
                    <strong>{label}</strong>
                    <span
                      className={`badge ${
                        !present ? '' : probe.reachable === true ? 'good' : probe.reachable === false ? 'bad' : ''
                      }`}
                    >
                      {!present ? 'Not reported' : probe.reachable === true ? 'Reachable' : probe.reachable === false ? 'Unreachable' : 'Unknown'}
                    </span>
                  </div>
                  <strong className="probe-latency">{fmt(probe.latency_ms, ' ms')}</strong>
                  <p className="muted small">
                    {key === 'dns'
                      ? 'Fixed public lookup (example.com)'
                      : `Loss ${fmt(probe.loss_pct, '%')} · spread ${fmt(probe.jitter_ms, ' ms')}`}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="muted small probe-note">
            <Info size={13} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />
            {String(connectivity.interpretation || 'ICMP can be filtered; a failed probe does not establish an internet outage.')}
          </p>
        </>
      ) : (
        <Empty title="Connectivity probes unavailable">
          {String(connectivity.reason || 'Enable optional probes locally on the router to collect reachability and latency observations.')}
        </Empty>
      )}
    </Card>
  );
}
