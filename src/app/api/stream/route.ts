import { getRuntime } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export function GET() {
  const { store } = getRuntime();
  const enc = new TextEncoder();
  let onEvents: (p: { key: string; events: unknown[] }) => void;
  let timer: ReturnType<typeof setInterval>;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const cleanup = () => {
        closed = true;
        store.off('events', onEvents);
        clearInterval(timer);
      };
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
        JSON.stringify(sessions.map((s) => [s.key, s.status, s.steerable, s.eventCount, s.lastActivity, s.spinner]));
      let lastFp = '';
      const sendSessions = () => {
        const sessions = store.summaries();
        const fp = fingerprint(sessions);
        if (fp === lastFp) return;
        lastFp = fp;
        send({ type: 'sessions', sessions });
      };
      sendSessions();
      onEvents = (p) => {
        if (p.events.length > 0) send({ type: 'events', key: p.key, events: p.events });
      };
      store.on('events', onEvents);
      timer = setInterval(sendSessions, 1000);
    },
    cancel() {
      closed = true;
      store.off('events', onEvents);
      clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
