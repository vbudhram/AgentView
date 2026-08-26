import type { SessionStatus } from '@/lib/ui-types';
import { accentColor, accentDim } from '@/lib/persona';

// Compact robot face whose expression tracks the session status.
// Pure inline SVG; the small animations live in globals.css (.av-*) and
// switch off under prefers-reduced-motion.
export function AgentAvatar({ status, hue, size = 28 }: {
  status: SessionStatus; hue: number; size?: number;
}) {
  const accent = accentColor(hue);
  const dim = accentDim(hue);
  const ended = status === 'ended';
  const tipColor =
    status === 'working' ? 'var(--green)' :
    status === 'needs_input' ? 'var(--amber)' :
    status === 'blocked' ? 'var(--red)' :
    ended ? 'var(--ended)' : accent;

  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" aria-hidden="true"
      style={{ flexShrink: 0, display: 'block', opacity: ended ? 0.45 : 1 }}
    >
      {/* antenna */}
      <line x1="16" y1="3.2" x2="16" y2="6.6" stroke={dim} strokeWidth="1.4" />
      <circle
        cx="16" cy="3" r="1.7" fill={tipColor}
        className={status === 'working' ? 'av-tip-working' : status === 'blocked' ? 'av-alarm' : ''}
      />
      {/* side bolts */}
      <rect x="3.4" y="13.5" width="2.2" height="5.5" rx="1.1" fill={dim} />
      <rect x="26.4" y="13.5" width="2.2" height="5.5" rx="1.1" fill={dim} />
      {/* head */}
      <rect
        x="6" y="6.8" width="20" height="19" rx="5.4"
        fill="var(--bg-raised)" stroke={ended ? 'var(--ended)' : accent}
        strokeOpacity={ended ? 0.8 : 0.65} strokeWidth="1.3"
      />

      {status === 'working' && (
        <g>
          {/* focused visor eyes with scanning pupils */}
          <rect x="9" y="13.6" width="6" height="4.6" rx="2" fill="rgba(0,0,0,0.5)" stroke={dim} strokeWidth="0.7" />
          <rect x="17" y="13.6" width="6" height="4.6" rx="2" fill="rgba(0,0,0,0.5)" stroke={dim} strokeWidth="0.7" />
          <rect className="av-pupil" x="11.2" y="14.7" width="1.7" height="2.4" rx="0.8" fill="var(--green)" />
          <rect className="av-pupil" x="19.2" y="14.7" width="1.7" height="2.4" rx="0.8" fill="var(--green)" />
          <line x1="13" y1="22" x2="19" y2="22" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" />
        </g>
      )}

      {status === 'needs_input' && (
        <g>
          {/* raised brow + question glint */}
          <path d="M9.7 12.2 Q12.5 10 15.2 12" fill="none" stroke="var(--amber)" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="12.5" cy="16" r="2.1" fill={accent} />
          <circle cx="19.5" cy="16.4" r="1.8" fill={accent} />
          <path d="M13.5 21.6 Q16 23.2 18.5 21.6" fill="none" stroke="var(--text-dim)" strokeWidth="1.2" strokeLinecap="round" />
          <text
            className="av-glint" x="23.2" y="12.4" fontSize="8" fontWeight="700"
            fill="var(--amber)" fontFamily="var(--font-mono)"
          >
            ?
          </text>
        </g>
      )}

      {status === 'blocked' && (
        <g>
          {/* alarmed wide eyes */}
          <line x1="9.6" y1="11.6" x2="14.6" y2="12.9" stroke="var(--red)" strokeWidth="1.2" strokeLinecap="round" />
          <line x1="22.4" y1="11.6" x2="17.4" y2="12.9" stroke="var(--red)" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="12.5" cy="16.6" r="2.9" fill="#e8ecea" stroke="var(--red)" strokeWidth="0.9" className="av-alarm" />
          <circle cx="19.5" cy="16.6" r="2.9" fill="#e8ecea" stroke="var(--red)" strokeWidth="0.9" className="av-alarm" />
          <circle cx="12.5" cy="16.8" r="1.2" fill="#111614" />
          <circle cx="19.5" cy="16.8" r="1.2" fill="#111614" />
          <circle cx="16" cy="22.2" r="1.6" fill="none" stroke="var(--red)" strokeWidth="1.1" />
        </g>
      )}

      {status === 'idle' && (
        <g>
          <circle cx="12.5" cy="16" r="2.1" fill={accent} />
          <circle cx="19.5" cy="16" r="2.1" fill={accent} />
          <line x1="13" y1="21.8" x2="19" y2="21.8" stroke="var(--text-dim)" strokeWidth="1.2" strokeLinecap="round" />
        </g>
      )}

      {ended && (
        <g>
          {/* powered down: closed eyes */}
          <path d="M10.4 16 Q12.5 18 14.6 16" fill="none" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M17.4 16 Q19.5 18 21.6 16" fill="none" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" />
          <line x1="13.4" y1="21.8" x2="18.6" y2="21.8" stroke="var(--text-faint)" strokeWidth="1.2" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}
