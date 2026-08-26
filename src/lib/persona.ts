// Deterministic agent personas: each session key hashes to a codename + accent hue.

export interface Persona {
  name: string;      // "Rusty Falcon"
  hue: number;       // accent hue, curated to sit well on the phosphor theme
}

// Curated lists: professional-cute, never silly-random. Big lists keep the
// species distinct across a fleet; the epithet resolves the rare collision.
const ADJECTIVES = [
  'Rusty', 'Amber', 'Cobalt', 'Ivory', 'Onyx', 'Copper',
  'Slate', 'Indigo', 'Jade', 'Ember', 'Misty', 'Nimble',
  'Steady', 'Quiet', 'Swift', 'Bold', 'Lucky', 'Stormy',
  'Frosty', 'Golden', 'Iron', 'Dusty', 'Silent', 'Vivid',
  'Brave', 'Clever', 'Mellow', 'Rapid', 'Tidal', 'Umber',
  'Arctic', 'Briny', 'Cedar', 'Dapper', 'Eager', 'Foggy',
  'Gentle', 'Hardy', 'Keen', 'Lunar',
] as const;

const CALLSIGNS = [
  'Falcon', 'Lynx', 'Otter', 'Badger', 'Heron', 'Raven',
  'Kestrel', 'Marten', 'Wren', 'Osprey', 'Bobcat', 'Gecko',
  'Condor', 'Puffin', 'Merlin', 'Magpie', 'Sparrow', 'Fennec',
  'Harrier', 'Ibis', 'Jaguar', 'Caracal', 'Lemur', 'Marmot',
  'Mongoose', 'Narwhal', 'Ocelot', 'Pangolin', 'Quokka', 'Stoat',
  'Tapir', 'Toucan', 'Cormorant', 'Weasel', 'Wombat', 'Egret',
  'Gannet', 'Petrel', 'Shrike', 'Kite', 'Goshawk', 'Owl',
  'Ferret', 'Mink', 'Civet', 'Serval', 'Margay', 'Coyote',
  'Vixen', 'Ermine', 'Gibbon', 'Macaque', 'Tamarin', 'Beaver',
  'Pika', 'Chinchilla', 'Capybara', 'Axolotl', 'Tortoise', 'Iguana',
  'Skink', 'Newt', 'Bunting', 'Siskin', 'Linnet', 'Grouse',
  'Lapwing', 'Plover', 'Curlew', 'Avocet', 'Bittern', 'Dunlin',
] as const;

// Version-mark epithets: appended only when two current sessions collide on
// the same full codename, so "Frosty Lynx VII" and "Frosty Lynx XI" split.
const EPITHETS = [
  'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX',
  'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII',
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

// Resolve personas for the current session set: any full-name collision gets a
// deterministic per-key epithet, so every visible codename is unique.
export function resolvePersonas(keys: string[]): Map<string, Persona> {
  const out = new Map<string, Persona>();
  const byName = new Map<string, string[]>();
  for (const k of keys) {
    const p = personaFor(k);
    out.set(k, p);
    const list = byName.get(p.name);
    if (list) list.push(k); else byName.set(p.name, [k]);
  }
  for (const clash of byName.values()) {
    if (clash.length < 2) continue;
    for (const k of clash) {
      const p = out.get(k)!;
      const epithet = EPITHETS[Math.floor(fnv1a(k) / 977) % EPITHETS.length];
      out.set(k, { ...p, name: `${p.name} ${epithet}` });
    }
  }
  return out;
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
