/* The swarm orb: a shell of 900 points, drawn from the voice state. It is the
   orb; ?orb=rings brings back the ring orb beside it.

   The cloud is not data. It is a pure function of one seed, so this file stays
   small, the frozen test frames match everywhere, and the shape can be read
   rather than inspected. Every point also carries its own phase, speed, wobble
   axis and outward vector, which is what makes a thousand of them breathe like
   one body instead of a grid.

   Colour stays the desk's: the state hue arrives eased in `env.hue`, every
   point sits on it, and activity moves a point up a ramp of that same hue
   towards white. So the swarm turns violet while listening and amber while
   thinking along with the rest of the screen. */

const SWARM_N = 900;
/* The design's world radius. Point sizes below are in the same units, so what
   reaches the screen is the ratio size / SWARM_R. */
const SWARM_R = 0.12;
/* Activation is quantised into steps on purpose: the banding is the look. */
const SWARM_K = 8;
/* Camera distance and tilt in shell radii — far enough that the far side is
   only a little smaller than the near side, which keeps it reading as a swarm
   instead of a funnel. */
const SWARM_CAMERA = 3.4;
const SWARM_TILT = -0.16;
/* Radians a second at rest. Slow enough to be weather rather than motion, fast
   enough that a glance a minute apart does not find the same face. */
const SWARM_IDLE_SPIN = 0.17;
/* A thought breaking into speech throws the shell outwards for this long. */
const SWARM_BURST_S = 1.4;

/* The boot arrival. The points start this many shell radii out -- far enough to
   be off the frame, so they fly in from outside it rather than appearing on it
   -- and the camera pulls back by `PULL` while they do, which is what keeps the
   travelling cloud inside a square canvas. `STAGGER` is the share of the boot
   the cascade spans: the whole shell is not one arrival but a near face landing
   first and the far side still on its way. */
const SWARM_BOOT_FROM = 3.6;
const SWARM_BOOT_PULL = 1.9;
const SWARM_BOOT_STAGGER = 0.72;
const SWARM_BOOT_DEPTH = 0.35;

/* Three brightnesses of resting point. Saturation and lightness are the
   design's; the hue comes from the voice state at draw time. */
const SWARM_TIERS = [
  { sat: 88, light: 10, alpha: 0.55, size: 0.0018 },
  { sat: 83, light: 47, alpha: 0.85, size: 0.0024 },
  { sat: 100, light: 79, alpha: 1.0, size: 0.0034 },
];

const SWARM_POINTS = (() => {
  /* Park–Miller from seed 7. The sequence *is* the cloud: reorder these draws
     and it is a different cloud. */
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const GA = Math.PI * (3 - Math.sqrt(5)); /* golden angle: an even sphere */
  const pts = [];

  for (let i = 0; i < SWARM_N; i++) {
    const y = 1 - ((i + 0.5) / SWARM_N) * 2;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const th = GA * i;
    const dir = { x: Math.cos(th) * rr, y, z: Math.sin(th) * rr };
    const u = rnd();
    const axis = { x: 0, y: 0, z: 0 };
    const p = {
      dir,
      tier: u > 0.93 ? 2 : u > 0.6 ? 1 : 0,
      shell: SWARM_R * (0.82 + rnd() * 0.22),
      ph: rnd() * Math.PI * 2,
      sp: 0.25 + rnd() * 0.5,
      amp: 0.006 + rnd() * 0.01,
      axis,
      theta: Math.atan2(dir.z, dir.x),
      sc: { x: 0, y: 0, z: 0 },
    };
    axis.x = rnd() - 0.5;
    axis.y = rnd() - 0.5;
    axis.z = rnd() - 0.5;
    const al = Math.hypot(axis.x, axis.y, axis.z) || 1;
    axis.x /= al;
    axis.y /= al;
    axis.z /= al;
    pts.push(p);
  }

  /* A second pass, as the design has it: the vector each point flies along
     when the shell bursts. */
  for (const p of pts) {
    const sx = rnd() - 0.5;
    const sy = rnd() - 0.5;
    const sz = rnd() - 0.5;
    const k = 0.4 + rnd() * 0.8;
    p.sc = {
      x: (sx * 2 + p.dir.x) * k,
      y: (sy * 2 + p.dir.y) * k,
      z: (sz * 2 + p.dir.z) * k,
    };
  }

  return pts;
})();

/* Integrated, not t × speed: a state change must speed the swarm up, never
   teleport it to a new angle. Same reason the rings do it (app.js). */
const swarmMotion = {
  last: null,
  drift: 0,
  spin: 0,
  /* Where a hand has left the cloud. The idle turn carries on from here rather
     than from zero, so letting go does not snap the swarm back. */
  yaw: 0,
  pitch: 0,
  lv: { listening: 0, thinking: 0, speaking: 0 },
  envSpeak: 0,
  burstAt: -Infinity,
  state: 'idle',
};

function swarmEase(v, to, up, down, dt) {
  return v + (to - v) * Math.min(1, dt * (to > v ? up : down));
}

/* One ramp of eight, rebuilt only when the eased hue has moved a whole degree:
   otherwise this would build thousands of colour objects a second. The glows
   are gradients around the origin, placed by the transform at draw time — a
   gradient is fixed in user space, so this is the only way to pay for them
   once rather than per point. */
const swarmRamp = { hue: null, steps: [], tiers: [], stepGlow: [], tierGlow: [] };

function swarmGlow(ctx, hue, sat, light) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, `hsla(${hue},${sat}%,${light}%,0.5)`);
  g.addColorStop(0.35, `hsla(${hue},${sat}%,${light}%,0.14)`);
  g.addColorStop(1, `hsla(${hue},${sat}%,${light}%,0)`);
  return g;
}

function swarmColours(ctx, hue) {
  if (swarmRamp.hue === hue) return swarmRamp;
  swarmRamp.hue = hue;
  swarmRamp.tiers = SWARM_TIERS.map(
    (tr) => `hsla(${hue},${tr.sat}%,${tr.light}%,${tr.alpha})`,
  );
  swarmRamp.tierGlow = SWARM_TIERS.map((tr) =>
    swarmGlow(ctx, hue, tr.sat, tr.light),
  );
  swarmRamp.steps = [];
  swarmRamp.stepGlow = [];
  for (let k = 0; k < SWARM_K; k++) {
    const f = (k + 1) / SWARM_K;
    const sat = Math.round(100 - f * 14);
    const light = Math.round(44 + f * 52);
    swarmRamp.steps.push(`hsla(${hue},${sat}%,${light}%,${(0.6 + f * 0.4).toFixed(3)})`);
    swarmRamp.stepGlow.push(swarmGlow(ctx, hue, sat, light));
  }
  return swarmRamp;
}

/* Rodrigues: rotate a unit vector about a unit axis. The per-point wobble is a
   rotation rather than an offset, so a point never leaves its shell. */
function swarmRotate(out, v, axis, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const d = axis.x * v.x + axis.y * v.y + axis.z * v.z;
  out.x = v.x * c + (axis.y * v.z - axis.z * v.y) * s + axis.x * d * (1 - c);
  out.y = v.y * c + (axis.z * v.x - axis.x * v.z) * s + axis.y * d * (1 - c);
  out.z = v.z * c + (axis.x * v.y - axis.y * v.x) * s + axis.z * d * (1 - c);
}

const swarmTmp = { x: 0, y: 0, z: 0 };

function drawSwarmOrb(ctx, W, H, t, env) {
  const hue = Math.round(env.hue ?? 200);
  const state = env.state || 'idle';
  const m = swarmMotion;
  const lv = m.lv;

  if (state !== m.state) {
    if (m.state === 'thinking' && state === 'speaking') m.burstAt = t;
    m.state = state;
  }

  /* The syllable envelope is the real playback level: app.js already measures
     RMS against its recent peak, so loud reads as 1 whatever the voice. */
  const syl = Math.min(1, Math.max(0, (env.amp || 0) / 2.2));

  let drift;
  let spin;
  let envSpeak;
  let burst;

  if (env.frozen) {
    /* A frozen frame must be a function of t alone: one state, held, no event. */
    lv.listening = state === 'listening' ? 1 : 0;
    lv.thinking = state === 'thinking' ? 1 : 0;
    lv.speaking = state === 'speaking' ? 1 : 0;
    envSpeak = syl * lv.speaking;
    burst = 0;
    drift = t * (1 + lv.listening * 2.5 + lv.thinking * 3 + envSpeak * 2);
    spin = t * (SWARM_IDLE_SPIN + lv.thinking * 0.7);
  } else {
    const dt = m.last === null ? 0 : Math.min(0.05, Math.max(0, t - m.last));
    m.last = t;
    lv.listening = swarmEase(lv.listening, state === 'listening' ? 1 : 0, 3, 2.5, dt);
    lv.thinking = swarmEase(lv.thinking, state === 'thinking' ? 1 : 0, 3, 2.5, dt);
    lv.speaking = swarmEase(lv.speaking, state === 'speaking' ? 1 : 0, 3, 2.5, dt);
    m.envSpeak = swarmEase(m.envSpeak, syl * lv.speaking, 18, 6, dt);
    envSpeak = m.envSpeak;
    const bx = (t - m.burstAt) / SWARM_BURST_S;
    burst = bx >= 0 && bx < 1 ? Math.pow(Math.sin(Math.PI * Math.pow(bx, 0.6)), 2) : 0;
    m.drift +=
      dt * (1 + lv.listening * 2.5 + lv.thinking * 3 + envSpeak * 2 + burst * 6);
    m.spin += dt * (SWARM_IDLE_SPIN + lv.thinking * 0.7 + burst * 2.4);
    drift = m.drift;
    spin = m.spin;
  }

  const T = lv.thinking;
  /* An incoming voice arrives smoother than our own. */
  const envListen =
    (0.55 + 0.25 * Math.sin(t * 2.1) + 0.2 * Math.sin(t * 5.3 + 1)) * lv.listening;
  const spread = burst * 1.6 + Math.max(0, envSpeak - 0.55) * 1.4;

  const cx = W / 2;
  const cy = H / 2;
  const Rpx = (Math.min(W, H) / 2) * 0.9;
  const reveal = Math.max(0, Math.min(1, env.boot ?? 1));
  /* A burst throws points to nearly twice the shell radius and boot starts them
     further out still, both of which run off a square canvas and read as the
     cloud being cut to a box. The camera pulls back instead, by exactly as much
     as the cloud has grown. */
  const unit = (Rpx * 0.78) / (1 + spread * 0.45 + (1 - reveal) * SWARM_BOOT_PULL);
  const colours = swarmColours(ctx, hue);

  ctx.clearRect(0, 0, W, H);
  if (reveal <= 0.01) return;

  /* The whole cloud rolls while thinking, as the design's orb does. */
  const roll = Math.sin(t * 0.8) * 0.12 * T;
  const cs = Math.cos(spin + m.yaw);
  const ss = Math.sin(spin + m.yaw);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  /* The tilt is where the cloud is being looked at from, so a drag up or down
     belongs here rather than in a rotation of its own. */
  const tilt = SWARM_TILT + m.pitch;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);

  ctx.save();
  /* Additive, so the draw order does not matter and no depth sort is needed —
     overlapping points simply add up, which is what makes the near face glow. */
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = reveal;

  /* Atmosphere behind the swarm, so the shell sits in light rather than on black. */
  const core = 0.05 + (env.energy ?? 0.4) * 0.06 + envSpeak * 0.05;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Rpx * 1.1);
  g.addColorStop(0, `hsla(${hue},95%,60%,${core.toFixed(3)})`);
  g.addColorStop(0.55, `hsla(${hue},90%,50%,${(core * 0.35).toFixed(3)})`);
  g.addColorStop(1, `hsla(${hue},85%,45%,0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, Rpx * 1.1, 0, 7);
  ctx.fill();

  for (let i = 0; i < SWARM_N; i++) {
    const p = SWARM_POINTS[i];
    const dir = p.dir;

    /* Three waves over the shell, one per state, each with its own geometry:
       speech runs in bands up the body, listening ripples out of the equator,
       thought flickers in sparse patches that drift. */
    const wS =
      envSpeak * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(dir.y * 7 - t * 9 + p.ph * 0.6)));
    const wL =
      envListen *
      (0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(Math.abs(dir.y) * 9 + t * 4.5), 2));
    const wT =
      T *
      Math.pow(0.5 + 0.5 * Math.sin(p.theta * 3 + dir.y * 5 - t * 3.2), 4) *
      (0.6 + 0.4 * Math.sin(t * 7 + p.ph));

    swarmRotate(
      swarmTmp,
      dir,
      p.axis,
      Math.sin(drift * p.sp * 0.4 + p.ph) * (0.12 + T * 0.1),
    );
    const r =
      (p.shell + Math.sin(drift * p.sp + p.ph) * p.amp) *
      (1 + wS * 0.14 - wL * 0.08 - T * 0.04 + wT * 0.05);

    const out = spread * 0.05;
    let x = (swarmTmp.x * r + p.sc.x * out) / SWARM_R;
    let y = (swarmTmp.y * r + p.sc.y * out) / SWARM_R;
    let z = (swarmTmp.z * r + p.sc.z * out) / SWARM_R;

    /* During boot the points arrive from outside, nearest first. */
    if (reveal < 1) {
      const order = 1 - (i / SWARM_N) * SWARM_BOOT_STAGGER;
      const k = Math.max(0, Math.min(1, (reveal - (1 - order)) / order));
      if (k <= 0) continue;
      /* Eased, so a point crosses the distance fast and then settles onto its
         shell rather than stopping dead on arrival. */
      const travelled = 1 - Math.pow(1 - k, 2.2);
      const from = SWARM_BOOT_FROM + (1 - SWARM_BOOT_FROM) * travelled;
      x *= from;
      y *= from;
      /* Depth travels a fraction of what the plane does. The camera sits
         SWARM_CAMERA radii out, so a point given the full distance towards it
         crosses the lens and comes out mirrored through the centre; and the
         flight that can actually be seen is the one across the frame. */
      z *= 1 + (from - 1) * SWARM_BOOT_DEPTH;
    }

    /* Spin about y, then the thinking roll about z, then the fixed tilt. */
    const rx = x * cs + z * ss;
    z = z * cs - x * ss;
    x = rx * cr - y * sr;
    y = rx * sr + y * cr;
    const ry = y * ct - z * st;
    z = y * st + z * ct;
    y = ry;

    const persp = SWARM_CAMERA / (SWARM_CAMERA - z);
    const sx = cx + x * unit * persp;
    const sy = cy - y * unit * persp;

    let w = Math.max(wS, envSpeak > T ? spread * 0.5 : 0);
    if (wL > w) w = wL;
    const wTb = Math.max(wT, burst * 0.7);
    if (wTb > w) w = wTb;
    const k = Math.floor(w * SWARM_K * 1.1) - 1;
    const active = k >= 0;

    /* Depth reads as brightness, which additive compositing gives for free. An
       active point keeps most of its light, so a wave shows through the body. */
    const dz = Math.max(0, Math.min(1, (z + 1) / 2));
    /* Whatever the camera does, a point near the edge of the frame fades out
       rather than meeting the canvas border, so the cloud never has a corner. */
    const edge = Math.hypot(sx - cx, sy - cy) / Rpx;
    if (edge > 1.06) continue;
    const fade = edge > 0.88 ? 1 - (edge - 0.88) / 0.18 : 1;
    const alpha = reveal * fade * (active ? 0.6 + 0.4 * dz : 0.3 + 0.7 * dz);
    const step = active ? Math.min(SWARM_K - 1, k) : -1;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = active ? colours.steps[step] : colours.tiers[p.tier];

    const rad = Math.max(
      0.4,
      (SWARM_TIERS[p.tier].size / SWARM_R) * unit * persp * (1 + w * 0.5),
    );
    ctx.beginPath();
    ctx.arc(sx, sy, rad, 0, 7);
    ctx.fill();

    /* One soft halo on the brightest points and on anything riding a wave:
       cheaper than a blur, and it is what makes the shell glow rather than
       speckle. */
    if (p.tier === 2 || w > 0.55) {
      const k2 = rad * 3.4;
      ctx.globalAlpha = alpha * (0.3 + w * 0.3);
      ctx.fillStyle = active ? colours.stepGlow[step] : colours.tierGlow[p.tier];
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(k2, k2);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, 7);
      ctx.fill();
      ctx.restore();
    }
  }

  ctx.restore();
}

/* A hand on the cloud turns it. Yaw accumulates without limit -- all the way
   round is the point -- while the tilt stops short of the poles, where a shell
   of points seen end-on stops reading as a sphere at all. */
window.JarvisSwarm = {
  drag: function (dx, dy) {
    const m = swarmMotion;
    m.yaw += dx * 0.007;
    m.pitch = Math.max(-1.35, Math.min(1.35, m.pitch + dy * 0.007));
  },
};
