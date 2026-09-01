import { getRuntime } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export function GET() {
  const { store } = getRuntime();
  const enc = new TextEncoder();
  let onEvents: (p: { key: string; events: unknown[] }) => void;
  let timer: ReturnType<typeof setInterval>;
  let closed = false;
  const cleanup = () => {
    closed = true;
    store.off('events', onEvents);
    clearInterval(timer);
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        // enqueue throws after the client disconnects
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          cleanup();
        }
      };
      // Status flips from time or the proc poller emit no store events,
      // so poll the summaries each tick and send only real changes.
      const fingerprint = (sessions: ReturnType<typeof store.summaries>) =>
        JSON.stringify(sessions.map((s) => [s.key, s.status, s.steerable, s.wrapperOutdated, s.eventCount, s.lastActivity, s.spinner]));
      let lastFp = '';
      const sendSessions = () => {
        const sessions = store.summaries();
        const fp = fingerprint(sessions);
        if (fp === lastFp) return;
        lastFp = fp;
        send({ type: 'sessions', sessions });
      };
      // A comment line kept flowing so intermediaries (mobile proxies, DERP
      // relays) flush the stream and don't idle-kill the connection.
      const heartbeat = () => { if (!closed) { try { controller.enqueue(enc.encode(': ping\n\n')); } catch { cleanup(); } } };
      controller.enqueue(enc.encode('retry: 3000\n\n'));
      sendSessions();
      onEvents = (p) => {
        if (p.events.length > 0) send({ type: 'events', key: p.key, events: p.events });
      };
      store.on('events', onEvents);
      let ticks = 0;
      timer = setInterval(() => { sendSessions(); if (++ticks % 15 === 0) heartbeat(); }, 1000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
