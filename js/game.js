/* ============================================================
   game.js — Steady Lines: ghost straight strokes through the
   checkpoints. Six endpoint pairs per round; press on A, pull one
   stroke to B, lift. Scoring is pure segment geometry (RMS drift
   from the ideal line + endpoint misses) — the pure functions sit
   at the top so they are unit-testable without a canvas. The two
   previous attempts stay faintly ghosted (with their ideal lines):
   ghosting lines is the actual studio warm-up this drill copies.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'lines';
  var STROKES_PER_ROUND = 6;
  var START_RADIUS = 28;   /* px around A that counts as a start */
  var MIN_SAMPLES = 8;     /* fewer sampled points = accidental tap */
  var REVEAL_MS = 1500;    /* reveal holds this long; a tap skips ahead */
  var GHOSTS_KEPT = 2;

  /* ============================================================
     Pure scoring — geometry in, 0–100 out. No canvas, no DOM.
     Points are {x,y} (input samples also carry t, a timestamp in
     ms, which only steadiness() reads).
     ============================================================ */
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

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

  /* RMS perpendicular drift of the samples, normalized by |AB|. */
  function strokeError(points, a, b) {
    var len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0 || points.length === 0) return 1;
    var sum = 0, d, i;
    for (i = 0; i < points.length; i++) {
      d = perpDist(points[i], a, b);
      sum += d * d;
    }
    return Math.sqrt(sum / points.length) / len;
  }

  /* The first 0.4% of drift is free (no hand stroke is at exactly
     zero, and a score of 100 must be reachable); zero at 5.5%. */
  function straightness(err) {
    return 100 * clamp01(1 - Math.max(0, err - 0.004) / 0.051);
  }

  /* First 24px of combined endpoint miss are free, then up to −20. */
  function endpointPenalty(missA, missB) {
    return 20 * clamp01((missA + missB - 24) / 160);
  }

  function strokeScore(points, a, b) {
    if (!points || points.length === 0) return 0;
    var first = points[0], last = points[points.length - 1];
    var missA = Math.hypot(first.x - a.x, first.y - a.y);
    var missB = Math.hypot(last.x - b.x, last.y - b.y);
    var s = straightness(strokeError(points, a, b)) - endpointPenalty(missA, missB);
    return Math.max(0, Math.min(100, s));
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

  /* Mean signed perpendicular offset as a fraction of |AB|.
     Positive = the stroke bows right of the pull direction
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

  /* Round-end coaching: if most strokes bow the same way, say so.
     Takes the per-stroke signedBias values; returns '' when there is
     no consistent tendency worth reporting. */
  function biasCoaching(biasList) {
    var right = 0, left = 0, i;
    for (i = 0; i < biasList.length; i++) {
      if (biasList[i] > 0.006) right += 1;
      else if (biasList[i] < -0.006) left += 1;
    }
    if (right >= 4 && right > left) return 'your strokes bow right of the pull — aim a hair left.';
    if (left >= 4 && left > right) return 'your strokes bow left of the pull — aim a hair right.';
    return '';
  }

  function roundScore(scores) {
    if (!scores.length) return 0;
    var sum = 0, i;
    for (i = 0; i < scores.length; i++) sum += scores[i];
    return sum / scores.length;
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

  /* ---- round state ---- */
  var round = 0, strokeIdx = 0, scores = [], biases = [], pair = null, playing = false;
  var drawing = false, stroke = [], ghosts = [], revealing = null, revealTimer = null;
  var activePointer = null; /* one stroke = one pointer; palms and second fingers are ignored */

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

  function strokeLabel() { return 'stroke ' + (strokeIdx + 1) + ' of ' + STROKES_PER_ROUND; }

  /* Later strokes are longer (35% → 80% of canvas width); orientation
     cycles near-horizontal / diagonal / near-vertical with jitter. */
  function makePair(idx) {
    var margin = 26;
    var t = idx / (STROKES_PER_ROUND - 1);
    var frac = Math.max(0.35, Math.min(0.80, 0.35 + 0.45 * t + rand(-0.03, 0.03)));
    var len = W * frac;
    var base = [0, 45, 90, 135][idx % 4];
    var ang = (base + rand(-12, 12)) * Math.PI / 180;
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
    ghosts = [];
    stroke = [];
    drawing = false;
    activePointer = null;
    revealing = null;
    playing = true;
    makePair(0);
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    hint.textContent = strokeLabel() + ' — press on A, pull one stroke to B.';
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
      /* dashed grab zone: shows where a stroke may start (56px wide) */
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(a.x, a.y, START_RADIUS, 0, Math.PI * 2);
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

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    /* ghosting: the two previous attempts stay faintly on the page,
       each with its ideal segment so the lesson persists */
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

    if (!playing) return;

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
    if (drawing) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      drawPolyline(stroke);
    }
  }

  /* ---- input: one pointer stroke from A to B ---- */
  function pointerPos(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, t: ev.timeStamp || 0 };
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (!playing) return;
    if (revealing) {
      /* tap-to-continue: skip the rest of the reveal hold */
      ev.preventDefault();
      clearTimeout(revealTimer);
      nextStep();
      return;
    }
    if (drawing || !pair) return;
    ev.preventDefault();
    var p = pointerPos(ev);
    if (Math.hypot(p.x - pair.a.x, p.y - pair.a.y) > START_RADIUS) {
      hint.textContent = 'start at the A dot.';
      return;
    }
    drawing = true;
    activePointer = ev.pointerId;
    stroke = [p];
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (!drawing || ev.pointerId !== activePointer) return;
    ev.preventDefault();
    /* coalesced events: full-fidelity sampling of fast strokes */
    var evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : null;
    if (evs && evs.length) {
      for (var i = 0; i < evs.length; i++) stroke.push(pointerPos(evs[i]));
    } else {
      stroke.push(pointerPos(ev));
    }
    draw();
  });

  function endStroke(ev) {
    if (!drawing || ev.pointerId !== activePointer) return;
    ev.preventDefault();
    drawing = false;
    activePointer = null;
    if (stroke.length < MIN_SAMPLES) {
      /* accidental tap — reset the attempt, no penalty */
      stroke = [];
      hint.textContent = strokeLabel() + ' — just a tap; pull a full stroke from A to B.';
      draw();
      return;
    }
    var sc = strokeScore(stroke, pair.a, pair.b);
    var sd = steadiness(stroke);
    var wd = worstDrift(stroke, pair.a, pair.b);
    scores.push(sc);
    biases.push(signedBias(stroke, pair.a, pair.b));
    revealing = {
      points: stroke,
      a: pair.a,
      b: pair.b,
      score: Math.round(sc),
      steadyWord: sd === null ? '' : (sd >= 70 ? 'steady pull' : 'hesitant'),
      /* copy the sample rather than aliasing into points[]: a resize
         rescales the stroke and the marker separately, and an alias
         would take the scale twice and drift off the line it marks */
      worst: wd ? {
        p: { x: stroke[wd.i].x, y: stroke[wd.i].y },
        foot: projectOnLine(stroke[wd.i], pair.a, pair.b),
        d: wd.d,
      } : null,
    };
    stroke = [];
    var extra = revealing.steadyWord ? ' · ' + revealing.steadyWord : '';
    hint.textContent = strokeLabel() + ' — ' + revealing.score + extra +
      (strokeIdx === 0 ? '. mint = ideal, dot = widest drift. tap for next.' : '. tap for next.');
    draw();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(nextStep, REVEAL_MS);
  }
  canvas.addEventListener('pointerup', endStroke);
  /* fallback if pointer capture failed and the release lands off-canvas */
  window.addEventListener('pointerup', endStroke);

  canvas.addEventListener('pointercancel', function (ev) {
    /* interrupted stroke (system gesture etc.) — reset, no penalty */
    if (!drawing || ev.pointerId !== activePointer) return;
    drawing = false;
    activePointer = null;
    stroke = [];
    if (playing && !revealing) hint.textContent = strokeLabel() + ' — stroke interrupted; go again from A.';
    draw();
  });

  function nextStep() {
    if (!revealing) return;
    ghosts.push({ points: revealing.points, a: revealing.a, b: revealing.b });
    if (ghosts.length > GHOSTS_KEPT) ghosts.shift();
    revealing = null;
    strokeIdx += 1;
    if (strokeIdx < STROKES_PER_ROUND) {
      makePair(strokeIdx);
      hint.textContent = strokeLabel() + ' — press on A, pull one stroke to B.';
      draw();
      return;
    }
    finishRound();
  }

  function finishRound() {
    playing = false;
    pair = null;
    draw();
    var res = ArtDaily.report(roundScore(scores));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    var coach = biasCoaching(biases);
    hint.textContent = 'round done — ' + (coach ? coach + ' ' : '') + 'press "new round" to go again.';
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
    if (drawing) {
      /* the canvas rescaled under an in-flight stroke (rotation) —
         void the attempt, no penalty, rather than scoring it against
         geometry placed for the old canvas */
      drawing = false;
      activePointer = null;
      stroke = [];
      if (playing && !revealing) hint.textContent = strokeLabel() + ' — screen changed; go again from A.';
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
