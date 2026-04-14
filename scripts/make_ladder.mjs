// Scans an FFmpeg HLS output directory (v0..vN/playlist.m3u8) and writes:
//  - ladder.json: per-rung metadata and the byte size of every segment (used by the simulator)
//  - master.m3u8: rewritten with measured AVERAGE-BANDWIDTH / peak BANDWIDTH, RESOLUTION and
//    CODECS, so the browser player and the simulator see identical rung bitrates.
// Usage: node scripts/make_ladder.mjs media/hls
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: make_ladder.mjs <hls-dir>');
  process.exit(2);
}
const CODEC = 'avc1.640028'; // H.264 High@4.0, forced for every rung by package.sh

function parseMediaPlaylist(text) {
  const lines = text.split(/\r?\n/);
  let init = null;
  let target = 0;
  const segs = [];
  let dur = null;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MAP:')) init = /URI="([^"]+)"/.exec(l)[1];
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) target = Number(l.split(':')[1]);
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#')) {
      segs.push({ uri: l.trim(), durationS: dur });
      dur = null;
    }
  }
  return { init, target, segs };
}

// RESOLUTION per variant URI from FFmpeg's own master playlist.
function ffmpegResolutions(masterPath) {
  const out = {};
  const lines = fs.readFileSync(masterPath, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    out[lines[j].trim()] = { width: Number(m[1]), height: Number(m[2]) };
  }
  return out;
}

const ffMaster = fs.existsSync(path.join(dir, 'master.ffmpeg.m3u8'))
  ? path.join(dir, 'master.ffmpeg.m3u8')
  : path.join(dir, 'master.m3u8');
const resolutions = ffmpegResolutions(ffMaster);

const variants = fs
  .readdirSync(dir)
  .filter((d) => /^v\d+$/.test(d))
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
if (variants.length === 0) throw new Error(`no v<N> directories in ${dir}`);

const rungs = variants.map((v, index) => {
  const vdir = path.join(dir, v);
  const pl = parseMediaPlaylist(fs.readFileSync(path.join(vdir, 'playlist.m3u8'), 'utf8'));
  const segments = pl.segs.map((s) => ({
    uri: `${v}/${s.uri}`,
    durationS: s.durationS,
    bytes: fs.statSync(path.join(vdir, s.uri)).size,
  }));
  const totalBytes = segments.reduce((a, s) => a + s.bytes, 0);
  const totalDur = segments.reduce((a, s) => a + s.durationS, 0);
  const peak = Math.max(...segments.map((s) => (s.bytes * 8) / s.durationS));
  const { width, height } = resolutions[`${v}/playlist.m3u8`];
  return {
    index,
    kbps: Math.round((totalBytes * 8) / totalDur / 1000), // measured average
    peakKbps: Math.round(peak / 1000),
    width,
    height,
    codec: CODEC,
    playlist: `${v}/playlist.m3u8`,
    init: `${v}/${pl.init}`,
    initBytes: fs.statSync(path.join(vdir, pl.init)).size,
    segments,
  };
});

const segCounts = new Set(rungs.map((r) => r.segments.length));
if (segCounts.size !== 1) throw new Error('rungs have different segment counts');
const ladder = {
  version: 1,
  codec: CODEC,
  segmentDurationS: Math.round(rungs[0].segments[0].durationS),
  segmentCount: rungs[0].segments.length,
  rungs,
};
fs.writeFileSync(path.join(dir, 'ladder.json'), JSON.stringify(ladder, null, 1));

const ff = path.join(dir, 'master.m3u8');
if (ffMaster === ff) fs.renameSync(ff, path.join(dir, 'master.ffmpeg.m3u8'));
let master = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n';
for (const r of rungs) {
  master +=
    `#EXT-X-STREAM-INF:BANDWIDTH=${r.peakKbps * 1000},AVERAGE-BANDWIDTH=${r.kbps * 1000},` +
    `RESOLUTION=${r.width}x${r.height},CODECS="${r.codec}",FRAME-RATE=30.000\n${r.playlist}\n`;
}
fs.writeFileSync(ff, master);
for (const r of rungs) {
  console.log(
    `rung ${r.index}: ${r.width}x${r.height} avg ${r.kbps} kbps peak ${r.peakKbps} kbps, ` +
      `${r.segments.length} segments`,
  );
}
