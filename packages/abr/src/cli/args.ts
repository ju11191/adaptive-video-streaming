/** Tiny "--key value" / "--flag" argument parser for the CLIs. */
export function parseArgs(argv: readonly string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export function str(args: Record<string, string | true>, k: string, def: string): string {
  const v = args[k];
  return typeof v === 'string' ? v : def;
}

export function num(args: Record<string, string | true>, k: string, def: number): number {
  const v = args[k];
  if (typeof v !== 'string') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${k} must be a number`);
  return n;
}
