import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  FileClock,
  Globe,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Network,
  Pause,
  Play,
  RefreshCw,
  Router,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Terminal,
  Wifi,
} from 'lucide-react';
import { configured, db } from './lib/client';
import { MonitorProvider, useMonitor } from './lib/data';
import { date, nowRange, relativeAge, toLocalDateTimeInput } from './lib/model';
import { Button, Card, Empty, Input, Notice } from './components/ui/primitives';
import { ObservationTime } from './components/Shared';
import { ActionButton, ActionForm, ActionProvider, ActionSubmit } from './components/Actions';
import { assertResult, withTimeout } from './lib/async';
import { CPU, DNS, Internet, Memory, Network as NetworkPage, Overview, WiFi } from './pages/Telemetry';
import { Alerts, Diagnostics, Firmware, Logs } from './pages/Records';
import { Enrollment, Settings } from './pages/Settings';

const pages = [
  { name: 'Overview', group: 'Telemetry', subtitle: 'Live system vitals, active incidents, and WAN throughput.', icon: LayoutDashboard, component: Overview },
  { name: 'CPU & system', group: 'Telemetry', subtitle: 'Processor load, per-core balance, processes, thermals, and kernel limits.', icon: Cpu, component: CPU },
  { name: 'Memory', group: 'Telemetry', subtitle: 'RAM utilization, reclaimable kernel pools, pressure stalls, and VM events.', icon: Database, component: Memory },
  { name: 'Network', group: 'Telemetry', subtitle: 'Uplink throughput, interface counters, and daily WAN bandwidth.', icon: Network, component: NetworkPage },
  { name: 'Wi-Fi', group: 'Telemetry', subtitle: 'Radio channel survey, signal quality, and anonymized client stations.', icon: Wifi, component: WiFi },
  { name: 'Internet & ISP', group: 'Telemetry', subtitle: 'Router-originated IPv4, IPv6, gateway, and DNS reachability probes.', icon: Globe, component: Internet },
  { name: 'DNS & adblock', group: 'Telemetry', subtitle: 'Resolver health, adblock service checks, and daemon status.', icon: ShieldCheck, component: DNS },
  { name: 'Logs', group: 'Diagnostics', subtitle: 'Grouped system and kernel logs with severity and service filters.', icon: Terminal, component: Logs },
  { name: 'Diagnostics', group: 'Diagnostics', subtitle: 'Cloud-received diagnostic snapshots and private gzip archives.', icon: HardDrive, component: Diagnostics },
  { name: 'Firmware comparison', group: 'Diagnostics', subtitle: 'Compare retained uptime windows across firmware boots.', icon: FileClock, component: Firmware },
  { name: 'Alerts', group: 'Operations', subtitle: 'Open incidents, event history, and sustained threshold rules.', icon: Bell, component: Alerts },
  { name: 'Settings', group: 'Operations', subtitle: 'Display preferences, collection intervals, client labels, and credentials.', icon: SettingsIcon, component: Settings },
] as const;

const navGroups = ['Telemetry', 'Diagnostics', 'Operations'] as const;

export default function App() {
  return (
    <ActionProvider>
      <SessionApp />
    </ActionProvider>
  );
}

function SessionApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(configured);
  const [error, setError] = useState(() => {
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.slice(1));
    return (query.get('error_description') || hash.get('error_description') || '').slice(0, 500);
  });

  useEffect(() => {
    if (!db) return;
    let active = true;
    withTimeout(db.auth.getSession())
      .then(({ data, error }) => {
        if (!active) return;
        setSession(data.session);
        if (error) setError(error.message);
        setLoading(false);
      })
      .catch((e) => {
        if (active) {
          setError(String(e));
          setLoading(false);
        }
      });
    const { data } = db.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setLoading(false);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  if (!configured) return <Setup />;
  if (loading) {
    return (
      <main className="auth-wrap">
        <div role="status" className="loading">
          Restoring session…
        </div>
      </main>
    );
  }
  if (!session) return <Login initialError={error} />;
  return (
    <MonitorProvider session={session}>
      <Shell />
    </MonitorProvider>
  );
}

function Brand() {
  return (
    <div className="brand">
      <div className="brand-icon">
        <Router size={18} />
      </div>
      <div>
        <strong>
          nicx <span>monitor</span>
        </strong>
        <small>Router observability</small>
      </div>
    </div>
  );
}

function Setup() {
  return (
    <main className="auth-wrap">
      <Card className="auth-card">
        <Brand />
        <p className="eyebrow">Configuration required</p>
        <h1>Connect your Supabase project.</h1>
        <p className="muted">Configure the environment variables below before signing in. No demo metrics or simulated routers are bundled.</p>
        <ol className="setup-list">
          <li>
            Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> using the browser-safe project key.
          </li>
          <li>
            Set <code>VITE_API_URL</code> to the monitoring Worker.
          </li>
          <li>Create your owner account in Supabase Auth, then rebuild the dashboard.</li>
        </ol>
        <Notice>Only the publishable or anon key belongs in this dashboard. The service-role key remains in the Worker.</Notice>
      </Card>
    </main>
  );
}

function Login({ initialError }: { initialError: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const dismissLogin = useRef<(() => void) | null>(null);
  useEffect(() => () => dismissLogin.current?.(), []);

  return (
    <main className="auth-wrap">
      <Card className="auth-card">
        <Brand />
        <div className="auth-intro">
          <h1>Sign in to your router workspace</h1>
          <p className="muted">View live telemetry, system logs, and diagnostics from your OpenWrt devices.</p>
        </div>
        <ActionForm
          className="stack"
          actionKey="auth-login"
          onDismissRef={dismissLogin}
          pending="Signing in securely…"
          success="Signed in. Your router workspace is ready."
          onSubmit={async () => {
            try {
              assertResult(await db!.auth.signInWithPassword({ email, password }));
            } finally {
              setPassword('');
            }
          }}
        >
          <label>
            Email address
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
          </label>
          <label>
            Password
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              minLength={8}
            />
          </label>
          {initialError && (
            <p role="alert" className="notice danger">
              {initialError}
            </p>
          )}
          <ActionSubmit variant="default" pendingLabel="Signing in…">
            Sign in securely <ArrowUpRight size={16} />
          </ActionSubmit>
        </ActionForm>
        <p className="small muted auth-foot">
          <ShieldCheck size={15} /> Private access. Accounts are provisioned by your project administrator.
        </p>
      </Card>
    </main>
  );
}

function Shell() {
  const state = useMonitor();
  const {
    device,
    devices,
    selectDevice,
    latest,
    openAlerts,
    paused,
    setPaused,
    zone,
    theme,
    setTheme,
    range,
    setRange,
    loading,
    error,
    transport,
    manualRefresh,
    lastRefreshAt,
  } = state;

  const [page, setPage] = useState(() => {
    const name = decodeURIComponent(location.hash.slice(1));
    return pages.find((p) => p.name === name)?.name || 'Overview';
  });
  const [menu, setMenu] = useState(false);
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(() => toLocalDateTimeInput(range.from));
  const [to, setTo] = useState(() => toLocalDateTimeInput(range.to));
  const [rangeError, setRangeError] = useState('');

  useEffect(() => {
    const pop = () => setPage(pages.find((p) => p.name === decodeURIComponent(location.hash.slice(1)))?.name || 'Overview');
    window.addEventListener('hashchange', pop);
    return () => window.removeEventListener('hashchange', pop);
  }, []);

  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [page]);

  const current = pages.find((p) => p.name === page) || pages[0];
  const Page = current.component;
  const seen = device?.last_seen_at ? Date.parse(device.last_seen_at) : null;
  const offlineThresholdMs = Math.max(120000, Number(device?.config.upload_interval || 30) * 3000);
  const online = !!seen && Date.now() - seen < offlineThresholdMs;
  const hasCriticalAlert = openAlerts.some((a) => a.severity === 'critical');

  const shift = (direction: number) => {
    const span = Date.parse(range.to) - Date.parse(range.from);
    setRange({
      ...range,
      from: new Date(Date.parse(range.from) + direction * span).toISOString(),
      to: new Date(Date.parse(range.to) + direction * span).toISOString(),
      live: false,
    });
  };

  const toggleCustom = () => {
    setCustom((v) => {
      const next = !v;
      if (next) {
        setFrom(toLocalDateTimeInput(range.from));
        setTo(toLocalDateTimeInput(range.to));
        setRangeError('');
      }
      return next;
    });
  };

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      {menu && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMenu(false)} />}
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <Brand />
        <nav aria-label="Main navigation" className="sidebar-nav">
          {navGroups.map((group) => (
            <div className="nav-group" key={group}>
              <div className="sidebar-label">{group}</div>
              {pages
                .filter((p) => p.group === group)
                .map((p) => (
                  <a
                    key={p.name}
                    href={'#' + encodeURIComponent(p.name)}
                    aria-current={page === p.name ? 'page' : undefined}
                    className={page === p.name ? 'active' : ''}
                    title={p.name === 'Alerts' && openAlerts.length > 0 ? `${openAlerts.length} open alerts` : undefined}
                    onClick={() => {
                      setPage(p.name);
                      setMenu(false);
                    }}
                  >
                    <p.icon size={16} />
                    <span>{p.name}</span>
                    {p.name === 'Alerts' && openAlerts.length > 0 && (
                      <span className={`nav-badge ${hasCriticalAlert ? 'bad' : 'warn'}`} aria-hidden="true">
                        {openAlerts.length}
                      </span>
                    )}
                  </a>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="connection">
            <span className={`status-dot ${paused ? 'idle' : ''}`} />
            {transport}
          </span>
          <p>Outbound telemetry only. No remote shell.</p>
          <ActionButton
            variant="ghost"
            pendingLabel="Signing out…"
            successMessage="Signed out of this browser."
            onAction={async () => {
              const result = await db!.auth.signOut();
              if (result.error) throw result.error;
            }}
          >
            <LogOut size={15} /> Sign out
          </ActionButton>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <Button className="mobile-menu" variant="ghost" aria-label="Open navigation" onClick={() => setMenu(true)}>
              <Menu size={19} />
            </Button>
            <div className="router-picker">
              <Router size={16} />
              <select aria-label="Current router" value={device?.id || ''} onChange={(e) => selectDevice(e.target.value)}>
                {!devices.length && <option value="">No routers enrolled</option>}
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <Enrollment />
            </div>
          </div>
          <div className="topbar-actions">
            <span className="timezone">{zone}</span>
            <Button
              variant="ghost"
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </Button>
            <span className="avatar" title={state.session.user.email}>
              {state.session.user.email?.slice(0, 1).toUpperCase() || 'N'}
            </span>
          </div>
        </header>

        <main id="main-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <h1>{current.name}</h1>
              <p className="muted">{current.subtitle}</p>
            </div>
            {device && <ObservationTime />}
          </div>

          {device && (
            <div className="control-dock">
              <div className="device-strip">
                <span className={`badge ${device.revoked_at ? 'bad' : online ? 'good' : 'warn'}`}>
                  <span className="status-dot" />
                  {device.revoked_at ? 'Revoked' : online ? 'Receiving' : `Offline (${relativeAge(device.last_seen_at)})`}
                </span>
                <strong>{device.name}</strong>
                <span className="muted small device-model">{device.model || 'Model not reported'}</span>
                {(Number(device.dropped_samples || 0) > 0 || Number(device.dropped_logs || 0) > 0 || device.storage_degraded_at) && (
                  <span
                    className="badge warn"
                    title="Telemetry drops or cloud storage budget degradation have been recorded for this device."
                  >
                    <AlertTriangle size={12} />
                    {device.storage_degraded_at
                      ? 'Storage guard active'
                      : `Dropped ${Number(device.dropped_samples || 0)}s / ${Number(device.dropped_logs || 0)}l`}
                  </span>
                )}
                <span className="strip-spacer" />
                <span className="small muted last-refresh">Checked {date(lastRefreshAt, zone)}</span>
              </div>

              <section className="time-toolbar" aria-label="Shared time and refresh controls">
                <div className="segmented" aria-label="Time window">
                  {[0.25, 1, 6, 24, 168, 720].map((h) => (
                    <button
                      aria-pressed={range.live && range.hours === h}
                      key={h}
                      onClick={() => {
                        setRange(nowRange(h));
                        setCustom(false);
                      }}
                    >
                      {h === 0.25 ? '15m' : h === 168 ? '7d' : h === 720 ? '30d' : h + 'h'}
                    </button>
                  ))}
                  <button aria-pressed={!range.live || custom} onClick={toggleCustom}>
                    Custom
                  </button>
                </div>
                <div className="button-group">
                  <Button aria-label="Previous time window" title="Previous window" onClick={() => shift(-1)}>
                    <ChevronLeft size={16} />
                  </Button>
                  <Button aria-label="Next time window" title="Next window" disabled={range.live} onClick={() => shift(1)}>
                    <ChevronRight size={16} />
                  </Button>
                </div>
                <span className="range-caption small muted">
                  {range.live
                    ? `Last ${range.hours === 0.25 ? '15 minutes' : range.hours === 168 ? '7 days' : range.hours === 720 ? '30 days' : range.hours + ' hours'}`
                    : `${date(range.from, zone, true)} to ${date(range.to, zone, true)}`}
                </span>
                <div className="strip-spacer" />
                <div className="toolbar-right">
                  <Button aria-pressed={paused} onClick={() => setPaused(!paused)}>
                    {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? 'Resume' : 'Pause'}
                  </Button>
                  <ActionButton
                    aria-label="Refresh observations"
                    pendingLabel="Refreshing…"
                    successMessage="Cloud data refreshed. No router collection was requested."
                    onAction={manualRefresh}
                  >
                    <RefreshCw size={14} />
                    <span className="refresh-label">Refresh</span>
                  </ActionButton>
                </div>
              </section>

              {custom && (
                <form
                  className="custom-range"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!from || !to || Date.parse(from) >= Date.parse(to)) {
                      setRangeError('Choose an end time after the start time.');
                      return;
                    }
                    setRangeError('');
                    setRange({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), live: false, hours: 0 });
                    setCustom(false);
                  }}
                >
                  <label>
                    From (browser local time)
                    <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required />
                  </label>
                  <label>
                    To (browser local time)
                    <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} required />
                  </label>
                  <div className="button-group">
                    <Button variant="default" type="submit">
                      Apply to all pages
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setCustom(false)}>
                      Cancel
                    </Button>
                  </div>
                  {rangeError && (
                    <p role="alert" className="small error-text">
                      {rangeError}
                    </p>
                  )}
                </form>
              )}

              {!range.live && (
                <div className="history-banner" role="status">
                  <Clock size={15} />
                  <span>
                    <strong>Historical window:</strong> {date(range.from, zone, true)} to {date(range.to, zone, true)}. Gauges show the last
                    retained raw observation in this range.
                  </span>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setRange(nowRange(6));
                      setCustom(false);
                    }}
                  >
                    Return to Live
                  </Button>
                </div>
              )}
            </div>
          )}

          {error && (
            <div role="alert" className="notice danger">
              <span>{error}</span>
              <ActionButton pendingLabel="Retrying…" successMessage="Cloud reads completed successfully." onAction={manualRefresh}>
                Retry cloud reads
              </ActionButton>
            </div>
          )}

          <div className="page-content">
            {loading ? (
              <div role="status" className="loading">
                Loading your routers…
              </div>
            ) : !device ? (
              <Card>
                <Empty title="No router enrolled yet">Enroll your first router to see live telemetry, history, and alerts.</Empty>
                <div className="center">
                  <Enrollment />
                </div>
              </Card>
            ) : (
              <>
                {latest && range.live && !online && !device.revoked_at && page !== 'Settings' && (
                  <div className="notice warn" role="status">
                    <strong>Router offline or delayed:</strong> Last contact was{' '}
                    {device.last_seen_at ? `${relativeAge(device.last_seen_at)} (${date(device.last_seen_at, zone, true)})` : 'never recorded'}.
                    Expected upload cadence is every {Number(device.config.upload_interval || 30)}s. Values below show the last received snapshot, not
                    live readings.
                  </div>
                )}
                {device.revoked_at && page !== 'Settings' && (
                  <div className="notice danger" role="status">
                    <span>
                      <strong>Device revoked:</strong> Ingestion was stopped on {date(device.revoked_at, zone, true)}. Historical records remain
                      read-only.
                    </span>
                  </div>
                )}
                {!latest && page !== 'Settings' && (
                  <Notice>
                    {range.live
                      ? 'This router has not sent a recent observation. Check enrollment and outbound connectivity on the router.'
                      : 'No raw snapshot remains in this historical window. Aggregated charts can remain available after raw detail expires.'}
                  </Notice>
                )}
                <Page key={device.id} />
              </>
            )}
          </div>

          <footer>
            <span>
              <Activity size={13} /> Nicx Router Monitor
            </span>
            <span>UTC storage, {zone} display, missing metrics stay unknown</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
