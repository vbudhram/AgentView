import { gzipSync } from 'node:zlib';
import { getRuntime } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

// Transcripts reach tens of MB; phones over Tailscale must not download the
// whole file to open a session. `?tail=N` returns only the last N events,
// with `total` so the client can tell a tailed snapshot from a stale one.
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const all = getRuntime().store.events(decodeURIComponent(key));
  const tailRaw = new URL(req.url).searchParams.get('tail');
  const tail = tailRaw === null ? NaN : parseInt(tailRaw, 10);
  const events = Number.isFinite(tail) && tail >= 0 ? all.slice(Math.max(0, all.length - tail)) : all;
  const body = JSON.stringify({ events, total: all.length });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  // JSON transcripts compress ~10x; the SSE stream is untouched by this.
  if (req.headers.get('accept-encoding')?.includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    return new Response(new Uint8Array(gzipSync(body)), { headers });
  }
  return new Response(body, { headers });
}
