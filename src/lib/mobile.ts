'use client';
import { useEffect, useRef, useSyncExternalStore } from 'react';

// Single breakpoint shared with globals.css: at or under this width the app
// switches to the phone model (full-screen list ⇄ full-screen detail).
export const MOBILE_QUERY = '(max-width: 700px)';

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

// Touch-reliable activation. Some taps never produce a synthetic click
// (long presses, busy frames), so these fire on a pointer event and dedupe
// the follow-up click; the plain click path still serves the keyboard.
function useGuardedRun(fn: () => void): () => void {
  const last = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  return () => {
    if (Date.now() - last.current < 500) return;
    last.current = Date.now();
    fnRef.current();
  };
}

// For content inside a scroller: pointerup, which a scroll gesture cancels,
// so a drag that starts on the control still scrolls.
export function useTapActivate(fn: () => void): {
  onPointerUp: () => void;
  onClick: () => void;
} {
  const run = useGuardedRun(fn);
  return { onPointerUp: run, onClick: run };
}

// For toolbar controls that never sit in a scroll path (tab bars, headers,
// key chips): pointerdown, the instant native-segmented-control feel.
export function usePressActivate(fn: () => void): {
  onPointerDown: () => void;
  onClick: () => void;
} {
  const run = useGuardedRun(fn);
  return { onPointerDown: run, onClick: run };
}

// iOS soft keyboard: the layout viewport keeps its size while the visual
// viewport shrinks. Publish the visual height as --app-h so bottom-pinned
// surfaces (compose bar, terminal) stay above the keyboard.
export function useVisualViewportVar(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
      // iOS nudges the layout viewport when focusing near the keyboard;
      // pin it back so fixed surfaces stay aligned.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      root.style.removeProperty('--app-h');
    };
  }, [active]);
}
