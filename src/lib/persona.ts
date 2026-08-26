// Deterministic agent personas: each session key hashes to a codename + accent hue.

export interface Persona {
  name: string;      // "Rusty Falcon"
  hue: number;       // accent hue, curated to sit well on the phosphor theme
}

// Curated lists: professional-cute, never silly-random.
const ADJECTIVES = [
  'Rusty', 'Amber', 'Cobalt', 'Ivory', 'Onyx', 'Copper',
  'Slate', 'Indigo', 'Jade', 'Ember', 'Misty', 'Nimble',
  'Steady', 'Quiet', 'Swift', 'Bold', 'Lucky', 'Stormy',
  'Frosty', 'Golden', 'Iron', 'Dusty', 'Silent', 'Vivid',
] as const;

const CALLSIGNS = [
  'Falcon', 'Lynx', 'Otter', 'Badger', 'Heron', 'Raven',
  'Kestrel', 'Marten', 'Wren', 'Osprey', 'Bobcat', 'Gecko',
  'Condor', 'Puffin', 'Merlin', 'Magpie', 'Comet', 'Nova',
  'Vector', 'Beacon', 'Sparrow', 'Fennec', 'Harrier', 'Drift',
] as const;

// Hues that read well on the dark theme; red/amber stay reserved for alerts.
const HUES = [92, 130, 155, 175, 195, 215, 240, 265, 290, 315] as const;

// FNV-1a 32-bit: stable across server and client.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function personaFor(key: string): Persona {
  const h = fnv1a(key);
  const adj = ADJECTIVES[h % ADJECTIVES.length];
  const noun = CALLSIGNS[Math.floor(h / 251) % CALLSIGNS.length];
  const hue = HUES[Math.floor(h / 65537) % HUES.length];
  return { name: `${adj} ${noun}`, hue };
}

export function accentColor(hue: number): string {
  return `hsl(${hue} 65% 66%)`;
}

export function accentDim(hue: number, alpha = 0.35): string {
  return `hsla(${hue}, 55%, 55%, ${alpha})`;
}

// Desaturated accent for demoted flavor text; keeps ~4.5:1 on the dark theme.
export function accentSoft(hue: number): string {
  return `hsl(${hue} 30% 64%)`;
}
