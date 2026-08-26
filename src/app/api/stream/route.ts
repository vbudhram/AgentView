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
      const send = (obj: unknown) => {
        if (closed) return;
        // enqueue throws after the client disconnects
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      send({ type: 'sessions', sessions: store.summaries() });
      let dirty = false;
      onEvents = (p) => {
        if (p.events.length > 0) send({ type: 'events', key: p.key, events: p.events });
        dirty = true;
      };
      store.on('events', onEvents);
      timer = setInterval(() => {
        if (dirty) { dirty = false; send({ type: 'sessions', sessions: store.summaries() }); }
      }, 1000);
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
