import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { db } from './client';
import { actionError, withTimeout } from './async';
import { nowRange, readPreference, timeRangeKey, writePreference, type AlertRecord, type Device, type Sample, type TimeRange } from './model';

interface Store {
  session: Session;
  devices: Device[];
  device: Device | null;
  selectDevice: (id: string) => void;
  latest: Sample | null;
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  paused: boolean;
  setPaused: (p: boolean) => void;
  zone: string;
  setZone: (z: string) => void;
  theme: string;
  setTheme: (t: string) => void;
  refreshSeconds: number;
  setRefreshSeconds: (n: number) => void;
  tick: number;
  refresh: () => void;
  manualRefresh: () => Promise<void>;
  lastRefreshAt: string | null;
  error: string;
  transport: string;
  history: Sample[];
  openAlerts: AlertRecord[];
  loading: boolean;
}

interface Registry {
  epoch: number;
  track: (id: string, promise: Promise<void>) => void;
}

const Context = createContext<Store | null>(null);
const QueryContext = createContext<Registry | null>(null);

export const useMonitor = () => {
  const v = useContext(Context);
  if (!v) throw new Error('Monitor context required');
  return v;
};

function sameSnapshot(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function MonitorProvider({ session, children }: { session: Session; children: ReactNode }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState(() => readPreference('device', ''));
  const [latest, setLatest] = useState<Sample | null>(null);
  const [latestDevice, setLatestDevice] = useState('');
  const [snapshot, setSnapshot] = useState<Sample | null>(null);
  const [dataRange, setDataRange] = useState('');
  const [history, setHistory] = useState<Sample[]>([]);
  const [openAlerts, setOpenAlerts] = useState<AlertRecord[]>([]);
  const [range, setRange] = useState<TimeRange>(() => {
    const stored = readPreference<TimeRange | null>('range', null);
    return stored && typeof stored.hours === 'number' && Number.isFinite(Date.parse(stored.from)) && Number.isFinite(Date.parse(stored.to))
      ? stored
      : nowRange();
  });
  const [paused, setPaused] = useState(false);
  const [refreshSeconds, setRefreshState] = useState(() => readPreference('refresh-seconds', 30));
  const [zone, setZoneState] = useState(() => readPreference('zone', 'Asia/Kolkata'));
  const [theme, setThemeState] = useState(() => readPreference('theme', 'dark'));
  const [tick, setTick] = useState(0);
  const [manualEpoch, setManualEpoch] = useState(0);
  const [deviceError, setDeviceError] = useState('');
  const [metricError, setMetricError] = useState('');
  const [loading, setLoading] = useState(true);
  const [transport, setTransport] = useState('Connecting');
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const running = useRef(new Map<string, Promise<void>>());
  const waiters = useRef<{ resolve: () => void; reject: (error: Error) => void }[]>([]);
  const loadedWindowRef = useRef('');
  const lastManualEpochRef = useRef(0);
  const loadedDevicesEpochRef = useRef(-1);

  const track = useCallback((id: string, promise: Promise<void>) => {
    running.current.set(id, promise);
    const done = () => {
      if (running.current.get(id) === promise) running.current.delete(id);
    };
    void promise.then(done, done);
  }, []);

  const registry = useMemo(() => ({ epoch: manualEpoch, track }), [manualEpoch, track]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const manualRefresh = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        waiters.current.push({ resolve, reject });
        setManualEpoch((n) => n + 1);
        setTick((t) => t + 1);
      }),
    [],
  );

  useEffect(() => writePreference('range', range), [range]);
  const activeRange = useMemo(() => (range.live ? nowRange(range.hours) : range), [range, tick]);
  const rangeKey = timeRangeKey(range);
  const visible = useRef(document.visibilityState !== 'hidden');
  const device = useMemo(() => devices.find((d) => d.id === selected) || devices[0] || null, [devices, selected]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePreference('theme', theme);
  }, [theme]);

  useEffect(() => {
    const manualTriggered = manualEpoch !== lastManualEpochRef.current;
    // When browsing a frozen historical window, skip background polling of device list after initial load.
    if (!range.live && loadedDevicesEpochRef.current >= 0 && !manualTriggered) {
      return;
    }
    let active = true;
    const work = withTimeout(
      db!
        .from('devices')
        .select('id,name,model,created_at,last_seen_at,last_boot_id,revoked_at,dropped_samples,dropped_logs,storage_degraded_at,config')
        .order('created_at'),
    )
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setDeviceError(error.message);
          throw new Error(error.message);
        }
        loadedDevicesEpochRef.current = manualEpoch;
        const nextDevices = (data as Device[]) || [];
        setDevices((prev) => (sameSnapshot(prev, nextDevices) ? prev : nextDevices));
        setDeviceError('');
      })
      .catch((error) => {
        if (active) setDeviceError(actionError(error));
        throw error;
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    track('core-devices', work);
    void work.catch(() => {});
    return () => {
      active = false;
    };
  }, [session.user.id, tick, manualEpoch, range.live, track]);

  // Coalesce polling fallback with Realtime/manual refreshes so they never double-fetch back to back.
  useEffect(() => {
    const change = () => {
      visible.current = document.visibilityState !== 'hidden';
      if (visible.current && !paused) refresh();
    };
    document.addEventListener('visibilitychange', change);
    const timer =
      !paused && visible.current
        ? setTimeout(() => {
            if (!paused && visible.current) refresh();
          }, refreshSeconds * 1000)
        : undefined;
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', change);
    };
  }, [paused, refresh, refreshSeconds, tick]);

  useEffect(() => {
    if (!device) {
      setLatest(null);
      setHistory([]);
      setOpenAlerts([]);
      loadedWindowRef.current = '';
      return;
    }
    const windowKey = `${device.id}:${rangeKey}`;
    const manualTriggered = manualEpoch !== lastManualEpochRef.current;
    // Frozen historical ranges are immutable; skip automatic timer ticks once loaded unless user forces a refresh.
    if (!range.live && loadedWindowRef.current === windowKey && !manualTriggered) {
      return;
    }
    let active = true;
    const query = async () => {
      try {
        const current = range.live ? nowRange(range.hours) : range;
        const [latestResult, historyResult, snapshotResult, alertsResult] = await withTimeout(
          Promise.all([
            db!.from('device_latest').select('*').eq('device_id', device.id).maybeSingle(),
            db!.rpc('history', { p_device_id: device.id, p_from: current.from, p_to: current.to }),
            range.live
              ? Promise.resolve({ data: null, error: null })
              : db!
                  .from('metric_samples')
                  .select('*')
                  .eq('device_id', device.id)
                  .gte('effective_at', range.from)
                  .lt('effective_at', range.to)
                  .order('effective_at', { ascending: false })
                  .order('seq', { ascending: false })
                  .limit(1)
                  .maybeSingle(),
            db!
              .from('alerts')
              .select('id,device_id,rule_key,severity,message,opened_at,resolved_at,acknowledged_at')
              .eq('device_id', device.id)
              .is('resolved_at', null)
              .order('opened_at', { ascending: false })
              .limit(25),
          ]),
        );
        const error = latestResult.error || historyResult.error || snapshotResult.error || alertsResult.error;
        if (error) throw new Error(error.message);
        if (!active) return;
        loadedWindowRef.current = windowKey;
        lastManualEpochRef.current = manualEpoch;
        setMetricError('');
        setLatestDevice(device.id);
        const nextSnapshot = snapshotResult.data as Sample | null;
        setSnapshot((prev) => (sameSnapshot(prev, nextSnapshot) ? prev : nextSnapshot));
        setDataRange(rangeKey);
        const nextLatest = latestResult.data as Sample | null;
        setLatest((prev) => (sameSnapshot(prev, nextLatest) ? prev : nextLatest));
        const nextHistory = (historyResult.data || []) as Sample[];
        setHistory((prev) => (sameSnapshot(prev, nextHistory) ? prev : nextHistory));
        const alertRows = Array.isArray(alertsResult.data) ? (alertsResult.data as AlertRecord[]) : [];
        const nextAlerts = alertRows.filter((a) => a && typeof a.id === 'string' && !a.resolved_at);
        setOpenAlerts((prev) => (sameSnapshot(prev, nextAlerts) ? prev : nextAlerts));
        setLastRefreshAt(new Date().toISOString());
      } catch (error) {
        if (active) setMetricError(actionError(error));
        throw error;
      }
    };
    const work = query();
    track('core-metrics', work);
    void work.catch(() => {});
    return () => {
      active = false;
    };
  }, [device?.id, tick, range, rangeKey, manualEpoch, track]);

  // Child query effects and the core effects above register their real promises before this effect.
  useEffect(() => {
    if (!manualEpoch || !waiters.current.length) return;
    const requests = waiters.current.splice(0);
    void Promise.allSettled([...running.current.values()]).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        for (const request of requests) request.reject(new Error(actionError(failure.reason)));
      } else {
        setLastRefreshAt(new Date().toISOString());
        for (const request of requests) request.resolve();
      }
    });
  }, [manualEpoch]);

  useEffect(() => {
    if (!device || paused) return;
    let channel: ReturnType<NonNullable<typeof db>['channel']> | null = null;
    const connect = () => {
      if (document.visibilityState === 'hidden') return;
      channel = db!
        .channel('latest:' + device.id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'device_latest', filter: `device_id=eq.${device.id}` }, () =>
          refresh(),
        )
        .subscribe((status) => setTransport(status === 'SUBSCRIBED' ? `Live + ${refreshSeconds}s sync` : `${refreshSeconds}s polling`));
    };
    const visibility = () => {
      if (channel) {
        void db!.removeChannel(channel);
        channel = null;
      }
      if (document.visibilityState !== 'hidden') connect();
      else setTransport('Hidden tab · paused');
    };
    connect();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      if (channel) void db!.removeChannel(channel);
    };
  }, [device?.id, paused, refresh, refreshSeconds]);

  const selectDevice = useCallback((id: string) => {
    setSelected(id);
    writePreference('device', id);
  }, []);

  const setRefreshSeconds = useCallback((n: number) => {
    setRefreshState(n);
    writePreference('refresh-seconds', n);
  }, []);

  const setZone = useCallback((z: string) => {
    setZoneState(z);
    writePreference('zone', z);
  }, []);

  const scopedLatest = latestDevice === device?.id ? (range.live ? latest : dataRange === rangeKey ? snapshot : null) : null;
  const scopedHistory = latestDevice === device?.id && dataRange === rangeKey ? history : [];
  const scopedAlerts = latestDevice === device?.id ? openAlerts : [];

  const value: Store = useMemo(
    () => ({
      session,
      devices,
      device,
      selectDevice,
      latest: scopedLatest,
      history: scopedHistory,
      openAlerts: scopedAlerts,
      range: activeRange,
      setRange,
      paused,
      setPaused,
      refreshSeconds,
      setRefreshSeconds,
      zone,
      setZone,
      theme,
      setTheme: setThemeState,
      tick,
      refresh,
      manualRefresh,
      lastRefreshAt,
      error: deviceError || metricError,
      transport: paused ? 'Paused' : transport,
      loading,
    }),
    [
      session,
      devices,
      device,
      selectDevice,
      scopedLatest,
      scopedHistory,
      scopedAlerts,
      activeRange,
      paused,
      refreshSeconds,
      setRefreshSeconds,
      zone,
      setZone,
      theme,
      tick,
      refresh,
      manualRefresh,
      lastRefreshAt,
      deviceError,
      metricError,
      transport,
      loading,
    ],
  );

  return (
    <QueryContext.Provider value={registry}>
      <Context.Provider value={value}>{children}</Context.Provider>
    </QueryContext.Provider>
  );
}

function sameDeps(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

export function useQuery<T>(
  query: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
  scopeDeps: unknown[],
  refreshDeps: unknown[] = [],
) {
  const [result, setResult] = useState<{ data: T | null; scope: unknown[] } | null>(null);
  const [errorState, setErrorState] = useState<{ message: string; scope: unknown[]; background: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const registry = useContext(QueryContext);
  const id = useId();
  const isCurrent = result !== null && sameDeps(scopeDeps, result.scope);
  const matchingError = errorState && sameDeps(scopeDeps, errorState.scope) ? errorState : null;
  const blockingError = matchingError && !matchingError.background ? matchingError.message : '';
  const refreshError = matchingError && matchingError.background ? matchingError.message : '';
  const scopeAtEffectRef = useRef(isCurrent);
  scopeAtEffectRef.current = isCurrent;
  const allDeps = [...scopeDeps, ...refreshDeps, registry?.epoch];

  useEffect(() => {
    let active = true;
    const background = scopeAtEffectRef.current;
    if (background) {
      setRefreshing(true);
    } else {
      setRefreshing(false);
    }
    const scopeSnapshot = [...scopeDeps];
    const work = withTimeout(Promise.resolve().then(query))
      .then((response) => {
        if (response.error) throw new Error(response.error.message);
        if (active) {
          setResult((prev) =>
            prev && sameDeps(prev.scope, scopeSnapshot) && sameSnapshot(prev.data, response.data)
              ? prev
              : { data: response.data, scope: scopeSnapshot },
          );
          setErrorState(null);
          setRefreshedAt(new Date().toISOString());
        }
      })
      .catch((err) => {
        if (active) setErrorState({ message: actionError(err), scope: scopeSnapshot, background });
        throw err;
      })
      .finally(() => {
        if (active) setRefreshing(false);
      });
    registry?.track(id, work);
    void work.catch(() => {});
    return () => {
      active = false;
    };
  }, allDeps);

  return {
    data: isCurrent ? (result?.data ?? null) : null,
    error: blockingError,
    refreshError,
    loading: !isCurrent && !blockingError,
    refreshing,
    refreshedAt,
    isCurrent,
  };
}
