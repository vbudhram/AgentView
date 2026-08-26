import type { SessionStatus } from '@/lib/ui-types';
import { accentColor, accentDim } from '@/lib/persona';

// Compact robot face whose expression tracks the session status.
// Drawn for legibility at ~20px: few features, bold strokes, big eyes.
// The small animations live in globals.css (.av-*) and switch off under
// prefers-reduced-motion.
export function AgentAvatar({ status, hue, size = 28 }: {
  status: SessionStatus; hue: number; size?: number;
}) {
  const accent = accentColor(hue);
  const dim = accentDim(hue);
  const ended = status === 'ended';
  const tipColor =
    status === 'working' ? 'var(--green)' :
    status === 'needs_input' ? 'var(--amber)' :
    status === 'blocked' ? 'var(--amber-deep)' :
    ended ? 'var(--ended)' : accent;

  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" aria-hidden="true"
      style={{ flexShrink: 0, display: 'block', opacity: ended ? 0.45 : 1 }}
    >
      {/* antenna */}
      <line x1="16" y1="3.4" x2="16" y2="6.6" stroke={dim} strokeWidth="1.8" />
      <circle
        cx="16" cy="3.2" r="2.2" fill={tipColor}
        className={status === 'working' ? 'av-tip-working' : status === 'blocked' ? 'av-alarm' : ''}
      />
      {/* head */}
      <rect
        x="4.5" y="6.8" width="23" height="20.5" rx="6"
        fill="var(--bg-raised)" stroke={ended ? 'var(--ended)' : accent}
        strokeOpacity={ended ? 0.8 : 0.85} strokeWidth="1.8"
      />

      {status === 'working' && (
        <g>
          {/* focused visor eyes with bright pupils */}
          <rect x="8" y="13" width="7" height="5.6" rx="2.4" fill="rgba(0,0,0,0.55)" />
          <rect x="17" y="13" width="7" height="5.6" rx="2.4" fill="rgba(0,0,0,0.55)" />
          <rect x="10.4" y="14.2" width="2.6" height="3.2" rx="1.2" fill="var(--green)" />
          <rect x="19.4" y="14.2" width="2.6" height="3.2" rx="1.2" fill="var(--green)" />
          <line x1="12.5" y1="23" x2="19.5" y2="23" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" />
        </g>
      )}

      {status === 'needs_input' && (
        <g>
          {/* big open eyes + oversized question mark */}
          <circle cx="12" cy="16.2" r="2.9" fill={accent} />
          <circle cx="19.4" cy="16.6" r="2.4" fill={accent} />
          <path d="M12.8 22.4 Q16 24.4 19.2 22.4" fill="none" stroke="var(--text-dim)" strokeWidth="1.7" strokeLinecap="round" />
          <text
            className="av-glint" x="21.6" y="13.6" fontSize="11.5" fontWeight="800"
            fill="var(--amber)" stroke="var(--bg)" strokeWidth="0.5" fontFamily="var(--font-mono)"
          >
            ?
          </text>
        </g>
      )}

      {status === 'blocked' && (
        <g>
          {/* stalled: wide watchful eyes, flat mouth — waiting, not panicking */}
          <circle cx="12" cy="16.4" r="3.4" fill="#e8ecea" className="av-alarm" />
          <circle cx="20" cy="16.4" r="3.4" fill="#e8ecea" className="av-alarm" />
          <circle cx="12" cy="16.6" r="1.6" fill="#111614" />
          <circle cx="20" cy="16.6" r="1.6" fill="#111614" />
          <line x1="13" y1="23" x2="19" y2="23" stroke="var(--amber-deep)" strokeWidth="1.8" strokeLinecap="round" />
        </g>
      )}

      {status === 'idle' && (
        <g>
          <circle cx="12" cy="16.2" r="2.7" fill={accent} />
          <circle cx="20" cy="16.2" r="2.7" fill={accent} />
          <line x1="12.5" y1="22.6" x2="19.5" y2="22.6" stroke="var(--text-dim)" strokeWidth="1.7" strokeLinecap="round" />
        </g>
      )}

      {ended && (
        <g>
          {/* powered down: closed eyes */}
          <path d="M9.4 16.2 Q12 18.6 14.6 16.2" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M17.4 16.2 Q20 18.6 22.6 16.2" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="13" y1="22.6" x2="19" y2="22.6" stroke="var(--text-faint)" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}
