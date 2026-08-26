import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null;
  const url = sessionId ? `claude://session/${sessionId}` : 'claude://';
  execFile('open', [url], (err) => { if (err) execFile('open', ['claude://']); });
  return NextResponse.json({ ok: true });
}
