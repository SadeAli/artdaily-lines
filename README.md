# Steady Lines — ghost straight strokes

A daily line-confidence drill: two checkpoint dots appear, you press on A and
pull **one** straight stroke to B. Six strokes per round (~40 seconds), longer
as the round goes on, and your last two attempts stay faintly ghosted on the
page **with their ideal lines** — ghosting lines is the classic studio warm-up
this game trains.

**Scoring** is pure geometry: straightness = 100 × (1 − max(0, RMS drift from
the ideal segment ÷ stroke length − 0.004) ÷ 0.051) — the first 0.4% of drift
is free, so a visibly clean stroke earns a real 100 — minus up to 20 points for
missing the endpoint dots (the first 24 px of combined miss are free). Round
score is the mean of the six strokes.

**The reveal** overlays the ideal line in mint, drops a dashed tick at the
point of widest drift, and reads the stroke's kinematics as *steady pull* or
*hesitant* (velocity consistency — a coaching readout, never a penalty). It
holds ~1.5 s; tap to skip ahead. At round end, if most strokes bowed the same
side of the pull, the drill names the tendency so you can correct it.

**Fair input**: one stroke = one pointer (a resting palm or second finger can
neither pollute nor end your stroke), fast strokes are sampled via coalesced
pointer events, a mid-stroke rotation/resize voids the attempt without
penalty, and the canvas runs taller on phones so near-vertical strokes get
room.

## Run it

No build step, no dependencies:

```sh
python3 -m http.server 8080
# then visit http://localhost:8080
```

Part of [Art Daily](https://artdaily.sadeali.com/), a
[SadeAli](https://sadeali.com/) experiment — more at
[sadeali.com](https://sadeali.com/).
