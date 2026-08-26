import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';

export async function POST(req: Request) {
  const { sessionId } = await req.json().catch(() => ({ sessionId: null }));
  const url = sessionId ? `claude://session/${sessionId}` : 'claude://';
  execFile('open', [url], (err) => { if (err) execFile('open', ['claude://']); });
  return NextResponse.json({ ok: true });
}
