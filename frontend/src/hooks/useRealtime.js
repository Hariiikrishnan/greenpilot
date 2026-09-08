// React binding for the canonical realtime connection.
//
// Mount ONCE per authenticated session (e.g. in ChatsPage) and pass a stable
// `onEvent({ type, data })` callback:
//
//   const onEvent = useCallback((ev) => {
//     if (ev.type === 'message-status-update') applyTick(ev.data);
//     if (ev.type === 'inbound-message') refetch();
//   }, [...]);
//   useRealtime(onEvent);
//
// Lifecycle: connects on mount (auth cookie → server-verified org rooms),
// no-ops when onEvent is absent, and unsubscribes (never disconnects — the
// singleton is shared) on unmount. A manual `disconnectRealtime()` still
// exists for logout.

import { useEffect } from 'react';
import {
  REALTIME_EVENTS,
  connectRealtime,
  subscribeRealtime,
} from '../realtime/socketClient.js';

export function useRealtime(onEvent) {
  useEffect(() => {
    if (!onEvent) return undefined;
    connectRealtime();
    const unsubs = REALTIME_EVENTS.map((type) =>
      subscribeRealtime(type, (data) => {
        try { onEvent({ type, data }); } catch { /* isolate consumer faults */ }
      })
    );
    return () => { for (const u of unsubs) u(); };
  }, [onEvent]);
}

export { REALTIME_EVENTS };
