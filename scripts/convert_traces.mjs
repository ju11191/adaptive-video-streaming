// Converts raw bandwidth logs (Norway HSDPA / Belgium 4G share one format:
//   <epoch> <ms_since_start> <lat> <lon> <bytes_since_prev> <ms_since_prev>)
// into "<time_s> <mbps>" traces. A sample's throughput is bytes*8/ms_since_prev, assigned to
// the interval that *ended* at that line, so it is written at the previous line's time.
// Traces shorter than MIN_DURATION_S or with no data are skipped (counted in manifest.json).
// Usage: node scripts/convert_traces.mjs <raw-dir> <out-dir>
import fs from 'node:fs';
import path from 'node:path';

const [rawDir, outDir] = process.argv.slice(2);
if (!rawDir || !outDir) {
  console.error('usage: convert_traces.mjs <raw-dir> <out-dir>');
  process.exit(2);
}
const MIN_DURATION_S = 60;

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.log')) yield p;
  }
}

function convert(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const ms = Number(f[1]);
    const bytes = Number(f[4]);
    const elapsed = Number(f[5]);
    if (!Number.isFinite(ms) || !Number.isFinite(bytes) || !(elapsed > 0) || bytes < 0) continue;
    rows.push({ ms, bytes, elapsed });
  }
  const out = [];
  for (const r of rows) {
    const t = (r.ms - r.elapsed - rows[0].ms + rows[0].elapsed) / 1000; // interval start
    const mbps = (r.bytes * 8) / r.elapsed / 1000;
    if (out.length && t <= out[out.length - 1][0]) continue; // keep time strictly increasing
    out.push([t, mbps]);
  }
  return out;
}

const manifest = { generatedBy: 'scripts/convert_traces.mjs', sets: {}, skipped: [] };
for (const set of ['norway', 'belgium']) {
  const src = path.join(rawDir, set);
  if (!fs.existsSync(src)) continue;
  const dst = path.join(outDir, set);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const entries = [];
  for (const file of [...walk(src)].sort()) {
    const samples = convert(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(src, file);
    const dur = samples.length > 1 ? samples[samples.length - 1][0] - samples[0][0] : 0;
    const mean = samples.reduce((a, s) => a + s[1], 0) / Math.max(1, samples.length);
    if (samples.length < 2 || dur < MIN_DURATION_S || !(mean > 0)) {
      manifest.skipped.push({ set, file: rel, samples: samples.length, durationS: dur });
      continue;
    }
    const name = rel
      .replace(/\.log$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+/, '');
    fs.writeFileSync(
      path.join(dst, `${name}.txt`),
      `# source: ${set}/${rel}\n` + samples.map(([t, m]) => `${t.toFixed(3)} ${m.toFixed(4)}`).join('\n') + '\n',
    );
    entries.push({ name: `${set}/${name}`, durationS: +dur.toFixed(1), meanMbps: +mean.toFixed(3) });
  }
  manifest.sets[set] = entries;
  const means = entries.map((e) => e.meanMbps).sort((a, b) => a - b);
  console.log(
    `${set}: ${entries.length} traces, mean throughput median ${means[Math.floor(means.length / 2)]} Mbps`,
  );
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`skipped ${manifest.skipped.length} short/empty logs`);
