import { NextResponse } from 'next/server';
import { getRuntime } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ sessions: getRuntime().store.summaries() });
}
