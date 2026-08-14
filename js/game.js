/* ============================================================
   game.js — Steady Lines: ghost straight strokes through the
   checkpoints. Six endpoint pairs per round; press on A, pull one
   stroke to B, lift. Scoring is pure segment geometry (RMS drift
   from the ideal line + endpoint misses) — the pure functions sit
   at the top so they are unit-testable without a canvas. The two
   previous attempts stay faintly ghosted: ghosting lines is the
   actual studio warm-up this drill copies.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'lines';
  var STROKES_PER_ROUND = 6;
  var START_RADIUS = 28;   /* px around A that counts as a start */
  var MIN_SAMPLES = 8;     /* fewer sampled points = accidental tap */
  var REVEAL_MS = 700;
  var GHOSTS_KEPT = 2;

  /* ============================================================
     Pure scoring — geometry in, 0–100 out. No canvas, no DOM.
     ============================================================ */
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  /* Perpendicular distance from point p to the line through a→b. */
  function perpDist(p, a, b) {
    var abx = b.x - a.x, aby = b.y - a.y;
    var len = Math.hypot(abx, aby);
    if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(abx * (p.y - a.y) - aby * (p.x - a.x)) / len;
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

  /* Drift of 5.5% of the stroke's own length scores zero. */
  function straightness(err) { return 100 * clamp01(1 - err / 0.055); }

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

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  function inks() {
    var cs = getComputedStyle(document.documentElement);
    return {
      ink: cs.getPropertyValue('--ink').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--mint').trim(),
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 0.62);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---- round state ---- */
  var round = 0, strokeIdx = 0, scores = [], pair = null, playing = false;
  var drawing = false, stroke = [], ghosts = [], revealing = null, revealTimer = null;

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
    ghosts = [];
    stroke = [];
    drawing = false;
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
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.accent;
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

    /* ghosting: the two previous attempts stay faintly on the page */
    if (ghosts.length) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 2;
      for (var g = 0; g < ghosts.length; g++) drawPolyline(ghosts[g]);
      ctx.restore();
    }

    if (!playing) return;

    if (revealing) {
      /* the player's ink, then the ideal overlaid in accent */
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      drawPolyline(revealing.points);
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(revealing.a.x, revealing.a.y);
      ctx.lineTo(revealing.b.x, revealing.b.y);
      ctx.stroke();
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
      ctx.fillStyle = c.accent;
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
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (!playing || revealing || drawing || !pair) return;
    ev.preventDefault();
    var p = pointerPos(ev);
    if (Math.hypot(p.x - pair.a.x, p.y - pair.a.y) > START_RADIUS) {
      hint.textContent = 'start at the A dot.';
      return;
    }
    drawing = true;
    stroke = [p];
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (!drawing) return;
    ev.preventDefault();
    stroke.push(pointerPos(ev));
    draw();
  });

  function endStroke(ev) {
    if (!drawing) return;
    ev.preventDefault();
    drawing = false;
    if (stroke.length < MIN_SAMPLES) {
      /* accidental tap — reset the attempt, no penalty */
      stroke = [];
      hint.textContent = strokeLabel() + ' — just a tap; pull a full stroke from A to B.';
      draw();
      return;
    }
    var sc = strokeScore(stroke, pair.a, pair.b);
    scores.push(sc);
    revealing = { points: stroke, a: pair.a, b: pair.b, score: Math.round(sc) };
    stroke = [];
    hint.textContent = strokeLabel() + ' — ' + revealing.score + '. the mint line is the ideal.';
    draw();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(nextStep, REVEAL_MS);
  }
  canvas.addEventListener('pointerup', endStroke);
  /* fallback if pointer capture failed and the release lands off-canvas */
  window.addEventListener('pointerup', endStroke);

  canvas.addEventListener('pointercancel', function () {
    /* interrupted stroke (system gesture etc.) — reset, no penalty */
    if (!drawing) return;
    drawing = false;
    stroke = [];
    if (playing && !revealing) hint.textContent = strokeLabel() + ' — stroke interrupted; go again from A.';
    draw();
  });

  function nextStep() {
    if (!revealing) return;
    ghosts.push(revealing.points);
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
    hint.textContent = 'round done — press "new round" to go again.';
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
  window.addEventListener('resize', function () {
    fitCanvas();
    /* re-place the current pair so it always fits the new canvas */
    if (playing && !revealing && !drawing) makePair(strokeIdx);
    draw();
  });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
