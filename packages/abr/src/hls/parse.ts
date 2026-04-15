/** Minimal HLS playlist parsing: just what a VOD fMP4 player needs. */

export interface Variant {
  uri: string;
  bandwidth: number;
  averageBandwidth: number | null;
  width: number | null;
  height: number | null;
  codecs: string | null;
}

export interface MediaPlaylist {
  targetDurationS: number;
  initUri: string | null;
  segments: { uri: string; durationS: number }[];
  endList: boolean;
}

/** Parses an attribute list: KEY=VALUE,KEY="quoted, value",... */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const v = m[2]!;
    out[m[1]!] = v.startsWith('"') ? v.slice(1, -1) : v;
  }
  return out;
}

function lines(text: string): string[] {
  const ls = text.split(/\r?\n/).map((l) => l.trim());
  if (ls[0] !== '#EXTM3U') throw new Error('not an HLS playlist (missing #EXTM3U)');
  return ls;
}

export function parseMaster(text: string): Variant[] {
  const ls = lines(text);
  const out: Variant[] = [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    if (!l.startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = parseAttributes(l.slice('#EXT-X-STREAM-INF:'.length));
    let uri = '';
    while (++i < ls.length) {
      const next = ls[i]!;
      if (next && !next.startsWith('#')) {
        uri = next;
        break;
      }
    }
    if (!uri) throw new Error('EXT-X-STREAM-INF without URI');
    const res = a['RESOLUTION']?.split('x').map(Number);
    out.push({
      uri,
      bandwidth: Number(a['BANDWIDTH'] ?? 0),
      averageBandwidth: a['AVERAGE-BANDWIDTH'] ? Number(a['AVERAGE-BANDWIDTH']) : null,
      width: res?.[0] ?? null,
      height: res?.[1] ?? null,
      codecs: a['CODECS'] ?? null,
    });
  }
  if (out.length === 0) throw new Error('master playlist has no variants');
  return out;
}

export function parseMedia(text: string): MediaPlaylist {
  const ls = lines(text);
  const pl: MediaPlaylist = { targetDurationS: 0, initUri: null, segments: [], endList: false };
  let dur: number | null = null;
  for (const l of ls) {
    if (l.startsWith('#EXT-X-TARGETDURATION:')) pl.targetDurationS = Number(l.split(':')[1]);
    else if (l.startsWith('#EXT-X-MAP:')) pl.initUri = parseAttributes(l.slice(11))['URI'] ?? null;
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l === '#EXT-X-ENDLIST') pl.endList = true;
    else if (l && !l.startsWith('#')) {
      if (dur === null) throw new Error(`segment ${l} without #EXTINF`);
      pl.segments.push({ uri: l, durationS: dur });
      dur = null;
    }
  }
  return pl;
}

/** Resolves a playlist-relative URI against the playlist URL. */
export function resolveUri(base: string, rel: string): string {
  return new URL(rel, base).toString();
}
