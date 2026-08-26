import { NextResponse } from 'next/server';
import { getRuntime } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return NextResponse.json({ events: getRuntime().store.events(decodeURIComponent(key)) });
}
