import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { db } from './client';
import { actionError, withTimeout } from './async';
import { nowRange, readPreference, writePreference, type AlertRecord, type Device, type Sample, type TimeRange } from './model';

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
  const rangeKey = range.live ? 'live:' + range.hours : range.from + ':' + range.to;
  const visible = useRef(document.visibilityState !== 'hidden');
  const device = devices.find((d) => d.id === selected) || devices[0] || null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePreference('theme', theme);
  }, [theme]);

  useEffect(() => {
    let active = true;
    const work = withTimeout(db!.from('devices').select('*').order('created_at'))
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setDeviceError(error.message);
          throw new Error(error.message);
        }
        setDevices((data as Device[]) || []);
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
  }, [session.user.id, tick, track]);

  useEffect(() => {
    const change = () => {
      visible.current = document.visibilityState !== 'hidden';
      if (visible.current && !paused) refresh();
    };
    document.addEventListener('visibilitychange', change);
    const timer = setInterval(() => {
      if (!paused && visible.current) refresh();
    }, refreshSeconds * 1000);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', change);
    };
  }, [paused, refresh, refreshSeconds]);

  useEffect(() => {
    if (!device) {
      setLatest(null);
      setHistory([]);
      setOpenAlerts([]);
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
            db!.from('alerts').select('*').eq('device_id', device.id).order('opened_at', { ascending: false }).limit(25),
          ]),
        );
        const error = latestResult.error || historyResult.error || snapshotResult.error;
        if (error) throw new Error(error.message);
        if (!active) return;
        setMetricError('');
        setLatestDevice(device.id);
        setSnapshot(snapshotResult.data as Sample | null);
        setDataRange(rangeKey);
        setLatest(latestResult.data as Sample | null);
        setHistory((historyResult.data || []) as Sample[]);
        const alertRows = Array.isArray(alertsResult.data) ? (alertsResult.data as AlertRecord[]) : [];
        setOpenAlerts(alertRows.filter((a) => a && typeof a.id === 'string' && !a.resolved_at));
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
  }, [device?.id, tick, range, track]);

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

  const value: Store = {
    session,
    devices,
    device,
    selectDevice: (id) => {
      setSelected(id);
      writePreference('device', id);
    },
    latest: latestDevice === device?.id ? (range.live ? latest : dataRange === rangeKey ? snapshot : null) : null,
    history: latestDevice === device?.id && dataRange === rangeKey ? history : [],
    openAlerts: latestDevice === device?.id ? openAlerts : [],
    range: activeRange,
    setRange,
    paused,
    setPaused,
    refreshSeconds,
    setRefreshSeconds: (n) => {
      setRefreshState(n);
      writePreference('refresh-seconds', n);
    },
    zone,
    setZone: (z) => {
      setZoneState(z);
      writePreference('zone', z);
    },
    theme,
    setTheme: setThemeState,
    tick,
    refresh,
    manualRefresh,
    lastRefreshAt,
    error: deviceError || metricError,
    transport: paused ? 'Paused' : transport,
    loading,
  };

  return (
    <QueryContext.Provider value={registry}>
      <Context.Provider value={value}>{children}</Context.Provider>
    </QueryContext.Provider>
  );
}
export function useQuery<T>(query: () => PromiseLike<{ data: T | null; error: { message: string } | null }>, deps: unknown[]) {
  const [result, setResult] = useState<{ data: T | null; inputs: unknown[] } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const registry = useContext(QueryContext);
  const id = useId();
  const inputs = [...deps, registry?.epoch];

  useEffect(() => {
    let active = true;
    setLoading(true);
    const work = withTimeout(Promise.resolve().then(query))
      .then((response) => {
        if (response.error) throw new Error(response.error.message);
        if (active) {
          setResult({ data: response.data, inputs });
          setError('');
          setRefreshedAt(new Date().toISOString());
        }
      })
      .catch((error) => {
        if (active) setError(actionError(error));
        throw error;
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    registry?.track(id, work);
    void work.catch(() => {});
    return () => {
      active = false;
    };
  }, inputs);

  // A render can have new inputs before the effect marks its query as loading.
  const isCurrent =
    result !== null && result.inputs.length === inputs.length && inputs.every((input, index) => Object.is(input, result.inputs[index]));
  return { data: result?.data ?? null, error, loading, refreshedAt, isCurrent };
}
