// The crown jewels: a treasure inventory generated at startup.
// Same seed, same jewels: the inventory is identical after every restart (idempotent seed).

export type Kind = "bar" | "gem" | "crown" | "coin" | "pearls" | "bond" | "ring" | "chalice" | "tiara" | "egg" | "watch" | "ingot";

export type Item = {
  drawer: number; // safe-deposit drawer number
  kind: Kind;
  name: string;
  detail: string;
  serial: string;
  appraisal: number; // euros
  deposit?: { at: string; from: string }; // set for visitor deposits
};

// Tiny deterministic PRNG (mulberry32).
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Recipe = { kind: Kind; name: string; detail: (r: () => number) => string; value: [number, number] };

const pick = (r: () => number, min: number, max: number, step = 1) => Math.round((min + r() * (max - min)) / step) * step;

const RECIPES: Recipe[] = [
  { kind: "crown", name: "Coronation crown", detail: (r) => `${pick(r, 380, 520)} stones, gold and velvet`, value: [9_000_000, 14_000_000] },
  { kind: "bar", name: "Gold bullion bar", detail: (r) => `${pick(r, 398, 404, 0.1).toFixed(1)} troy oz, 999.9 fine`, value: [1_100_000, 1_300_000] },
  { kind: "gem", name: "Star sapphire", detail: (r) => `${pick(r, 28, 46, 0.1).toFixed(1)} ct, cabochon`, value: [600_000, 1_400_000] },
  { kind: "tiara", name: "Emerald tiara", detail: (r) => `${pick(r, 11, 19)} emeralds, platinum`, value: [2_000_000, 3_500_000] },
  { kind: "coin", name: "Gold aureus", detail: (r) => `Rome, ${pick(r, 27, 14)} BC, 7.9 g`, value: [180_000, 420_000] },
  { kind: "pearls", name: "Natural pearl necklace", detail: (r) => `${pick(r, 41, 63)} pearls, three strands`, value: [700_000, 1_600_000] },
  { kind: "egg", name: "Jewelled clockwork egg", detail: (r) => `enamel, ${pick(r, 1890, 1912)}`, value: [3_000_000, 6_000_000] },
  { kind: "bond", name: "Bearer bond", detail: (r) => `${pick(r, 1921, 1934)}, 10,000 francs`, value: [40_000, 90_000] },
  { kind: "ring", name: "Signet ring", detail: (r) => `18k gold, ${pick(r, 1780, 1840)}`, value: [60_000, 140_000] },
  { kind: "chalice", name: "Silver-gilt chalice", detail: (r) => `${pick(r, 22, 31)} cm, chased`, value: [250_000, 600_000] },
  { kind: "watch", name: "Pocket chronometer", detail: (r) => `${pick(r, 1898, 1911)}, 21 jewels`, value: [120_000, 300_000] },
  { kind: "ingot", name: "Platinum ingot", detail: () => "1 kg, 999.5 fine", value: [28_000, 34_000] },
];

function serial(r: () => number, kind: Kind) {
  const hex = Math.floor(r() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return `${kind.slice(0, 2).toUpperCase()}-${hex}-${pick(r, 10, 99)}`;
}

export function seedInventory(seed = 0x7a017): Item[] {
  const r = prng(seed);
  return RECIPES.map((recipe, i) => ({
    drawer: i + 1,
    kind: recipe.kind,
    name: recipe.name,
    detail: recipe.detail(r),
    serial: serial(r, recipe.kind),
    appraisal: pick(r, recipe.value[0], recipe.value[1], 1000),
  }));
}

// What a visitor may deposit through the tunnel: a fixed menu, no free text.
export const DEPOSITS = {
  bar: { name: "Gold bar", detail: "1 kg, 999.9 fine", value: [95_000, 105_000] },
  gem: { name: "Ruby", detail: "4.2 ct, oval", value: [60_000, 140_000] },
  coin: { name: "Gold sovereign", detail: "7.98 g, 22k", value: [700, 900] },
  pearls: { name: "Pearl earrings", detail: "a pair, natural", value: [8_000, 22_000] },
} as const;

export type DepositKind = keyof typeof DEPOSITS;
export const isDepositKind = (value: unknown): value is DepositKind => typeof value === "string" && value in DEPOSITS;

export function mintDeposit(kind: DepositKind, drawer: number, from: string, r = Math.random): Item {
  const recipe = DEPOSITS[kind];
  return {
    drawer,
    kind,
    name: recipe.name,
    detail: recipe.detail,
    serial: serial(r, kind),
    appraisal: pick(r, recipe.value[0], recipe.value[1], 10),
    deposit: { at: new Date().toISOString(), from },
  };
}
