/** One candidate configuration measured on the training traces (pooled over datasets). */
export interface Candidate {
  spec: string;
  /** 1 - mean(rebuffer ratio)/mean(baseline's), as reported by compare.ts. */
  rebufferCut: number;
  avgKbps: number;
  switches: number;
}

export interface Selection {
  family: string;
  chosen: Candidate;
  /** False when no candidate met the bitrate floor and the fallback (highest bitrate) was used. */
  feasible: boolean;
  candidates: (Candidate & { feasible: boolean })[];
}

/** Family of a spec: the algorithm name before ':'. */
export const familyOf = (spec: string) => spec.split(':', 1)[0]!;

/**
 * Selection rule, per algorithm family: among candidates whose avg bitrate is
 * >= minKbpsRatio x baseline, maximise the rebuffer cut (ties: fewer switches). If none is
 * feasible, take the highest avg bitrate.
 */
export function selectPerFamily(cands: readonly Candidate[], baselineKbps: number, minKbpsRatio: number): Selection[] {
  const families = [...new Set(cands.map((c) => familyOf(c.spec)))];
  return families.map((family) => {
    const mine = cands
      .filter((c) => familyOf(c.spec) === family)
      .map((c) => ({ ...c, feasible: c.avgKbps >= minKbpsRatio * baselineKbps }));
    const ok = mine.filter((c) => c.feasible);
    const pool = ok.length ? ok : mine;
    const best = [...pool].sort((a, b) =>
      ok.length ? b.rebufferCut - a.rebufferCut || a.switches - b.switches : b.avgKbps - a.avgKbps,
    )[0]!;
    const { feasible: _, ...chosen } = best;
    return { family, chosen, feasible: ok.length > 0, candidates: mine };
  });
}
