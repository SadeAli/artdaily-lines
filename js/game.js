/* ============================================================
   game.js — Steady Lines: pull straight strokes from dot to dot.
   Six endpoint pairs per round; press on (or near) A, pull to B,
   lift. Scoring is pure segment geometry (RMS drift from the ideal
   line + endpoint misses) — the pure functions sit at the top so
   they are unit-testable without a canvas. The two previous
   attempts stay faintly behind the new one, with their ideal lines:
   drawing over your own last try is the studio warm-up this copies.

   Hardware fairness (protocol v1 input profile):
     · the error at which the score dies is ArtDaily.ease()d, so a
       mouse's wrist arc is not graded against a pen tablet's sweep;
     · every relative tolerance has an absolute pixel floor, so a
       332px phone canvas is not held to twice the desktop standard;
     · the start ring is ArtDaily.startRadius()d and SNAPS — a press
       near A is measured from where you landed, never refused;
     · a lift that stops short does not score: press again where you
       lifted and the same stroke carries on (a trackpad cannot pull
       550px in one throw, and that is not a drawing mistake).
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'lines';
  var STROKES_PER_ROUND = 6;
  var START_BASE = 28;      /* px around A before the SDK's per-device scaling */
  var SNAP_MULT = 3;        /* a press this many radii out is accepted, not refused */
  var MIN_PATH_PX = 22;     /* drawn path shorter than this is a tap, not a stroke */
  var RESUME_PX = 60;       /* press this close to where you lifted = same stroke */
  var DONE_FRAC = 0.88;     /* stroke counts as finished once it gets this far to B */
  var REVEAL_MS = 1500;     /* reveal holds this long; a tap skips ahead */
  var GHOSTS_KEPT = 2;
  var PEN_LOCKOUT_MS = 700; /* a finger is inert this long after the pen last spoke */

  /* Drift tolerance is relative to |AB| — a longer pull earns more room —
     but never below an absolute pixel floor. Without the floor the phone's
     short first stroke zeroed at 6.4px RMS while the desktop's equivalent
     was allowed 13px: the same drill, half the tolerance, on the device
     with the least precise input. The ZERO point is the eased one; the
     free zone stays absolute because "as good as a hand gets" is a pixel
     count, not a hardware setting. */
  var REL_FREE = 0.004, FREE_FLOOR_PX = 3;
  var REL_ZERO = 0.055, ZERO_FLOOR_PX = 16;
  var ENDPOINT_FREE_PX = 24; /* combined endpoint miss that costs nothing */

  /* ============================================================
     Pure scoring — geometry in, 0–100 out. No canvas, no DOM.
     Points are {x,y} (input samples also carry t, a timestamp in
     ms, which only steadiness() reads). `ease` is the multiplier
     from ArtDaily.ease(1): 1 pen, 2 mouse/trackpad, 1.5 finger.
     ============================================================ */
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function pathLength(pts) {
    var s = 0, i;
    for (i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return s;
  }

  /* Perpendicular distance from point p to the line through a→b. */
  function perpDist(p, a, b) {
    var abx = b.x - a.x, aby = b.y - a.y;
    var len = Math.hypot(abx, aby);
    if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(abx * (p.y - a.y) - aby * (p.x - a.x)) / len;
  }

  /* Foot of the perpendicular from p onto the line through a→b. */
  function projectOnLine(p, a, b) {
    var abx = b.x - a.x, aby = b.y - a.y;
    var len2 = abx * abx + aby * aby;
    if (len2 === 0) return { x: a.x, y: a.y };
    var t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    return { x: a.x + t * abx, y: a.y + t * aby };
  }

  /* RMS perpendicular drift of the samples, in pixels. */
  function driftPx(points, a, b) {
    if (!points || points.length === 0) return Infinity;
    var sum = 0, d, i;
    for (i = 0; i < points.length; i++) {
      d = perpDist(points[i], a, b);
      sum += d * d;
    }
    return Math.sqrt(sum / points.length);
  }

  /* The px band this attempt is graded in: free = still a clean 100,
     zero = the score has run out. */
  function tolerancePx(len, ease) {
    var e = ease > 0 ? ease : 1;
    var L = len > 0 ? len : 0;
    return {
      free: Math.max(REL_FREE * L, FREE_FLOOR_PX),
      zero: e * Math.max(REL_ZERO * L, ZERO_FLOOR_PX),
    };
  }

  function straightness(rms, len, ease) {
    var t = tolerancePx(len, ease);
    if (!isFinite(rms)) return 0;
    if (t.zero <= t.free) return rms <= t.free ? 100 : 0;
    return 100 * clamp01(1 - (rms - t.free) / (t.zero - t.free));
  }

  /* First 24px of combined endpoint miss are free — eased, because a
     mouse stops where the mouse stops — then up to −20. */
  function endpointPenalty(missA, missB, ease) {
    var free = (ease > 0 ? ease : 1) * ENDPOINT_FREE_PX;
    return 20 * clamp01((missA + missB - free) / 160);
  }

  /* How far along a→b the stroke actually got (1 = reached B). */
  function strokeProgress(points, a, b) {
    if (!points || points.length === 0) return 0;
    var abx = b.x - a.x, aby = b.y - a.y;
    var len2 = abx * abx + aby * aby;
    if (len2 === 0) return 1;
    var last = points[points.length - 1];
    return ((last.x - a.x) * abx + (last.y - a.y) * aby) / len2;
  }

  /* The scored segment starts where the player actually landed. A press
     inside the snap ring is a hit, and the stroke it begins is judged
     from that first sample to B — the whole attempt is translated onto
     the target rather than the first sample alone, which would leave a
     blind landing paying for an offset it also corrected. */
  function strokeScore(points, a, b, ease) {
    /* one sample is a press, not a line — it has no straightness to read */
    if (!points || points.length < 2) return 0;
    var len = Math.hypot(b.x - a.x, b.y - a.y);
    var first = points[0], last = points[points.length - 1];
    var missA = Math.hypot(first.x - a.x, first.y - a.y);
    var missB = Math.hypot(last.x - b.x, last.y - b.y);
    var s = straightness(driftPx(points, a, b), len, ease) - endpointPenalty(missA, missB, ease);
    return isFinite(s) ? Math.max(0, Math.min(100, s)) : 0;
  }

  /* The sample where the stroke drifted furthest — for the reveal
     tick that shows WHERE the line bowed, not just how much. */
  function worstDrift(points, a, b) {
    var best = -1, idx = -1, i, d;
    for (i = 0; i < points.length; i++) {
      d = perpDist(points[i], a, b);
      if (d > best) { best = d; idx = i; }
    }
    return idx < 0 ? null : { i: idx, d: best };
  }

  /* Velocity consistency of the stroke — pure kinematics, never
     time-on-page. 100 = one even confident pull; low = stop-start
     tracing. Null when the samples carry no usable timing. Kept out
     of the numeric score: it is a coaching readout, not a penalty. */
  function steadiness(points) {
    var speeds = [], i, dx, dy, dt, d;
    for (i = 1; i < points.length; i++) {
      dt = (points[i].t || 0) - (points[i - 1].t || 0);
      if (dt <= 0) continue;
      dx = points[i].x - points[i - 1].x;
      dy = points[i].y - points[i - 1].y;
      speeds.push(Math.hypot(dx, dy) / dt);
    }
    if (speeds.length < 6) return null;
    var mean = 0;
    for (i = 0; i < speeds.length; i++) mean += speeds[i];
    mean /= speeds.length;
    if (mean <= 0) return 0;
    var varSum = 0;
    for (i = 0; i < speeds.length; i++) { d = speeds[i] - mean; varSum += d * d; }
    var cv = Math.sqrt(varSum / speeds.length) / mean;
    /* cv ≤ 0.45 reads as one pull; ≥ 1.6 as stop-start hesitation */
    return Math.round(100 * clamp01(1 - (cv - 0.45) / 1.15));
  }

  /* The reveal in words. The dashed tick already shows WHERE the line
     bowed; this names HOW FAR, in the same band the score is graded in,
     so the sentence and the number can never disagree. Returns '' only
     for an unreadable stroke.

     `rmsPx` is the very number straightness() grades — pass it and an
     attempt the drill has ALREADY called perfect keeps the perfect
     wording. Without it a long stroke could score a flat 100 (RMS inside
     the free zone) and be handed "bowed 9px at its widest" in the same
     breath: measured, 1000px pull, RMS 3.98 against a free zone of 4.
     The player believes the sentence over the number. */
  function driftWords(worstPx, len, ease, rmsPx) {
    var t = tolerancePx(len, ease);
    if (!isFinite(worstPx) || worstPx < 0) return '';
    /* 'dead straight' is reserved for an attempt the score ITSELF calls
       perfect — straightness() is a flat 100 anywhere inside the free
       zone. The old worst-sample test (1.5 × free) also handed it to
       strokes scoring in the low 90s, so the reveal congratulated a line
       the number had already marked down. Without an RMS to check
       against, that test is still the best available fallback. */
    if (isFinite(rmsPx) && rmsPx >= 0) {
      if (rmsPx <= t.free) return 'dead straight';
    } else if (worstPx <= 1.5 * t.free) {
      return 'dead straight';
    }
    if (worstPx <= t.zero) return 'bowed ' + Math.round(worstPx) + 'px at its widest';
    return 'well off the straight path — ' + Math.round(worstPx) + 'px at its widest';
  }

  /* Which way the stroke missed B, in words — the sentence that names the
     endpoint half of the score. `along` is signed distance past B measured
     ALONG a→b (negative = short of it); `perp` is how far off that line the
     stroke finished. Whichever is bigger is what actually happened.

     It used to print "for stopping short of B" for all three misses. Measured
     against the real drill: a pull that ran 160px PAST B was handed
     "−14 for stopping short of B", and one that finished level with B but
     90px wide of it got the same words. The reveal draws the ideal line and
     the widest-drift tick, but neither says anything about the endpoint — this
     sentence is the only place that half of the score is ever explained, so it
     has to describe the miss the player actually made. */
  function endMissWords(alongPx, perpPx) {
    var along = isFinite(alongPx) ? alongPx : 0;
    var perp = isFinite(perpPx) && perpPx > 0 ? perpPx : 0;
    if (Math.abs(along) >= perp) {
      return along > 0 ? 'for running past B' : 'for stopping short of B';
    }
    return 'for finishing wide of B';
  }

  /* Mean signed perpendicular offset as a fraction of |AB|.
     Positive = the stroke bows right of the direction of travel
     (screen coords, y down). */
  function signedBias(points, a, b) {
    var abx = b.x - a.x, aby = b.y - a.y;
    var len = Math.hypot(abx, aby);
    if (len === 0 || points.length === 0) return 0;
    var sum = 0, i;
    for (i = 0; i < points.length; i++) {
      sum += (abx * (points[i].y - a.y) - aby * (points[i].x - a.x)) / len;
    }
    return (sum / points.length) / len;
  }

  /* Round-end coaching: if most strokes bow the same way, say so in
     plain words. Takes the per-stroke signedBias values; returns ''
     when there is no consistent tendency worth reporting. */
  function biasCoaching(biasList) {
    var right = 0, left = 0, i;
    for (i = 0; i < biasList.length; i++) {
      if (biasList[i] > 0.006) right += 1;
      else if (biasList[i] < -0.006) left += 1;
    }
    /* Name the FRAME, not just the side. "curve to the right of the straight
       path — aim a hair left" is measured in the direction of the pull, and
       the strokes of a round point six different ways: a player who has just
       watched a left-to-right line sag downwards reads "right" as "toward B"
       and "aim left" as "aim backwards". Saying which way you are pulling
       makes the same true statement readable, and the arc — one wrist pivot
       repeated six times — is the thing they can actually act on. */
    if (right >= 4 && right > left) {
      return 'every line arcs the same way — right of the direction you are pulling. that is the wrist pivoting: aim a hair the other way, or draw from the shoulder.';
    }
    if (left >= 4 && left > right) {
      return 'every line arcs the same way — left of the direction you are pulling. that is the wrist pivoting: aim a hair the other way, or draw from the shoulder.';
    }
    return '';
  }

  function roundScore(scores) {
    if (!scores.length) return 0;
    var sum = 0, i;
    for (i = 0; i < scores.length; i++) sum += scores[i];
    var v = sum / scores.length;
    return isFinite(v) ? v : 0;
  }

  /* ============================================================
     Canvas / DOM from here down.
     ============================================================ */
  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks (re-read on every repaint) ----
     accent is the airy wash used for ghosts; accentInk is the AA-contrast
     variant used for everything meaning-bearing (targets, ideal line,
     score). See the note above --game-accent-ink in css/style.css. */
  function inks() {
    var cs = getComputedStyle(document.documentElement);
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--mint').trim();
    return {
      ink: cs.getPropertyValue('--ink').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: accent,
      accentInk: cs.getPropertyValue('--game-accent-ink').trim() || accent,
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    /* taller sheet on phones so near-vertical strokes get room */
    H = Math.round(W * (W < 520 ? 0.92 : 0.62));
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* The start zone the SDK sizes for this hardware, never smaller than
     6% of the sheet. A screenless tablet gets the biggest ring even
     though it is the most precise instrument — its hand is out of sight,
     and acquiring a small target blind is the hardest thing it does. */
  function startRadius() {
    return Math.max(ArtDaily.startRadius(START_BASE), Math.round(0.06 * Math.min(W, H)));
  }
  function easeFactor() { return ArtDaily.ease(1); }

  /* ---- round state ---- */
  var round = 0, strokeIdx = 0, scores = [], biases = [], pair = null, playing = false;
  var reported = false;     /* this round has already reached ArtDaily.report */
  var drawing = false, stroke = [], ghosts = [], revealing = null, revealTimer = null;
  var activePointer = null, activeType = null;
  var lastPenAt = -1e9;     /* palm rejection: a finger waits after the pen speaks */
  var pending = null;       /* a stroke that stopped short, waiting to be carried on */
  var snapped = false;      /* this attempt started outside the ring and was accepted */
  /* the last scored stroke, in words — the sixth stroke's reveal used to be
     reported and overwritten by "round done" in the same tick, so the one
     stroke a player most wants read back to them was the one that never was */
  var lastWords = '';

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

  function strokeLabel() { return 'stroke ' + (strokeIdx + 1) + ' of ' + STROKES_PER_ROUND; }

  function playHint() { return strokeLabel() + ' — press on A, pull one stroke to B.'; }

  /* Later strokes are longer (35% → 80% of canvas width; never under 50%
     on a phone, where a short pull plus a tiny canvas is the harshest
     grading in the drill); orientation cycles with jitter, and skips
     near-vertical on a narrow sheet because that is a pure thumb-pivot
     arc, not a test of anything. */
  function makePair(idx) {
    var margin = 26;
    var narrow = W < 520;
    var t = idx / (STROKES_PER_ROUND - 1);
    var lo = narrow ? 0.50 : 0.35;
    var frac = Math.max(lo, Math.min(0.80, lo + (0.80 - lo) * t + rand(-0.03, 0.03)));
    var len = W * frac;
    var pool = narrow ? [0, 50, 130, 25] : [0, 45, 90, 135];
    var ang = (pool[idx % 4] + rand(-12, 12)) * Math.PI / 180;
    var dx = Math.cos(ang), dy = Math.sin(ang);
    /* shrink strokes that would not fit the canvas at this angle */
    if (Math.abs(dx) > 0.01) len = Math.min(len, (W - 2 * margin) / Math.abs(dx));
    if (Math.abs(dy) > 0.01) len = Math.min(len, (H - 2 * margin) / Math.abs(dy));
    var hx = dx * len / 2, hy = dy * len / 2;
    var mx = rand(margin + Math.abs(hx), W - margin - Math.abs(hx));
    var my = rand(margin + Math.abs(hy), H - margin - Math.abs(hy));
    var p = { x: mx - hx, y: my - hy }, q = { x: mx + hx, y: my + hy };
    /* half the strokes run right-to-left / bottom-up for variety */
    pair = Math.random() < 0.5 ? { a: p, b: q } : { a: q, b: p };
  }

  function newRound() {
    clearTimeout(revealTimer);
    round += 1;
    strokeIdx = 0;
    scores = [];
    biases = [];
    reported = false;
    ghosts = [];
    stroke = [];
    pending = null;
    snapped = false;
    lastWords = '';
    drawing = false;
    activePointer = null;
    activeType = null;
    revealing = null;
    playing = true;
    makePair(0);
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    hint.textContent = playHint();
    draw();
  }

  /* ---- painting (canvas bg stays clear so the CSS dot-grid shows) ---- */
  function drawPolyline(pts) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function drawLabel(p, text, c) {
    ctx.fillStyle = c;
    ctx.font = '800 12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    var lx = Math.max(10, Math.min(W - 10, p.x));
    var ly = p.y > 26 ? p.y - 13 : p.y + 23;
    ctx.fillText(text, lx, ly);
  }

  function drawEndpoints(c, subdued) {
    var a = revealing ? revealing.a : pair.a;
    var b = revealing ? revealing.b : pair.b;
    if (!subdued) {
      var r = startRadius();
      ctx.save();
      /* a decorative halo at the snap radius: press anywhere inside it and
         the stroke is accepted. The hint and the how-to carry that in
         words, so this one is free to stay faint */
      ctx.globalAlpha = 0.45;
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r * SNAP_MULT, 0, Math.PI * 2);
      ctx.stroke();
      /* the "aim here" ring, at full --muted (5.2:1 on paper, 5.8:1 on the
         night sheet) — it used to be a 0.3-alpha hairline, so players aimed
         far tighter than the drill was actually asking for */
      ctx.globalAlpha = 1;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = c.accentInk;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.accentInk;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
    ctx.stroke();
    drawLabel(a, 'A', subdued ? c.muted : c.ink);
    drawLabel(b, 'B', subdued ? c.muted : c.ink);
  }

  /* Where to press to carry on after a lift — an open ring on the last
     sample, so "press again here" is a place, not a sentence. Drawn at
     RESUME_PX, the radius that is actually accepted: at 0.4x of it every
     press between the drawn edge and 60px resumed a stroke the player
     could see they were outside of. */
  function drawResumeMark(c) {
    var p = pending.lift;
    ctx.save();
    ctx.strokeStyle = c.accentInk;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, RESUME_PX, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    /* the two previous attempts stay faintly on the page, each with its
       ideal segment, so the lesson persists into the next stroke */
    if (ghosts.length) {
      ctx.save();
      for (var g = 0; g < ghosts.length; g++) {
        ctx.globalAlpha = 0.15;
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ghosts[g].a.x, ghosts[g].a.y);
        ctx.lineTo(ghosts[g].b.x, ghosts[g].b.y);
        ctx.stroke();
        ctx.globalAlpha = 0.22;
        ctx.strokeStyle = c.muted;
        ctx.lineWidth = 2;
        drawPolyline(ghosts[g].points);
      }
      ctx.restore();
    }

    /* a finished round keeps its last reveal on the sheet to study — the
       round is already reported, so nothing is waiting on this paint */
    if (!playing && !revealing) return;

    if (revealing) {
      /* the player's ink, then the ideal overlaid in accent */
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      drawPolyline(revealing.points);
      ctx.strokeStyle = c.accentInk;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(revealing.a.x, revealing.a.y);
      ctx.lineTo(revealing.b.x, revealing.b.y);
      ctx.stroke();
      /* tick at the widest drift: dot on the ink, dash to the ideal */
      if (revealing.worst && revealing.worst.d >= 3) {
        ctx.save();
        ctx.strokeStyle = c.muted;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(revealing.worst.p.x, revealing.worst.p.y);
        ctx.lineTo(revealing.worst.foot.x, revealing.worst.foot.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = c.muted;
        ctx.beginPath();
        ctx.arc(revealing.worst.p.x, revealing.worst.p.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      drawEndpoints(c, true);
      /* stroke score flashed near the midpoint */
      var label = String(revealing.score);
      var tx = Math.max(26, Math.min(W - 26, (revealing.a.x + revealing.b.x) / 2));
      var ty = Math.max(24, Math.min(H - 12, (revealing.a.y + revealing.b.y) / 2 - 12));
      ctx.font = '900 16px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      var w = ctx.measureText(label).width + 16;
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = c.card;
      ctx.fillRect(tx - w / 2, ty - 15, w, 22);
      ctx.restore();
      ctx.fillStyle = c.accentInk;
      ctx.fillText(label, tx, ty + 1);
      return;
    }

    if (pair) drawEndpoints(c, false);
    /* a stroke that stopped short stays on the sheet while it waits */
    if (pending) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      drawPolyline(pending.points);
      drawResumeMark(c);
    }
    if (drawing) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      drawPolyline(stroke);
    }
  }

  /* ---- input: press on or near A, pull to B, lift ---- */
  /* Split in two so a run of coalesced samples can share ONE canvas
     measurement: getBoundingClientRect() forces a layout flush, and a fast
     pen hands over dozens of samples per frame — all of them describing a
     canvas that cannot have moved between them — in the same handler that
     repaints. Measured here: 16 layout reads per pointermove instead of 1.
     (This is the hazard ArtDaily.samples() is documented against.) */
  function posIn(ev, rect) {
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, t: ev.timeStamp || 0 };
  }
  function pointerPos(ev) {
    return posIn(ev, canvas.getBoundingClientRect());
  }

  /* A pen outranks a finger: artists rest the palm before the nib lands,
     so first-pointer-wins hands the stroke to the palm and the pen draws
     nothing. A pen press evicts a young touch stroke; a finger stays out
     of the way for a moment after the pen last spoke. */
  function penWins(ev) {
    /* only a FINGER ever waits, and only while the pen is still talking;
       a mouse or an unknown pointer type is always allowed to draw */
    if (ev.pointerType !== 'touch') return true;
    return (ev.timeStamp || 0) - lastPenAt >= PEN_LOCKOUT_MS;
  }

  /* The press that owns the current stroke is provably no longer down.

     A pointer is `primary` only while it is the FIRST ACTIVE pointer of its
     type, so a new primary of the SAME type proves the stored one has ended —
     while a genuine second finger arriving during a live stroke is never
     primary, and is still ignored by the guard below.

     This is the only recovery a FINGER has. The same-id branch below exists
     for a release lost outside the document (press, drag out of the embed
     frame, let go over the page), and it works for a mouse or a pen because
     those keep one pointerId for the whole session. Every touch gets a FRESH
     id, so that branch can never fire for one — and no pointerup,
     pointercancel or lostpointercapture will ever arrive for a finger that is
     already gone. Measured: one lost touch release left `drawing` true against
     an id nothing could match again, every later press was swallowed, and the
     sheet was dead until "new round" — which throws the whole round away. */
  function ownerGone(ev) {
    return ev.isPrimary === true && ev.pointerType === activeType;
  }

  function abortStroke() {
    if (activePointer !== null) {
      try { canvas.releasePointerCapture(activePointer); } catch (e) {}
    }
    drawing = false;
    activePointer = null;
    activeType = null;
    stroke = [];
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'pen') lastPenAt = ev.timeStamp || 0;
    if (!playing) return;
    if (revealing) {
      /* tap-to-continue: skip the rest of the reveal hold */
      ev.preventDefault();
      clearTimeout(revealTimer);
      nextStep();
      return;
    }
    if (!pair) return;
    if (drawing) {
      /* This very pointer is down twice with no release in between, which the
         pointer-events spec says cannot happen: its release was lost. (Press
         on the canvas, drag out of the embed frame, let go over the page — the
         SDK's own note describes it.) The old press is over, so drop it.
         Without this the `else return` below swallowed the new press while
         pointermove — which only checks `drawing` and the id, both still
         matching — kept appending its samples to the ABANDONED stroke. The two
         were welded and scored as one: measured, a clean A→B pull scored 0
         instead of 100, and the reveal blamed the player for 141px of drift
         they had already walked away from. */
      if (ev.pointerId === activePointer) abortStroke();
      /* the palm got here first — let the pen take the stroke over */
      else if (ev.pointerType === 'pen' && activeType !== 'pen') abortStroke();
      /* a finger's release was lost: the id is new but the old one is gone */
      else if (ownerGone(ev)) abortStroke();
      else return;
    }
    if (!penWins(ev)) return;
    ev.preventDefault();
    var p = pointerPos(ev);

    var r = startRadius();
    var d = Math.hypot(p.x - pair.a.x, p.y - pair.a.y);

    /* Carrying on a stroke a short throw forced you to break.
       The A ring wins wherever the two zones overlap: the drill's own words
       are "press inside the dashed circle to carry on, or on A to start
       over", and RESUME_PX (60) reaches well past A on a short abort — so
       without this test the press on A silently folded the abandoned pull
       into the scored stroke, at up to a third of the stroke's score.
       No deadline: proximity already tells "carry on" from "start over",
       and a player who pauses to read that sentence must not lose their
       ink for having read it. */
    if (pending && d > r &&
        Math.hypot(p.x - pending.lift.x, p.y - pending.lift.y) <= RESUME_PX) {
      stroke = pending.points;
      stroke.push(p);
      pending = null;
      drawing = true;
      activePointer = ev.pointerId;
      activeType = ev.pointerType;
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
      hint.textContent = strokeLabel() + ' — carrying on from where you lifted.';
      draw();
      return;
    }

    if (d > r * SNAP_MULT) {
      hint.textContent = strokeLabel() + ' — that was wide of A; press on or near the A dot.';
      return;
    }
    pending = null;
    snapped = d > r;
    drawing = true;
    activePointer = ev.pointerId;
    activeType = ev.pointerType;
    stroke = [p];
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    if (snapped) hint.textContent = strokeLabel() + ' — landed wide of A; measuring from where you started. pull to B.';
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (ev.pointerType === 'pen') lastPenAt = ev.timeStamp || 0;
    if (!drawing || ev.pointerId !== activePointer) return;
    ev.preventDefault();
    /* coalesced events: full-fidelity sampling of fast strokes. The canvas is
       measured ONCE for the whole run — see posIn(). */
    var rect = canvas.getBoundingClientRect();
    var evs = ArtDaily.samples(ev);
    for (var i = 0; i < evs.length; i++) stroke.push(posIn(evs[i], rect));
    draw();
  });

  function endStroke(ev) {
    if (!drawing || ev.pointerId !== activePointer) return;
    if (ev.cancelable) ev.preventDefault();
    drawing = false;
    activePointer = null;
    activeType = null;
    if (stroke.length < 2 || pathLength(stroke) < MIN_PATH_PX) {
      /* a press with no pull — no penalty, and say which it was */
      stroke = [];
      pending = null;
      hint.textContent = strokeLabel() + ' — that was a press, not a pull. no penalty, go again from A.';
      draw();
      return;
    }
    /* the attempt is judged in its own frame: from the sample the player
       actually landed on, to B */
    var a0 = { x: stroke[0].x, y: stroke[0].y };
    var last = stroke[stroke.length - 1];
    var prog = strokeProgress(stroke, a0, pair.b);
    var lenAB = Math.hypot(pair.b.x - a0.x, pair.b.y - a0.y);
    var reached = prog >= DONE_FRAC ||
      Math.hypot(last.x - pair.b.x, last.y - pair.b.y) <= startRadius();
    if (!reached) {
      /* a trackpad cannot throw 550px in one go. That is the pad running
         out, not a bad line — so it is not scored, it is resumable. */
      var pct = Math.max(0, Math.min(99, Math.round(prog * 100)));
      pending = { points: stroke, lift: { x: last.x, y: last.y } };
      stroke = [];
      hint.textContent = strokeLabel() + ' — you lifted at ' + pct +
        '% — no penalty. press inside the dashed circle to carry on, or on A to start over.';
      draw();
      return;
    }
    var ease = easeFactor();
    var sc = strokeScore(stroke, a0, pair.b, ease);
    var sd = steadiness(stroke);
    var wd = worstDrift(stroke, a0, pair.b);
    /* the same RMS straightness() grades, so the words and the number
       are two readings of one measurement, never two measurements */
    var rms = driftPx(stroke, a0, pair.b);
    var missB = Math.hypot(last.x - pair.b.x, last.y - pair.b.y);
    var endLoss = Math.round(endpointPenalty(0, missB, ease));
    scores.push(sc);
    biases.push(signedBias(stroke, a0, pair.b));
    revealing = {
      points: stroke,
      a: a0,
      b: pair.b,
      score: Math.round(sc),
      steadyWord: sd === null ? '' : (sd >= 70 ? 'steady pull' : 'hesitant'),
      /* copy the sample rather than aliasing into points[]: a resize
         rescales the stroke and the marker separately, and an alias
         would take the scale twice and drift off the line it marks */
      worst: wd ? {
        p: { x: stroke[wd.i].x, y: stroke[wd.i].y },
        foot: projectOnLine(stroke[wd.i], a0, pair.b),
        d: wd.d,
      } : null,
    };
    stroke = [];
    /* say which half of the score moved: a line that bowed and a line
       that stopped short are different mistakes with different fixes */
    var bow = driftWords(wd ? wd.d : Infinity, lenAB, ease, rms);
    var extra = bow ? ' · ' + bow : '';
    if (revealing.steadyWord) extra += ' · ' + revealing.steadyWord;
    if (endLoss >= 3) {
      extra += ' · −' + endLoss + ' ' +
        endMissWords((prog - 1) * lenAB, perpDist(last, a0, pair.b));
    }
    lastWords = 'last stroke ' + revealing.score + extra + '.';
    hint.textContent = strokeLabel() + ' — ' + revealing.score + extra +
      (strokeIdx === 0 ? '. the green line is the straight path you were aiming for; the dot is where you drifted widest. tap for next.' : '. tap for next.');
    draw();
    clearTimeout(revealTimer);
    if (scores.length >= STROKES_PER_ROUND) {
      /* report NOW, not after the reveal timer — a "new round" click (or a
         closed dialog, which tears the frame down) during this reveal must
         never swallow six finished strokes. The last reveal stays on the
         sheet until the next round starts. */
      finishRound();
    } else {
      revealTimer = setTimeout(nextStep, REVEAL_MS);
    }
  }
  canvas.addEventListener('pointerup', endStroke);
  /* fallback if pointer capture failed and the release lands off-canvas */
  window.addEventListener('pointerup', endStroke);
  /* iOS drops capture without a pointerup — treat it as the lift it is */
  canvas.addEventListener('lostpointercapture', endStroke);

  function cancelStroke(ev) {
    /* interrupted stroke (system gesture etc.) — reset, no penalty */
    if (!drawing || ev.pointerId !== activePointer) return;
    abortStroke();
    if (playing && !revealing) hint.textContent = strokeLabel() + ' — your device interrupted the stroke; no penalty, go again from A.';
    draw();
  }
  canvas.addEventListener('pointercancel', cancelStroke);
  window.addEventListener('pointercancel', cancelStroke);

  function nextStep() {
    if (!revealing) return;
    ghosts.push({ points: revealing.points, a: revealing.a, b: revealing.b });
    if (ghosts.length > GHOSTS_KEPT) ghosts.shift();
    revealing = null;
    pending = null;
    strokeIdx += 1;
    if (strokeIdx < STROKES_PER_ROUND) {
      makePair(strokeIdx);
      hint.textContent = playHint();
      draw();
      return;
    }
    finishRound();
  }

  function finishRound() {
    playing = false;
    pair = null;
    pending = null;
    draw();
    if (reported) return;   /* exactly once per round, on every path */
    reported = true;
    var res = ArtDaily.report(roundScore(scores));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    var coach = biasCoaching(biases);
    hint.textContent = 'round done — ' + (lastWords ? lastWords + ' ' : '') +
      (coach ? coach + ' ' : '') + 'press "new round" to go again.';
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  /* the hardware changed mid-session (a laptop user plugged in a tablet):
     the start ring is a different size now, so repaint it */
  ArtDaily.onInput(function () { draw(); });

  /* Everything already drawn is in CSS pixels placed against the old canvas
     box, so a resize has to carry it across or the reveal — the whole lesson
     — and the ghosts strand themselves off-screen. */
  function rescaleGeometry(sx, sy) {
    var g;
    for (g = 0; g < ghosts.length; g++) {
      scalePoints(ghosts[g].points, sx, sy);
      scalePoint(ghosts[g].a, sx, sy);
      scalePoint(ghosts[g].b, sx, sy);
    }
    if (revealing) {
      scalePoints(revealing.points, sx, sy);
      scalePoint(revealing.a, sx, sy);
      scalePoint(revealing.b, sx, sy);
      if (revealing.worst) {
        scalePoint(revealing.worst.p, sx, sy);
        scalePoint(revealing.worst.foot, sx, sy);
      }
    }
  }
  function scalePoint(p, sx, sy) { p.x *= sx; p.y *= sy; }
  function scalePoints(pts, sx, sy) {
    for (var i = 0; i < pts.length; i++) scalePoint(pts[i], sx, sy);
  }

  window.addEventListener('resize', function () {
    var oldW = W, oldH = H;
    fitCanvas();
    if (W === oldW && H === oldH) { draw(); return; }
    if (drawing || pending) {
      /* the canvas rescaled under an in-flight stroke (rotation) —
         void the attempt, no penalty, rather than scoring it against
         geometry placed for the old canvas */
      abortStroke();
      pending = null;
      if (playing && !revealing) hint.textContent = strokeLabel() + ' — the screen changed size; no penalty, go again from A.';
    }
    if (oldW > 0 && oldH > 0) rescaleGeometry(W / oldW, H / oldH);
    /* re-place the current pair so it always fits the new canvas */
    if (playing && !revealing) makePair(strokeIdx);
    draw();
  });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
