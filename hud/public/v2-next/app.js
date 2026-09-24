/* Jarvis FUI v2-next — live production HUD (anim + CoreLink).
   Visual design frozen (usage-pass2 look at rest). Boot + focus animation kept.

   Core WS focus contract (jarvis-core PR #11 — FINAL):
     {kind:'focus', panel:string, cue?: DisplayCue}
       panel = desk topic (weather|agenda|mail|work|notes|+packs). Cue-gated like
       v1 displays (focus applies when cue fires, not on arrival). Change-only.
       Also emitted in non-briefing turns. Core is source of truth.
     {kind:'unfocus'} — end of turn (done / error / client cancel).
     done.briefing?: boolean (typed).
     usage persisted server-side; sent on connect after ≥1 turn since that deploy.
   Interim client focus derivation: fallback ONLY if Core never sent focus on this
   connection (core-link.js). Never double-fires with Core focus.
   Stale focus guard: 20s (not a short idle timer — would fight Core unfocus).
   'system' is never Core-focused; client key S still focuses it.

   Single WebSocket owned by CoreLink (live-bridge.js). ?usage= still overrides gauges.
   ?t= / ?live=0 skip boot to resting. ?boot=replay / B. ?focus= after boot.
   Keys: Space talk (CoreLink) · 1-4 voice test only with ?dev=1|?live=0 ·
         B boot · W/A/N/M/P/S focus · Esc unfocus.
*/

const HUE = 200;
const ACCENT = 22; /* orange/amber accents like the pin */

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}


/* Voice / demo state — drives energy, ring speed, sweep, bloom */
let voiceState = 'idle'; /* idle | listening | thinking | speaking */
let waveAmp = 0.55; /* waveform amplitude multiplier */
let liveAudioLevel = 0; /* 0..1 from CoreLink playback/mic */
function setLiveAudioLevel(n) {
  liveAudioLevel = Math.max(0, Math.min(1, Number(n) || 0));
  if (liveAudioLevel > 0.02) waveAmp = Math.max(waveAmp, 0.35 + liveAudioLevel * 1.4);
}

let ringSpeedMul = 1;
let sweepMul = 1;
let bloomMul = 1;

const VOICE_PRESETS = {
  idle:      { energyBase: 0.38, energyAmp: 0.18, breatheHz: 1.15, ring: 1.0,  sweep: 0.9,  bloom: 1.0,  wave: 0.0  },
  listening: { energyBase: 0.55, energyAmp: 0.22, breatheHz: 2.2,  ring: 1.55, sweep: 1.7,  bloom: 1.35, wave: 0.28 },
  thinking:  { energyBase: 0.68, energyAmp: 0.18, breatheHz: 3.1,  ring: 2.2,  sweep: 2.4,  bloom: 1.65, wave: 0.18 },
  speaking:  { energyBase: 0.78, energyAmp: 0.28, breatheHz: 2.6,  ring: 1.85, sweep: 1.9,  bloom: 2.15, wave: 1.65 },
};

const STATUS_COPY = {
  idle:      { label: 'STANDBY',  sub: 'Neural core · idle breathe' },
  listening: { label: 'LISTENING', sub: 'Mic open · hearing' },
  thinking:  { label: 'THINKING',  sub: 'Composer · synthesizing' },
  speaking:  { label: 'SPEAKING',  sub: 'TTS · through-orb waveform' },
};

function applyVoicePreset(state) {
  voiceState = state;
  const p = VOICE_PRESETS[state] || VOICE_PRESETS.idle;
  ringSpeedMul = p.ring;
  sweepMul = p.sweep;
  bloomMul = p.bloom;
  waveAmp = p.wave;
  document.documentElement.setAttribute('data-voice', state);

  const copy = STATUS_COPY[state] || STATUS_COPY.idle;
  const orbState = document.getElementById('orb-state');
  const orbSub = document.getElementById('orb-sub');
  const footer = document.getElementById('footer-standby');
  const pill = document.getElementById('voice-pill');
  const pillText = document.getElementById('voice-pill-text');
  if (orbState) orbState.textContent = copy.label;
  if (orbSub) orbSub.textContent = copy.sub;
  if (footer) footer.textContent = copy.label;
  if (pill && pillText) {
    if (state === 'idle') {
      pill.hidden = true;
    } else {
      pill.hidden = false;
      pill.dataset.state = state;
      pillText.textContent = copy.label;
    }
  }
}


function idleEnergy(t) {
  const p = VOICE_PRESETS[voiceState] || VOICE_PRESETS.idle;
  const breathe = Math.sin(t * p.breatheHz) * 0.5 + 0.5;
  return p.energyBase + breathe * p.energyAmp;
}

/* Outer containment hairline radius, as a multiple of orb R.
   Shared by the containment stroke and the radar sweep reach. */
const OUTER_CONTAINMENT = 1.08;

/* Sparse ring language — thinner/fewer than option C, cyan-only */
const RING_LAYERS = [
  { r: 0.34, style: 'solid', w: 0.7, speed: 0, alpha: 0.28 },
  { r: 0.42, style: 'segs', segs: 4, gap: 0.42, w: 1.35, speed: 0.14, alpha: 0.48 },
  { r: 0.52, style: 'dash', dash: [2.5, 6], w: 0.7, speed: -0.16, alpha: 0.28 },
  { r: 0.62, style: 'segs', segs: 5, gap: 0.30, w: 1.5, speed: 0.08, alpha: 0.45 },
  { r: 0.72, style: 'ticks', tickN: 64, tickLen: 0.028, w: 0.7, speed: -0.05, alpha: 0.36 },
  { r: 0.84, style: 'segs', segs: 6, gap: 0.22, w: 1.15, speed: 0.07, alpha: 0.38 },
  { r: 0.96, style: 'dash', dash: [4, 5], w: 0.75, speed: -0.04, alpha: 0.22 },
  { r: 1.06, style: 'ticks', tickN: 72, tickLen: 0.018, w: 0.55, speed: 0.03, alpha: 0.20 },
];

/* Orb build gates for boot choreography. Resting state leaves all at full. */
const orbBoot = {
  core: 1,       /* 0..1 soft-core / plasma opacity */
  rings: RING_LAYERS.length, /* how many rings are revealed */
  ringDraw: 1,   /* 0..1 arc progress on the newest ring */
  sweep: true,   /* radar sweep armed */
  contain: true, /* outer containment hairline */
};

/* Deterministic plasma particles (seeded RNG — freeze frames stay stable) */
const PARTICLES = (() => {
  const rnd = seeded(0x4a525649); /* JARV */
  const list = [];
  for (let i = 0; i < 160; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = Math.pow(rnd(), 0.55); /* denser toward rim for plasma disk */
    list.push({
      a,
      r: 0.08 + rr * 0.88,
      size: 0.6 + rnd() * 2.2,
      phase: rnd() * Math.PI * 2,
      speed: 0.15 + rnd() * 0.55,
      bright: 0.35 + rnd() * 0.65,
      orbit: (rnd() - 0.5) * 0.12,
    });
  }
  return list;
})();

function drawArcSeg(ctx, cx, cy, r, a0, a1) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
}

/* ---------- Soft filled energy disk (deep navy → cyan rim) ---------- */
function drawSoftCore(ctx, cx, cy, R, hue, energy, t) {
  const pulse = 0.92 + 0.08 * Math.sin(t * (1.8 + (voiceState === 'speaking' ? 2.4 : voiceState === 'thinking' ? 1.6 : 0)));
  const coreR = R * (0.30 + energy * 0.018) * pulse; /* large filled disk, not a pin-point */
  const bm = bloomMul;

  /* Outer atmospheric bloom */
  let g = ctx.createRadialGradient(cx, cy, coreR * 0.55, cx, cy, coreR * (2.4 + bm * 0.35));
  g.addColorStop(0, `hsla(${hue},100%,55%,${(0.22 + energy * 0.18) * bm})`);
  g.addColorStop(0.35, `hsla(${hue},95%,48%,${(0.10 + energy * 0.08) * bm})`);
  g.addColorStop(0.7, `hsla(${hue},90%,40%,${0.03 * bm})`);
  g.addColorStop(1, `hsla(${hue},80%,35%,0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 2.6, 0, 7);
  ctx.fill();

  /* Filled disk body — deep navy center → luminous cyan rim */
  g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  g.addColorStop(0.0, `hsla(215, 72%, 7%, 0.97)`);          /* deep navy heart */
  g.addColorStop(0.18, `hsla(212, 78%, 11%, 0.94)`);
  g.addColorStop(0.40, `hsla(${hue}, 88%, 18%, 0.90)`);
  g.addColorStop(0.62, `hsla(${hue}, 95%, 36%, ${0.58 + energy * 0.18})`);
  g.addColorStop(0.82, `hsla(${hue}, 100%, 58%, ${0.78 + energy * 0.15})`);
  g.addColorStop(0.94, `hsla(${hue}, 100%, 72%, ${0.85 + energy * 0.12})`);
  g.addColorStop(1.0, `hsla(${hue}, 100%, 85%, ${0.55 + energy * 0.22})`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, 7);
  ctx.fill();

  /* Soft rim highlight ring */
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  g = ctx.createRadialGradient(cx, cy, coreR * 0.78, cx, cy, coreR * 1.08);
  g.addColorStop(0, `hsla(${hue},100%,70%,0)`);
  g.addColorStop(0.55, `hsla(${hue},100%,75%,${0.18 + energy * 0.2})`);
  g.addColorStop(0.85, `hsla(${hue},100%,85%,${0.45 + energy * 0.25})`);
  g.addColorStop(1, `hsla(${hue},100%,90%,0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 1.1, 0, 7);
  ctx.fill();

  /* Inner specular crescent (sphere volume cue) */
  g = ctx.createRadialGradient(
    cx - coreR * 0.28, cy - coreR * 0.32, 0,
    cx - coreR * 0.1, cy - coreR * 0.1, coreR * 0.7
  );
  g.addColorStop(0, `hsla(${hue},100%,88%,${0.14 + energy * 0.08})`);
  g.addColorStop(0.5, `hsla(${hue},90%,60%,0.04)`);
  g.addColorStop(1, `hsla(${hue},80%,40%,0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 0.92, 0, 7);
  ctx.fill();
  ctx.restore();

  return coreR;
}

/* ---------- Plasma / particle texture inside the disk ---------- */
function drawPlasma(ctx, cx, cy, coreR, hue, energy, t) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 0.96, 0, 7);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';

  /* Soft swirling nebula washes */
  for (let i = 0; i < 5; i++) {
    const ang = t * (0.18 + i * 0.05) + i * 1.3;
    const rr = coreR * (0.25 + (i % 3) * 0.18);
    const px = cx + Math.cos(ang) * rr * 0.55;
    const py = cy + Math.sin(ang * 0.9) * rr * 0.4;
    const rad = coreR * (0.35 + (i % 2) * 0.15);
    const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
    const a = (0.04 + energy * 0.05) * (0.7 + 0.3 * Math.sin(t * 1.2 + i));
    g.addColorStop(0, `hsla(${hue + i * 3},100%,70%,${a})`);
    g.addColorStop(1, `hsla(${hue},100%,50%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, 7);
    ctx.fill();
  }

  /* Speckled plasma particles */
  for (let i = 0; i < PARTICLES.length; i++) {
    const p = PARTICLES[i];
    const a = p.a + t * p.orbit + Math.sin(t * p.speed + p.phase) * 0.08;
    const breathe = 0.92 + 0.08 * Math.sin(t * (1.4 + p.speed) + p.phase);
    const rr = coreR * p.r * breathe;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr * 0.92; /* slight vertical squash = sphere cue */
    const tw = 0.45 + 0.55 * Math.sin(t * (2.0 + p.speed) + p.phase);
    const alpha = (0.08 + energy * 0.12) * p.bright * tw;
    const sz = p.size * (0.7 + energy * 0.35);
    ctx.fillStyle = `hsla(${hue},100%,${70 + tw * 25}%,${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, sz, 0, 7);
    ctx.fill();
  }

  ctx.restore();
}

/* ---------- Thin sparse radar rings ---------- */
function drawRings(ctx, cx, cy, R, hue, energy, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const breathe = 1 + Math.sin(t * 0.55) * 0.01;
  const RR = R * breathe;

  /* faint hairline guides */
  for (let i = 0; i < 3; i++) {
    const rr = RR * (0.38 + i * 0.22);
    ctx.strokeStyle = `hsla(${hue},80%,60%,${0.04 + energy * 0.025})`;
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, 7);
    ctx.stroke();
  }

  RING_LAYERS.forEach((ring, ri) => {
    if (ri >= orbBoot.rings) return;
    const radius = RR * ring.r;
    const rot = (ring.speed || 0) * t * ringSpeedMul + ri * 0.15;
    const pulse = 0.8 + 0.2 * Math.sin(t * 1.25 + ri * 0.7);
    const alpha = ring.alpha * pulse * (0.55 + energy * 0.65);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = `hsla(${hue},100%,${66 + pulse * 16}%,${alpha})`;
    ctx.lineWidth = ring.w;
    const drawFrac =
      ri === orbBoot.rings - 1 ? Math.max(0.001, Math.min(1, orbBoot.ringDraw)) : 1;

    if (ring.style === 'solid') {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * drawFrac);
      ctx.stroke();
    } else if (ring.style === 'segs') {
      const n = ring.segs;
      const arcSpan = (Math.PI * 2) / n;
      const drawSpan = arcSpan * (1 - ring.gap);
      const nShow = Math.max(1, Math.ceil(n * drawFrac));
      for (let s = 0; s < nShow; s++) {
        const jitter = (s % 3 === 0) ? 0.12 : (s % 2 === 0 ? -0.08 : 0.04);
        const span = Math.max(0.08, drawSpan * (1 + jitter));
        const a0 = rot + s * arcSpan;
        drawArcSeg(ctx, cx, cy, radius, a0, a0 + span);
      }
    } else if (ring.style === 'dash') {
      ctx.setLineDash(ring.dash);
      ctx.lineDashOffset = -t * Math.abs(ring.speed) * 36 * ringSpeedMul * Math.sign(ring.speed || 1);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, rot, rot + Math.PI * 2 * drawFrac);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (ring.style === 'ticks') {
      const tickNCap = Math.max(1, Math.ceil((ring.tickN || 64) * drawFrac));
      const n = tickNCap;
      const len = RR * ring.tickLen;
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * Math.PI * 2;
        const major = i % 8 === 0;
        const L = major ? len * 1.6 : len;
        const cos = Math.cos(a), sin = Math.sin(a);
        ctx.strokeStyle = `hsla(${hue},100%,${major ? 80 : 65}%,${alpha * (major ? 1.2 : 0.8)})`;
        ctx.lineWidth = major ? 1.05 : 0.55;
        ctx.beginPath();
        ctx.moveTo(cx + cos * (radius - L * 0.1), cy + sin * (radius - L * 0.1));
        ctx.lineTo(cx + cos * (radius + L), cy + sin * (radius + L));
        ctx.stroke();
      }
    }
  });

  ctx.restore();
}

/* ---------- Subtle crosshairs / radial ticks ---------- */
function drawCrosshairs(ctx, cx, cy, R, hue, energy, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const a = 0.10 + energy * 0.08;

  /* main axes — broken at core */
  ctx.strokeStyle = `hsla(${hue},100%,75%,${a})`;
  ctx.lineWidth = 0.85;
  const gap = R * 0.34;
  const outer = R * 1.02;
  ctx.beginPath();
  ctx.moveTo(cx - outer, cy); ctx.lineTo(cx - gap, cy);
  ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + outer, cy);
  ctx.moveTo(cx, cy - outer); ctx.lineTo(cx, cy - gap);
  ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + outer);
  ctx.stroke();

  /* diagonal hairlines */
  ctx.strokeStyle = `hsla(${hue},100%,70%,${a * 0.55})`;
  ctx.lineWidth = 0.55;
  const dGap = R * 0.38;
  const dOut = R * 0.88;
  for (let i = 0; i < 4; i++) {
    const ang = Math.PI / 4 + i * (Math.PI / 2);
    const c = Math.cos(ang), s = Math.sin(ang);
    ctx.beginPath();
    ctx.moveTo(cx + c * dGap, cy + s * dGap);
    ctx.lineTo(cx + c * dOut, cy + s * dOut);
    ctx.stroke();
  }

  /* rotating micro ticks near core rim */
  const n = 20;
  const rot = t * 0.08 * ringSpeedMul;
  for (let i = 0; i < n; i++) {
    const ang = rot + (i / n) * Math.PI * 2;
    const r0 = R * 0.32;
    const r1 = R * (0.34 + (i % 5 === 0 ? 0.035 : 0.018));
    ctx.strokeStyle = `hsla(${hue},100%,80%,${0.14 + energy * 0.1})`;
    ctx.lineWidth = i % 5 === 0 ? 1.1 : 0.55;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.stroke();
  }

  ctx.restore();
}

/* Radar sweep — ALWAYS visible in every voice state.
   Constant full-length bright cyan leading line + soft cyan conic trail.
   No energy gating, no speaking skip, no alpha pulsing to zero. */
function drawSweep(ctx, cx, cy, R, hue, energy, t) {
  if (!orbBoot.sweep) return;
  const ang = t * 0.45 * Math.max(0.85, sweepMul || 1);
  const wedge = 0.48;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  /* Soft cyan trailing wedge — cyan only, constant alpha floor */
  const g = ctx.createConicGradient(ang - wedge, cx, cy);
  const a = 0.22; /* fixed cyan floor — never grey, never zero */
  g.addColorStop(0, `hsla(${hue},100%,70%,0)`);
  g.addColorStop(0.001, `hsla(${hue},100%,80%,${a * 0.25})`);
  g.addColorStop((wedge * 0.55) / (Math.PI * 2), `hsla(${hue},100%,82%,${a * 0.65})`);
  g.addColorStop(wedge / (Math.PI * 2), `hsla(${hue},100%,88%,${a})`);
  g.addColorStop((wedge + 0.018) / (Math.PI * 2), `hsla(${hue},100%,75%,0)`);
  g.addColorStop(1, `hsla(${hue},100%,70%,0)`);
  ctx.fillStyle = g;
  const sweepR = R * OUTER_CONTAINMENT; /* match outer containment hairline */
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, sweepR, ang - wedge, ang);
  ctx.closePath();
  ctx.fill();

  /* Always-on hairline leading sweep — ~1 CSS px, no tip dot */
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.strokeStyle = `hsla(${hue},100%,94%,0.95)`;
  ctx.lineWidth = Math.max(1, dpr); /* device-space: 1 CSS px */
  ctx.lineCap = 'butt';
  ctx.shadowColor = `hsla(${hue},100%,80%,0.45)`;
  ctx.shadowBlur = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(ang) * sweepR, cy + Math.sin(ang) * sweepR);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.restore();
}


function drawThroughWaveform(ctx, cx, cy, R, coreR, hue, energy, t) {
  const amp = waveAmp;
  if (amp < 0.08) return;

  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;
  const maxHalf = canvasW * 0.46;
  const halfW = Math.min(R * 1.28, maxHalf);
  const baseAmp = coreR * (0.20 + amp * 0.36);
  const steps = Math.max(180, Math.floor(halfW * 2.6));
  const padY = baseAmp * 2.8 + 24;

  const off = document.createElement('canvas');
  off.width = canvasW;
  off.height = canvasH;
  const o = off.getContext('2d');
  o.clearRect(0, 0, canvasW, canvasH);
  o.globalCompositeOperation = 'lighter';

  function sampleY(u, layer) {
    const xNorm = u * 2 - 1;
    const env = Math.exp(-xNorm * xNorm * 0.85) * (0.65 + 0.35 * (1 - Math.abs(xNorm) * 0.25));
    const insideBoost = Math.abs(xNorm) < (coreR / halfW) ? 1.35 : 1.0;
    return (
      Math.sin(u * Math.PI * (7 + layer * 3) + t * (3.4 + amp * 1.8 + layer)) * baseAmp * env * insideBoost +
      Math.sin(u * Math.PI * (17 + layer * 5) + t * (6.2 + amp * 2.5)) * baseAmp * 0.32 * env +
      Math.sin(u * Math.PI * 31 + t * 9.5 + layer) * baseAmp * 0.12 * env * amp
    );
  }

  function strokeLayer(getY, alpha, lineW) {
    o.beginPath();
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const x = cx - halfW + u * halfW * 2;
      const y = cy + getY(u);
      if (i === 0) o.moveTo(x, y);
      else o.lineTo(x, y);
    }
    o.strokeStyle = `hsla(${hue},100%,88%,${alpha})`;
    o.lineWidth = lineW;
    o.lineJoin = 'round';
    o.lineCap = 'round';
    o.stroke();
  }

  /* soft body — thin enough not to read as a grey bar */
  strokeLayer((u) => sampleY(u, 0) * 0.9, 0.22 + amp * 0.18, 2.4 + amp * 1.2);
  /* bright primary */
  strokeLayer((u) => sampleY(u, 0), 0.70 + amp * 0.25, 1.5 + amp * 0.7);
  /* secondary harmonic */
  if (amp > 0.4) {
    strokeLayer((u) => sampleY(u, 1) * 0.55, 0.28 + amp * 0.15, 0.85);
  }

  /* hot center band (subtle, cyan only) */
  if (voiceState === 'speaking') {
    const band = o.createRadialGradient(cx, cy, 0, cx, cy, coreR * 0.9);
    band.addColorStop(0, `hsla(${hue},100%,90%,${0.06 + energy * 0.05})`);
    band.addColorStop(0.55, `hsla(${hue},100%,80%,${0.03 + energy * 0.02})`);
    band.addColorStop(1, `hsla(${hue},100%,80%,0)`);
    o.fillStyle = band;
    o.beginPath();
    o.ellipse(cx, cy, coreR * 0.9, coreR * 0.22, 0, 0, 7);
    o.fill();
  }

  /* Horizontal alpha mask — smooth fade over outer 25% each side */
  o.globalCompositeOperation = 'destination-in';
  const fade = o.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
  fade.addColorStop(0.0, 'rgba(0,0,0,0)');
  fade.addColorStop(0.12, 'rgba(0,0,0,0.35)');
  fade.addColorStop(0.22, 'rgba(0,0,0,0.75)');
  fade.addColorStop(0.30, 'rgba(0,0,0,1)');
  fade.addColorStop(0.70, 'rgba(0,0,0,1)');
  fade.addColorStop(0.78, 'rgba(0,0,0,0.75)');
  fade.addColorStop(0.88, 'rgba(0,0,0,0.35)');
  fade.addColorStop(1.0, 'rgba(0,0,0,0)');
  o.fillStyle = fade;
  o.fillRect(cx - halfW - 2, cy - padY, halfW * 2 + 4, padY * 2);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(off, 0, 0);
  ctx.restore();
}



/* Mini status waveform under the orb */
function drawStatusWave(canvas, t) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 100;
  const h = canvas.clientHeight || 18;
  const tw = Math.round(w * dpr), th = Math.round(h * dpr);
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw;
    canvas.height = th;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const speaking = voiceState === 'speaking';
  const amp = Math.max(0.15, waveAmp * (speaking ? 1 : 0.55));
  const mid = h / 2;
  const hue = speaking ? 355 : HUE;

  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const u = x / w;
    const y =
      mid +
      Math.sin(u * Math.PI * 7 + t * (3.5 + amp)) * (h * 0.32) * amp +
      Math.sin(u * Math.PI * 15 + t * 6.2) * (h * 0.12 * amp);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = speaking
    ? `hsla(${hue},95%,65%,0.95)`
    : `hsla(${hue},100%,72%,0.85)`;
  ctx.lineWidth = 1.3;
  ctx.shadowColor = speaking
    ? `hsla(${hue},100%,55%,0.55)`
    : `hsla(${hue},100%,70%,0.45)`;
  ctx.shadowBlur = 5;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawOrb(ctx, W, H, t) {
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 * 0.90;
  const energy = idleEnergy(t);

  ctx.clearRect(0, 0, W, H);

  /* outer soft atmosphere (blooms with core during boot) */
  if (orbBoot.core > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.max(0, Math.min(1, orbBoot.core));
    let g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.15);
    g.addColorStop(0, `hsla(${HUE},90%,50%,${0.04 + energy * 0.04})`);
    g.addColorStop(1, `hsla(${HUE},80%,40%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.15, 0, 7);
    ctx.fill();
    ctx.restore();
  }

  drawSweep(ctx, cx, cy, R, HUE, energy, t);
  drawRings(ctx, cx, cy, R, HUE, energy, t);
  if (orbBoot.rings > 0) drawCrosshairs(ctx, cx, cy, R, HUE, energy, t);

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, orbBoot.core));
  const coreR = drawSoftCore(ctx, cx, cy, R, HUE, energy, t);
  drawPlasma(ctx, cx, cy, coreR, HUE, energy, t);
  ctx.restore();

  /* Through-orb waveform sits on the core (no center text label) */
  if (orbBoot.core > 0.2) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, orbBoot.core));
    drawThroughWaveform(ctx, cx, cy, R, coreR, HUE, energy, t);
    ctx.restore();
  }

  /* outer containment hairline */
  if (orbBoot.contain) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `hsla(${HUE},70%,55%,0.18)`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(cx, cy, R * OUTER_CONTAINMENT, 0, 7);
    ctx.stroke();
    ctx.restore();
  }
}


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
  const pts = 32;
  const values = [];
  let v = 0.4 + rnd() * 0.2;
  for (let i = 0; i < pts; i++) {
    v += (rnd() - 0.48) * 0.18 + Math.sin(t * 1.6 + i * 0.45 + seed) * 0.035;
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
  ctx.strokeStyle = `hsla(${HUE},100%,70%,0.8)`;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = `hsla(${HUE},100%,70%,0.5)`;
  ctx.shadowBlur = 5;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `hsla(${HUE},100%,60%,0.28)`);
  g.addColorStop(1, `hsla(${HUE},100%,50%,0)`);
  ctx.fillStyle = g;
  ctx.fill();
}

/* ---------- Waveform (pin-style oscilloscope) ---------- */
function drawWaveform(canvas, t) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 220;
  const h = canvas.clientHeight || 36;
  const tw = Math.round(w * dpr),
    th = Math.round(h * dpr);
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw;
    canvas.height = th;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = `hsla(${HUE},40%,40%,0.25)`;
  ctx.lineWidth = 0.5;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  ctx.beginPath();
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const u = x / w;
    const amp = waveAmp;
    const y =
      mid +
      Math.sin(u * Math.PI * 8 + t * (3.2 + amp)) * (h * 0.28) * amp * (0.55 + 0.45 * Math.sin(t * 1.1 + u * 4)) +
      Math.sin(u * Math.PI * 19 + t * (5.5 + amp * 2)) * (h * 0.1 * amp);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  const speaking = voiceState === 'speaking';
  const hue = speaking ? 355 : HUE;
  ctx.strokeStyle = speaking
    ? `hsla(${hue},95%,65%,0.9)`
    : `hsla(${hue},100%,72%,0.85)`;
  ctx.lineWidth = 1.4;
  ctx.shadowColor = speaking
    ? `hsla(${hue},100%,55%,0.55)`
    : `hsla(${hue},100%,70%,0.55)`;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/* ---------- Plan usage gauges (session / week) ----------
   Shape matches jarvis-core HUD: message { kind:'usage', usage: PlanUsage }
   PlanUsage = { status, binding, session, week, at }
   PlanWindow = { utilization: 0..100 | null, resetsAt: ISO | null }
   WS URL: (wss|ws):// + location.host + '/ws'  (same as v1) */
const WS_PATH = '/ws';

const usageView = {
  status: null, /* 'ok' | 'warning' | 'rejected' | null */
  binding: null,
  session: { target: null, display: null, resetsAt: null },
  week: { target: null, display: null, resetsAt: null },
  fromDev: false,
};

let coreWs = null;
let coreWsRetry = 0;
let coreWsTimer = null;

function usageTone(pct) {
  if (usageView.status === 'rejected') return 'err';
  if (usageView.status === 'warning') return 'warn';
  if (pct != null && pct >= 80) return 'warn';
  return 'ok';
}

function usageHue(tone) {
  if (tone === 'err') return 0;
  if (tone === 'warn') return ACCENT;
  return HUE; /* cyan/neutral below 80% */
}

function formatReset(winKey, iso) {
  if (!iso) return 'Resets —';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Resets —';
  if (winKey === 'session') {
    return (
      'Resets ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
  }
  return (
    'Resets ' +
    d.toLocaleString([], {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  );
}

function gaugeTitle(winKey) {
  const w = usageView[winKey];
  const pct = w.target;
  const pctStr = pct == null ? '—' : Math.round(pct) + '%';
  return pctStr + '\n' + formatReset(winKey, w.resetsAt);
}

function syncGaugeDom() {
  ['session', 'week'].forEach((key) => {
    const el = document.getElementById(
      key === 'session' ? 'gauge-session' : 'gauge-week'
    );
    if (!el) return;
    const pct = usageView[key].target;
    const tone = usageTone(pct);
    el.dataset.tone = tone;
    el.title = gaugeTitle(key);
    const shown = pct == null ? '—' : String(Math.round(pct)) + '%';
    el.setAttribute(
      'aria-label',
      (key === 'session' ? 'Session' : 'Weekly') +
        ' plan usage ' +
        shown +
        '. ' +
        formatReset(key, usageView[key].resetsAt)
    );
  });
}

function applyUsage(u) {
  if (!u) {
    usageView.status = null;
    usageView.binding = null;
    usageView.session = { target: null, display: usageView.session.display, resetsAt: null };
    usageView.week = { target: null, display: usageView.week.display, resetsAt: null };
    syncGaugeDom();
    return;
  }
  usageView.status = u.status || null;
  usageView.binding = u.binding || null;
  const take = (prev, win) => {
    const util =
      win && win.utilization != null && !Number.isNaN(Number(win.utilization))
        ? Number(win.utilization)
        : null;
    /* Core sends 0..100 (see PlanWindow in shared types + v1 Math.round). */
    return {
      target: util,
      display: prev.display,
      resetsAt: win && win.resetsAt ? win.resetsAt : null,
    };
  };
  usageView.session = take(usageView.session, u.session);
  usageView.week = take(usageView.week, u.week);
  if (!animate) {
    usageView.session.display = usageView.session.target;
    usageView.week.display = usageView.week.target;
  }
  syncGaugeDom();
}

function easeUsageDisplays() {
  ['session', 'week'].forEach((key) => {
    const w = usageView[key];
    if (w.target == null) {
      w.display = null;
      return;
    }
    if (w.display == null) {
      w.display = w.target;
      return;
    }
    const d = w.target - w.display;
    if (Math.abs(d) < 0.15) w.display = w.target;
    else w.display += d * 0.14;
  });
}

function drawAccentRing(canvas, winKey) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = Math.min(canvas.clientWidth || 52, canvas.clientHeight || 52);
  const tw = Math.round(size * dpr);
  const th = Math.round(size * dpr);
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw;
    canvas.height = th;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.36;
  const w = usageView[winKey];
  const pct =
    w.display != null
      ? Math.max(0, Math.min(100, w.display))
      : w.target != null
        ? Math.max(0, Math.min(100, w.target))
        : null;
  const tone = usageTone(w.target);
  const hue = usageHue(tone);
  const frac = pct == null ? 0 : pct / 100;
  const end = -Math.PI / 2 + Math.PI * 2 * frac;

  ctx.strokeStyle = `hsla(${hue},40%,42%,0.22)`;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 7);
  ctx.stroke();

  if (pct != null && frac > 0.001) {
    ctx.strokeStyle = `hsla(${hue},100%,${tone === 'ok' ? 62 : 55}%,0.92)`;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = `hsla(${hue},100%,50%,0.5)`;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, end);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  ctx.fillStyle =
    pct == null
      ? `hsla(${HUE},30%,55%,0.55)`
      : `hsla(${hue},90%,${tone === 'ok' ? 72 : 68}%,0.95)`;
  ctx.font = `600 ${Math.round(size * 0.22)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(pct == null ? '—' : String(Math.round(pct)), cx, cy + 0.5);
}

function showGaugeTip(winKey, anchor) {
  const tip = document.getElementById('gauge-tip');
  if (!tip || !anchor) return;
  const w = usageView[winKey];
  const pct = w.target;
  const tone = usageTone(pct);
  const pctStr = pct == null ? '—' : Math.round(pct) + '%';
  tip.dataset.tone = tone;
  tip.innerHTML =
    '<span class="tip-pct">' +
    pctStr +
    '</span>\n<span class="tip-reset">' +
    formatReset(winKey, w.resetsAt) +
    '</span>';
  /* position relative to orb-gauges: align with hovered gauge */
  const host = document.getElementById('orb-gauges');
  if (host) {
    const hb = host.getBoundingClientRect();
    const ab = anchor.getBoundingClientRect();
    tip.style.top = Math.max(0, ab.top - hb.top) + 'px';
    tip.style.left = 'calc(100% + 10px)';
  }
  tip.hidden = false;
}

function hideGaugeTip() {
  const tip = document.getElementById('gauge-tip');
  if (tip) tip.hidden = true;
}

function bindGaugeTips() {
  ['session', 'week'].forEach((key) => {
    const el = document.getElementById(
      key === 'session' ? 'gauge-session' : 'gauge-week'
    );
    if (!el) return;
    el.addEventListener('mouseenter', () => showGaugeTip(key, el));
    el.addEventListener('mouseleave', hideGaugeTip);
    el.addEventListener('focus', () => showGaugeTip(key, el));
    el.addEventListener('blur', hideGaugeTip);
  });
}

function onCoreMessage(m) {
  /* Deprecated dual-WS path — CoreLink (live-bridge.js) owns all kinds.
     Kept as a no-op so old callers do not throw. Focus/usage arrive via LiveBridge. */
  void m;
}

function scheduleCoreReconnect() {
  const delay = Math.min(30000, 1000 * Math.pow(2, coreWsRetry++));
  clearTimeout(coreWsTimer);
  coreWsTimer = setTimeout(connectCore, delay);
}

function connectCore() {
  /* Deprecated: CoreLink owns the only /ws connection (live-bridge.js). */
  console.warn('[v2-next] connectCore() is a no-op; use CoreLink via LiveBridge');
  return;
  if (usageView.fromDev) return;
  clearTimeout(coreWsTimer);
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let sock;
  try {
    sock = new WebSocket(proto + location.host + WS_PATH);
  } catch (e) {
    scheduleCoreReconnect();
    return;
  }
  coreWs = sock;
  sock.onopen = () => {
    coreWsRetry = 0;
  };
  sock.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    onCoreMessage(m);
  };
  sock.onerror = () => {};
  sock.onclose = () => {
    if (coreWs !== sock) return;
    coreWs = null;
    scheduleCoreReconnect();
  };
}

function parseUsageDevParam(raw) {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  const now = Date.now();
  const sessionReset = new Date(now + 2.5 * 3600 * 1000).toISOString();
  const weekReset = new Date(now + 3 * 24 * 3600 * 1000);
  /* snap week tip to a Monday-ish display: keep real date, formatter adds weekday */
  const weekIso = weekReset.toISOString();
  if (v === 'rejected') {
    return {
      status: 'rejected',
      binding: 'session',
      session: { utilization: 100, resetsAt: sessionReset },
      week: { utilization: 100, resetsAt: weekIso },
      at: new Date().toISOString(),
    };
  }
  const parts = v.split(',').map((s) => s.trim());
  const s = Number(parts[0]);
  const w = Number(parts[1]);
  if (Number.isNaN(s) || Number.isNaN(w)) return null;
  const bound = Math.max(s, w);
  return {
    status: bound >= 80 ? 'warning' : 'ok',
    binding: s >= w ? 'session' : 'week',
    session: { utilization: s, resetsAt: sessionReset },
    week: { utilization: w, resetsAt: weekIso },
    at: new Date().toISOString(),
  };
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

/* ---------- Hero number tick flash ---------- */
let lastTick = 0;
function maybeFlashHero(t) {
  if (t - lastTick < 2.8) return;
  lastTick = t;
  document.querySelectorAll('.hero-metric .value').forEach((el, i) => {
    if ((Math.floor(t) + i) % 3 !== 0) return;
    el.classList.remove('tick-flash');
    void el.offsetWidth;
    el.classList.add('tick-flash');
  });
}

/* ---------- Boot ---------- */
const params = new URLSearchParams(location.search);
const hasT = params.has('t');
const liveParam = params.get('live');
const freezeT = parseFloat(params.get('t') || '4.2');
const demoBriefing = params.get('demo') === 'briefing';
const initialVoice = (params.get('voice') || 'idle').toLowerCase();
const usageDevRaw = params.get('usage'); /* e.g. 34,62 or rejected */
/* Default animated. ?t= freezes for shots. ?live=0 forces off. ?live=1 forces on. */
const animate =
  liveParam === '0' ? false : liveParam === '1' ? true : !hasT || demoBriefing;

const canvas = document.getElementById('orb');
const sparkIds = ['spark-cpu', 'spark-net'];

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
  drawWaveform(document.getElementById('wave-footer'), t);
  drawStatusWave(document.getElementById('status-wave'), t);
  easeUsageDisplays();
  drawAccentRing(document.getElementById('ring-a'), 'session');
  drawAccentRing(document.getElementById('ring-b'), 'week');
  maybeFlashHero(t);

  /* breathe IO bar */
  const fill = document.querySelector('.bar-fill');
  if (fill) {
    const w = 28 + (Math.sin(t * 1.3) * 0.5 + 0.5) * 22;
    fill.style.width = `${w}%`;
  }
}



/* ---------- Mock briefing demo (?demo=briefing) ---------- */
const MOCK_BRIEFING_LINES = [
  'Goedemorgen. Hier is je avondbriefing.',
  'Weer: 14° · licht bewolkt, geen neerslag verwacht.',
  'Agenda: 4 items — stand-up, design review, 1:1, focusblok.',
  'Mail: 12 ongelezen · 2 als urgent gemarkeerd (mock).',
  'Work: 4 open PRs — 1 klaar voor review, 1 draft.',
  'Systeem: Brain online · Desk idle · alles groen.',
];

function showDemoBadge(on) {
  const el = document.getElementById('demo-badge');
  if (el) el.hidden = !on;
}

function showUserChip(text) {
  const chip = document.getElementById('voice-chip');
  const txt = document.getElementById('voice-chip-text');
  if (!chip || !txt) return;
  if (!text) {
    chip.hidden = true;
    return;
  }
  txt.textContent = text;
  chip.hidden = false;
}

function showTranscript(mode, lines) {
  const panel = document.getElementById('transcript-panel');
  const box = document.getElementById('transcript-lines');
  if (!panel || !box) return;
  if (!mode) {
    panel.hidden = true;
    box.innerHTML = '';
    return;
  }
  panel.hidden = false;
  box.innerHTML = '';
  (lines || []).forEach((text, i) => {
    const div = document.createElement('div');
    div.className = 'line' + (mode === 'thinking' ? ' thinking' : '');
    div.style.animationDelay = `${i * 0.12}s`;
    div.textContent = text;
    box.appendChild(div);
  });
}

function appendTranscriptLine(text) {
  const panel = document.getElementById('transcript-panel');
  const box = document.getElementById('transcript-lines');
  if (!panel || !box) return;
  panel.hidden = false;
  const div = document.createElement('div');
  div.className = 'line';
  div.textContent = text;
  box.appendChild(div);
  while (box.children.length > 5) box.removeChild(box.firstChild);
}

function runBriefingDemo() {
  showDemoBadge(true);
  applyVoicePreset('idle');
  showUserChip(null);
  showTranscript(null);

  const t0 = performance.now();
  const schedule = [
    { at: 2000, fn: () => {
      applyVoicePreset('listening');
      showUserChip('Geef me een briefing');
    }},
    { at: 5000, fn: () => {
      showUserChip(null);
      applyVoicePreset('thinking');
      showTranscript('thinking', ['Briefing samenstellen…']);
    }},
    { at: 12000, fn: () => {
      applyVoicePreset('speaking');
      showTranscript('speaking', []);
    }},
  ];

  /* speak lines staggered 12s → ~27s */
  MOCK_BRIEFING_LINES.forEach((line, i) => {
    schedule.push({
      at: 12500 + i * 2400,
      fn: () => appendTranscriptLine(line),
    });
  });

  schedule.push({
    at: 28000,
    fn: () => {
      applyVoicePreset('idle');
      showUserChip(null);
      showTranscript(null);
    },
  });
  schedule.push({
    at: 32000,
    fn: () => {
      /* stay idle; badge remains so viewer knows it was a demo */
      applyVoicePreset('idle');
    },
  });

  schedule.sort((a, b) => a.at - b.at);
  let i = 0;
  function tick(now) {
    const elapsed = now - t0;
    while (i < schedule.length && elapsed >= schedule[i].at) {
      try { schedule[i].fn(); } catch (e) { console.warn(e); }
      i++;
    }
    if (i < schedule.length) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* =============================================================================
   FOCUS / BOOT / PANEL DATA (v2-next anim pass)
   -----------------------------------------------------------------------------
   Proposed WS contract (Core will add later; client ready now):
     { kind:'focus', panel:'weather'|'agenda'|'notes'|'mail'|'work'|'system' }
     { kind:'unfocus' }
   Explicit focus always wins over interim derivation once Core sends it.
   'system' is focusable from the client / keyboard; briefings will not emit it yet.

   Interim live trigger (mirrors v1 HUD behaviour until Core ships focus/unfocus):
     • {kind:'desk', slots:[{topic,label,briefing?}]}
         On connect. Topics weather/agenda/mail/work/notes (packs may add more;
         unknown topics ignored). Map → panel ids via DESK_TOPIC_TO_PANEL.
         A slot with briefing:true marks the connection as "in briefing".
     • {kind:'tiles', source, topic, topicLabel, tiles}
         Standing tool facts — update panel cache when topic maps, but do NOT
         focus on tiles alone outside a briefing.
     • {kind:'display', turnId, id, payload, dismiss, cue?}
         Speech-synced. During a briefing, derive topic from payload
         (title/body/alt text) via TOPIC_ANCHORS (v1 sticky-topic style) and
         focus that panel. Unknown topics ignored.
     • {kind:'done', briefing:true} (or done while inBriefing)
         End of a briefing turn → unfocus (v1 settleDesk equivalent).

   Auto-unfocus safety net: ~1.5 s after voice returns to idle.
   ============================================================================= */

const DESK_TOPIC_TO_PANEL = {
  weather: 'weather',
  agenda: 'agenda',
  mail: 'mail',
  work: 'work',
  notes: 'notes',
  /* aliases seen in packs / speech */
  calendar: 'agenda',
  email: 'mail',
  inbox: 'mail',
  github: 'work',
  prs: 'work',
  pr: 'work',
};

/* v1 TOPIC_ANCHORS — words that mean a subject has come up (sticky-topic style). */
const TOPIC_ANCHORS = {
  weather: ['weer', 'weersverwachting', 'verwachting', 'weather', 'forecast', 'graden', 'regen', 'zonnig', 'bewolkt', 'wind', 'temperatuur', 'buiten'],
  mail: ['mail', 'email', 'inbox', 'bericht', 'afzender', 'postvak'],
  agenda: ['agenda', 'afspraak', 'afspraken', 'kalender', 'calendar'],
  notes: ['notitie', 'notities', 'note', 'notes', 'idea', 'todo'],
  work: ['werk', 'pull', 'request', 'pipeline', 'build', 'repo', 'ticket', 'pr', 'github'],
};

const PANEL_ORDER = ['weather', 'agenda', 'notes', 'mail', 'work', 'system'];

const reducedMotion =
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

const bootParams = {
  replay: params.get('boot') === 'replay',
  focus: (params.get('focus') || '').toLowerCase(),
  skip:
    hasT ||
    liveParam === '0' ||
    /* freeze / live=0 → finished resting state, no choreography */
    false,
};

let inBriefing = false;
let focusedPanelId = null;
let focusHandOff = null; /* promise chain for smooth handoff */
let idleUnfocusTimer = null;
let bootDone = false;
let bootRunning = false;

/* ---------- Per-panel data layer ---------- */
const Panels = {
  meta: {
    weather: { wsKind: 'desk|tiles|display', note: 'desk/tiles topic=weather; display during briefing' },
    agenda: { wsKind: 'desk|tiles|display', note: 'desk/tiles topic=agenda' },
    notes: { wsKind: 'desk|tiles|display', note: 'desk/tiles topic=notes' },
    mail: { wsKind: 'desk|tiles|display', note: 'desk/tiles topic=mail' },
    work: { wsKind: 'desk|tiles|display', note: 'desk/tiles topic=work' },
    system: { wsKind: 'metrics|health', note: 'metrics/health — no briefing focus yet' },
    usage: { wsKind: 'usage', note: 'wired live' },
  },
  cacheKey(id) {
    return 'jarvis.v2.panel.' + id;
  },
  load(id) {
    try {
      const raw = localStorage.getItem(this.cacheKey(id));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  },
  save(id, data) {
    try {
      localStorage.setItem(
        this.cacheKey(id),
        JSON.stringify({ data, at: Date.now() })
      );
    } catch (e) {
      /* quota / private mode — ignore */
    }
  },
  el(id) {
    return document.querySelector('[data-panel="' + id + '"]');
  },
  /** Seed cache from current DOM mock when nothing stored yet. */
  seedFromDom(id) {
    const el = this.el(id);
    if (!el) return null;
    const data = { html: el.innerHTML, source: 'mock' };
    this.save(id, data);
    return data;
  },
  render(id, data) {
    if (id === 'usage') {
      applyUsage(data || null);
      return;
    }
    const el = this.el(id);
    if (!el || !data) return;
    if (typeof data.html === 'string' && data.html.length) {
      el.innerHTML = data.html;
    }
    /* Future: structured data → DOM. WS kinds get plugged in per panel later. */
  },
  update(id, data) {
    this.render(id, data);
    if (id === 'usage') {
      this.save(id, data);
    } else if (data) {
      this.save(id, data);
    }
  },
  /** On boot: render last-known (cache) or keep built-in mock and seed cache. */
  hydrateAll() {
    PANEL_ORDER.forEach((id) => {
      const cached = this.load(id);
      if (cached && cached.data) {
        this.render(id, cached.data);
      } else {
        this.seedFromDom(id);
      }
    });
    const u = this.load('usage');
    if (u && u.data && !usageView.fromDev) {
      applyUsage(u.data);
    }
  },
};

function panelIdFromTopic(topic) {
  if (!topic) return null;
  const key = String(topic).toLowerCase().trim();
  return DESK_TOPIC_TO_PANEL[key] || null;
}

function saidWord(text, word) {
  if (!text || !word || word.length < 4) return false;
  const t = text.toLowerCase();
  const w = word.toLowerCase();
  const re = new RegExp(
    '(?:^|[^\\p{L}\\p{N}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^\\p{L}\\p{N}])',
    'u'
  );
  return re.test(t);
}

/** Derive a desk topic from display payload text (v1 sticky-topic style). */
function topicFromDisplayPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const bits = [];
  if (payload.title) bits.push(String(payload.title));
  if (payload.body) bits.push(String(payload.body));
  if (payload.alt) bits.push(String(payload.alt));
  if (payload.caption) bits.push(String(payload.caption));
  if (Array.isArray(payload.rows)) {
    payload.rows.forEach((r) => {
      if (r && r.label) bits.push(String(r.label));
      if (r && r.value) bits.push(String(r.value));
    });
  }
  const said = bits.join(' ');
  for (const [topic, anchors] of Object.entries(TOPIC_ANCHORS)) {
    for (const word of anchors) {
      if (saidWord(said, word)) return topic;
    }
  }
  return null;
}

function handleDeskMessage(m) {
  const slots = Array.isArray(m.slots) ? m.slots : [];
  let briefing = false;
  slots.forEach((s) => {
    if (!s) return;
    if (s.briefing) briefing = true;
    const id = panelIdFromTopic(s.topic);
    if (!id) return; /* unknown pack topic — ignore gracefully */
    /* Standing desk snapshot: cache label only; keep mock HTML until live render lands. */
    const cached = Panels.load(id);
    const data = (cached && cached.data) || Panels.seedFromDom(id) || { html: '', source: 'desk' };
    data.desk = { topic: s.topic, label: s.label || s.topic, briefing: !!s.briefing };
    data.source = 'desk';
    Panels.save(id, data);
  });
  if (briefing) inBriefing = true;
}

function handleTilesMessage(m) {
  const id = panelIdFromTopic(m.topic);
  if (!id) return;
  const cached = Panels.load(id);
  const data = (cached && cached.data) || Panels.seedFromDom(id) || { html: '', source: 'tiles' };
  data.tiles = {
    source: m.source || '',
    topic: m.topic,
    topicLabel: m.topicLabel || m.topic,
    tiles: Array.isArray(m.tiles) ? m.tiles : [],
  };
  data.source = 'tiles';
  Panels.save(id, data);
  /* Standing context — do not focus on tiles alone outside a briefing. */
}

function handleDisplayMessage(m) {
  if (!inBriefing) return;
  const topic = topicFromDisplayPayload(m.payload);
  const id = panelIdFromTopic(topic);
  if (!id) return;
  focusPanel(id);
}

function handleDoneMessage(m) {
  if (m.briefing === true || inBriefing) {
    inBriefing = false;
    unfocusPanel();
  }
}

/* Extend core message router with interim desk/tiles/display/done. */
const _onCoreMessageBase = onCoreMessage;
onCoreMessage = function onCoreMessageExtended(m) {
  if (!m || typeof m.kind !== 'string') return;
  if (m.kind === 'focus' && m.panel) {
    /* Explicit contract wins. */
    inBriefing = true;
    focusPanel(String(m.panel));
    return;
  }
  if (m.kind === 'unfocus') {
    inBriefing = false;
    unfocusPanel();
    return;
  }
  if (m.kind === 'usage') {
    if (usageView.fromDev) return;
    Panels.update('usage', m.usage || null);
    return;
  }
  if (m.kind === 'desk') {
    handleDeskMessage(m);
    return;
  }
  if (m.kind === 'tiles') {
    handleTilesMessage(m);
    return;
  }
  if (m.kind === 'display') {
    handleDisplayMessage(m);
    return;
  }
  if (m.kind === 'done') {
    handleDoneMessage(m);
    return;
  }
  /* ready / lang / metrics / health — reserved; see Panels.meta */
};

/* ---------- Focus (FLIP) ---------- */
function isPhoneFocus() {
  return window.matchMedia('(max-width: 800px)').matches;
}

function setVeil(on) {
  const veil = document.getElementById('focus-veil');
  if (!veil) return;
  if (on) {
    veil.hidden = false;
    veil.setAttribute('data-on', '1');
    veil.setAttribute('aria-hidden', 'false');
  } else {
    veil.setAttribute('data-on', '0');
    veil.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      if (veil.getAttribute('data-on') !== '1') veil.hidden = true;
    }, 500);
  }
}

function dimOthers(exceptId, on) {
  PANEL_ORDER.forEach((id) => {
    const el = Panels.el(id);
    if (!el) return;
    if (on && id !== exceptId) el.classList.add('focus-dim');
    else el.classList.remove('focus-dim');
  });
  /* Pack mini-cards share focus-dim with fixed panels */
  document.querySelectorAll('.pack-card[data-panel]').forEach((el) => {
    const id = el.getAttribute('data-panel');
    if (on && id !== exceptId) el.classList.add('focus-dim');
    else el.classList.remove('focus-dim');
  });
  document.documentElement.classList.toggle('is-focusing', !!on);
}

function focusPanel(id) {
  if (!id || typeof id !== 'string') return;
  /* Fixed panels + pack topics (Core focus.panel = desk topic). system = client-only. */
  const fixed = ['weather', 'agenda', 'notes', 'mail', 'work', 'system'];
  const el = document.querySelector('[data-panel="' + id + '"]');
  if (!fixed.includes(id) && !el) return;
  const run = () => _focusPanelNow(id);
  if (focusHandOff) {
    focusHandOff = focusHandOff.then(run);
  } else {
    focusHandOff = Promise.resolve().then(run);
  }
  return focusHandOff;
}

function _focusPanelNow(id) {
  return new Promise((resolve) => {
    if (focusedPanelId && focusedPanelId !== id) {
      _unfocusPanelNow(true).then(() => {
        _focusPanelApply(id, resolve);
      });
    } else if (focusedPanelId === id) {
      resolve();
    } else {
      _focusPanelApply(id, resolve);
    }
  });
}

function _focusPanelApply(id, done) {
  const el = Panels.el(id);
  if (!el) {
    done();
    return;
  }
  focusedPanelId = id;
  setVeil(true);
  dimOthers(id, true);

  if (reducedMotion) {
    el.classList.add('is-focused');
    el.style.opacity = '1';
    done();
    return;
  }

  if (isPhoneFocus()) {
    el.classList.add('is-focused');
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      el.scrollIntoView();
    }
    done();
    return;
  }

  /* FLIP: measure slot → apply focused layout → invert → play */
  const first = el.getBoundingClientRect();
  el.classList.add('is-focused');
  /* Target: centre of viewport, ~1.7× scale, clamped to margins */
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 48;
  const scale = Math.min(1.7, (vw - margin * 2) / first.width, (vh - margin * 2) / first.height);
  const targetW = first.width * scale;
  const targetH = first.height * scale;
  const targetLeft = (vw - targetW) / 2;
  const targetTop = (vh - targetH) / 2;
  const dx = targetLeft - first.left;
  const dy = targetTop - first.top;

  el.classList.add('focus-animating');
  el.style.transformOrigin = 'top left';
  el.style.transition = 'none';
  el.style.transform = 'translate(0px,0px) scale(1)';
  void el.offsetWidth;
  el.style.transition = 'transform 560ms cubic-bezier(0.22, 0.61, 0.36, 1)';
  el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ')';

  const finish = () => {
    el.removeEventListener('transitionend', finish);
    done();
  };
  el.addEventListener('transitionend', finish);
  setTimeout(finish, 600);
}

function unfocusPanel() {
  const run = () => _unfocusPanelNow(false);
  if (focusHandOff) {
    focusHandOff = focusHandOff.then(run);
  } else {
    focusHandOff = Promise.resolve().then(run);
  }
  return focusHandOff;
}

function _unfocusPanelNow(/* silent */) {
  return new Promise((resolve) => {
    const id = focusedPanelId;
    if (!id) {
      setVeil(false);
      dimOthers(null, false);
      resolve();
      return;
    }
    const el = Panels.el(id);
    focusedPanelId = null;

    if (!el) {
      setVeil(false);
      dimOthers(null, false);
      resolve();
      return;
    }

    if (reducedMotion || isPhoneFocus()) {
      el.classList.remove('is-focused', 'focus-animating');
      el.style.transform = '';
      el.style.transition = '';
      setVeil(false);
      dimOthers(null, false);
      resolve();
      return;
    }

    /* Animate back to identity transform (slot) */
    el.style.transition = 'transform 520ms cubic-bezier(0.22, 0.61, 0.36, 1)';
    el.style.transform = 'translate(0px,0px) scale(1)';
    const finish = () => {
      el.removeEventListener('transitionend', finish);
      el.classList.remove('is-focused', 'focus-animating');
      el.style.transform = '';
      el.style.transition = '';
      el.style.transformOrigin = '';
      setVeil(false);
      dimOthers(null, false);
      resolve();
    };
    el.addEventListener('transitionend', finish);
    setTimeout(finish, 560);
  });
}

/* Voice idle → auto-unfocus safety net */
const _applyVoicePreset = applyVoicePreset;
applyVoicePreset = function applyVoicePresetWrapped(state) {
  _applyVoicePreset(state);
  clearTimeout(idleUnfocusTimer);
  if (state === 'idle' && focusedPanelId) {
    idleUnfocusTimer = setTimeout(() => {
      if (focusedPanelId) unfocusPanel();
    }, 20000); /* stale guard only — Core owns unfocus */
  }
};

/* ---------- Boot choreography ---------- */
function setOrbBootFull() {
  orbBoot.core = 1;
  orbBoot.rings = RING_LAYERS.length;
  orbBoot.ringDraw = 1;
  orbBoot.sweep = true;
  orbBoot.contain = true;
}

function setOrbBootEmpty() {
  orbBoot.core = 0;
  orbBoot.rings = 0;
  orbBoot.ringDraw = 0;
  orbBoot.sweep = false;
  orbBoot.contain = false;
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

function animateValue(from, to, dur, onUpdate) {
  return new Promise((resolve) => {
    if (dur <= 0 || reducedMotion) {
      onUpdate(to);
      resolve();
      return;
    }
    const t0 = performance.now();
    function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      onUpdate(from + (to - from) * easeOutCubic(p));
      if (p < 1) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });
}

function revealChrome(sel, cls) {
  const el = document.querySelector(sel);
  if (!el) return;
  el.classList.add(cls || 'fui-in');
  el.style.opacity = '';
  el.style.pointerEvents = '';
}

function enterPanel(id) {
  const el = Panels.el(id);
  if (!el) return waitMs(0);
  return new Promise((resolve) => {
    el.classList.remove('fui-enter');
    void el.offsetWidth;
    el.classList.add('fui-enter');
    el.style.opacity = '';
    el.style.pointerEvents = '';
    const done = () => {
      el.removeEventListener('animationend', done);
      el.classList.remove('fui-enter');
      resolve();
    };
    el.addEventListener('animationend', done);
    setTimeout(done, 450);
  });
}

async function runBootSequence() {
  if (bootRunning) return;
  bootRunning = true;
  bootDone = false;
  document.documentElement.classList.remove('boot-skip');
  document.documentElement.classList.add('boot-pending');
  document.documentElement.removeAttribute('data-ready');

  /* Reset chrome visibility for replay */
  document.querySelectorAll('.panel, .header, .footer, .orb-gauges').forEach((el) => {
    el.classList.remove('fui-in', 'fui-enter');
    el.style.opacity = '';
  });

  if (reducedMotion) {
    document.documentElement.classList.add('boot-reduced');
    setOrbBootFull();
    document.documentElement.classList.remove('boot-pending');
    document.documentElement.classList.add('boot-skip');
    document.querySelectorAll('.panel, .header, .footer, .orb-gauges').forEach((el) => {
      el.classList.add('fui-in');
    });
    await waitMs(200);
    document.documentElement.classList.remove('boot-pending', 'boot-reduced');
    document.documentElement.classList.add('boot-skip');
    bootDone = true;
    bootRunning = false;
    document.documentElement.setAttribute('data-ready', '1');
    return;
  }

  setOrbBootEmpty();

  /* 1) Core blooms ~550ms */
  await animateValue(0, 1, 550, (v) => {
    orbBoot.core = v;
  });

  /* 2) Rings draw in one-by-one inside→out (~130ms each) */
  for (let i = 0; i < RING_LAYERS.length; i++) {
    orbBoot.rings = i + 1;
    orbBoot.ringDraw = 0;
    await animateValue(0, 1, 120, (v) => {
      orbBoot.ringDraw = v;
    });
  }
  orbBoot.contain = true;
  await waitMs(80);

  /* 3) Sweep arms after rings */
  orbBoot.sweep = true;

  /* Gauges right after orb */
  document.documentElement.classList.remove('boot-pending');
  /* keep panels/header/footer hidden via inline until entered */
  document.querySelectorAll('.panel, .header, .footer').forEach((el) => {
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
  });
  revealChrome('.orb-gauges', 'fui-in');
  await waitMs(200);

  /* Header / footer with or just before panels */
  revealChrome('.header', 'fui-in');
  revealChrome('.footer', 'fui-in');
  await waitMs(160);

  /* Panels: L weather→agenda→notes, then R mail→work→system */
  for (let i = 0; i < PANEL_ORDER.length; i++) {
    enterPanel(PANEL_ORDER[i]); /* fire; stagger */
    await waitMs(170);
  }
  await waitMs(420);

  document.querySelectorAll('.panel').forEach((el) => {
    el.style.opacity = '';
    el.style.pointerEvents = '';
  });
  document.documentElement.classList.add('boot-skip');
  setOrbBootFull();
  bootDone = true;
  bootRunning = false;
  document.documentElement.setAttribute('data-ready', '1');
}

function skipToRestingState() {
  setOrbBootFull();
  document.documentElement.classList.remove('boot-pending');
  document.documentElement.classList.add('boot-skip');
  document.querySelectorAll('.panel, .header, .footer, .orb-gauges').forEach((el) => {
    el.style.opacity = '';
    el.style.pointerEvents = '';
    el.classList.remove('fui-enter');
  });
  bootDone = true;
  document.documentElement.setAttribute('data-ready', '1');
}

async function afterBootHooks() {
  if (bootParams.focus && PANEL_ORDER.concat(['system']).includes(bootParams.focus)) {
    await waitMs(80);
    focusPanel(bootParams.focus);
  }
}


function boot() {
  updateClock(new Date());
  document.documentElement.setAttribute('data-live', animate ? '1' : '0');
  const voice = ['idle', 'listening', 'thinking', 'speaking'].includes(initialVoice)
    ? initialVoice : 'idle';
  applyVoicePreset(voice);
  bindGaugeTips();
  Panels.hydrateAll();
  const devUsage = parseUsageDevParam(usageDevRaw);
  if (devUsage) {
    usageView.fromDev = true;
    Panels.update('usage', devUsage);
  }
  /* Single WS owned by CoreLink via live-bridge.js — do not open a second socket.
     LiveBridge.init() auto-runs on DOMContentLoaded; call again if needed. */
  if (window.LiveBridge && typeof LiveBridge.init === 'function' && !window.__liveBridgeStarted) {
    window.__liveBridgeStarted = true;
    LiveBridge.init();
  }

  window.addEventListener('keydown', (e) => {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    const voiceMap = { '1': 'idle', '2': 'listening', '3': 'thinking', '4': 'speaking' };
    const allowVoiceTest = params.get('dev') === '1' || params.get('live') === '0';
    if (voiceMap[e.key] && allowVoiceTest) { applyVoicePreset(voiceMap[e.key]); return; }
    if (e.key === 'b' || e.key === 'B') { runBootSequence().then(afterBootHooks); return; }
    if (e.key === 'Escape') { unfocusPanel(); return; }
    const focusMap = {
      w: 'weather', W: 'weather',
      a: 'agenda', A: 'agenda',
      n: 'notes', N: 'notes',
      m: 'mail', M: 'mail',
      p: 'work', P: 'work',
      s: 'system', S: 'system',
    };
    if (focusMap[e.key]) { focusPanel(focusMap[e.key]); return; }
  });

  if (demoBriefing) runBriefingDemo();

  /* Start paint loop first so orb boot frames are visible */
  if (animate) {
    let t0 = performance.now();
    function frame(now) {
      const t = (now - t0) / 1000;
      paintFrame(t);
      if (now % 2000 < 20) updateClock(new Date());
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  const skipBoot = bootParams.skip || !animate;
  if (skipBoot) {
    skipToRestingState();
    if (!animate) paintFrame(freezeT);
    afterBootHooks();
  } else {
    setOrbBootEmpty();
    runBootSequence().then(afterBootHooks);
  }
  if (bootParams.replay && !skipBoot) {
    /* ?boot=replay already runs sequence above */
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

window.JarvisV2 = {
  applyVoicePreset, paintFrame, freezeT, animate, applyUsage, usageView,
  Panels, focusPanel, unfocusPanel, runBootSequence, orbBoot,
  setLiveAudioLevel,
  /* aliases used by live-bridge */
  applyVoicePreset,
  focusPanel,
  unfocusPanel,
  applyUsage,
};
