/** Node-only helpers (filesystem). Not imported by the browser bundle. */
import fs from 'node:fs';
import path from 'node:path';
import { Trace } from './sim/trace.ts';
import { type LadderJson, NOMINAL_LADDER_KBPS, type VideoModel, syntheticVideo, videoFromLadder } from './sim/video.ts';

export function loadTrace(file: string, name?: string): Trace {
  return Trace.parse(fs.readFileSync(file, 'utf8'), name ?? path.basename(file, '.txt'));
}

/** Lists `<dir>/**.txt` traces, named "<set>/<file>" relative to `root`. Sorted for determinism. */
export function listTraceFiles(dir: string, root = path.dirname(dir)): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.txt')) out.push({ name: path.relative(root, p).replace(/\.txt$/, ''), file: p });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The packaged video if media/hls/ladder.json exists, else the nominal CBR ladder. */
export function loadVideo(ladderPath: string | null, segmentCount?: number): { video: VideoModel; source: string } {
  if (ladderPath && fs.existsSync(ladderPath)) {
    const json = JSON.parse(fs.readFileSync(ladderPath, 'utf8')) as LadderJson;
    return { video: videoFromLadder(json, segmentCount), source: ladderPath };
  }
  return { video: syntheticVideo(NOMINAL_LADDER_KBPS, 4, segmentCount ?? 48), source: 'nominal CBR ladder' };
}

/** Repository root (two levels above packages/abr/src). */
export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
