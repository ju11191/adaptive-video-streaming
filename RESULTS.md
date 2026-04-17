# RESULTS

All numbers here were produced by the scripts in `bench/` on the machine below. Nothing was
estimated or hand-edited. The raw output of each run is pasted under its section. Rerunning a
command regenerates the same files in `bench/out/` (git-ignored).

**Hardware / software**

- Apple M3 (8 cores), 16 GiB RAM, macOS 15.7 (Darwin 24.6.0)
- Node v23.10.0, Apple clang 15.0.0 (C++ release build), Homebrew clang 23.1.2 (clang-format)
- Docker 28.4.0 (Docker Desktop, linux/arm64 VM) for FFmpeg, Kafka, and the compose stack

**Data**

- Video: Big Buck Bunny 1080p30 (CC-BY 3.0, Blender Foundation), first 192 s → 48 × 4 s segments,
  6 rungs, measured average bitrates 298/737/1173/1811/2790/4192 kbps
  (`scripts/package.sh`). `scripts/verify_media.sh` checked GOP alignment on all
  288 segments (0 problems).
- Traces (`scripts/fetch_traces.sh`): 85 Norway HSDPA 3G logs (median per-trace mean
  throughput 1.15 Mbit/s) and 40 Belgium 4G/LTE logs (median 32.1 Mbit/s). One log shorter
  than 60 s was skipped. FCC: not downloadable from this machine (see TODO in §4).

---

## 1. ABR comparison: buffer-based (BBA) vs throughput baseline

> BBA-1, BOLA and a held-out split are in §7.

**Command:** `bench/abr_compare.sh` (125 traces × 5 seeded start offsets × 3 algorithms; the
simulation takes ~80 ms).

**Setup decided before running:** RTT 80 ms, max buffer 60 s, playback
starts after one segment. Throughput rule: harmonic mean of the last 5 segments × 0.9. BBA:
reservoir 10 s, cushion 40 s. BBA-guard: the same, plus a BBA-2-style startup ramp.

### Headline: BBA rebuffers *more* than the throughput baseline here.

| trace set | rebuffer ratio, throughput → BBA | rebuffer-ratio "cut" (95% CI) | rebuffers/session | avg bitrate | switches/session |
|---|---|---|---|---|---|
| all 125 traces | 7.3% → 8.4% | **−16.0%** [−23.5%, −10.4%] (i.e. +16% more) | 2.74 → 3.02 (−10.3% cut, i.e. more) | 1915 → 1824 kbps (−90) | 4.8 → 6.3 |
| Norway 3G (85) | 10.7% → 12.4% | −16.1% [−23.5%, −10.5%] | 4.02 → 4.45 | **896 → 1090 kbps (+194)** | 6.5 → 6.9 |
| Belgium 4G (40) | 0.0% → 0.0% (only 2 throughput sessions stalled) | n/a (both ≈ 0) | 0.010 → 0.000 | **4080 → 3385 kbps (−694)** | 1.4 → 5.1 |

What BBA trades:

- **On the 3G traces, BBA trades rebuffering for bitrate**, rather than the other
  way round. Once its buffer passes the cushion, BBA requests rungs up to 4.2 Mbit/s on links
  whose mean is ~1.1 Mbit/s. A 2 MB segment started just before a tunnel or handover outage then
  takes longer than the buffer that is left. The harmonic-mean rule never asks for those rungs, so
  it is not exposed.
- **On the 4G traces** capacity (~32 Mbit/s) is far above the top rung. BBA's only effect is to
  climb slowly through the cushion: −694 kbps average bitrate and 3.7 more switches per session,
  for removing a rebuffer that happened in only 2 of 40 throughput-rule traces.
- **Startup time is identical** (the first segment is always the lowest rung for all three
  algorithms, because there is no throughput sample yet). The startup guard only changes the
  ramp after the first segment. It recovers most of BBA's bitrate loss on 4G (3855 vs 3385 kbps)
  but does not change rebuffering.
- **Win/tie/loss per trace on rebuffer ratio** (BBA vs throughput): 21 / 48 / 56 overall.

Why this differs from the BBA paper's result: the paper compared against Netflix's production
rate-based algorithm of the time. Here the baseline is already conservative: a *harmonic* mean,
which is dominated by slow samples, × 0.9 safety. The sensitivity sweep below shows the cut
depends heavily on how conservative the baseline is. Removing the safety factor makes the
throughput rule 8.8% worse; a 0.7 factor makes it 12.7% better. No BBA parametrisation tried
here gets below the 0.9 baseline on the 3G traces. The Pensieve-paper BB setting (reservoir 5 s,
cushion 10 s) is the worst: 58% more rebuffering, +365 kbps.

### Sensitivity sweep (in-sample; explains the result, not a tuned headline)

**Command:** `bench/abr_sensitivity.sh` (2000 bootstrap resamples).

#### Trace set: all (n = 125)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 7.3% | — | 2.739 | — | 1915 | — | 4.8 | — | 3118 | — | — |
| throughput:safety=1 | 7.9% | -8.8% [-13.3%, -6.0%] | 3.064 | -11.9% [-18.5%, -7.8%] | 1992 | 77 [64, 91] | 5.0 | 0.2 [-0.0, 0.4] | 3118 | 0 [0, 0] | 1/53/71 |
| throughput:safety=0.7 | 6.3% | 12.7% [8.5%, 17.9%] | 2.400 | 12.4% [8.2%, 18.5%] | 1751 | -164 [-185, -141] | 4.0 | -0.8 [-1.1, -0.5] | 3118 | 0 [0, 0] | 70/55/0 |
| bba:reservoirS=5,cushionS=10 | 11.5% | -58.3% [-83.5%, -42.3%] | 5.206 | -90.1% [-134.9%, -63.2%] | 2110 | 196 [146, 243] | 14.3 | 9.5 [8.4, 10.7] | 3118 | 0 [0, 0] | 3/39/83 |
| bba:reservoirS=5,cushionS=40 | 9.4% | -29.7% [-42.5%, -21.2%] | 3.576 | -30.5% [-46.2%, -20.4%] | 1891 | -24 [-93, 42] | 6.6 | 1.8 [1.3, 2.2] | 3118 | 0 [0, 0] | 12/42/71 |
| bba:reservoirS=20,cushionS=30 | 7.7% | -5.7% [-10.4%, -1.2%] | 2.749 | -0.4% [-4.3%, 4.4%] | 1760 | -155 [-232, -80] | 6.7 | 1.8 [1.5, 2.2] | 3118 | 0 [0, 0] | 39/48/38 |
| bba-guard:reservoirS=20,cushionS=30 | 7.7% | -5.4% [-10.1%, -1.0%] | 2.755 | -0.6% [-4.5%, 3.9%] | 1937 | 22 [-9, 53] | 7.2 | 2.4 [2.0, 2.7] | 3118 | 0 [0, 0] | 41/48/36 |

#### Trace set: norway (n = 85)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 10.7% | — | 4.024 | — | 896 | — | 6.5 | — | 4399 | — | — |
| throughput:safety=1 | 11.6% | -8.8% [-13.3%, -6.0%] | 4.501 | -11.9% [-18.7%, -7.6%] | 1004 | 108 [93, 124] | 6.7 | 0.3 [-0.0, 0.6] | 4399 | 0 [0, 0] | 1/13/71 |
| throughput:safety=0.7 | 9.3% | 12.7% [8.6%, 18.0%] | 3.527 | 12.3% [8.1%, 18.7%] | 675 | -221 [-243, -200] | 4.9 | -1.5 [-1.9, -1.1] | 4399 | 0 [0, 0] | 69/16/0 |
| bba:reservoirS=5,cushionS=10 | 16.9% | -58.3% [-84.5%, -41.6%] | 7.656 | -90.3% [-136.2%, -62.2%] | 1261 | 365 [334, 395] | 19.6 | 13.1 [12.1, 14.2] | 4399 | 0 [0, 0] | 1/1/83 |
| bba:reservoirS=5,cushionS=40 | 13.9% | -29.7% [-43.1%, -21.2%] | 5.259 | -30.7% [-46.5%, -20.0%] | 1140 | 244 [227, 260] | 7.3 | 0.9 [0.3, 1.4] | 4399 | 0 [0, 0] | 10/4/71 |
| bba:reservoirS=20,cushionS=30 | 11.3% | -5.7% [-10.2%, -1.3%] | 4.042 | -0.5% [-4.3%, 4.2%] | 1034 | 138 [125, 151] | 7.6 | 1.2 [0.7, 1.7] | 4399 | 0 [0, 0] | 37/10/38 |
| bba-guard:reservoirS=20,cushionS=30 | 11.3% | -5.4% [-9.9%, -1.0%] | 4.052 | -0.7% [-4.5%, 3.9%] | 1033 | 137 [123, 150] | 8.1 | 1.6 [1.2, 2.0] | 4399 | 0 [0, 0] | 39/10/36 |


### Raw output: `bench/abr_compare.sh`

```
### ABR comparison (baseline: throughput)

- command: `npx tsx packages/abr/src/cli/compare.ts --traces data/traces/norway,data/traces/belgium --algos throughput,bba,bba-guard --baseline throughput --offsets 5 --seed 1 --out bench/out/abr`
- host: Apple M3 x8, 16 GiB, darwin 24.6.0, node v23.10.0
- video: media/hls/ladder.json (48 x 4 s segments, ladder 298/737/1173/1811/2790/4192 kbps)
- traces: 125 (norway 85, belgium 40), 5 seeded start offsets each (seed 1); rtt 80 ms, max buffer 60 s, startup after 1 segment (4 s)
- CIs: 95% paired percentile bootstrap over traces, 10000 resamples. "Cut" = 1 - mean(algo)/mean(throughput).
- simulation wall time: 77 ms

#### Trace set: all (n = 125)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 7.3% | — | 2.739 | — | 1915 | — | 4.8 | — | 3118 | — | — |
| bba | 8.4% | -16.0% [-23.5%, -10.4%] | 3.022 | -10.3% [-16.9%, -5.0%] | 1824 | -90 [-165, -18] | 6.3 | 1.4 [1.0, 1.9] | 3118 | 0 [0, 0] | 21/48/56 |
| bba-guard | 8.5% | -16.4% [-23.8%, -11.0%] | 3.035 | -10.8% [-17.5%, -5.4%] | 1973 | 59 [22, 94] | 6.5 | 1.6 [1.2, 2.1] | 3118 | 0 [0, 0] | 21/47/57 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 7.3% | 0.0% | 0.0% | 0.6% | 5.2% | 29.4% | 81.1% | 65.6% |
| bba | 8.4% | 0.0% | 0.0% | 1.3% | 8.0% | 32.6% | 81.1% | 58.4% |
| bba-guard | 8.5% | 0.0% | 0.0% | 1.5% | 8.0% | 32.6% | 81.1% | 59.2% |

#### Trace set: norway (n = 85)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 10.7% | — | 4.024 | — | 896 | — | 6.5 | — | 4399 | — | — |
| bba | 12.4% | -16.1% [-23.5%, -10.5%] | 4.445 | -10.5% [-17.2%, -5.2%] | 1090 | 194 [179, 209] | 6.9 | 0.4 [-0.1, 0.9] | 4399 | 0 [0, 0] | 19/10/56 |
| bba-guard | 12.4% | -16.5% [-23.8%, -11.1%] | 4.464 | -10.9% [-17.7%, -5.7%] | 1088 | 192 [177, 207] | 7.1 | 0.6 [0.1, 1.1] | 4399 | 0 [0, 0] | 19/9/57 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 10.7% | 0.1% | 0.6% | 2.8% | 19.3% | 32.5% | 81.1% | 94.1% |
| bba | 12.4% | 0.0% | 1.2% | 4.7% | 20.7% | 38.2% | 81.1% | 85.9% |
| bba-guard | 12.4% | 0.0% | 1.3% | 4.8% | 21.3% | 38.2% | 81.1% | 87.1% |

#### Trace set: belgium (n = 40)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 0.0% | — | 0.010 | — | 4080 | — | 1.4 | — | 397 | — | — |
| bba | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3385 | -694 [-710, -676] | 5.1 | 3.7 [3.5, 3.9] | 397 | 0 [0, 0] | 2/38/0 |
| bba-guard | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3855 | -225 [-242, -210] | 5.3 | 3.9 [3.7, 4.0] | 397 | 0 [0, 0] | 2/38/0 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.2% | 5.0% |
| bba | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba-guard | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

```

---

## 2. Sequential test validity: A/A false-positive rate under continuous monitoring

**Command:** `bench/aa_fpr.sh` (5000 A/A experiments × 20 000 observations each, per
distribution; ~22 s total).

Each experiment draws every observation from one distribution, so there is no true difference.
It assigns each observation to an arm by a fair coin and **checks after every observation**.

| distribution | mSPRT (checked after every obs) | naive Welch, every obs | naive Welch, every 100 obs | fixed-horizon Welch, one look |
|---|---|---|---|---|
| normal(1000, 300) | **2.56%** [2.16, 3.04] | 46.1% | 38.5% | 5.38% |
| lognormal(median 1500, σ 0.8) | **3.80%** [3.30, 4.37] | 44.2% | 37.4% | 5.32% |
| simulated startup times (raw, sd 8.9 s) | **0.96%** [0.72, 1.27] | 43.2% | 36.4% | 5.12% |
| simulated startup times, capped at 10 s (the production metric) | **3.58%** [3.10, 4.13] | 44.3% | 37.0% | 5.02% |

(α = 0.05, τ = 100 ms for the normal case and 250 ms otherwise, burn-in 200 per arm;
95% Wilson intervals.)

**Measured FPR of the sequential test: 0.96%–3.80%, at or below α = 5% on all four
distributions.** The upper CI bound is below 5% in every case. A fixed-horizon test peeked at
after every observation rejects a true null 43–46% of the time. Even peeking only every 100
observations gives 36–39%. That is why the dashboard cannot simply show a t-test p-value.

Arrival-order effect (from `bench/detect_offline.sh`, 2000 A/A runs, 30 min horizon):

| inclusion rule | 5 sessions/s | 20 sessions/s | 100 sessions/s |
|---|---|---|---|
| on completion (value-dependent order) | 2.75% | 3.70% | **7.00%** |
| cohort: at start + 10 s cap, start order (used by consumer) | 2.65% | 3.25% | 4.30% |

### Raw output: `bench/aa_fpr.sh`

```
$ build/release/avs_aa_fpr --experiments 5000 --max-n 20000 --dist normal:1000:300 --tau 100 --burn-in 200 --seed 1
A/A false-positive simulation
  distribution  : normal(mean=1000.000000, sd=300.000000)
  experiments   : 5000, observations per experiment: 20000 (both arms, fair coin)
  alpha         : 0.050, mSPRT tau: 100, burn-in: 200 per arm, seed: 1
  runtime       : 5.51 s

procedure                                             rejects     rate      95% Wilson CI
mSPRT, checked after every observation                    128   0.0256   [0.0216, 0.0304]
naive Welch z-test, checked after every observation      2303   0.4606   [0.4468, 0.4744]
naive Welch z-test, checked every 100 observations       1927   0.3854   [0.3720, 0.3990]
fixed-horizon Welch z-test, one look at the end           269   0.0538   [0.0479, 0.0604]

mSPRT false rejections happened at median n = 1527 (min 401, max 19479)

$ build/release/avs_aa_fpr --experiments 5000 --max-n 20000 --dist lognormal:1500:0.8 --tau 250 --burn-in 200 --seed 2
A/A false-positive simulation
  distribution  : lognormal(median=1500.000000, sigma=0.800000)
  experiments   : 5000, observations per experiment: 20000 (both arms, fair coin)
  alpha         : 0.050, mSPRT tau: 250, burn-in: 200 per arm, seed: 2
  runtime       : 6.15 s

procedure                                             rejects     rate      95% Wilson CI
mSPRT, checked after every observation                    190   0.0380   [0.0330, 0.0437]
naive Welch z-test, checked after every observation      2211   0.4422   [0.4285, 0.4560]
naive Welch z-test, checked every 100 observations       1871   0.3742   [0.3609, 0.3877]
fixed-horizon Welch z-test, one look at the end           266   0.0532   [0.0473, 0.0598]

mSPRT false rejections happened at median n = 2251 (min 402, max 19832)

$ build/release/avs_aa_fpr --experiments 5000 --max-n 20000 --dist empirical:bench/out/startup_samples.txt --tau 250 --burn-in 200 --seed 3
A/A false-positive simulation
  distribution  : empirical(bench/out/startup_samples.txt, n=20000, mean=3007.7, sd=8903.1)
  experiments   : 5000, observations per experiment: 20000 (both arms, fair coin)
  alpha         : 0.050, mSPRT tau: 250, burn-in: 200 per arm, seed: 3
  runtime       : 5.03 s

procedure                                             rejects     rate      95% Wilson CI
mSPRT, checked after every observation                     48   0.0096   [0.0072, 0.0127]
naive Welch z-test, checked after every observation      2161   0.4322   [0.4185, 0.4460]
naive Welch z-test, checked every 100 observations       1821   0.3642   [0.3510, 0.3776]
fixed-horizon Welch z-test, one look at the end           256   0.0512   [0.0454, 0.0577]

mSPRT false rejections happened at median n = 12167 (min 4500, max 19955)

$ build/release/avs_aa_fpr --experiments 5000 --max-n 20000 --dist empirical:bench/out/startup_samples.txt --cap 10000 --tau 250 --burn-in 200 --seed 4
A/A false-positive simulation
  distribution  : empirical(bench/out/startup_samples.txt, n=20000, mean=3007.7, sd=8903.1) capped at 10000.000000
  experiments   : 5000, observations per experiment: 20000 (both arms, fair coin)
  alpha         : 0.050, mSPRT tau: 250, burn-in: 200 per arm, seed: 4
  runtime       : 5.03 s

procedure                                             rejects     rate      95% Wilson CI
mSPRT, checked after every observation                    179   0.0358   [0.0310, 0.0413]
naive Welch z-test, checked after every observation      2213   0.4426   [0.4289, 0.4564]
naive Welch z-test, checked every 100 observations       1852   0.3704   [0.3571, 0.3839]
fixed-horizon Welch z-test, one look at the end           251   0.0502   [0.0445, 0.0566]

mSPRT false rejections happened at median n = 3645 (min 401, max 19870)

```

---

## 3. Time to detect a startup regression: offline (statistics only, no pipeline)

**Command:** `bench/detect_offline.sh`. Poisson session arrivals; startup times are bootstrapped from
20 000 simulated sessions (`packages/abr/src/cli/startup_samples.ts`, throughput ABR, uniform
over the 125 traces, random offsets). The treatment arm gets +effect before the 10 s cap. The test
configuration matches the consumer's: α 0.05, τ 250 ms, burn-in 200 per arm, cohort inclusion.
200 runs per cell, 1 h horizon.

Median (p90) time to detect a **+300 ms** regression:

| total traffic | median | p90 | detected within 1 h |
|---|---|---|---|
| 2 sessions/s | 1206 s (20.1 min) | 2502 s | 192/200 |
| 5 sessions/s | 521 s (8.7 min) | 1207 s | 200/200 |
| 10 sessions/s | 273 s (4.5 min) | 500 s | 200/200 |
| 20 sessions/s | 131 s (2.2 min) | 300 s | 200/200 |
| 50 sessions/s | 68 s | 125 s | 200/200 |
| 100 sessions/s | 34 s | 64 s | 200/200 |

Detection takes under 10 minutes in the median at ≥ 5 sessions/s, and at the 90th percentile at
≥ 10 sessions/s. Detection needs a roughly fixed number of sessions (median ~2400–2850 total
for +300 ms), so time scales as 1/rate. For effect size the dependence is roughly 1/effect²:
median n ≈ 5300–5700 for +200 ms, ≈ 1000–1120 for +500 ms, ≈ 430 for +1000 ms. At +1000 ms the
floor comes from the 10 s cohort delay plus burn-in. The full grid is below.

### Raw output: `bench/detect_offline.sh`

```
$ build/release/avs_detect_sim --dist empirical:bench/out/startup_samples.txt --cap 10000 --tau 250 --burn-in 200 --alpha 0.05 --inclusion cohort --rates 2,5,10,20,50,100 --effects 100,200,300,500,1000 --runs 200 --horizon-s 3600 --seed 1
Offline time-to-detect (mSPRT on mean startup time, no pipeline)
  distribution: empirical(bench/out/startup_samples.txt, n=20000, mean=3007.7, sd=8903.1), capped at 10000.000000 ms after adding the effect
  alpha 0.050, tau 250 ms, burn-in 200/arm, 200 runs per cell, horizon 3600 s, seed 1
  inclusion: cohort (session enters the test at arrival + cap, in arrival order)

    rate/s  effect_ms   detected        p10_s     median_s        p90_s       mean_s       median_n
         2        100     34/200        834.8       1974.7       3093.6       1960.6           3898
         2        200    120/200        521.5       1819.5       3109.4       1822.4           3585
         2        300    192/200        537.2       1206.3       2501.2       1382.4           2400
         2        500    200/200        268.1        515.0       1120.4        635.2           1016
         2       1000    200/200        208.9        230.2        343.8        254.0            431
         5        100     69/200        708.3       2282.4       3417.0       2143.7          11427
         5        200    191/200        457.7       1140.3       2710.5       1376.6           5674
         5        300    200/200        180.7        520.8       1206.7        624.9           2558
         5        500    200/200        106.3        225.9        460.7        258.2           1065
         5       1000    200/200         89.4         96.7        137.2        105.9            427
        10        100    144/200        363.0       1588.8       2968.6       1615.5          15752
        10        200    200/200        189.2        539.8       1262.8        649.9           5306
        10        300    200/200        117.8        272.9        499.5        298.4           2634
        10        500    200/200         58.8        114.9        235.5        133.5           1062
        10       1000    200/200         48.7         53.5         70.0         56.5            430
        20        100    193/200        266.9       1326.3       2528.6       1311.3          26218
        20        200    200/200         75.5        278.6        660.0        329.2           5378
        20        300    200/200         57.8        130.8        299.6        158.9           2393
        20        500    200/200         33.8         66.2        114.8         71.6           1115
        20       1000    200/200         29.8         31.8         40.5         33.6            427
        50        100    200/200         77.7        519.2       1167.2        592.5          25588
        50        200    200/200         44.1        118.1        270.5        138.1           5435
        50        300    200/200         32.6         67.5        125.2         72.9           2850
        50        500    200/200         20.2         30.6         49.0         33.2           1034
        50       1000    200/200         18.0         18.7         22.0         19.4            430
       100        100    200/200         56.1        227.8        560.1        287.5          21952
       100        200    200/200         26.7         62.7        127.8         73.9           5282
       100        300    200/200         18.7         34.0         63.6         38.9           2406
       100        500    200/200         14.8         20.9         32.5         22.6           1076
       100       1000    200/200         13.9         14.4         16.3         14.8            429

(effect 0 rows are A/A: 'detected' there are false positives within the horizon;
 time statistics are over detected runs only)

$ build/release/avs_detect_sim --dist empirical:bench/out/startup_samples.txt --cap 10000 --tau 250 --burn-in 200 --alpha 0.05 --inclusion cohort --rates 5,20,100 --effects 0 --runs 2000 --horizon-s 1800 --seed 2
Offline time-to-detect (mSPRT on mean startup time, no pipeline)
  distribution: empirical(bench/out/startup_samples.txt, n=20000, mean=3007.7, sd=8903.1), capped at 10000.000000 ms after adding the effect
  alpha 0.050, tau 250 ms, burn-in 200/arm, 2000 runs per cell, horizon 1800 s, seed 2
  inclusion: cohort (session enters the test at arrival + cap, in arrival order)

    rate/s  effect_ms   detected        p10_s     median_s        p90_s       mean_s       median_n
         5          0     53/2000        210.1        494.4       1508.8        663.4           2433
        20          0     65/2000         68.0        268.3        979.0        407.0           5184
       100          0     86/2000         21.3         77.2        533.3        191.2           6594

(effect 0 rows are A/A: 'detected' there are false positives within the horizon;
 time statistics are over detected runs only)

$ build/release/avs_detect_sim --dist empirical:bench/out/startup_samples.txt --cap 10000 --tau 250 --burn-in 200 --alpha 0.05 --inclusion completion --rates 5,20,100 --effects 0 --runs 2000 --horizon-s 1800 --seed 2
Offline time-to-detect (mSPRT on mean startup time, no pipeline)
  distribution: empirical(bench/out/startup_samples.txt, n=20000, mean=3007.7, sd=8903.1), capped at 10000.000000 ms after adding the effect
  alpha 0.050, tau 250 ms, burn-in 200/arm, 2000 runs per cell, horizon 1800 s, seed 2
  inclusion: completion (session enters the test when its startup completes)

    rate/s  effect_ms   detected        p10_s     median_s        p90_s       mean_s       median_n
         5          0     55/2000        159.3        494.4       1500.1        650.7           2473
        20          0     74/2000         37.1        230.8        978.3        373.7           4640
       100          0    140/2000          7.3         23.4        361.2        124.6           2176

(effect 0 rows are A/A: 'detected' there are false positives within the horizon;
 time statistics are over detected runs only)

```

---

## 4. Time to detect a startup regression: live pipeline

**Command:** `bench/detect_live.sh`, which calls `npx tsx bench/detect_live.ts` with the
arguments below. The stack is docker-compose on the M3 (Kafka 3.9.0 KRaft single broker,
6 partitions). The load generator runs on the host and POSTs to the collector. The path is
collector → Kafka → C++ consumer (librdkafka) → mSPRT.

Each run: `POST /api/reset` (new experiment epoch). The loadgen then starts Poisson sessions with
**+300 ms added to every arm-B startup from the first session**. The bench polls `/api/state`
once per second until the startup test rejects. The reported time is the consumer's own
`decided_wall_ms − epoch start`. The bench-observed time is within 1 s of it in every run.

| traffic | runs | detected | consumer decision times (s) | median | sessions in test at decision |
|---|---|---|---|---|---|
| 10 sessions/s | 3 | 3/3 | 206.7, 366.4, 368.9 | **366 s (6.1 min)** | 1872, 3660, 3689 |
| 20 sessions/s | 5 | 5/5 | 41.3, 77.8, 126.9, 167.0, 211.9 | **127 s (2.1 min)** | 586–4045 |
| 50 sessions/s | 3 | 3/3 | 39.6, 40.8, 49.0 | **41 s** | 1360–1789 |

- **Under 10 minutes in every run at ≥ 10 sessions/s.** The slowest run was 6.1 min.
- The live times agree with the offline statistics-only simulation (§3: median 273 s at 10/s,
  131 s at 20/s, 68 s at 50/s), allowing for 3–5 runs per cell. The pipeline adds a fixed
  ~12 s: the 10 s cohort delay, 2 s watermark lateness, and Kafka/poll latency of well under a
  second. At 50/s, the 1360–1789 sessions needed arrive in ~30 s, and the fixed ~12 s comes on top.
- The estimated difference at the moment of rejection is biased upward (245–791 ms for a true
  +300 ms before capping, about +280 ms after). A sequential test stops when the noise happens to
  favour rejection, which is the usual "winner's curse" of early stopping. The always-valid CI
  still covers the truth in every run (e.g. [2, 431], [10, 1485]).
- Dependence on traffic rate and effect size: detection needs a roughly fixed number of
  sessions for a given effect (about 2400–2850 median for +300 ms; ~1/effect² scaling, see the
  offline grid in §3), so time ≈ sessions ÷ rate + ~12 s.

### Raw output: `bench/detect_live.sh` (+300 ms runs)

```
run 0 seed 100: detected after 211.9 s (bench saw 212.9 s), 4045 sessions in test, diff 245 ms, CI [2, 431], 50273 events consumed
run 1 seed 101: detected after 167.0 s (bench saw 167.7 s), 3081 sessions in test, diff 306 ms, CI [17, 569], 39877 events consumed
run 2 seed 102: detected after 41.3 s (bench saw 42.2 s), 586 sessions in test, diff 791 ms, CI [10, 1485], 7662 events consumed
run 3 seed 103: detected after 126.9 s (bench saw 127.5 s), 2294 sessions in test, diff 349 ms, CI [11, 582], 29124 events consumed
run 4 seed 104: detected after 77.8 s (bench saw 78.3 s), 1296 sessions in test, diff 458 ms, CI [7, 811], 16819 events consumed
rate 20/s, +300 ms: detected 5/5; consumer decision times (s): 41.3, 77.8, 126.9, 167.0, 211.9
run 0 seed 200: detected after 368.9 s (bench saw 369.7 s), 3689 sessions in test, diff 274 ms, CI [6, 352], 46997 events consumed
run 1 seed 201: detected after 366.4 s (bench saw 366.5 s), 3660 sessions in test, diff 262 ms, CI [4, 480], 47108 events consumed
run 2 seed 202: detected after 206.7 s (bench saw 206.9 s), 1872 sessions in test, diff 387 ms, CI [2, 667], 24090 events consumed
rate 10/s, +300 ms: detected 3/3; consumer decision times (s): 206.7, 366.4, 368.9
run 0 seed 300: detected after 49.0 s (bench saw 49.2 s), 1789 sessions in test, diff 358 ms, CI [9, 669], 22244 events consumed
run 1 seed 301: detected after 39.6 s (bench saw 40.2 s), 1428 sessions in test, diff 409 ms, CI [1, 824], 18868 events consumed
run 2 seed 302: detected after 40.8 s (bench saw 41.2 s), 1360 sessions in test, diff 474 ms, CI [25, 654], 18592 events consumed
rate 50/s, +300 ms: detected 3/3; consumer decision times (s): 39.6, 40.8, 49.0
```

### A/A through the live pipeline (no injected effect)

**Command:** `caffeinate -i npx tsx bench/detect_live.ts --rate 20 --inject-ms 0 --runs 2 --timeout-s 600 --seed 400`

| traffic | runs | false positives within 10 min | events consumed per run |
|---|---|---|---|
| 20 sessions/s | 2 | **0/2** | 147 361, 150 715 |

Two runs cannot measure a 5% rate, which is what §2 and §3 are for. These runs show that the live
path does not produce spurious early rejections, as the completion-order bug did.

**Invalidated attempt (excluded, kept here for honesty):** the first A/A attempt
(`bench/detect_live.sh`, last step) overlapped the laptop's idle sleep (macOS power log: sleep at
08:58:48, wake at 09:45:52 on battery). Its run 1 consumed only 36 events and run 0 lost its last
~2 minutes. Neither reported a decision. `detect_live.ts` now flags any run whose 1 s poll loop
sees a gap > 5 s as `hostSuspended` and excludes it, and `detect_live.sh` should be run under
`caffeinate -i`. All +300 ms runs above finished by 08:50:37, before the sleep.

```
run 0 seed 400: no decision within 600 s, 147361 events consumed
run 1 seed 401: no decision within 600 s, 150715 events consumed
rate 20/s, +0 ms: detected 0/2 valid runs (2 total); consumer decision times (s):
```

---

## 5. End-to-end test (Playwright, real browser through the shaper)

**Command:** `e2e/run.sh`. Headless Google Chrome (H.264 needs proprietary codecs, which
Playwright's Chromium lacks) plays the real packaged stream from the C++ origin. Every segment
request is paced by `traces/synthetic/e2e_step.txt` (8 → 0.4 → 8 Mbit/s). The throughput ABR
and a 20 s max buffer are used. The test asserts:
- MSE supports `avc1.640028`, playback starts, more than 30 frames are decoded, and currentTime advances;
- the rung sequence goes up and later down;
- segment responses carry `X-Shaped`;
- the collector (memory sink) received `session_start`, `startup` and `bitrate_switch` events
  (up and down) for this session id and one arm.

```
rung sequence: 0555555554
telemetry: 6 events (session_start, startup, bitrate_switch, rebuffer_start, rebuffer_end)
  ✓  1 tests/stream.spec.ts:18:1 › plays through the shaper, switches rungs up and down, and records telemetry (39.1s)
  1 passed (41.4s)
```

Event counts vary between runs (6–12) because the number of switches and rebuffers depends on
real network and decode timing. The asserted properties held in all four runs during development.

---

## 6. TODO: not run here

- **FCC Measuring Broadband America traces.** `data.fcc.gov` and `www.fcc.gov` return HTTP 403
  to scripted clients from this machine (checked 2026-10-20 with curl and a fetch tool). To add
  them, download a raw-data archive in a browser from
  https://www.fcc.gov/reports-research/reports/measuring-broadband-america/ (e.g. the
  `curr_webget` table of a monthly archive), convert each unit's per-test throughput series to
  `<time_s> <mbps>` lines in `data/traces/fcc/<name>.txt`, then run:
  `npx tsx packages/abr/src/cli/compare.ts --traces data/traces/norway,data/traces/belgium,data/traces/fcc --out bench/out/abr_fcc`
- **Live detection at more rates and effect sizes.** Only +300 ms at 10, 20 and 50 sessions/s was
  run live (3–5 runs each). The offline grid in §3 covers 2–100 sessions/s × 100–1000 ms. To extend:
  `caffeinate -i npx tsx bench/detect_live.ts --rate 5 --inject-ms 300 --runs 5 --timeout-s 1800`

---

## 7. BBA-1, BOLA-BASIC and BOLA-E

**Provenance.** §1's numbers are left exactly as they were. After the new optional context fields
were added, `bench/abr_compare.sh` was rerun, and the throughput/BBA-0/BBA-guard rows were
byte-identical to §1 (diff of `summary.md`, excluding the wall-time line). The defaults, grid,
split and selection rule were committed before any new algorithm touched a trace. The
extended-grid deviation was committed after the train selection and before any test number was
viewed. **Every number in this section was produced** by `bench/abr_followup.sh`. A rerun was
diffed against the first run and was identical apart from wall time.

**Command:** `bench/abr_followup.sh`, which runs `abr_compare.sh`, `abr_sensitivity.sh`,
`abr_heldout.sh` and `abr_heldout_seeds.sh`. The settings are unchanged from §1: RTT 80 ms, max
buffer 60 s, playback after 1 segment, 5 seeded offsets (seed 1), and 10 000 bootstrap resamples.
Host as above.

**Algorithms.** Formulas, constants and references are in the source (`packages/abr/src/abr/`).
- `bba1`: BBA-1 with the VBR chunk map and the dynamic reservoir (X = 120 s, clamp [8, 35] s, map
  top at 54 s).
- `bola`: BOLA-BASIC, with V and γp solved from Q_low = 10 s and Q_max = 56 s.
- `bola-e`: dash.js-style BOLA with a throughput startup, the placeholder buffer, the BOLA-O
  up-switch cap and a placeholder reset on rebuffer.

### Headline: the best held-out result is +8.4% [4.1%, 14.4%], and it costs bitrate.

**Held-out test set** (63 traces: Norway 43, Belgium 20; split seed 1). The parameters were picked on
the 62 train traces by the pre-registered rule: train avg bitrate ≥ 0.95 × throughput's, then the
maximum rebuffer cut.

| algorithm (test set, n = 63) | params | rebuffer-ratio cut vs throughput (95% CI) | Δ avg kbps | Δ switches/session | W/T/L |
|---|---|---|---|---|---|
| throughput (baseline) | HM5 × 0.9 | — (8.2% ratio, 1921 kbps) | — | — (4.8) | — |
| BBA-0 (for reference) | r 10, c 40 | −8.8% [−16.9%, −3.4%] | −87 [−194, 15] | +1.4 | 9/26/28 |
| BBA-1, paper defaults | r ∈ [8, 35], map top 54 s | −11.8% [−21.4%, −5.7%] | −21 [−122, 73] | +2.7 | 7/26/30 |
| BBA-1, tuned on train | r_lo 24, map top 40 s | +3.0% [−1.5%, 8.9%] | −79 [−180, 16] | +4.6 | 23/27/13 |
| BOLA-BASIC, paper defaults | Q_low 10 | −10.5% [−18.4%, −5.6%] | −54 [−149, 35] | +4.3 | 7/26/30 |
| BOLA-BASIC, tuned on train | Q_low 10 (= default) | −10.5% [−18.4%, −5.6%] | −54 [−149, 35] | +4.3 | 7/26/30 |
| BOLA-E, defaults | Q_low 10 | −4.8% [−9.9%, −2.0%] | +81 [61, 102] | −1.7 | 10/30/23 |
| BOLA-E, tuned on train | Q_low 30 | **+3.4% [0.3%, 7.7%]** | +29 [12, 46] | −1.6 | 20/32/11 |
| *extended grid (deviation)* BBA-1 | r_lo 28, map top 36 s | +4.5% [−0.0%, 11.3%] | −85 [−184, 8] | +6.5 | 27/27/9 |
| *extended grid (deviation)* BOLA-E | Q_low 50 | **+8.4% [4.1%, 14.4%]** | −61 [−79, −44] | −1.2 | 28/34/1 |

**Per dataset (test set).**

| algorithm | Norway 3G (n = 43): cut (CI) | Norway Δ kbps | Belgium 4G (n = 20): cut | Belgium Δ kbps |
|---|---|---|---|---|
| throughput | — (11.9%, 913 kbps) | — | — (0.0%, 4089 kbps) | — |
| BBA-0 | −8.8% [−16.6%, −3.4%] | +199 | undefined (no stalls by anyone) | −702 |
| BBA-1 defaults | −11.8% [−21.1%, −5.8%] | +246 | undefined | −594 |
| BBA-1 tuned (24/40) | +3.0% [−1.6%, 9.0%] | +188 | undefined | −654 |
| BOLA-BASIC (default = tuned) | −10.5% [−18.2%, −5.6%] | +197 | undefined | −594 |
| BOLA-E defaults | −4.8% [−9.8%, −2.1%] | +117 | undefined | +2 |
| BOLA-E tuned (Q_low 30) | +3.4% [0.4%, 7.7%] | +45 [25, 68] | undefined | −8 [−28, 6] |
| BOLA-E ext. (Q_low 50) | +8.4% [4.2%, 14.5%] | −79 [−100, −60] | undefined | −23 [−56, −3] |

On the Belgium test half no algorithm stalls, the throughput rule included. Its two stalling
traces from §1 both landed in train, so the cut there is 0/0 and the raw output prints `NaN`. The
Belgium column is therefore only about bitrate.

**Robustness to the split** (`bench/abr_heldout_seeds.sh`). The whole pipeline (grid on train,
selection, test) was rerun for split seeds 2–5. Seed 1 is the pre-registered headline and turns out
to be one of the more favourable splits.

| tuned algorithm (all test traces) | seed 1 | seed 2 | seed 3 | seed 4 | seed 5 |
|---|---|---|---|---|---|
| BBA-1 (picked 24/40 every time) | +3.0% [−1.5, 8.9] | −3.2% [−10.9, 3.7] | −3.6% [−9.7, 3.7] | −2.6% [−9.2, 3.7] | −1.0% [−5.6, 3.7] |
| BOLA-BASIC (Q_low 10 or 15) | −10.5% | −7.4% | −15.0% | −14.0% | −3.8% |
| BOLA-E (picked Q_low 30 every time) | +3.4% [0.3, 7.7] | −0.6% [−7.1, 4.4] | +3.4% [−2.1, 8.3] | +0.7% [−4.6, 5.3] | −0.6% [−5.4, 2.9] |
| ext. BBA-1 (28/36 every time) | +4.5% [−0.0, 11.3] | −1.8% | −1.5% | −0.9% | −0.2% |
| ext. BOLA-E (Q_low 50 every time) | +8.4% [4.1, 14.4], −61 kbps | +7.8% [3.3, 13.7], −70 | +7.9% [3.9, 13.0], −64 | +5.6% [2.2, 10.9], −56 | +5.5% [2.4, 10.1], −56 |

What this shows:

- **The largest held-out cut is BOLA-E at Q_low 50: +8.4%**, CI upper bound 14.4%. It comes from the extended (deviation) grid, and it is the only result whose CI
  excludes zero on every split. The best pre-registered result is BOLA-E at Q_low 30: +3.4%
  [0.3%, 7.7%] on seed 1, but on seeds 2–5 its CI includes zero every time. I would not call it a
  real win.
- **With the papers' defaults, all three new algorithms rebuffer more than the throughput rule**:
  - full 125 traces: BBA-1 −17.2%, BOLA −15.1%, BOLA-E −8.4% (raw output below);
  - held-out: BBA-1 −11.8%, BOLA −10.5%, BOLA-E −4.8%.

  Like BBA-0, BBA-1 and BOLA turn the 3G links' spare capacity into bitrate (+200–250 kbps) at the
  cost of more stalls.
- **3G vs 4G.**
  - Everything that reduces stalls does so on Norway 3G; Belgium 4G has nothing to remove.
  - On 4G, BBA-0, BBA-1 and BOLA-BASIC lose 594–702 kbps (they climb slowly through the
    cushion), as §1 found for BBA-0.
  - BOLA-E ties the throughput rule on 4G (+2 kbps with defaults, −8 tuned, −23 at Q_low 50),
    because its startup and its BOLA-O cap use the throughput estimate.
  - Its 3G gain at Q_low 50 is a **trade**: 8.4% fewer stalls for 79 kbps (−8.7%) less bitrate on
    3G. At Q_low 30 it is a small Pareto gain on seed 1 (+3.4% and +45 kbps), but that does not
    survive other splits.
- **Why BBA-1 does not help.**
  - The paper's dynamic reservoir assumes capacity = R_min. On this content the 120 s sum of
    (Chunk[0][k]/R_min − V) ranges from −2.7 s to +4.9 s, so the reservoir is clamped to 8 s on
    every decision. BBA-1 is effectively a chunk-aware BBA with an 8 s reservoir, which is more
    aggressive than BBA-0's 10 s.
  - Ablations (in-sample): ignoring the real sizes (`bba1:nominalSizes=1`) gives −18.2% vs
    −17.2%, so VBR awareness changes rebuffering by about 1 point. It buys +75 kbps (1813 → 1888)
    and costs 1.7 more switches.
  - An estimated-capacity reservoir (`bba1:useEstimate=1`) gives −17.4%. It barely moves,
    because the clamp at 35 s and the R_min floor dominate.
  - Tuned on train, BBA-1 wants the largest reservoir allowed and the shortest cushion, which
    pushes it towards "R_min until 24–28 s, then jump". It still doesn't separate from zero on
    held-out traces.
- **Why BOLA-BASIC does not help.** With Q_low = 10 s, the derived V = 14.1 s and γp = 1.32 put
  the top rung at a buffer of only 38.8 s, which is more aggressive than BBA-0 (top at 50 s). The
  paper's §IV-B form with γp = 5 (in-sample: +2.4% [−1.2%, 6.9%]) holds R_min up to 32 s. It
  trades 224 kbps for that and makes 10.6 switches per session.
- **What actually helps is the hybrid.** BOLA-E's gains come from adding a throughput cap
  (BOLA-O) to a conservative buffer map (high Q_low). It is no longer a purely buffer-based
  algorithm. This matches the BBA paper's own observation that capacity estimation still matters
  outside steady state. It also matches §1's finding that the throughput rule's safety factor is
  the most powerful lever here: in-sample, `throughput:safety=0.7` cuts 12.7% for −164 kbps.
- **The bias in the comparison favours the challengers**, and they still mostly lose. Only the new
  algorithms were tuned; the throughput rule kept its untuned 0.9.

**In the browser** (`e2e/run.sh`, at the commit that adds the player wiring; the
bench output was rediffed and is identical): `bba1` and `bola-e` play through the shaper in
headless Chrome. `bba1` fetched the `ladder.json` sidecar once. Rung sequences, with a 20 s
buffer cap on the step trace: bba1 `00000`, bola-e `055`. The original throughput test still
passes (`0555555554`).

### Raw output: held-out test set (pre-registered picks), `bench/abr_heldout.sh`

```
### ABR comparison (baseline: throughput)

- command: `npx tsx packages/abr/src/cli/compare.ts --traces data/traces/norway,data/traces/belgium --baseline throughput --offsets 5 --seed 1 --split-seed 1 --subset test --algos throughput;bba;bba1;bola;bola-e;bba1:reservoirMinS=24,cushionEndS=40;bola:qLowS=10;bola-e:qLowS=30 --out bench/out/abr_heldout/test`
- host: Apple M3 x8, 16 GiB, darwin 24.6.0, node v23.10.0
- video: media/hls/ladder.json (48 x 4 s segments, ladder 298/737/1173/1811/2790/4192 kbps)
- traces: 63 (norway 43, belgium 20), 5 seeded start offsets each (seed 1); rtt 80 ms, max buffer 60 s, startup after 1 segment (4 s)
- subset: **test** half of the stratified by-trace split (split seed 1)
- CIs: 95% paired percentile bootstrap over traces, 10000 resamples. "Cut" = 1 - mean(algo)/mean(throughput).
- simulation wall time: 72 ms

#### Trace set: all (n = 63)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 8.2% | — | 2.883 | — | 1921 | — | 4.8 | — | 3549 | — | — |
| bba | 8.9% | -8.8% [-16.9%, -3.4%] | 3.060 | -6.2% [-14.1%, -0.9%] | 1834 | -87 [-194, 15] | 6.2 | 1.4 [0.8, 2.0] | 3549 | 0 [0, 0] | 9/26/28 |
| bba1 | 9.1% | -11.8% [-21.4%, -5.7%] | 3.184 | -10.5% [-21.4%, -3.7%] | 1900 | -21 [-122, 73] | 7.5 | 2.7 [2.1, 3.2] | 3549 | 0 [0, 0] | 7/26/30 |
| bola | 9.0% | -10.5% [-18.4%, -5.6%] | 3.143 | -9.0% [-18.9%, -3.1%] | 1867 | -54 [-149, 35] | 9.2 | 4.3 [3.8, 4.9] | 3549 | 0 [0, 0] | 7/26/30 |
| bola-e | 8.5% | -4.8% [-9.9%, -2.0%] | 3.003 | -4.2% [-10.0%, -1.2%] | 2002 | 81 [61, 102] | 3.1 | -1.7 [-2.1, -1.3] | 3549 | 0 [0, 0] | 10/30/23 |
| bba1:reservoirMinS=24,cushionEndS=40 | 7.9% | 3.0% [-1.5%, 8.9%] | 2.737 | 5.1% [-0.3%, 13.7%] | 1842 | -79 [-180, 16] | 9.4 | 4.6 [3.9, 5.3] | 3549 | 0 [0, 0] | 23/27/13 |
| bola:qLowS=10 | 9.0% | -10.5% [-18.4%, -5.6%] | 3.143 | -9.0% [-18.9%, -3.1%] | 1867 | -54 [-149, 35] | 9.2 | 4.3 [3.8, 4.9] | 3549 | 0 [0, 0] | 7/26/30 |
| bola-e:qLowS=30 | 7.9% | 3.4% [0.3%, 7.7%] | 2.797 | 3.0% [0.6%, 6.8%] | 1950 | 29 [12, 46] | 3.2 | -1.6 [-2.0, -1.2] | 3549 | 0 [0, 0] | 20/32/11 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 8.2% | 0.0% | 0.0% | 0.6% | 7.3% | 26.6% | 81.1% | 66.7% |
| bba | 8.9% | 0.0% | 0.0% | 1.5% | 8.8% | 28.3% | 81.1% | 60.3% |
| bba1 | 9.1% | 0.0% | 0.0% | 1.8% | 10.3% | 28.4% | 81.1% | 61.9% |
| bola | 9.0% | 0.0% | 0.0% | 1.5% | 9.5% | 28.2% | 81.1% | 60.3% |
| bola-e | 8.5% | 0.0% | 0.0% | 1.7% | 7.6% | 28.1% | 81.1% | 66.7% |
| bba1:reservoirMinS=24,cushionEndS=40 | 7.9% | 0.0% | 0.0% | 0.5% | 6.3% | 26.6% | 81.1% | 58.7% |
| bola:qLowS=10 | 9.0% | 0.0% | 0.0% | 1.5% | 9.5% | 28.2% | 81.1% | 60.3% |
| bola-e:qLowS=30 | 7.9% | 0.0% | 0.0% | 0.5% | 6.1% | 26.8% | 81.1% | 66.7% |

#### Trace set: norway (n = 43)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 11.9% | — | 4.223 | — | 913 | — | 6.5 | — | 5026 | — | — |
| bba | 13.0% | -8.8% [-16.6%, -3.4%] | 4.484 | -6.2% [-14.2%, -0.9%] | 1112 | 199 [173, 223] | 6.8 | 0.3 [-0.4, 1.0] | 5026 | 0 [0, 0] | 9/6/28 |
| bba1 | 13.4% | -11.8% [-21.1%, -5.8%] | 4.665 | -10.5% [-21.5%, -3.9%] | 1158 | 246 [219, 269] | 9.4 | 2.9 [2.2, 3.7] | 5026 | 0 [0, 0] | 7/6/30 |
| bola | 13.2% | -10.5% [-18.2%, -5.6%] | 4.605 | -9.0% [-19.1%, -3.3%] | 1110 | 197 [175, 217] | 11.0 | 4.6 [3.8, 5.3] | 5026 | 0 [0, 0] | 7/6/30 |
| bola-e | 12.5% | -4.8% [-9.8%, -2.1%] | 4.400 | -4.2% [-10.0%, -1.2%] | 1030 | 117 [96, 141] | 4.0 | -2.5 [-2.9, -2.1] | 5026 | 0 [0, 0] | 10/10/23 |
| bba1:reservoirMinS=24,cushionEndS=40 | 11.6% | 3.0% [-1.6%, 9.0%] | 4.009 | 5.1% [-0.3%, 13.9%] | 1101 | 188 [164, 211] | 12.2 | 5.7 [4.8, 6.6] | 5026 | 0 [0, 0] | 23/7/13 |
| bola:qLowS=10 | 13.2% | -10.5% [-18.2%, -5.6%] | 4.605 | -9.0% [-19.1%, -3.3%] | 1110 | 197 [175, 217] | 11.0 | 4.6 [3.8, 5.3] | 5026 | 0 [0, 0] | 7/6/30 |
| bola-e:qLowS=30 | 11.5% | 3.4% [0.4%, 7.7%] | 4.098 | 3.0% [0.6%, 6.7%] | 958 | 45 [25, 68] | 4.1 | -2.3 [-2.8, -1.9] | 5026 | 0 [0, 0] | 20/12/11 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 11.9% | 0.2% | 0.6% | 2.7% | 20.2% | 36.7% | 81.1% | 97.7% |
| bba | 13.0% | 0.1% | 1.4% | 4.6% | 21.0% | 37.8% | 81.1% | 88.4% |
| bba1 | 13.4% | 0.2% | 1.7% | 4.8% | 21.4% | 38.7% | 81.1% | 90.7% |
| bola | 13.2% | 0.2% | 1.5% | 5.0% | 21.3% | 38.4% | 81.1% | 88.4% |
| bola-e | 12.5% | 0.4% | 1.7% | 3.5% | 21.3% | 36.7% | 81.1% | 97.7% |
| bba1:reservoirMinS=24,cushionEndS=40 | 11.6% | 0.0% | 0.5% | 2.6% | 20.6% | 32.9% | 81.1% | 86.0% |
| bola:qLowS=10 | 13.2% | 0.2% | 1.5% | 5.0% | 21.3% | 38.4% | 81.1% | 88.4% |
| bola-e:qLowS=30 | 11.5% | 0.1% | 0.5% | 2.7% | 20.1% | 33.1% | 81.1% | 97.7% |

#### Trace set: belgium (n = 20)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 0.0% | — | 0.000 | — | 4089 | — | 1.3 | — | 375 | — | — |
| bba | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 3387 | -702 [-722, -684] | 5.1 | 3.8 [3.6, 4.1] | 375 | 0 [0, 0] | 0/20/0 |
| bba1 | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 3495 | -594 [-619, -571] | 3.4 | 2.1 [1.9, 2.3] | 375 | 0 [0, 0] | 0/20/0 |
| bola | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 3495 | -594 [-610, -578] | 5.1 | 3.8 [3.6, 4.1] | 375 | 0 [0, 0] | 0/20/0 |
| bola-e | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 4091 | 2 [-14, 19] | 1.2 | -0.1 [-0.3, 0.1] | 375 | 0 [0, 0] | 0/20/0 |
| bba1:reservoirMinS=24,cushionEndS=40 | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 3435 | -654 [-671, -636] | 3.5 | 2.1 [2.0, 2.3] | 375 | 0 [0, 0] | 0/20/0 |
| bola:qLowS=10 | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 3495 | -594 [-610, -578] | 5.1 | 3.8 [3.6, 4.1] | 375 | 0 [0, 0] | 0/20/0 |
| bola-e:qLowS=30 | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 4081 | -8 [-28, 6] | 1.3 | -0.0 [-0.1, 0.1] | 375 | 0 [0, 0] | 0/20/0 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba1 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola-e | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba1:reservoirMinS=24,cushionEndS=40 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola:qLowS=10 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola-e:qLowS=30 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
```

### Raw output: train-set selection (pre-registered grid)

```
### Parameter selection on the training traces

- rule: avg bitrate >= 0.95 x throughput (1908 kbps -> floor 1813 kbps); then max rebuffer cut, ties -> fewer switches

#### bba1: chose `bba1:reservoirMinS=24,cushionEndS=40`

| spec | rebuffer cut (train) | avg kbps | switches | feasible |
|---|---|---|---|---|
| bba1:reservoirMinS=8,cushionEndS=40 | -31.5% | 1926 | 9.1 | yes |
| bba1:reservoirMinS=8,cushionEndS=47 | -29.4% | 1905 | 8.3 | yes |
| bba1:reservoirMinS=8,cushionEndS=54 | -24.3% | 1875 | 7.9 | yes |
| bba1:reservoirMinS=12,cushionEndS=40 | -23.3% | 1904 | 8.5 | yes |
| bba1:reservoirMinS=12,cushionEndS=47 | -20.5% | 1881 | 7.6 | yes |
| bba1:reservoirMinS=12,cushionEndS=54 | -20.1% | 1826 | 7.5 | yes |
| bba1:reservoirMinS=16,cushionEndS=40 | -18.7% | 1879 | 9.2 | yes |
| bba1:reservoirMinS=16,cushionEndS=47 | -16.5% | 1850 | 8.5 | yes |
| bba1:reservoirMinS=16,cushionEndS=54 | -15.5% | 1790 | 8.1 | no |
| bba1:reservoirMinS=20,cushionEndS=40 | -14.2% | 1849 | 9.5 | yes |
| bba1:reservoirMinS=20,cushionEndS=47 | -13.5% | 1816 | 8.5 | yes |
| bba1:reservoirMinS=20,cushionEndS=54 | -13.2% | 1762 | 8.2 | no |
| bba1:reservoirMinS=24,cushionEndS=40 | -11.3% | 1819 | 9.6 | yes |
| bba1:reservoirMinS=24,cushionEndS=47 | -11.3% | 1776 | 8.8 | no |
| bba1:reservoirMinS=24,cushionEndS=54 | -9.7% | 1735 | 8.0 | no |

#### bola: chose `bola:qLowS=10`

| spec | rebuffer cut (train) | avg kbps | switches | feasible |
|---|---|---|---|---|
| bola:qLowS=5 | -40.9% | 1883 | 10.2 | yes |
| bola:qLowS=10 | -21.1% | 1840 | 9.6 | yes |
| bola:qLowS=15 | -15.0% | 1807 | 9.6 | no |
| bola:qLowS=20 | -10.8% | 1766 | 9.9 | no |
| bola:qLowS=25 | -8.3% | 1735 | 9.9 | no |
| bola:qLowS=30 | -3.9% | 1696 | 10.4 | no |

#### bola-e: chose `bola-e:qLowS=30`

| spec | rebuffer cut (train) | avg kbps | switches | feasible |
|---|---|---|---|---|
| bola-e:qLowS=5 | -17.5% | 1988 | 3.1 | yes |
| bola-e:qLowS=10 | -13.0% | 1980 | 3.1 | yes |
| bola-e:qLowS=15 | -10.6% | 1972 | 3.1 | yes |
| bola-e:qLowS=20 | -9.1% | 1960 | 3.2 | yes |
| bola-e:qLowS=25 | -4.7% | 1948 | 3.2 | yes |
| bola-e:qLowS=30 | -2.8% | 1937 | 3.3 | yes |
```

### Raw output: train-set selection (extended grid, deviation)

```
### Parameter selection on the training traces

- rule: avg bitrate >= 0.95 x throughput (1908 kbps -> floor 1813 kbps); then max rebuffer cut, ties -> fewer switches

#### bba1: chose `bba1:reservoirMinS=28,cushionEndS=36`

| spec | rebuffer cut (train) | avg kbps | switches | feasible |
|---|---|---|---|---|
| bba1:reservoirMinS=24,cushionEndS=36 | -11.4% | 1839 | 10.9 | yes |
| bba1:reservoirMinS=24,cushionEndS=40 | -11.3% | 1819 | 9.6 | yes |
| bba1:reservoirMinS=24,cushionEndS=44 | -11.8% | 1808 | 8.9 | no |
| bba1:reservoirMinS=28,cushionEndS=36 | -9.8% | 1818 | 11.7 | yes |
| bba1:reservoirMinS=28,cushionEndS=40 | -7.2% | 1800 | 9.9 | no |
| bba1:reservoirMinS=28,cushionEndS=44 | -6.4% | 1784 | 9.0 | no |
| bba1:reservoirMinS=32,cushionEndS=36 | -8.4% | 1797 | 13.9 | no |
| bba1:reservoirMinS=32,cushionEndS=40 | -5.0% | 1775 | 10.8 | no |
| bba1:reservoirMinS=32,cushionEndS=44 | -3.8% | 1754 | 9.4 | no |

#### bola-e: chose `bola-e:qLowS=50`

| spec | rebuffer cut (train) | avg kbps | switches | feasible |
|---|---|---|---|---|
| bola-e:qLowS=30 | -2.8% | 1937 | 3.3 | yes |
| bola-e:qLowS=35 | -0.4% | 1921 | 3.3 | yes |
| bola-e:qLowS=40 | 1.0% | 1904 | 3.5 | yes |
| bola-e:qLowS=45 | 3.6% | 1879 | 3.7 | yes |
| bola-e:qLowS=50 | 5.6% | 1849 | 4.2 | yes |
```

### Raw output: held-out test set (extended picks)

```
### ABR comparison (baseline: throughput)

- command: `npx tsx packages/abr/src/cli/compare.ts --traces data/traces/norway,data/traces/belgium --baseline throughput --offsets 5 --seed 1 --split-seed 1 --subset test --algos throughput;bba1:reservoirMinS=24,cushionEndS=40;bola:qLowS=10;bola-e:qLowS=30;bba1:reservoirMinS=28,cushionEndS=36;bola-e:qLowS=50 --out bench/out/abr_heldout/test_ext`
- host: Apple M3 x8, 16 GiB, darwin 24.6.0, node v23.10.0
- video: media/hls/ladder.json (48 x 4 s segments, ladder 298/737/1173/1811/2790/4192 kbps)
- traces: 63 (norway 43, belgium 20), 5 seeded start offsets each (seed 1); rtt 80 ms, max buffer 60 s, startup after 1 segment (4 s)
- subset: **test** half of the stratified by-trace split (split seed 1)
- CIs: 95% paired percentile bootstrap over traces, 10000 resamples. "Cut" = 1 - mean(algo)/mean(throughput).
- simulation wall time: 62 ms

#### Trace set: all (n = 63)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 8.2% | — | 2.883 | — | 1921 | — | 4.8 | — | 3549 | — | — |
| bba1:reservoirMinS=24,cushionEndS=40 | 7.9% | 3.0% [-1.5%, 8.9%] | 2.737 | 5.1% [-0.3%, 13.7%] | 1842 | -79 [-180, 16] | 9.4 | 4.6 [3.9, 5.3] | 3549 | 0 [0, 0] | 23/27/13 |
| bola:qLowS=10 | 9.0% | -10.5% [-18.4%, -5.6%] | 3.143 | -9.0% [-18.9%, -3.1%] | 1867 | -54 [-149, 35] | 9.2 | 4.3 [3.8, 4.9] | 3549 | 0 [0, 0] | 7/26/30 |
| bola-e:qLowS=30 | 7.9% | 3.4% [0.3%, 7.7%] | 2.797 | 3.0% [0.6%, 6.8%] | 1950 | 29 [12, 46] | 3.2 | -1.6 [-2.0, -1.2] | 3549 | 0 [0, 0] | 20/32/11 |
| bba1:reservoirMinS=28,cushionEndS=36 | 7.8% | 4.5% [-0.0%, 11.3%] | 2.724 | 5.5% [0.5%, 14.2%] | 1836 | -85 [-184, 8] | 11.3 | 6.5 [5.3, 7.7] | 3549 | 0 [0, 0] | 27/27/9 |
| bola-e:qLowS=50 | 7.5% | 8.4% [4.1%, 14.4%] | 2.673 | 7.3% [3.5%, 14.1%] | 1860 | -61 [-79, -44] | 3.7 | -1.2 [-1.5, -0.8] | 3549 | 0 [0, 0] | 28/34/1 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 8.2% | 0.0% | 0.0% | 0.6% | 7.3% | 26.6% | 81.1% | 66.7% |
| bba1:reservoirMinS=24,cushionEndS=40 | 7.9% | 0.0% | 0.0% | 0.5% | 6.3% | 26.6% | 81.1% | 58.7% |
| bola:qLowS=10 | 9.0% | 0.0% | 0.0% | 1.5% | 9.5% | 28.2% | 81.1% | 60.3% |
| bola-e:qLowS=30 | 7.9% | 0.0% | 0.0% | 0.5% | 6.1% | 26.8% | 81.1% | 66.7% |
| bba1:reservoirMinS=28,cushionEndS=36 | 7.8% | 0.0% | 0.0% | 0.3% | 5.6% | 26.5% | 81.1% | 55.6% |
| bola-e:qLowS=50 | 7.5% | 0.0% | 0.0% | 0.2% | 6.0% | 25.1% | 81.1% | 66.7% |

#### Trace set: norway (n = 43)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 11.9% | — | 4.223 | — | 913 | — | 6.5 | — | 5026 | — | — |
| bba1:reservoirMinS=24,cushionEndS=40 | 11.6% | 3.0% [-1.6%, 9.0%] | 4.009 | 5.1% [-0.3%, 13.9%] | 1101 | 188 [164, 211] | 12.2 | 5.7 [4.8, 6.6] | 5026 | 0 [0, 0] | 23/7/13 |
| bola:qLowS=10 | 13.2% | -10.5% [-18.2%, -5.6%] | 4.605 | -9.0% [-19.1%, -3.3%] | 1110 | 197 [175, 217] | 11.0 | 4.6 [3.8, 5.3] | 5026 | 0 [0, 0] | 7/6/30 |
| bola-e:qLowS=30 | 11.5% | 3.4% [0.4%, 7.7%] | 4.098 | 3.0% [0.6%, 6.7%] | 958 | 45 [25, 68] | 4.1 | -2.3 [-2.8, -1.9] | 5026 | 0 [0, 0] | 20/12/11 |
| bba1:reservoirMinS=28,cushionEndS=36 | 11.4% | 4.5% [-0.1%, 11.3%] | 3.991 | 5.5% [0.5%, 14.4%] | 1091 | 178 [153, 203] | 15.1 | 8.7 [7.4, 9.9] | 5026 | 0 [0, 0] | 27/7/9 |
| bola-e:qLowS=50 | 11.0% | 8.4% [4.2%, 14.5%] | 3.916 | 7.3% [3.6%, 14.1%] | 834 | -79 [-100, -60] | 4.7 | -1.8 [-2.1, -1.5] | 5026 | 0 [0, 0] | 28/14/1 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 11.9% | 0.2% | 0.6% | 2.7% | 20.2% | 36.7% | 81.1% | 97.7% |
| bba1:reservoirMinS=24,cushionEndS=40 | 11.6% | 0.0% | 0.5% | 2.6% | 20.6% | 32.9% | 81.1% | 86.0% |
| bola:qLowS=10 | 13.2% | 0.2% | 1.5% | 5.0% | 21.3% | 38.4% | 81.1% | 88.4% |
| bola-e:qLowS=30 | 11.5% | 0.1% | 0.5% | 2.7% | 20.1% | 33.1% | 81.1% | 97.7% |
| bba1:reservoirMinS=28,cushionEndS=36 | 11.4% | 0.0% | 0.3% | 2.3% | 20.7% | 32.9% | 81.1% | 81.4% |
| bola-e:qLowS=50 | 11.0% | 0.0% | 0.2% | 2.3% | 18.4% | 32.7% | 81.1% | 97.7% |

#### Trace set: belgium (n = 20)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 0.0% | — | 0.000 | — | 4089 | — | 1.3 | — | 375 | — | — |
| bba1:reservoirMinS=24,cushionEndS=40 | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 3435 | -654 [-671, -636] | 3.5 | 2.1 [2.0, 2.3] | 375 | 0 [0, 0] | 0/20/0 |
| bola:qLowS=10 | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 3495 | -594 [-610, -578] | 5.1 | 3.8 [3.6, 4.1] | 375 | 0 [0, 0] | 0/20/0 |
| bola-e:qLowS=30 | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 4081 | -8 [-28, 6] | 1.3 | -0.0 [-0.1, 0.1] | 375 | 0 [0, 0] | 0/20/0 |
| bba1:reservoirMinS=28,cushionEndS=36 | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 3438 | -651 [-669, -634] | 3.1 | 1.8 [1.6, 1.9] | 375 | 0 [0, 0] | 0/20/0 |
| bola-e:qLowS=50 | 0.0% | NaN% [NaN%, NaN%] | 0.000 | NaN% [NaN%, NaN%] | 4066 | -23 [-56, -3] | 1.5 | 0.2 [0.0, 0.3] | 375 | 0 [0, 0] | 0/20/0 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba1:reservoirMinS=24,cushionEndS=40 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola:qLowS=10 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola-e:qLowS=30 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba1:reservoirMinS=28,cushionEndS=36 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola-e:qLowS=50 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
```

### Raw output: split-seed robustness, `bench/abr_heldout_seeds.sh`

```
| split seed | trace set | algo (tuned on train) | rebuffer cut vs throughput | Δ kbps | Δ switches |
|---|---|---|---|---|---|
| 1 | all | bba1:reservoirMinS=24,cushionEndS=40 | 3.0% [-1.5%, 8.9%] | -79 [-180, 16] | 4.6 [3.9, 5.3] |
| 1 | all | bola:qLowS=10 | -10.5% [-18.4%, -5.6%] | -54 [-149, 35] | 4.3 [3.8, 4.9] |
| 1 | all | bola-e:qLowS=30 | 3.4% [0.3%, 7.7%] | 29 [12, 46] | -1.6 [-2.0, -1.2] |
| 1 | norway | bba1:reservoirMinS=24,cushionEndS=40 | 3.0% [-1.6%, 9.0%] | 188 [164, 211] | 5.7 [4.8, 6.6] |
| 1 | norway | bola:qLowS=10 | -10.5% [-18.2%, -5.6%] | 197 [175, 217] | 4.6 [3.8, 5.3] |
| 1 | norway | bola-e:qLowS=30 | 3.4% [0.4%, 7.7%] | 45 [25, 68] | -2.3 [-2.8, -1.9] |
| 1 (ext) | all | bba1:reservoirMinS=28,cushionEndS=36 | 4.5% [-0.0%, 11.3%] | -85 [-184, 8] | 6.5 [5.3, 7.7] |
| 1 (ext) | all | bola-e:qLowS=50 | 8.4% [4.1%, 14.4%] | -61 [-79, -44] | -1.2 [-1.5, -0.8] |
| 1 (ext) | norway | bba1:reservoirMinS=28,cushionEndS=36 | 4.5% [-0.1%, 11.3%] | 178 [153, 203] | 8.7 [7.4, 9.9] |
| 1 (ext) | norway | bola-e:qLowS=50 | 8.4% [4.2%, 14.5%] | -79 [-100, -60] | -1.8 [-2.1, -1.5] |
| 2 | all | bba1:reservoirMinS=24,cushionEndS=40 | -3.2% [-10.9%, 3.7%] | -90 [-189, 2] | 4.6 [3.9, 5.3] |
| 2 | all | bola:qLowS=15 | -7.4% [-16.5%, -0.2%] | -102 [-198, -13] | 4.7 [4.2, 5.3] |
| 2 | all | bola-e:qLowS=30 | -0.6% [-7.1%, 4.4%] | 15 [2, 27] | -1.6 [-2.0, -1.2] |
| 2 | norway | bba1:reservoirMinS=24,cushionEndS=40 | -3.2% [-10.9%, 3.5%] | 170 [151, 189] | 5.8 [5.0, 6.6] |
| 2 | norway | bola:qLowS=15 | -7.4% [-16.4%, -0.3%] | 151 [133, 168] | 5.2 [4.5, 5.9] |
| 2 | norway | bola-e:qLowS=30 | -0.6% [-6.9%, 4.3%] | 31 [17, 45] | -2.3 [-2.7, -1.9] |
| 2 (ext) | all | bba1:reservoirMinS=28,cushionEndS=36 | -1.8% [-8.7%, 5.3%] | -95 [-192, -4] | 6.6 [5.5, 7.7] |
| 2 (ext) | all | bola-e:qLowS=50 | 7.8% [3.3%, 13.7%] | -70 [-89, -53] | -0.9 [-1.3, -0.6] |
| 2 (ext) | norway | bba1:reservoirMinS=28,cushionEndS=36 | -1.8% [-8.8%, 4.9%] | 162 [143, 181] | 8.9 [7.8, 10.0] |
| 2 (ext) | norway | bola-e:qLowS=50 | 7.8% [3.3%, 13.6%] | -85 [-105, -66] | -1.5 [-1.9, -1.1] |
| 3 | all | bba1:reservoirMinS=24,cushionEndS=40 | -3.6% [-9.7%, 3.7%] | -76 [-175, 17] | 4.7 [4.0, 5.4] |
| 3 | all | bola:qLowS=10 | -15.0% [-22.9%, -9.0%] | -53 [-146, 35] | 4.4 [3.9, 5.0] |
| 3 | all | bola-e:qLowS=30 | 3.4% [-2.1%, 8.3%] | 25 [10, 43] | -1.8 [-2.2, -1.4] |
| 3 | norway | bba1:reservoirMinS=24,cushionEndS=40 | -3.7% [-10.0%, 3.5%] | 190 [169, 212] | 6.0 [5.2, 6.8] |
| 3 | norway | bola:qLowS=10 | -15.0% [-23.0%, -9.1%] | 197 [179, 217] | 4.7 [4.0, 5.6] |
| 3 | norway | bola-e:qLowS=30 | 3.4% [-2.3%, 8.3%] | 46 [28, 68] | -2.6 [-3.0, -2.1] |
| 3 (ext) | all | bba1:reservoirMinS=28,cushionEndS=36 | -1.5% [-7.7%, 6.4%] | -80 [-177, 12] | 6.8 [5.7, 7.9] |
| 3 (ext) | all | bola-e:qLowS=50 | 7.9% [3.9%, 13.0%] | -64 [-81, -48] | -1.0 [-1.3, -0.7] |
| 3 (ext) | norway | bba1:reservoirMinS=28,cushionEndS=36 | -1.6% [-7.8%, 6.2%] | 182 [160, 205] | 9.2 [8.2, 10.3] |
| 3 (ext) | norway | bola-e:qLowS=50 | 7.9% [3.8%, 13.0%] | -76 [-92, -60] | -1.6 [-1.9, -1.2] |
| 4 | all | bba1:reservoirMinS=24,cushionEndS=40 | -2.6% [-9.2%, 3.7%] | -86 [-185, 8] | 4.5 [3.8, 5.2] |
| 4 | all | bola:qLowS=10 | -14.0% [-24.7%, -7.5%] | -63 [-156, 24] | 4.5 [3.9, 5.0] |
| 4 | all | bola-e:qLowS=30 | 0.7% [-4.6%, 5.3%] | 30 [15, 48] | -1.5 [-1.9, -1.1] |
| 4 | norway | bba1:reservoirMinS=24,cushionEndS=40 | -2.6% [-9.2%, 3.5%] | 180 [158, 202] | 5.5 [4.6, 6.4] |
| 4 | norway | bola:qLowS=10 | -14.0% [-24.5%, -7.5%] | 186 [166, 205] | 4.8 [4.0, 5.6] |
| 4 | norway | bola-e:qLowS=30 | 0.7% [-4.7%, 5.2%] | 48 [30, 69] | -2.2 [-2.6, -1.7] |
| 4 (ext) | all | bba1:reservoirMinS=28,cushionEndS=36 | -0.9% [-7.1%, 5.7%] | -90 [-188, 3] | 6.4 [5.3, 7.6] |
| 4 (ext) | all | bola-e:qLowS=50 | 5.6% [2.2%, 10.9%] | -56 [-73, -40] | -0.9 [-1.1, -0.6] |
| 4 (ext) | norway | bba1:reservoirMinS=28,cushionEndS=36 | -0.9% [-7.0%, 5.4%] | 172 [150, 195] | 8.6 [7.5, 9.8] |
| 4 (ext) | norway | bola-e:qLowS=50 | 5.6% [2.2%, 10.8%] | -73 [-92, -55] | -1.3 [-1.7, -1.0] |
| 5 | all | bba1:reservoirMinS=24,cushionEndS=40 | -1.0% [-5.6%, 3.7%] | -85 [-184, 9] | 4.6 [3.9, 5.3] |
| 5 | all | bola:qLowS=15 | -3.8% [-9.7%, 1.1%] | -101 [-195, -12] | 4.5 [4.0, 5.0] |
| 5 | all | bola-e:qLowS=30 | -0.6% [-5.4%, 2.9%] | 28 [16, 41] | -1.6 [-2.1, -1.3] |
| 5 | norway | bba1:reservoirMinS=24,cushionEndS=40 | -1.1% [-5.6%, 3.6%] | 176 [155, 197] | 5.7 [4.9, 6.6] |
| 5 | norway | bola:qLowS=15 | -3.9% [-9.7%, 1.0%] | 150 [131, 169] | 4.9 [4.2, 5.6] |
| 5 | norway | bola-e:qLowS=30 | -0.6% [-5.4%, 2.7%] | 42 [26, 58] | -2.4 [-2.8, -1.9] |
| 5 (ext) | all | bba1:reservoirMinS=28,cushionEndS=36 | -0.2% [-4.2%, 4.5%] | -89 [-187, 4] | 6.6 [5.5, 7.8] |
| 5 (ext) | all | bola-e:qLowS=50 | 5.5% [2.4%, 10.1%] | -56 [-72, -41] | -1.0 [-1.3, -0.7] |
| 5 (ext) | norway | bba1:reservoirMinS=28,cushionEndS=36 | -0.2% [-4.3%, 4.5%] | 169 [148, 190] | 8.9 [7.8, 10.0] |
| 5 (ext) | norway | bola-e:qLowS=50 | 5.5% [2.4%, 10.0%] | -75 [-94, -57] | -1.5 [-1.9, -1.1] |
```

### Raw output: all 125 traces with paper defaults, `bench/abr_compare.sh`

The new algorithms are untuned here, so the full set is a fair (non-held-out) comparison. The
first three rows are identical to §1.

```
### ABR comparison (baseline: throughput)

- command: `npx tsx packages/abr/src/cli/compare.ts --traces data/traces/norway,data/traces/belgium --algos throughput,bba,bba-guard,bba1,bola,bola-e --baseline throughput --offsets 5 --seed 1 --out bench/out/abr`
- host: Apple M3 x8, 16 GiB, darwin 24.6.0, node v23.10.0
- video: media/hls/ladder.json (48 x 4 s segments, ladder 298/737/1173/1811/2790/4192 kbps)
- traces: 125 (norway 85, belgium 40), 5 seeded start offsets each (seed 1); rtt 80 ms, max buffer 60 s, startup after 1 segment (4 s)
- CIs: 95% paired percentile bootstrap over traces, 10000 resamples. "Cut" = 1 - mean(algo)/mean(throughput).
- simulation wall time: 105 ms

#### Trace set: all (n = 125)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 7.3% | — | 2.739 | — | 1915 | — | 4.8 | — | 3118 | — | — |
| bba | 8.4% | -16.0% [-23.5%, -10.4%] | 3.022 | -10.3% [-16.9%, -5.0%] | 1824 | -90 [-165, -18] | 6.3 | 1.4 [1.0, 1.9] | 3118 | 0 [0, 0] | 21/48/56 |
| bba-guard | 8.5% | -16.4% [-23.8%, -11.0%] | 3.035 | -10.8% [-17.5%, -5.4%] | 1973 | 59 [22, 94] | 6.5 | 1.6 [1.2, 2.1] | 3118 | 0 [0, 0] | 21/47/57 |
| bba1 | 8.5% | -17.2% [-24.8%, -11.7%] | 3.126 | -14.1% [-22.6%, -7.9%] | 1888 | -27 [-97, 40] | 7.7 | 2.8 [2.5, 3.2] | 3118 | 0 [0, 0] | 18/47/60 |
| bola | 8.4% | -15.1% [-21.7%, -10.3%] | 3.093 | -12.9% [-20.8%, -7.3%] | 1854 | -61 [-126, 1] | 9.4 | 4.5 [4.1, 4.9] | 3118 | 0 [0, 0] | 19/47/59 |
| bola-e | 7.9% | -8.4% [-13.3%, -5.1%] | 2.909 | -6.2% [-10.4%, -3.2%] | 1991 | 76 [63, 90] | 3.1 | -1.7 [-2.0, -1.5] | 3118 | 0 [0, 0] | 21/55/49 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 7.3% | 0.0% | 0.0% | 0.6% | 5.2% | 29.4% | 81.1% | 65.6% |
| bba | 8.4% | 0.0% | 0.0% | 1.3% | 8.0% | 32.6% | 81.1% | 58.4% |
| bba-guard | 8.5% | 0.0% | 0.0% | 1.5% | 8.0% | 32.6% | 81.1% | 59.2% |
| bba1 | 8.5% | 0.0% | 0.0% | 1.6% | 8.4% | 32.3% | 81.1% | 59.2% |
| bola | 8.4% | 0.0% | 0.0% | 1.5% | 7.3% | 31.7% | 81.1% | 58.4% |
| bola-e | 7.9% | 0.0% | 0.0% | 1.5% | 6.9% | 30.2% | 81.1% | 68.8% |

#### Trace set: norway (n = 85)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 10.7% | — | 4.024 | — | 896 | — | 6.5 | — | 4399 | — | — |
| bba | 12.4% | -16.1% [-23.5%, -10.5%] | 4.445 | -10.5% [-17.2%, -5.2%] | 1090 | 194 [179, 209] | 6.9 | 0.4 [-0.1, 0.9] | 4399 | 0 [0, 0] | 19/10/56 |
| bba-guard | 12.4% | -16.5% [-23.8%, -11.1%] | 4.464 | -10.9% [-17.7%, -5.7%] | 1088 | 192 [177, 207] | 7.1 | 0.6 [0.1, 1.1] | 4399 | 0 [0, 0] | 19/9/57 |
| bba1 | 12.5% | -17.2% [-24.9%, -11.7%] | 4.598 | -14.3% [-22.5%, -8.1%] | 1134 | 239 [223, 254] | 9.7 | 3.2 [2.7, 3.8] | 4399 | 0 [0, 0] | 16/9/60 |
| bola | 12.3% | -15.2% [-21.7%, -10.4%] | 4.548 | -13.0% [-21.0%, -7.4%] | 1081 | 185 [172, 198] | 11.4 | 4.9 [4.3, 5.5] | 4399 | 0 [0, 0] | 17/9/59 |
| bola-e | 11.6% | -8.4% [-13.4%, -5.1%] | 4.273 | -6.2% [-10.5%, -3.2%] | 1007 | 111 [98, 124] | 3.9 | -2.5 [-2.8, -2.2] | 4399 | 0 [0, 0] | 21/15/49 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 10.7% | 0.1% | 0.6% | 2.8% | 19.3% | 32.5% | 81.1% | 94.1% |
| bba | 12.4% | 0.0% | 1.2% | 4.7% | 20.7% | 38.2% | 81.1% | 85.9% |
| bba-guard | 12.4% | 0.0% | 1.3% | 4.8% | 21.3% | 38.2% | 81.1% | 87.1% |
| bba1 | 12.5% | 0.0% | 1.5% | 4.8% | 20.7% | 37.3% | 81.1% | 87.1% |
| bola | 12.3% | 0.0% | 1.4% | 4.6% | 21.0% | 37.6% | 81.1% | 85.9% |
| bola-e | 11.6% | 0.2% | 1.3% | 4.4% | 21.1% | 32.7% | 81.1% | 98.8% |

#### Trace set: belgium (n = 40)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 0.0% | — | 0.010 | — | 4080 | — | 1.4 | — | 397 | — | — |
| bba | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3385 | -694 [-710, -676] | 5.1 | 3.7 [3.5, 3.9] | 397 | 0 [0, 0] | 2/38/0 |
| bba-guard | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3855 | -225 [-242, -210] | 5.3 | 3.9 [3.7, 4.0] | 397 | 0 [0, 0] | 2/38/0 |
| bba1 | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3488 | -591 [-609, -571] | 3.4 | 2.0 [1.9, 2.2] | 397 | 0 [0, 0] | 2/38/0 |
| bola | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3495 | -585 [-600, -566] | 5.1 | 3.7 [3.5, 3.9] | 397 | 0 [0, 0] | 2/38/0 |
| bola-e | 0.0% | 0.0% [0.0%, 0.0%] | 0.010 | 0.0% [0.0%, 0.0%] | 4083 | 4 [-10, 21] | 1.3 | -0.1 [-0.2, 0.0] | 397 | 0 [0, 0] | 0/40/0 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.2% | 5.0% |
| bba | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba-guard | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba1 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola-e | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.2% | 5.0% |
```

### Raw output: sensitivity (in-sample, explanatory only), `bench/abr_sensitivity.sh`

```
### ABR comparison (baseline: throughput)

- command: `npx tsx packages/abr/src/cli/compare.ts --traces data/traces/norway,data/traces/belgium --algos throughput;throughput:safety=1;throughput:safety=0.7;bba:reservoirS=5,cushionS=10;bba:reservoirS=5,cushionS=40;bba:reservoirS=20,cushionS=30;bba-guard:reservoirS=20,cushionS=30;bba1;bba1:nominalSizes=1;bba1:useEstimate=1;bola;bola:gammaP=5;bola-e;bola-e:gammaP=5 --baseline throughput --offsets 5 --seed 1 --resamples 2000 --out bench/out/abr_sensitivity`
- host: Apple M3 x8, 16 GiB, darwin 24.6.0, node v23.10.0
- video: media/hls/ladder.json (48 x 4 s segments, ladder 298/737/1173/1811/2790/4192 kbps)
- traces: 125 (norway 85, belgium 40), 5 seeded start offsets each (seed 1); rtt 80 ms, max buffer 60 s, startup after 1 segment (4 s)
- CIs: 95% paired percentile bootstrap over traces, 2000 resamples. "Cut" = 1 - mean(algo)/mean(throughput).
- simulation wall time: 190 ms

#### Trace set: all (n = 125)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 7.3% | — | 2.739 | — | 1915 | — | 4.8 | — | 3118 | — | — |
| throughput:safety=1 | 7.9% | -8.8% [-13.3%, -6.0%] | 3.064 | -11.9% [-18.5%, -7.8%] | 1992 | 77 [64, 91] | 5.0 | 0.2 [-0.0, 0.4] | 3118 | 0 [0, 0] | 1/53/71 |
| throughput:safety=0.7 | 6.3% | 12.7% [8.5%, 17.9%] | 2.400 | 12.4% [8.2%, 18.5%] | 1751 | -164 [-185, -141] | 4.0 | -0.8 [-1.1, -0.5] | 3118 | 0 [0, 0] | 70/55/0 |
| bba:reservoirS=5,cushionS=10 | 11.5% | -58.3% [-83.5%, -42.3%] | 5.206 | -90.1% [-134.9%, -63.2%] | 2110 | 196 [146, 243] | 14.3 | 9.5 [8.4, 10.7] | 3118 | 0 [0, 0] | 3/39/83 |
| bba:reservoirS=5,cushionS=40 | 9.4% | -29.7% [-42.5%, -21.2%] | 3.576 | -30.5% [-46.2%, -20.4%] | 1891 | -24 [-93, 42] | 6.6 | 1.8 [1.3, 2.2] | 3118 | 0 [0, 0] | 12/42/71 |
| bba:reservoirS=20,cushionS=30 | 7.7% | -5.7% [-10.4%, -1.2%] | 2.749 | -0.4% [-4.3%, 4.4%] | 1760 | -155 [-232, -80] | 6.7 | 1.8 [1.5, 2.2] | 3118 | 0 [0, 0] | 39/48/38 |
| bba-guard:reservoirS=20,cushionS=30 | 7.7% | -5.4% [-10.1%, -1.0%] | 2.755 | -0.6% [-4.5%, 3.9%] | 1937 | 22 [-9, 53] | 7.2 | 2.4 [2.0, 2.7] | 3118 | 0 [0, 0] | 41/48/36 |
| bba1 | 8.5% | -17.2% [-24.8%, -11.6%] | 3.126 | -14.1% [-22.5%, -7.8%] | 1888 | -27 [-97, 39] | 7.7 | 2.8 [2.5, 3.2] | 3118 | 0 [0, 0] | 18/47/60 |
| bba1:nominalSizes=1 | 8.6% | -18.2% [-26.2%, -12.5%] | 3.109 | -13.5% [-20.9%, -7.7%] | 1813 | -102 [-179, -28] | 6.0 | 1.1 [0.7, 1.6] | 3118 | 0 [0, 0] | 18/46/61 |
| bba1:useEstimate=1 | 8.5% | -17.4% [-25.0%, -11.8%] | 3.112 | -13.6% [-21.5%, -7.6%] | 1887 | -28 [-98, 38] | 7.7 | 2.8 [2.5, 3.2] | 3118 | 0 [0, 0] | 18/47/60 |
| bola | 8.4% | -15.1% [-21.4%, -10.2%] | 3.093 | -12.9% [-20.6%, -7.4%] | 1854 | -61 [-125, 1] | 9.4 | 4.5 [4.1, 4.9] | 3118 | 0 [0, 0] | 19/47/59 |
| bola:gammaP=5 | 7.1% | 2.4% [-1.2%, 6.9%] | 2.550 | 6.9% [3.2%, 12.6%] | 1691 | -224 [-301, -149] | 10.6 | 5.8 [5.3, 6.3] | 3118 | 0 [0, 0] | 53/51/21 |
| bola-e | 7.9% | -8.4% [-13.8%, -5.1%] | 2.909 | -6.2% [-10.5%, -3.2%] | 1991 | 76 [63, 90] | 3.1 | -1.7 [-2.0, -1.5] | 3118 | 0 [0, 0] | 21/55/49 |
| bola-e:gammaP=5 | 7.2% | 0.3% [-2.7%, 2.8%] | 2.677 | 2.3% [0.3%, 4.6%] | 1936 | 22 [11, 33] | 3.3 | -1.6 [-1.8, -1.3] | 3118 | 0 [0, 0] | 40/62/23 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 7.3% | 0.0% | 0.0% | 0.6% | 5.2% | 29.4% | 81.1% | 65.6% |
| throughput:safety=1 | 7.9% | 0.0% | 0.0% | 1.7% | 6.3% | 30.5% | 81.1% | 69.6% |
| throughput:safety=0.7 | 6.3% | 0.0% | 0.0% | 0.0% | 3.6% | 27.5% | 81.1% | 52.8% |
| bba:reservoirS=5,cushionS=10 | 11.5% | 0.0% | 0.0% | 6.5% | 14.8% | 36.4% | 81.1% | 68.0% |
| bba:reservoirS=5,cushionS=40 | 9.4% | 0.0% | 0.0% | 3.2% | 11.2% | 33.6% | 81.1% | 64.0% |
| bba:reservoirS=20,cushionS=30 | 7.7% | 0.0% | 0.0% | 0.6% | 6.7% | 30.6% | 81.1% | 55.2% |
| bba-guard:reservoirS=20,cushionS=30 | 7.7% | 0.0% | 0.0% | 0.5% | 6.7% | 30.6% | 81.1% | 56.0% |
| bba1 | 8.5% | 0.0% | 0.0% | 1.6% | 8.4% | 32.3% | 81.1% | 59.2% |
| bba1:nominalSizes=1 | 8.6% | 0.0% | 0.0% | 1.6% | 8.8% | 32.8% | 81.1% | 60.0% |
| bba1:useEstimate=1 | 8.5% | 0.0% | 0.0% | 1.6% | 9.1% | 32.3% | 81.1% | 59.2% |
| bola | 8.4% | 0.0% | 0.0% | 1.5% | 7.3% | 31.7% | 81.1% | 58.4% |
| bola:gammaP=5 | 7.1% | 0.0% | 0.0% | 0.0% | 5.0% | 30.1% | 81.1% | 49.6% |
| bola-e | 7.9% | 0.0% | 0.0% | 1.5% | 6.9% | 30.2% | 81.1% | 68.8% |
| bola-e:gammaP=5 | 7.2% | 0.0% | 0.0% | 0.5% | 5.2% | 29.2% | 81.1% | 67.2% |

#### Trace set: norway (n = 85)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 10.7% | — | 4.024 | — | 896 | — | 6.5 | — | 4399 | — | — |
| throughput:safety=1 | 11.6% | -8.8% [-13.3%, -6.0%] | 4.501 | -11.9% [-18.7%, -7.6%] | 1004 | 108 [93, 124] | 6.7 | 0.3 [-0.0, 0.6] | 4399 | 0 [0, 0] | 1/13/71 |
| throughput:safety=0.7 | 9.3% | 12.7% [8.6%, 18.0%] | 3.527 | 12.3% [8.1%, 18.7%] | 675 | -221 [-243, -200] | 4.9 | -1.5 [-1.9, -1.1] | 4399 | 0 [0, 0] | 69/16/0 |
| bba:reservoirS=5,cushionS=10 | 16.9% | -58.3% [-84.5%, -41.6%] | 7.656 | -90.3% [-136.2%, -62.2%] | 1261 | 365 [334, 395] | 19.6 | 13.1 [12.1, 14.2] | 4399 | 0 [0, 0] | 1/1/83 |
| bba:reservoirS=5,cushionS=40 | 13.9% | -29.7% [-43.1%, -21.2%] | 5.259 | -30.7% [-46.5%, -20.0%] | 1140 | 244 [227, 260] | 7.3 | 0.9 [0.3, 1.4] | 4399 | 0 [0, 0] | 10/4/71 |
| bba:reservoirS=20,cushionS=30 | 11.3% | -5.7% [-10.2%, -1.3%] | 4.042 | -0.5% [-4.3%, 4.2%] | 1034 | 138 [125, 151] | 7.6 | 1.2 [0.7, 1.7] | 4399 | 0 [0, 0] | 37/10/38 |
| bba-guard:reservoirS=20,cushionS=30 | 11.3% | -5.4% [-9.9%, -1.0%] | 4.052 | -0.7% [-4.5%, 3.9%] | 1033 | 137 [123, 150] | 8.1 | 1.6 [1.2, 2.0] | 4399 | 0 [0, 0] | 39/10/36 |
| bba1 | 12.5% | -17.2% [-25.0%, -11.7%] | 4.598 | -14.3% [-22.5%, -8.1%] | 1134 | 239 [222, 254] | 9.7 | 3.2 [2.7, 3.8] | 4399 | 0 [0, 0] | 16/9/60 |
| bba1:nominalSizes=1 | 12.6% | -18.3% [-26.2%, -12.6%] | 4.572 | -13.6% [-21.5%, -7.9%] | 1090 | 194 [179, 208] | 6.4 | -0.1 [-0.6, 0.4] | 4399 | 0 [0, 0] | 16/8/61 |
| bba1:useEstimate=1 | 12.6% | -17.5% [-25.2%, -11.9%] | 4.576 | -13.7% [-21.6%, -7.8%] | 1133 | 237 [221, 253] | 9.7 | 3.2 [2.7, 3.8] | 4399 | 0 [0, 0] | 16/9/60 |
| bola | 12.3% | -15.2% [-21.8%, -10.3%] | 4.548 | -13.0% [-21.0%, -7.2%] | 1081 | 185 [172, 198] | 11.4 | 4.9 [4.3, 5.5] | 4399 | 0 [0, 0] | 17/9/59 |
| bola:gammaP=5 | 10.4% | 2.3% [-1.1%, 6.7%] | 3.751 | 6.8% [3.2%, 12.6%] | 965 | 69 [55, 81] | 13.2 | 6.8 [6.1, 7.4] | 4399 | 0 [0, 0] | 51/13/21 |
| bola-e | 11.6% | -8.4% [-13.6%, -5.0%] | 4.273 | -6.2% [-10.6%, -2.9%] | 1007 | 111 [97, 124] | 3.9 | -2.5 [-2.8, -2.2] | 4399 | 0 [0, 0] | 21/15/49 |
| bola-e:gammaP=5 | 10.7% | 0.3% [-2.8%, 2.8%] | 3.932 | 2.3% [0.3%, 4.6%] | 929 | 33 [20, 46] | 4.2 | -2.3 [-2.6, -2.0] | 4399 | 0 [0, 0] | 40/22/23 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 10.7% | 0.1% | 0.6% | 2.8% | 19.3% | 32.5% | 81.1% | 94.1% |
| throughput:safety=1 | 11.6% | 0.4% | 1.6% | 4.0% | 20.9% | 33.1% | 81.1% | 100.0% |
| throughput:safety=0.7 | 9.3% | 0.0% | 0.0% | 1.5% | 16.4% | 29.9% | 81.1% | 76.5% |
| bba:reservoirS=5,cushionS=10 | 16.9% | 3.1% | 6.5% | 10.1% | 24.5% | 41.3% | 81.1% | 100.0% |
| bba:reservoirS=5,cushionS=40 | 13.9% | 0.5% | 3.1% | 6.3% | 21.3% | 39.8% | 81.1% | 94.1% |
| bba:reservoirS=20,cushionS=30 | 11.3% | 0.0% | 0.5% | 3.4% | 20.7% | 35.4% | 81.1% | 81.2% |
| bba-guard:reservoirS=20,cushionS=30 | 11.3% | 0.0% | 0.5% | 3.1% | 20.7% | 35.3% | 81.1% | 82.4% |
| bba1 | 12.5% | 0.0% | 1.5% | 4.8% | 20.7% | 37.3% | 81.1% | 87.1% |
| bba1:nominalSizes=1 | 12.6% | 0.0% | 1.5% | 4.8% | 21.3% | 38.2% | 81.1% | 88.2% |
| bba1:useEstimate=1 | 12.6% | 0.0% | 1.5% | 4.9% | 20.7% | 37.3% | 81.1% | 87.1% |
| bola | 12.3% | 0.0% | 1.4% | 4.6% | 21.0% | 37.6% | 81.1% | 85.9% |
| bola:gammaP=5 | 10.4% | 0.0% | 0.0% | 2.3% | 19.3% | 33.3% | 81.1% | 72.9% |
| bola-e | 11.6% | 0.2% | 1.3% | 4.4% | 21.1% | 32.7% | 81.1% | 98.8% |
| bola-e:gammaP=5 | 10.7% | 0.1% | 0.5% | 3.5% | 19.0% | 32.7% | 81.1% | 96.5% |

#### Trace set: belgium (n = 40)

| algo | rebuffer ratio (mean) | rebuffer cut vs throughput | rebuffers/session | count cut | avg kbps | Δ kbps | switches/session | Δ switches | startup ms | Δ startup ms | W/T/L (rebuf ratio) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| throughput | 0.0% | — | 0.010 | — | 4080 | — | 1.4 | — | 397 | — | — |
| throughput:safety=1 | 0.0% | 0.0% [0.0%, 0.0%] | 0.010 | 0.0% [0.0%, 0.0%] | 4091 | 11 [4, 22] | 1.3 | -0.1 [-0.2, 0.0] | 397 | 0 [0, 0] | 0/40/0 |
| throughput:safety=0.7 | 0.0% | 96.0% [0.0%, 100.0%] | 0.005 | 50.0% [0.0%, 100.0%] | 4039 | -41 [-65, -22] | 2.1 | 0.7 [0.5, 0.9] | 397 | 0 [0, 0] | 1/39/0 |
| bba:reservoirS=5,cushionS=10 | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3916 | -164 [-181, -142] | 3.2 | 1.8 [1.6, 2.0] | 397 | 0 [0, 0] | 2/38/0 |
| bba:reservoirS=5,cushionS=40 | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3487 | -593 [-607, -575] | 5.1 | 3.7 [3.5, 3.9] | 397 | 0 [0, 0] | 2/38/0 |
| bba:reservoirS=20,cushionS=30 | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3302 | -778 [-796, -758] | 4.7 | 3.3 [3.0, 3.5] | 397 | 0 [0, 0] | 2/38/0 |
| bba-guard:reservoirS=20,cushionS=30 | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3858 | -222 [-237, -208] | 5.3 | 3.9 [3.8, 4.1] | 397 | 0 [0, 0] | 2/38/0 |
| bba1 | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3488 | -591 [-610, -571] | 3.4 | 2.0 [1.9, 2.2] | 397 | 0 [0, 0] | 2/38/0 |
| bba1:nominalSizes=1 | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3348 | -732 [-748, -715] | 5.1 | 3.7 [3.5, 3.9] | 397 | 0 [0, 0] | 2/38/0 |
| bba1:useEstimate=1 | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3488 | -591 [-610, -571] | 3.4 | 2.0 [1.9, 2.2] | 397 | 0 [0, 0] | 2/38/0 |
| bola | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3495 | -585 [-601, -565] | 5.1 | 3.7 [3.5, 3.9] | 397 | 0 [0, 0] | 2/38/0 |
| bola:gammaP=5 | 0.0% | 100.0% [100.0%, 100.0%] | 0.000 | 100.0% [100.0%, 100.0%] | 3233 | -846 [-866, -825] | 5.2 | 3.8 [3.5, 3.9] | 397 | 0 [0, 0] | 2/38/0 |
| bola-e | 0.0% | 0.0% [0.0%, 0.0%] | 0.010 | 0.0% [0.0%, 0.0%] | 4083 | 4 [-10, 20] | 1.3 | -0.1 [-0.2, 0.0] | 397 | 0 [0, 0] | 0/40/0 |
| bola-e:gammaP=5 | 0.0% | 0.0% [0.0%, 0.0%] | 0.010 | 0.0% [0.0%, 0.0%] | 4077 | -2 [-19, 16] | 1.4 | -0.0 [-0.1, 0.0] | 397 | 0 [0, 0] | 0/40/0 |

Per-trace rebuffer-ratio distribution:

| algo | mean | p10 | p25 | p50 | p75 | p90 | max | traces with any rebuffering |
|---|---|---|---|---|---|---|---|---|
| throughput | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.2% | 5.0% |
| throughput:safety=1 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.2% | 5.0% |
| throughput:safety=0.7 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 2.5% |
| bba:reservoirS=5,cushionS=10 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba:reservoirS=5,cushionS=40 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba:reservoirS=20,cushionS=30 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba-guard:reservoirS=20,cushionS=30 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba1 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba1:nominalSizes=1 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bba1:useEstimate=1 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola:gammaP=5 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| bola-e | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.2% | 5.0% |
| bola-e:gammaP=5 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.2% | 5.0% |
```
