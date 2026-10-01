/* The desk in three dimensions.

   Every panel sits at the centre of the stage and is placed only by transform,
   so the same six boxes read as two arrangements of one room: the core view,
   where three panels stand angled either side of the orb, and the carousel,
   where one of them turns to face the viewer and the orb withdraws to the
   corner. One eased number, `mix`, is the whole distance between the two,
   which is why a view can be changed in the middle of a briefing without
   anything falling out of step: there is no second layout to drift from, only
   a position along the way.

   The orb leaves the middle because something else has the floor. The carousel
   is one such thing and a camera feed is another, so both raise `busy` and the
   orb travels the same path for either.

   Nothing here reads the WebSocket. app.js decides what has the floor and says
   so; this file only knows where things go. Layout is written straight to
   style from `frame()`, which the paint loop in app.js calls, because at sixty
   frames a second the shortest path from a number to the screen is the one
   that stays readable. */
(function () {
  'use strict';

  /* Where a panel stands in the core view: which side of the orb, and which of
     the three rows. Both angles follow from those two numbers, which is why the
     table is this short and why a panel cannot be given a pose by hand. */
  const SLOTS = {
    weather: { side: -1, row: -1 },
    agenda: { side: -1, row: 0 },
    notes: { side: -1, row: 1 },
    mail: { side: 1, row: -1 },
    work: { side: 1, row: 0 },
    system: { side: 1, row: 1 },
  };

  /* The order the carousel turns in: a briefing's reading order, with the facts
     last because that is where a briefing ends. */
  const RING = ['weather', 'agenda', 'mail', 'work', 'system', 'notes'];
  const N = RING.length;

  /* The box every pose is measured from. Panels are scaled rather than resized,
     so these two numbers set the proportions of the whole desk. */
  const BASE_W = 288;
  const BASE_H = 200;

  /* A pull request is a long title beside a short id. Laid out this much wider
     before it is scaled, the titles get a line each instead of three. Only the
     panel at the centre of the carousel is given it; at the side there is no
     room, and in the core view there is nothing to read. */
  const WIDE = { work: 2 };

  /* Long enough that the room turns rather than cuts, short enough that a
     briefing's next line does not wait for it. */
  const VIEW_MS = 1500;
  /* A card is quicker to arrive than a view is to turn, so the orb gets out of
     its way sooner. */
  const BUSY_MS = 1100;

  /* The stage is only three-dimensional where there is room for two panels
     either side of the orb. Below that the stacked layout in the stylesheet
     is the layout, and this file does nothing at all. */
  const WIDE_ENOUGH = '(min-width: 1101px)';
  const STILL = '(prefers-reduced-motion: reduce)';

  const state = {
    view: 'dash',
    mix: 0,
    mixFrom: 0,
    mixTo: 0,
    mixT0: -99,
    busy: false,
    busyMix: 0,
    busyFrom: 0,
    busyTo: 0,
    busyT0: -99,
    pos: 0,
    target: 0,
    active: null,
    sub: '',
    flashAt: Object.create(null),
    /* The width a panel was last given, so a size is only written when it
       changes: writing it every frame would restart the transition every
       frame and the panel would never arrive. */
    sized: Object.create(null),
  };

  let els = null;
  let now = 0;

  function smooth(x) {
    const c = Math.max(0, Math.min(1, x));
    return c * c * (3 - 2 * c);
  }

  function enabled() {
    if (typeof matchMedia !== 'function') return false;
    return matchMedia(WIDE_ENOUGH).matches && !matchMedia(STILL).matches;
  }

  function nodes() {
    if (els && els.stage.isConnected) return els;
    const stage = document.querySelector('.stage');
    if (!stage) return null;
    const panels = Object.create(null);
    const flashes = Object.create(null);
    const scans = Object.create(null);
    Object.keys(SLOTS).forEach(function (id) {
      const el = stage.querySelector('.panel[data-panel="' + id + '"]');
      if (!el) return;
      panels[id] = el;
      flashes[id] = el.querySelector('.panel-flash');
      scans[id] = el.querySelector('.panel-scan');
    });
    els = {
      stage: stage,
      panels: panels,
      flashes: flashes,
      scans: scans,
      orb: stage.querySelector('.orb-core'),
      dock: stage.querySelector('.orb-dock'),
      foot: document.querySelector('.stage-foot'),
      label: document.getElementById('stage-label'),
      sub: document.getElementById('stage-sub'),
    };
    return els;
  }

  /* ---------- the ring ---------- */

  function ringIndex(id) {
    return RING.indexOf(id);
  }

  function idAt(pos) {
    return RING[((Math.round(pos) % N) + N) % N];
  }

  /* The target that reaches ring position k the short way round, so stepping
     from the last panel to the first turns forwards by one rather than back
     by five. */
  function near(k) {
    const cur = Math.round(state.target);
    let d = ((k - cur) % N + N) % N;
    if (d > N / 2) d -= N;
    return cur + d;
  }

  /* ---------- selection ---------- */

  /* Twice up and twice down inside a fifth of a second, then a decay: a
     contact being made, not a fade being played. */
  function flashCurve(e) {
    if (e < 0) return 0;
    if (e < 0.07) return e / 0.07;
    if (e < 0.14) return 1 - ((e - 0.07) / 0.07) * 0.7;
    if (e < 0.21) return 0.3 + ((e - 0.14) / 0.07) * 0.7;
    return Math.exp(-(e - 0.21) * 3.2);
  }

  function clock() {
    return performance.now() / 1000;
  }

  function setView(v, delay) {
    if (state.view === v) return;
    state.view = v;
    state.mixFrom = state.mix;
    state.mixTo = v === 'car' ? 1 : 0;
    state.mixT0 = clock() + (delay || 0);
  }

  function setBusy(on) {
    const want = !!on;
    if (state.busy === want) return;
    state.busy = want;
    state.busyFrom = state.busyMix;
    state.busyTo = want ? 1 : 0;
    state.busyT0 = clock();
  }

  /* Give a panel the floor. `carousel` turns the room so it faces the viewer;
     without it the desk stays as it is and the panel is only lit, which is
     what a single answer deserves. */
  function select(id, opts) {
    if (!SLOTS[id]) return;
    const o = opts || {};
    const k = ringIndex(id);
    const fromDash = state.view === 'dash';
    state.active = id;

    if (o.carousel) {
      if (fromDash) {
        state.pos = k;
        state.target = k;
        setView('car', 0);
      } else {
        state.target = near(k);
      }
      /* The flash is for arriving, so it waits for the turn. From the core
         view that is the whole morph; within the carousel, one step of it. */
      state.flashAt[id] = clock() + (o.delay != null ? o.delay : fromDash ? 1.45 : 0.55);
      return;
    }

    /* Staying put. Line the carousel up anyway, so opening it later shows the
       panel that was last spoken about rather than whatever was centred
       before. */
    state.target = near(k);
    state.pos = state.target;
    state.flashAt[id] = clock() + (o.delay != null ? o.delay : 0.25);
  }

  function release() {
    state.active = null;
    setView('dash');
  }

  function browse(dir) {
    state.target = Math.round(state.target) + dir;
    const id = idAt(state.target);
    state.active = id;
    state.flashAt[id] = clock() + 0.55;
    return id;
  }

  /* ---------- the footer line ---------- */

  function panelName(id) {
    const n = nodes();
    const el = n && n.panels[id];
    const h = el && el.querySelector('.panel-title h2');
    return h ? h.textContent.trim().toUpperCase() : '';
  }

  function setSub(text) {
    state.sub = text || '';
  }

  function paintFoot() {
    const n = nodes();
    if (!n || !n.foot) return;
    const showing = state.view === 'car' || !!state.active;
    n.foot.setAttribute('data-on', showing ? '1' : '0');
    const id = state.view === 'car' ? idAt(state.pos) : state.active;
    const name = id ? panelName(id) : '';
    if (n.label && n.label.textContent !== name) n.label.textContent = name;
    const sub = state.sub || (state.view === 'car' ? 'ESC = CORE' : '');
    if (n.sub && n.sub.textContent !== sub) n.sub.textContent = sub;
  }

  /* ---------- layout ---------- */

  /* How wide the panel at the centre is allowed to be laid out, in multiples of
     the base box: what it asks for, within what the stage can hold. */
  function wideFactor(id, w, k) {
    const want = WIDE[id] || 1;
    if (want <= 1) return 1;
    const room = (w - 120) / (BASE_W * k);
    return Math.max(1, Math.min(want, room));
  }

  /* The panel at the centre of the carousel gets back the rows that did not fit
     on the desk, and grows to hold them.

     Once per arrival, and in this order: the width and the rows have to be its
     own before the height it needs is the right number. Measuring it every
     frame instead would chase the height just given — the rows fit, so nothing
     overflows, so the panel shrinks, so they do not fit. */
  function sizePanel(id, el, h, scale, wide, centre) {
    const width = Math.round(BASE_W * (centre ? wide : 1));
    const key = (centre ? 'c' : 's') + width + '@' + Math.round(scale * 100) + 'x' + Math.round(h);
    if (state.sized[id] === key) return;
    state.sized[id] = key;
    el.style.setProperty('--pw', width + 'px');
    el.style.setProperty('--ph', BASE_H + 'px');
    el.classList.toggle('is-centre', !!centre);
    if (window.LiveBridge && LiveBridge.fitPanel) LiveBridge.fitPanel(id);
    if (!centre) return;
    const body = el.querySelector('.panel-body');
    const grown = body ? Math.max(0, body.scrollHeight - body.clientHeight) : 0;
    if (!grown) return;
    const room = Math.max(0, (h * 0.86) / scale - BASE_H);
    el.style.setProperty('--ph', Math.round(BASE_H + Math.min(grown, room)) + 'px');
  }

  function layout(t) {
    const n = nodes();
    if (!n) return;
    const w = n.stage.clientWidth;
    const h = n.stage.clientHeight;
    const mix = state.mix;
    /* Until the desk says it is ready, the boot choreography owns what can be
       seen: each panel fades in one after another. The stage still places them,
       because the fade has to happen in the right spot, but says nothing about
       whether they are visible. */
    const curtain = !document.documentElement.hasAttribute('data-ready');

    /* Core view: the desk shrinks as a whole rather than rearranging, so a
       short window gives a smaller desk and not a different one. */
    const k0 = Math.min(1, h / 660, w / 1300);
    const X = w / 2 - 162 * k0;
    const Y = 214 * k0;

    /* Carousel: one box, as large as the shorter side of the stage allows. */
    const K = Math.max(0.6, Math.min(1.9, (h * 0.58) / BASE_H, (w * 0.42) / BASE_W));
    const centreId = idAt(state.pos);
    const centreWide = wideFactor(centreId, w, K);
    /* The extra width a wide panel is laid out at is for its lines, not for the
       room: scaled by K as well it would reach past both edges of the stage, so
       it is scaled back by as much as it was widened by. */
    const centreFit = Math.min(1, (w * 0.62) / (BASE_W * centreWide * K));
    /* Far enough out that the panel at the side keeps its own edge, whatever
       width the centre was given, and still on the stage. */
    const clear = BASE_W * centreWide * K * centreFit * 0.5 + BASE_W * K * 0.9 * 0.25 + 20;
    const X1 = Math.max(Math.min(w * 0.33, BASE_W * K * 1.05), Math.min(clear, w / 2 - 60));
    const X2 = BASE_W * K * 0.35;

    Object.keys(SLOTS).forEach(function (id) {
      const el = n.panels[id];
      if (!el) return;
      const slot = SLOTS[id];

      const dash = {
        x: slot.side * X,
        y: slot.row * Y,
        z: (slot.row ? -80 : 0) * k0,
        ry: -slot.side * (slot.row ? 24 : 8),
        rx: -slot.row * 10,
        s: k0,
        o: slot.row ? 0.92 : 1,
        b: 1,
        zi: 50,
      };

      let d = ((ringIndex(id) - state.pos) % N + N) % N;
      if (d > N / 2) d -= N;
      const sg = Math.sign(d);
      const a = Math.abs(d);
      const m = Math.min(a, 1);
      const far = Math.max(a - 1, 0);
      const car = {
        x: sg * (m * X1 + far * X2),
        y: -h * 0.06,
        z: -m * 156 * K - far * 200,
        ry: -sg * m * 38,
        rx: 0,
        s: K * (id === centreId ? centreFit : 1) * (1 - m * 0.1) * (1 - Math.min(far, 1) * 0.25),
        o: a <= 1 ? 1 - m * 0.18 : Math.max(0, 0.82 * (1 - far * 1.6)),
        b: 1 - m * 0.22,
        zi: 100 - Math.round(a * 10),
      };

      const v = {};
      Object.keys(dash).forEach(function (key) {
        v[key] = dash[key] + (car[key] - dash[key]) * mix;
      });

      /* Only the panel that is both centred and in the carousel is laid out
         wide: in the core view it is one of six, and at the side the extra
         width would reach across the stage. */
      const centre = mix > 0.5 && id === centreId;
      sizePanel(id, el, h, K * centreFit, centreWide, centre);

      const fe = t - (state.flashAt[id] == null ? -99 : state.flashAt[id]);
      const f = flashCurve(fe);

      /* The centring comes first, so it is the only step not multiplied by the
         scale that follows it: a panel at the centre is scaled to twice its
         size, and a half-width shift taken after that would push it a hundred
         and forty pixels off the middle of the stage. */
      el.style.transform =
        'translate(-50%,-50%)' +
        ' translate3d(' + v.x.toFixed(1) + 'px,' + v.y.toFixed(1) + 'px,' + v.z.toFixed(1) + 'px)' +
        ' rotateY(' + v.ry.toFixed(2) + 'deg) rotateX(' + v.rx.toFixed(2) + 'deg)' +
        ' scale(' + (v.s * (1 + f * 0.035)).toFixed(4) + ')';
      if (!curtain) {
        el.style.opacity = v.o.toFixed(3);
        el.style.visibility = v.o < 0.01 ? 'hidden' : 'visible';
      }
      el.style.zIndex = String(Math.round(v.zi));
      el.style.filter = 'brightness(' + (v.b * (1 + f * 0.45)).toFixed(3) + ')';

      /* After the flash has decayed the panel with the floor keeps a low glow,
         so what is being talked about is still marked once the room is still. */
      const held = id === state.active && fe >= 0 ? 0.28 : 0;
      const fl = n.flashes[id];
      if (fl) fl.style.opacity = Math.max(f, held).toFixed(3);
      const sc = n.scans[id];
      if (sc) {
        const p = Math.max(0, Math.min(1, fe / 0.5));
        sc.style.top = (p * 100).toFixed(1) + '%';
        sc.style.opacity = fe >= 0 && fe < 0.55 ? '1' : '0';
      }
    });
  }

  /* The orb's whole journey out of the middle, from whichever reason has the
     floor. It ends about seventy pixels across in the bottom-left corner,
     where it reads as a light left on rather than a thing being used. */
  function layoutOrb() {
    const n = nodes();
    if (!n || !n.orb) return;
    const w = n.stage.clientWidth;
    const h = n.stage.clientHeight;
    const e = smooth(Math.max(state.mix, state.busyMix));
    /* Sized from the room left over, with the state line under it counted in:
       the orb may fill the stage, but not at the price of its own caption. */
    const rest = Math.min(1, h / 700, w / 1300);
    const s = rest + (0.2 - rest) * e;
    const tx = (92 - w / 2) * e;
    const ty = (h / 2 - 86) * e;
    n.orb.style.transform =
      'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + s.toFixed(4) + ')';
    /* Reachable wherever it stands: the swarm is turned by hand, and the middle
       of the stage is empty anyway. */
    n.orb.style.pointerEvents = 'auto';
    if (n.dock) {
      /* The dock travels with the orb but is not scaled, so the state line and
         the pack strip stay readable in the corner. Under the orb while it is
         in the middle and centred on it; beside the orb once it is in the
         corner and anchored by its left edge, or a strip of pack cards would
         run off the stage rather than into the room. */
      const dx = tx - 56 * e;
      const dy = ty + (280 * rest + 18) * (1 - e) + 64 * e;
      n.dock.style.transform =
        'translate(' + (-50 + 50 * e).toFixed(1) + '%,0)' +
        ' translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
      n.dock.setAttribute('data-mini', e > 0.6 ? '1' : '0');
    }
  }

  function frame(t, animate) {
    if (!enabled()) return;
    now = t;
    const live = animate !== false;
    const wall = clock();
    state.mix = live
      ? state.mixFrom + (state.mixTo - state.mixFrom) * smooth((wall - state.mixT0) / (VIEW_MS / 1000))
      : state.mixTo;
    state.busyMix = live
      ? state.busyFrom + (state.busyTo - state.busyFrom) * smooth((wall - state.busyT0) / (BUSY_MS / 1000))
      : state.busyTo;

    if (live) {
      const dt = Math.min(0.05, Math.max(0, t - (frame.last == null ? t : frame.last)));
      frame.last = t;
      state.pos += (state.target - state.pos) * (1 - Math.exp(-dt * 7));
      if (Math.abs(state.target - state.pos) < 0.0005) state.pos = state.target;
    } else {
      state.pos = state.target;
    }

    layout(live ? t : 99);
    layoutOrb();
    paintFoot();
  }

  /* Hand the stage back the panels it borrowed, for the stacked layout and for
     a window that was narrowed while a panel had the floor. */
  function reset() {
    const n = nodes();
    if (!n) return;
    Object.keys(n.panels).forEach(function (id) {
      const el = n.panels[id];
      el.style.transform = '';
      el.style.opacity = '';
      el.style.visibility = '';
      el.style.zIndex = '';
      el.style.filter = '';
      el.style.removeProperty('--pw');
      el.style.removeProperty('--ph');
      el.classList.remove('is-centre');
      const fl = n.flashes[id];
      if (fl) fl.style.opacity = '0';
    });
    state.sized = Object.create(null);
    if (n.orb) {
      n.orb.style.transform = '';
      n.orb.style.pointerEvents = '';
    }
    if (n.dock) {
      n.dock.style.transform = '';
      n.dock.setAttribute('data-mini', '0');
    }
    if (n.foot) n.foot.setAttribute('data-on', '0');
  }

  window.addEventListener('resize', function () {
    els = null;
    if (!enabled()) reset();
  });

  window.JarvisStage = {
    frame: frame,
    enabled: enabled,
    has: function (id) {
      return !!SLOTS[id];
    },
    select: select,
    release: release,
    browse: browse,
    setView: setView,
    setBusy: setBusy,
    setSub: setSub,
    reset: reset,
    view: function () {
      return state.view;
    },
    active: function () {
      return state.active;
    },
    centre: function () {
      return idAt(state.pos);
    },
    order: RING.slice(),
  };
})();
