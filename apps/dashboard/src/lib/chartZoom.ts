const sharedZoomByKey = new Map<string, { start?: number; end?: number }>();
const zoomListeners = new Map<string, Set<() => void>>();

export function getSavedZoom(scopeKey: string) {
  return sharedZoomByKey.get(scopeKey);
}

export function setSavedZoom(scopeKey: string, zoom?: { start?: number; end?: number }) {
  if (zoom) sharedZoomByKey.set(scopeKey, zoom);
  else sharedZoomByKey.delete(scopeKey);
}

export function subscribeZoomReset(scopeKey: string, listener: () => void) {
  let set = zoomListeners.get(scopeKey);
  if (!set) {
    set = new Set();
    zoomListeners.set(scopeKey, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

export function resetChartZoom(scopeKey: string) {
  sharedZoomByKey.delete(scopeKey);
  zoomListeners.get(scopeKey)?.forEach((fn) => fn());
}
