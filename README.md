# Steady Lines — pull straight strokes from dot to dot

A daily line-confidence drill: two dots appear, you press on A and pull a
straight stroke to B. Six strokes per round (~40 seconds), longer as the round
goes on, and your last two attempts stay faintly behind the new one **with
their straight paths** — drawing over your own last try is the classic studio
warm-up this game trains.

**Scoring** is pure geometry. RMS perpendicular drift from the straight path is
measured in pixels and graded in a band: everything under `max(0.4% × |AB|,
3 px)` is a clean 100, and the score reaches 0 at
`ease × max(5.5% × |AB|, 16 px)`. Up to 20 points come off for stopping short
of B (the first `ease × 24 px` of endpoint miss are free). Round score is the
mean of the six strokes.

Two constants there carry the fairness of the whole drill:

* **`ease`** is `ArtDaily.ease()` — 1.0 for a pen, 2.0 for a mouse or
  trackpad, 1.5 for a finger. A mouse pivots at the wrist and cannot creep, so
  a 15 px wobble over a 300 px pull is an honest mouse line and a sloppy pen
  line. It used to score **9**; it now scores **60**. The drill prints the mode
  it graded for in the HUD ("scoring for mouse or trackpad"), and scores are
  only ever compared with your own history.
* **the pixel floors** (3 px / 16 px) stop the relative tolerance from
  punishing small screens. A phone's short first stroke used to zero at 6.4 px
  RMS while the desktop's equivalent was allowed 13 px — the same drill at half
  the tolerance on the device with the least precise input.

**Starting is forgiving.** The inner dashed ring is `ArtDaily.startRadius(28)`
(bigger for a pen, because a screenless tablet's hardest task is acquiring a
small target with the hand out of sight) and never smaller than 6% of the
sheet. The outer ring is 3× that: a press anywhere inside it is accepted and
the stroke is measured from where you actually landed. A press is only refused
outside the outer ring, and the refusal keeps your place in the round.

**Lifting early is not a mistake.** A trackpad physically cannot throw 550 px
in one go. A stroke that stops before 88% of the way to B is not scored at all:
the drill says how far you got and draws a circle at the lift point — press
inside it (within 3 s) and the same stroke carries on. Before this, a lift was
silently scored ~80 and the next press was eaten as tap-to-continue, so the
player advanced a stroke believing their line was crooked.

**The reveal** overlays the straight path in green, drops a dashed tick at the
point of widest drift, splits the readout so a line that bowed and a line that
stopped short are told apart, and reads the stroke's kinematics as *steady
pull* or *hesitant* (a coaching readout, never a penalty). It holds ~1.5 s; tap
to skip ahead. At round end, if most lines curved the same way, the drill names
the tendency in plain words.

**Fair input**: a pen pointer outranks a palm that landed first (and a finger
waits 700 ms after the pen last spoke), fast strokes are sampled via coalesced
pointer events, `pointercancel` and `lostpointercapture` end a stroke as
politely as `pointerup` does, a mid-stroke rotation/resize voids the attempt
without penalty, the canvas runs taller on phones, and on a narrow sheet the
drill skips near-vertical pairs (a pure thumb-pivot arc) and never asks for a
pull under half the canvas width. The stylesheet suppresses the iOS long-press
callout over the canvas, double-tap zoom on the controls, and pull-to-refresh.

## Run it

No build step, no dependencies:

```sh
python3 -m http.server 8080
# then visit http://localhost:8080
```

Part of [Art Daily](https://artdaily.sadeali.com/), a
[SadeAli](https://sadeali.com/) experiment — more at
[sadeali.com](https://sadeali.com/).
