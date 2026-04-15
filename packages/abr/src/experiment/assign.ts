/** Deterministic, stateless session -> arm assignment (same answer in every component). */

/** 32-bit FNV-1a over UTF-16 code units (ASCII ids in practice). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // final avalanche (murmur3 fmix32) so sequential ids spread evenly
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export interface ArmSpec {
  name: string;
  weight?: number;
}

/** Hashes (experiment, session) to an arm, honouring optional integer weights. */
export function assignArm(experiment: string, sessionId: string, arms: readonly ArmSpec[]): string {
  if (arms.length === 0) throw new Error('no arms');
  const total = arms.reduce((a, x) => a + (x.weight ?? 1), 0);
  let bucket = fnv1a32(`${experiment}:${sessionId}`) % total;
  for (const a of arms) {
    bucket -= a.weight ?? 1;
    if (bucket < 0) return a.name;
  }
  return arms[arms.length - 1]!.name;
}
