/* Jarvis FUI v1 — orb + HUD chrome. Prototype only; production HUD untouched.
   Orb: neural connectome shell + soft core + horizontal ripple waves (ref match).
   Query: ?live=1 animates; ?t=4.2 freezes time (default freeze-friendly). */

const HUE = 200;

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function idleEnergy(t) {
  const breathe = Math.sin(t * 1.25) * 0.5 + 0.5;
  return 0.28 + breathe * 0.16;
}

function fibSphere(n, seed) {
  const rnd = seeded(seed);
  const pts = [];
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = phi * i + rnd() * 0.08;
    pts.push({
      x: Math.cos(theta) * r,
      y,
      z: Math.sin(theta) * r,
      bright: 0.35 + rnd() * 0.65,
      phase: rnd() * Math.PI * 2,
      size: 0.55 + rnd() * 1.15,
    });
  }
  return pts;
}

function project(p, cx, cy, R, rotY, rotX, depthScale) {
  const cosY = Math.cos(rotY),
    sinY = Math.sin(rotY);
  const cosX = Math.cos(rotX),
    sinX = Math.sin(rotX);
  let x = p.x * cosY - p.z * sinY;
  let z = p.x * sinY + p.z * cosY;
  let y = p.y * cosX - z * sinX;
  z = p.y * sinX + z * cosX;
  const persp = 1 + z * (depthScale || 0.22);
  return {
    sx: cx + x * R * persp,
    sy: cy + y * R * persp * 0.96,
    depth: z,
    scale: persp,
  };
}

function buildLinks(nodes, maxDist, maxPer, seed) {
  const rnd = seeded(seed);
  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    const candidates = [];
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      const dz = nodes[i].z - nodes[j].z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < maxDist) candidates.push({ j, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    const take = Math.min(maxPer, candidates.length);
    for (let k = 0; k < take; k++) {
      if (rnd() > 0.38) continue;
      links.push({
        a: i,
        b: candidates[k].j,
        phase: rnd() * Math.PI * 2,
        speed: 0.55 + rnd() * 1.4,
      });
    }
  }
  return links;
}

function drawCore(ctx, cx, cy, R, hue, energy) {
  const coreR = R * (0.28 + energy * 0.12);

  let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.8);
  g.addColorStop(0, `hsla(${hue},100%,${74 + energy * 16}%,${0.48 + energy * 0.38})`);
  g.addColorStop(0.22, `hsla(${hue},100%,58%,${0.22 + energy * 0.24})`);
  g.addColorStop(0.55, `hsla(${hue},100%,50%,${0.07 + energy * 0.08})`);
  g.addColorStop(1, `hsla(${hue},100%,50%,0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 2.8, 0, 7);
  ctx.fill();

  g = ctx.createRadialGradient(cx, cy, coreR * 0.08, cx, cy, coreR);
  g.addColorStop(0, `hsla(${hue},95%,90%,${0.38 + energy * 0.32})`);
  g.addColorStop(0.65, `hsla(${hue},95%,62%,${0.12 + energy * 0.12})`);
  g.addColorStop(1, `hsla(${hue},95%,55%,0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, 7);
  ctx.fill();
  return coreR;
}

/**
 * Horizontal concentric ripple waves / frequency arcs — signature of the
 * battlestation reference: left-right through the orb, not chronograph ticks.
 */
function drawHorizontalRipples(ctx, cx, cy, R, hue, energy, t) {
  const waveCount = 7;
  const breathe = Math.sin(t * 1.1) * 0.5 + 0.5;

  for (let i = 0; i < waveCount; i++) {
    const k = (i + 1) / waveCount;
    /* elliptical rings flattened on Y — reads as horizontal frequency arcs */
    const rx = R * (0.22 + k * 0.72) * (1 + Math.sin(t * 0.55 + i * 0.7) * 0.018);
    const ry = R * (0.08 + k * 0.22) * (0.85 + breathe * 0.08);
    const phase = t * (0.35 + i * 0.04) + i * 0.9;
    const pulse = 0.55 + 0.45 * Math.sin(phase);

    /* soft filled band */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const bandA = (0.055 + energy * 0.07) * (1.15 - k * 0.5) * pulse;
    ctx.strokeStyle = `hsla(${hue},100%,${68 + pulse * 14}%,${bandA})`;
    ctx.lineWidth = 1.5 + (1 - k) * 2.8;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    /* brighter arc segments left & right (soundwave energy look) */
    const arcAlpha = (0.16 + energy * 0.18) * (1 - k * 0.35) * pulse;
    ctx.strokeStyle = `hsla(${hue},100%,${78 + pulse * 10}%,${arcAlpha})`;
    ctx.lineWidth = 2.0 + pulse * 1.4;
    ctx.lineCap = 'round';

    /* right-side arc */
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, -0.55 + Math.sin(phase) * 0.08, 0.55 + Math.sin(phase) * 0.08);
    ctx.stroke();
    /* left-side arc */
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, Math.PI - 0.55, Math.PI + 0.55);
    ctx.stroke();

    /* jagged frequency spikes on outer 2–3 rings (audio-waveform feel) */
    if (i >= waveCount - 3) {
      const spikes = 18;
      ctx.strokeStyle = `hsla(${hue},100%,75%,${0.06 + energy * 0.08 * pulse})`;
      ctx.lineWidth = 1.0;
      for (let s = 0; s < spikes; s++) {
        const u = s / spikes;
        const ang = -0.85 + u * 1.7; /* right lobe */
        const angL = Math.PI - 0.85 + u * 1.7;
        const amp = (0.04 + 0.07 * Math.abs(Math.sin(phase * 1.4 + s * 1.7))) * R * (0.3 + k);
        const x0 = cx + Math.cos(ang) * rx;
        const y0 = cy + Math.sin(ang) * ry;
        const x1 = cx + Math.cos(ang) * (rx + amp);
        const y1 = cy + Math.sin(ang) * (ry + amp * 0.35);
        if (s % 2 === 0) {
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
        const lx0 = cx + Math.cos(angL) * rx;
        const ly0 = cy + Math.sin(angL) * ry;
        const lx1 = cx + Math.cos(angL) * (rx + amp);
        const ly1 = cy + Math.sin(angL) * (ry + amp * 0.35);
        if (s % 2 === 1) {
          ctx.beginPath();
          ctx.moveTo(lx0, ly0);
          ctx.lineTo(lx1, ly1);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /* traveling horizontal energy band through center */
  const bandY = cy + Math.sin(t * 0.9) * R * 0.04;
  const g = ctx.createLinearGradient(cx - R * 1.05, bandY, cx + R * 1.05, bandY);
  const ba = 0.14 + energy * 0.16;
  g.addColorStop(0, `hsla(${hue},100%,70%,0)`);
  g.addColorStop(0.25, `hsla(${hue},100%,75%,${ba * 0.5})`);
  g.addColorStop(0.5, `hsla(${hue},100%,85%,${ba})`);
  g.addColorStop(0.75, `hsla(${hue},100%,75%,${ba * 0.5})`);
  g.addColorStop(1, `hsla(${hue},100%,70%,0)`);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.fillRect(cx - R * 1.05, bandY - 1.5, R * 2.1, 3);
  ctx.restore();
}

function drawShellHint(ctx, cx, cy, R, hue, alpha) {
  ctx.strokeStyle = `hsla(${hue},70%,55%,${alpha})`;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.94, 0, 7);
  ctx.stroke();
}

/* ---------- Orb state ---------- */
const orbState = {
  nodes: null,
  links: null,
  init() {
    this.nodes = fibSphere(78, 101);
    this.links = buildLinks(this.nodes, 0.70, 4, 202);
  },
};

function drawOrb(ctx, W, H, t) {
  if (!orbState.nodes) orbState.init();
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2;
  const energy = idleEnergy(t);
  const rotY = t * 0.10;
  const rotX = 0.26 + Math.sin(t * 0.07) * 0.05;

  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';

  drawCore(ctx, cx, cy, R, HUE, energy);

  /* Horizontal ripples — draw mid-stack so mesh sits on top slightly */
  drawHorizontalRipples(ctx, cx, cy, R * 0.92, HUE, energy, t);

  const projected = orbState.nodes.map((n) => {
    const pr = project(n, cx, cy, R * 0.72, rotY, rotX, 0.2);
    return Object.assign(pr, { bright: n.bright, size: n.size, phase: n.phase });
  });

  const linkDraw = orbState.links
    .map((L) => {
      const A = projected[L.a],
        B = projected[L.b];
      return { A, B, mid: (A.depth + B.depth) * 0.5, L };
    })
    .sort((a, b) => a.mid - b.mid);

  linkDraw.forEach(({ A, B, L }) => {
    const depthFade = 0.35 + ((A.depth + B.depth) * 0.5 + 1) * 0.32;
    const pulse = 0.55 + 0.45 * Math.sin(t * L.speed + L.phase);
    ctx.strokeStyle = `hsla(${HUE},100%,${62 + pulse * 12}%,${(0.07 + energy * 0.10) * depthFade * pulse})`;
    ctx.lineWidth = 0.65 + pulse * 0.45;
    ctx.beginPath();
    ctx.moveTo(A.sx, A.sy);
    ctx.lineTo(B.sx, B.sy);
    ctx.stroke();
  });

  projected
    .slice()
    .sort((a, b) => a.depth - b.depth)
    .forEach((p) => {
      const twinkle = 0.7 + 0.3 * Math.sin(t * 1.8 + p.phase);
      const depthFade = 0.4 + (p.depth + 1) * 0.35;
      const sz = (p.size * 1.05 + energy * 0.7) * (0.85 + p.scale * 0.2) * twinkle;
      const a = (0.16 + p.bright * 0.42) * (0.55 + energy) * depthFade;
      ctx.fillStyle = `hsla(${HUE},100%,${70 + p.bright * 18}%,${a})`;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, sz, 0, 7);
      ctx.fill();
      if (p.bright > 0.72 && p.depth > -0.15) {
        const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, sz * 3.5);
        g.addColorStop(0, `hsla(${HUE},100%,80%,${a * 0.3})`);
        g.addColorStop(1, `hsla(${HUE},100%,60%,0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, sz * 3.5, 0, 7);
        ctx.fill();
      }
    });

  ctx.globalCompositeOperation = 'source-over';
  drawShellHint(ctx, cx, cy, R, HUE, 0.16);
}

/* ---------- Sparklines (fake metrics chrome) ---------- */
function drawSpark(canvas, seed, t) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const tw = Math.round(w * dpr),
    th = Math.round(h * dpr);
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw;
    canvas.height = th;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const rnd = seeded(seed);
  const pts = 28;
  const values = [];
  let v = 0.4 + rnd() * 0.2;
  for (let i = 0; i < pts; i++) {
    v += (rnd() - 0.48) * 0.18 + Math.sin(t * 0.8 + i * 0.4 + seed) * 0.02;
    v = Math.max(0.08, Math.min(0.95, v));
    values.push(v);
  }

  ctx.beginPath();
  values.forEach((val, i) => {
    const x = (i / (pts - 1)) * w;
    const y = h - val * (h - 2) - 1;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = `hsla(${HUE},100%,70%,0.75)`;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = `hsla(${HUE},100%,70%,0.45)`;
  ctx.shadowBlur = 4;
  ctx.stroke();
  ctx.shadowBlur = 0;

  /* fill under curve */
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `hsla(${HUE},100%,60%,0.25)`);
  g.addColorStop(1, `hsla(${HUE},100%,50%,0)`);
  ctx.fillStyle = g;
  ctx.fill();
}

/* ---------- Clock (NL date) ---------- */
const DAYS_NL = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const MONTHS_NL = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];

function updateClock(now) {
  const elTime = document.getElementById('clock-time');
  const elDate = document.getElementById('clock-date');
  if (!elTime) return;
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  elTime.textContent = `${hh}:${mm}`;
  const day = DAYS_NL[now.getDay()];
  const date = now.getDate();
  const month = MONTHS_NL[now.getMonth()];
  elDate.textContent = `${day} ${date} ${month}`.toUpperCase();
}

/* ---------- Boot ---------- */
const params = new URLSearchParams(location.search);
const freezeT = parseFloat(params.get('t') || '4.2');
const animate = params.get('live') === '1';

const canvas = document.getElementById('orb');
const sparkIds = ['spark-cpu', 'spark-net', 'spark-io'];

function sizeOrb() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const css = canvas.getBoundingClientRect();
  const tw = Math.round(css.width * dpr);
  const th = Math.round(css.height * dpr);
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw;
    canvas.height = th;
  }
  return { tw, th };
}

function paintFrame(t) {
  sizeOrb();
  const ctx = canvas.getContext('2d');
  drawOrb(ctx, canvas.width, canvas.height, t);
  sparkIds.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) drawSpark(el, 900 + i * 17, t);
  });
}

function boot() {
  updateClock(new Date());
  if (animate) {
    let t0 = performance.now();
    function frame(now) {
      const t = (now - t0) / 1000;
      paintFrame(t);
      if (now % 2000 < 20) updateClock(new Date());
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  } else {
    paintFrame(freezeT);
    document.documentElement.setAttribute('data-ready', '1');
  }
}

window.addEventListener('resize', () => {
  const t = animate ? (performance.now() / 1000) % 1000 : freezeT;
  paintFrame(t);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
