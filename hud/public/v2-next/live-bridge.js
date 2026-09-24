/* Live bridge: CoreLink → JarvisV2.
   Single WebSocket owned by CoreLink. Relative asset; works at /v2-next/ and /. */
(function () {
  'use strict';

  const FIXED = ['weather', 'agenda', 'notes', 'mail', 'work', 'system'];
  const params = new URLSearchParams(location.search);
  const liveOff = params.get('live') === '0';
  const usageOverride = params.has('usage');
  const SPARK_N = 32;
  const sparkHist = { cpu: [], mem: [] };

  let link = null;
  let packSlots = [];
  let freeCards = Object.create(null);
  let staleFocusTimer = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function emptyHtml() {
    return '<div class="empty-state"><span class="empty-line"></span><span class="empty-label">Awaiting Core</span></div>';
  }

  function setMeta(id, text) {
    const el = document.querySelector('[data-meta="' + id + '"]');
    if (el) el.textContent = text || '';
  }

  function setBody(id, html) {
    const el = document.querySelector('[data-body="' + id + '"]');
    if (el) el.innerHTML = html;
  }

  function cacheKey(id) {
    return 'jarvis.v2.panel.' + id;
  }

  function cachePanel(id, data) {
    try {
      localStorage.setItem(cacheKey(id), JSON.stringify({ data: data, at: Date.now() }));
    } catch (e) {}
  }

  function loadCache(id) {
    try {
      const raw = localStorage.getItem(cacheKey(id));
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p && p.data ? p.data : null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- Weather icon ----------
     A small line drawing in the desk's own colour, moving the way the weather
     does: the sun turns, clouds drift, rain and snow fall, lightning flickers.
     Keyed on Home Assistant's condition enum; the words are the fallback for
     a condition that came in as text only. */
  const WI_CLOUD = '<path class="wi-cloud" d="M15 33h19a7 7 0 0 0 .8-13.95A10 10 0 0 0 15.4 17 8 8 0 0 0 15 33z"/>';
  function wiSun(cx, cy, r) {
    let rays = '';
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const x1 = cx + Math.cos(a) * (r + 3), y1 = cy + Math.sin(a) * (r + 3);
      const x2 = cx + Math.cos(a) * (r + 6), y2 = cy + Math.sin(a) * (r + 6);
      rays += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"/>';
    }
    return '<g class="wi-sun"><circle cx="' + cx + '" cy="' + cy + '" r="' + r + '"/><g class="wi-rays">' + rays + '</g></g>';
  }
  function wiFall(kind, n) {
    let out = '<g class="wi-' + kind + '">';
    for (let i = 0; i < n; i++) {
      const x = 17 + i * (15 / Math.max(1, n - 1));
      out += kind === 'snow'
        ? '<circle cx="' + x.toFixed(1) + '" cy="37" r="1.3" style="animation-delay:' + (i * 0.45).toFixed(2) + 's"/>'
        : '<line x1="' + x.toFixed(1) + '" y1="36" x2="' + (x - 1.5).toFixed(1) + '" y2="40" style="animation-delay:' + (i * 0.27).toFixed(2) + 's"/>';
    }
    return out + '</g>';
  }
  const WI = {
    sunny: function () { return wiSun(24, 24, 7); },
    'clear-night': function () {
      return '<path class="wi-moon" d="M27 11a13 13 0 1 0 10 21 10.5 10.5 0 0 1-10-21z"/>' +
        '<g class="wi-stars"><path d="M36 12v4M34 14h4"/><path d="M40 22v3M38.5 23.5h3" style="animation-delay:1.1s"/></g>';
    },
    partlycloudy: function () { return wiSun(18, 18, 5) + '<g class="wi-drift">' + WI_CLOUD.replace('wi-cloud', 'wi-cloud wi-front') + '</g>'; },
    cloudy: function () { return '<g class="wi-drift">' + WI_CLOUD + '</g>'; },
    rainy: function () { return '<g class="wi-drift">' + WI_CLOUD + '</g>' + wiFall('rain', 3); },
    pouring: function () { return '<g class="wi-drift">' + WI_CLOUD + '</g>' + wiFall('rain fast', 5); },
    snowy: function () { return '<g class="wi-drift">' + WI_CLOUD + '</g>' + wiFall('snow', 3); },
    'snowy-rainy': function () { return '<g class="wi-drift">' + WI_CLOUD + '</g>' + wiFall('rain', 2) + wiFall('snow', 2); },
    hail: function () { return '<g class="wi-drift">' + WI_CLOUD + '</g>' + wiFall('snow fast', 4); },
    lightning: function () { return '<g class="wi-drift">' + WI_CLOUD + '</g><path class="wi-bolt" d="M25 31l-4 7h5l-3 7"/>'; },
    'lightning-rainy': function () { return '<g class="wi-drift">' + WI_CLOUD + '</g><path class="wi-bolt" d="M25 31l-4 7h5l-3 7"/>' + wiFall('rain', 2); },
    fog: function () {
      return '<g class="wi-fog"><path d="M11 20h26"/><path d="M8 26h28" style="animation-delay:.8s"/><path d="M12 32h26" style="animation-delay:1.6s"/></g>';
    },
    windy: function () {
      return '<g class="wi-wind"><path d="M8 19h20a4 4 0 1 0-4-4"/><path d="M8 26h28a4 4 0 1 1-4 4" style="animation-delay:.6s"/><path d="M8 33h14" style="animation-delay:1.2s"/></g>';
    },
  };
  WI['windy-variant'] = WI.windy;
  WI.exceptional = WI.cloudy;

  function weatherKind(icon, text) {
    if (icon && WI[icon]) return icon;
    const t = String(text || icon || '').toLowerCase();
    if (/thunder|lightning|onweer/.test(t)) return 'lightning';
    if (/pour|heavy rain|stortregen/.test(t)) return 'pouring';
    if (/snow|sneeuw/.test(t)) return 'snowy';
    if (/hail|hagel/.test(t)) return 'hail';
    if (/rain|drizzle|shower|regen|motregen|bui/.test(t)) return 'rainy';
    if (/fog|mist|haze|nevel/.test(t)) return 'fog';
    if (/wind/.test(t)) return 'windy';
    if (/partly|half|bewolkt met|part/.test(t)) return 'partlycloudy';
    if (/night|nacht/.test(t)) return 'clear-night';
    if (/sun|clear|zon|helder/.test(t)) return 'sunny';
    if (/cloud|overcast|bewolkt/.test(t)) return 'cloudy';
    return null;
  }

  function weatherIconHtml(vm) {
    const kind = weatherKind(vm.icon, vm.condition);
    if (!kind) return '';
    return '<svg class="wx-icon" viewBox="0 0 48 48" aria-hidden="true" data-kind="' + kind + '">' + WI[kind]() + '</svg>';
  }

  /* ---------- Renderers ---------- */
  function renderWeather(vm) {
    if (!vm || (vm.temp == null && !vm.condition && !(vm.forecast && vm.forecast.length) && !(vm.tiles && vm.tiles.length))) {
      setMeta('weather', '');
      setBody('weather', emptyHtml());
      return;
    }
    setMeta('weather', vm.title && vm.title !== 'Weather' ? vm.title : '');
    let html = '<div class="weather-temp">' + weatherIconHtml(vm);
    if (vm.temp != null) {
      html += '<div class="deg">' + esc(Math.round(vm.temp)) + '<span>' + esc(vm.unit || '°') + '</span></div>';
    }
    html += '<div class="cond"><div class="now">' + esc(vm.condition || '—') + '</div>';
    if (vm.sun && (vm.sun.rise || vm.sun.set)) {
      html +=
        '<div class="loc">' +
        esc((vm.sun.rise || '') + (vm.sun.rise && vm.sun.set ? ' · ' : '') + (vm.sun.set || '')) +
        '</div>';
    }
    html += '</div></div>';
    if (vm.forecast && vm.forecast.length) {
      html += '<div class="forecast-row">';
      vm.forecast.slice(0, 4).forEach(function (d) {
        const hi = d.high != null ? Math.round(d.high) + '°' : '—';
        html += '<div class="day">' + esc(d.label || '') + '<strong>' + esc(hi) + '</strong></div>';
      });
      html += '</div>';
    } else if (vm.tiles && vm.tiles.length) {
      html += '<ul class="list">';
      vm.tiles.slice(0, 4).forEach(function (t) {
        html +=
          '<li><span class="t">' +
          esc(t.label) +
          '</span><span class="body">' +
          esc(t.value) +
          '</span></li>';
      });
      html += '</ul>';
    }
    setBody('weather', html);
  }

  /* Every list panel opens the same way: how many, big, and beside it what
     that number is -- plus, where there is one, the line that matters most
     (the agenda's next appointment, the mail that wants an answer). A panel
     with data and nothing in it says 0; only a panel that has heard nothing
     yet waits for Core. */
  function heroHtml(value, label, aside) {
    return (
      '<div class="hero-metric hero-row"><div class="value">' + esc(value) + '</div>' +
      '<div class="hero-text"><div class="label">' + esc(label) + '</div>' +
      (aside ? '<div class="aside">' + aside + '</div>' : '') +
      '</div></div>'
    );
  }

  /* One line per item on the desk; the enlarged window shows the rest of it.
     Rows that do not fit fall off the end rather than scroll out of sight. */
  function rowHtml(cls, t, body, sub) {
    return (
      '<li class="fit-item' + (cls ? ' ' + cls : '') + '"><span class="t">' + esc(t) + '</span>' +
      '<span class="body">' + esc(body) + (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') +
      '</span></li>'
    );
  }

  const FIT_PANELS = ['agenda', 'notes', 'mail', 'work', 'system'];

  /** Hide the rows that would overflow the panel, last first. */
  function fitPanel(id) {
    const body = document.querySelector('[data-body="' + id + '"]');
    if (!body) return;
    const rows = Array.prototype.slice.call(body.querySelectorAll('.fit-item'));
    rows.forEach(function (r) { r.classList.remove('fit-hidden'); });
    const panel = body.closest('.panel');
    if (!panel || panel.classList.contains('is-focused')) return;
    if (getComputedStyle(body).overflowY === 'visible') return;   /* narrow layout: panels grow */
    for (let i = rows.length - 1; i >= 0 && body.scrollHeight > body.clientHeight + 1; i--) {
      rows[i].classList.add('fit-hidden');
    }
  }

  function fitAll() {
    FIT_PANELS.forEach(fitPanel);
  }

  function setList(id, html) {
    setBody(id, html);
    fitPanel(id);
  }

  /* The next timed item still to come, when the tiles have not said. */
  function nextFromItems(items) {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    for (const it of items) {
      const m = String(it.time || '').match(/^(\d{1,2}):(\d{2})/);
      if (m && parseInt(m[1], 10) * 60 + parseInt(m[2], 10) >= mins) return it.time + ' ' + it.title;
    }
    return null;
  }

  function renderAgenda(vm) {
    const now = new Date();
    setMeta(
      'agenda',
      now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    );
    if (!vm) {
      setBody('agenda', emptyHtml());
      return;
    }
    const items = vm.items || [];
    const count = vm.count != null ? vm.count : items.length;
    const next = vm.nextUp || nextFromItems(items);
    let html = heroHtml(
      count,
      count === 1 ? 'Item today' : 'Items today',
      next ? '<span class="k">Next up</span> ' + esc(next) : ''
    );
    html += '<ul class="list compact">';
    items.forEach(function (it) {
      html += rowHtml(it.mark ? 'mark' : '', it.time, it.title, it.sub);
    });
    html += '</ul>';
    setList('agenda', html);
  }

  function renderNotes(vm) {
    setMeta('notes', '');
    if (!vm) {
      setBody('notes', emptyHtml());
      return;
    }
    const items = vm.items || [];
    let html = heroHtml(items.length, items.length === 1 ? 'Note' : 'Notes');
    html += '<ul class="list compact">';
    items.forEach(function (it) {
      html += rowHtml('', it.tag, it.text);
    });
    html += '</ul>';
    setList('notes', html);
  }

  /* The figure is what he says about new mail (0 for "nothing new"); beside
     it how many want something from you, and under it which ones. Windows
     from before the pack sent a figure fall back to the unread count. */
  function renderMail(vm) {
    setMeta('mail', 'inbox');
    if (!vm) {
      setBody('mail', emptyHtml());
      return;
    }
    const items = vm.items || [];
    let value, label, aside = '';
    if (vm.figure) {
      value = vm.figure.value;
      label = 'New';
      if (vm.figure.label) aside = esc(vm.figure.label);
    } else {
      value = vm.unread != null ? vm.unread : items.length;
      label = vm.unread != null ? 'Unread' : 'Recent';
    }
    let html = heroHtml(value, label, aside);
    html += '<ul class="list compact mail-list">';
    items.forEach(function (it) {
      html += rowHtml(it.mark ? 'mark' : '', it.from, it.subject, it.hint);
    });
    html += '</ul>';
    setList('mail', html);
  }

  function renderWork(vm) {
    setMeta('work', '');
    if (!vm) {
      setBody('work', emptyHtml());
      return;
    }
    const items = vm.items || [];
    const count = vm.openCount != null ? vm.openCount : items.length;
    let html = heroHtml(count, count === 1 ? 'Open pull request' : 'Open pull requests');
    html += '<ul class="list compact">';
    items.forEach(function (it) {
      html += rowHtml(it.mark ? 'mark' : '', it.id, it.title, it.state);
    });
    html += '</ul>';
    setList('work', html);
  }

  function renderSystem(vm) {
    setMeta('system', '');
    if (!vm || (vm.cpu == null && vm.mem == null && vm.disk == null && vm.uptime == null)) {
      setBody('system', emptyHtml());
      return;
    }
    /* CPU, memory and disk are in the footer already; this panel is uptime and
       the health of what the brain depends on. */
    let html = '<ul class="list">';
    if (vm.uptime != null) html += '<li class="fit-item"><span class="t">UP</span><span class="body">' + esc(vm.uptime) + '</span></li>';
    if (vm.health && vm.health.length) {
      vm.health.slice(0, 5).forEach(function (h) {
        html +=
          '<li class="fit-item"><span class="t">' +
          esc(String(h.server || '').toUpperCase()) +
          '</span><span class="body">' +
          esc(h.state || '') +
          (h.detail ? ' · ' + esc(h.detail) : '') +
          '</span></li>';
      });
    }
    html += '</ul>';
    setList('system', html);

    pushSpark('cpu', vm.cpu);
    pushSpark('mem', vm.mem != null ? Math.min(100, vm.mem * 10) : null);
    const cpuEl = document.getElementById('spark-cpu-val');
    const memEl = document.getElementById('spark-mem-val');
    const diskEl = document.getElementById('spark-disk-val');
    const diskBar = document.getElementById('disk-bar');
    if (cpuEl) cpuEl.textContent = vm.cpu != null ? vm.cpu + '%' : '—';
    if (memEl) memEl.textContent = vm.mem != null ? vm.mem + 'G' : '—';
    if (diskEl) diskEl.textContent = vm.disk != null ? vm.disk + '%' : '—';
    if (diskBar && vm.disk != null) diskBar.style.width = Math.max(0, Math.min(100, vm.disk)) + '%';
    drawSpark('spark-cpu', sparkHist.cpu);
    drawSpark('spark-net', sparkHist.mem);
  }

  function renderPackCard(vm) {
    if (!vm || !vm.topic) return;
    const card = document.querySelector('.pack-card[data-topic="' + cssEscape(vm.topic) + '"]');
    if (!card) return;
    const body = card.querySelector('.pack-body');
    const title = card.querySelector('.pack-title');
    if (title && vm.title) title.textContent = vm.title;
    if (!body) return;
    let html = '';
    if (vm.tiles && vm.tiles.length) {
      vm.tiles.slice(0, 3).forEach(function (t) {
        html +=
          '<div class="pack-row"><span>' + esc(t.label) + '</span><b>' + esc(t.value) + '</b></div>';
      });
    } else if (vm.payload && vm.payload.type === 'text') {
      html = '<div class="pack-text">' + esc(vm.payload.body || '') + '</div>';
    } else if (vm.payload && vm.payload.type === 'panel' && vm.payload.rows) {
      vm.payload.rows.slice(0, 3).forEach(function (r) {
        html +=
          '<div class="pack-row"><span>' + esc(r.label) + '</span><b>' + esc(r.value) + '</b></div>';
      });
    } else {
      html = '<div class="empty-label">Awaiting Core</div>';
    }
    body.innerHTML = html;
  }

  const RENDERERS = {
    weather: renderWeather,
    agenda: renderAgenda,
    notes: renderNotes,
    mail: renderMail,
    work: renderWork,
    system: renderSystem,
  };

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/"/g, '\\"');
  }

  function pushSpark(key, v) {
    if (v == null || Number.isNaN(Number(v))) return;
    const arr = sparkHist[key];
    arr.push(Number(v));
    while (arr.length > SPARK_N) arr.shift();
  }

  function drawSpark(canvasId, values) {
    const c = document.getElementById(canvasId);
    if (!c || !values.length) return;
    const ctx = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(1, Math.max.apply(null, values));
    ctx.beginPath();
    values.forEach(function (v, i) {
      const x = (i / Math.max(1, values.length - 1)) * (w - 2) + 1;
      const y = h - 2 - (v / max) * (h - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'hsla(' + ((window.JarvisV2 && JarvisV2.hue && JarvisV2.hue()) || 200) + ',100%,70%,0.75)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  /* ---------- Pack strip ---------- */
  function renderPackStrip(slots) {
    packSlots = (slots || []).filter(function (s) {
      return s && s.topic && FIXED.indexOf(s.topic) < 0;
    });
    const strip = document.getElementById('pack-strip');
    const overflow = document.getElementById('pack-overflow');
    if (!strip) return;
    if (!packSlots.length) {
      strip.hidden = true;
      strip.innerHTML = '';
      if (overflow) {
        overflow.hidden = true;
        overflow.innerHTML = '';
      }
      return;
    }
    strip.hidden = false;
    const visible = packSlots.slice(0, 3);
    const rest = packSlots.length - visible.length;
    let html = '';
    visible.forEach(function (s) {
      html +=
        '<button type="button" class="pack-card" data-topic="' +
        esc(s.topic) +
        '" data-panel="' +
        esc(s.topic) +
        '">';
      html += '<div class="pack-title">' + esc(s.label || s.topic) + '</div>';
      html += '<div class="pack-body"><div class="empty-label">Awaiting Core</div></div>';
      html += '</button>';
    });
    if (rest > 0) html += '<button type="button" class="pack-more" id="pack-more">+' + rest + '</button>';
    strip.innerHTML = html;
    strip.querySelectorAll('.pack-card').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (window.JarvisV2 && JarvisV2.focusPanel) JarvisV2.focusPanel(btn.dataset.topic, { user: true });
      });
    });
    const more = document.getElementById('pack-more');
    if (more && overflow) {
      more.addEventListener('click', function () {
        overflow.hidden = false;
        overflow.innerHTML = packSlots
          .slice(3)
          .map(function (s) {
            return (
              '<button type="button" class="pack-overflow-item" data-topic="' +
              esc(s.topic) +
              '">' +
              esc(s.label || s.topic) +
              '</button>'
            );
          })
          .join('');
        overflow.querySelectorAll('button').forEach(function (b) {
          b.addEventListener('click', function () {
            overflow.hidden = true;
            if (window.JarvisV2 && JarvisV2.focusPanel) JarvisV2.focusPanel(b.dataset.topic, { user: true });
          });
        });
      });
    }
  }

  /* ---------- Free display cards (no desk topic) ---------- */
  function renderDisplayPayload(p) {
    if (!p || !p.type) return '<div class="empty-label">Empty display</div>';
    if (p.type === 'weather') {
      const t = p.now && p.now.temperature != null ? Math.round(p.now.temperature) + '°' : '—';
      const c = (p.now && (p.now.summary || p.now.condition)) || '';
      return (
        '<h3>' +
        esc(p.title || 'Weather') +
        '</h3><div class="free-weather"><b>' +
        esc(t) +
        '</b> ' +
        esc(c) +
        '</div>'
      );
    }
    if (p.type === 'panel') {
      let html = '<h3>' + esc(p.title || '') + '</h3><ul class="list">';
      (p.rows || []).forEach(function (r) {
        html +=
          '<li><span class="t">' +
          esc(r.label) +
          '</span><span class="body">' +
          esc(r.value) +
          (r.hint ? '<span class="sub">' + esc(r.hint) + '</span>' : '') +
          '</span></li>';
      });
      return html + '</ul>';
    }
    if (p.type === 'chart') {
      let html = '<h3>' + esc(p.title || 'Chart') + '</h3><div class="free-chart">';
      (p.points || []).slice(0, 8).forEach(function (pt) {
        html +=
          '<div class="pack-row"><span>' +
          esc(pt.label) +
          '</span><b>' +
          esc(pt.value) +
          (p.unit || '') +
          '</b></div>';
      });
      return html + '</div>';
    }
    /* A camera with a stream is the moving picture; the still is what shows
       if the stream cannot be had (see wireMedia). */
    if (p.type === 'image') {
      return (
        '<h3>' + esc(p.caption || p.alt || 'Image') +
        (p.stream ? '<span class="live-tag">Live</span>' : '') +
        '</h3><div class="free-media"><img class="free-img" src="' +
        esc(p.stream || p.url) +
        '" data-still="' + esc(p.url) +
        '" alt="' + esc(p.alt || '') + '"></div>'
      );
    }
    if (p.type === 'text') {
      return '<h3>' + esc(p.title || '') + '</h3><div class="free-text">' + esc(p.body || '') + '</div>';
    }
    return '<h3>Display</h3><pre class="free-text">' + esc(JSON.stringify(p).slice(0, 400)) + '</pre>';
  }

  /* A stream that fails (camera gone, brain restarted, link expired) drops
     back to the still it came with, and says it is no longer live. */
  function wireMedia(card) {
    card.querySelectorAll('img[data-still]').forEach(function (img) {
      img.addEventListener('error', function () {
        const still = img.dataset.still;
        if (!still || img.getAttribute('src') === still) return;
        img.src = still;
        const tag = card.querySelector('.live-tag');
        if (tag) tag.remove();
      });
    });
  }

  /* Letting go of a stream is closing its image: blank the source first, so
     the connection ends now rather than whenever the element is collected. */
  function releaseMedia(card) {
    card.querySelectorAll('img').forEach(function (img) {
      img.removeAttribute('src');
    });
  }

  function showFreeCard(id, payload, meta) {
    const layer = document.getElementById('free-card-layer');
    if (!layer) return;
    layer.hidden = false;
    layer.classList.remove('free-leaving');
    let card = freeCards[id];
    if (!card) {
      card = document.createElement('article');
      card.className = 'free-card free-in';
      card.dataset.displayId = id;
      freeCards[id] = card;
      layer.appendChild(card);
      card.addEventListener('animationend', function () { card.classList.remove('free-in'); }, { once: true });
    }
    releaseMedia(card);
    card.classList.toggle('media', !!(payload && payload.type === 'image'));
    card.innerHTML = renderDisplayPayload(payload);
    wireMedia(card);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'free-card-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', function () {
      dismissFreeCard(id, 'closed');
    });
    card.prepend(close);

    const dismiss = (meta && meta.dismiss) || { mode: 'next-turn' };
    if (card._timer) clearTimeout(card._timer);
    /* next-turn = keep until the *following* turn starts (not this turn's done). */
    card._untilNext = dismiss.mode === 'next-turn' || dismiss.mode === 'next_turn';
    if (dismiss.mode === 'timeout') {
      card._timer = setTimeout(function () {
        dismissFreeCard(id, 'timeout');
      }, Math.max(2000, dismiss.ms || 30000));
    }
  }

  function dismissFreeCard(id, reason) {
    const card = freeCards[id];
    if (!card) return;
    if (card._timer) clearTimeout(card._timer);
    delete freeCards[id];
    releaseMedia(card);
    const layer = document.getElementById('free-card-layer');
    const last = !Object.keys(freeCards).length;
    card.classList.remove('free-in');
    card.classList.add('free-out');
    if (last && layer) layer.classList.add('free-leaving');
    setTimeout(function () {
      card.remove();
      if (layer && !Object.keys(freeCards).length) {
        layer.hidden = true;
        layer.classList.remove('free-leaving');
      }
    }, 320);
  }

  function clearNextTurnFreeCards() {
    Object.keys(freeCards).forEach(function (id) {
      if (freeCards[id]._untilNext) dismissFreeCard(id, 'next-turn');
    });
  }

  /* ---------- Chrome ---------- */
  function setConnection(state, detail) {
    const pill = document.getElementById('pill-brain');
    const text = document.getElementById('pill-brain-text');
    if (!pill || !text) return;
    pill.dataset.state = state;
    if (state === 'online') text.textContent = 'BRAIN ONLINE';
    else if (state === 'connecting') text.textContent = 'BRAIN CONNECTING';
    else text.textContent = 'BRAIN OFFLINE';
  }

  function setTranscript(text, final) {
    const chip = document.getElementById('voice-chip');
    const txt = document.getElementById('voice-chip-text');
    if (!chip || !txt) return;
    if (!text) {
      chip.hidden = true;
      return;
    }
    txt.textContent = text + (final ? '' : '…');
    chip.hidden = false;
    if (final) {
      setTimeout(function () {
        if (txt.textContent.indexOf('…') < 0) chip.hidden = true;
      }, 3500);
    }
  }

  function normalizeUsage(u) {
    if (!u) return null;
    function win(w) {
      if (!w) return null;
      return {
        utilization: w.utilization != null ? w.utilization : w.utilization,
        resetsAt: w.resetsAt || w.resetsAt || null,
      };
    }
    return {
      status: u.status === 'rejected' ? 'rejected' : u.status === 'warning' ? 'warning' : u.status || 'ok',
      binding: u.binding || null,
      session: win(u.session),
      week: win(u.week),
      at: u.at || null,
    };
  }

  function onPanelData(id, vm) {
    if (vm && vm.partial && RENDERERS[id]) {
      const had = loadCache(id);
      if (had && had.items) vm = Object.assign({}, vm, { items: had.items, figure: vm.figure || had.figure || null });
    }
    if (RENDERERS[id]) {
      RENDERERS[id](vm);
      cachePanel(id, vm);
    } else if (id) {
      renderPackCard(Object.assign({ topic: id }, vm || {}));
      cachePanel('pack:' + id, vm);
    }
  }

  function onDisplay(panelId, payload, meta) {
    /* A desk display has been drawn already, through panelData and with the
       tiles beside it; drawing it again here without them lost the figures. */
    if (panelId && FIXED.indexOf(panelId) >= 0) return;
    if (panelId && FIXED.indexOf(panelId) < 0 && panelId !== 'display') {
      /* Pack topic display — update mini-card */
      renderPackCard({
        topic: panelId,
        title: (payload && payload.title) || panelId,
        payload: payload,
      });
      return;
    }
    const id = (meta && meta.id) || 'free-' + Date.now();
    showFreeCard(id, payload, meta);
  }

  function armStaleFocusGuard() {
    clearTimeout(staleFocusTimer);
    /* Long stale guard only — Core owns unfocus; do not fight it with a short idle timer. */
    staleFocusTimer = setTimeout(function () {
      if (window.JarvisV2 && JarvisV2.unfocusPanel) JarvisV2.unfocusPanel();
    }, 20000);
  }

  function clearStaleFocusGuard() {
    clearTimeout(staleFocusTimer);
    staleFocusTimer = null;
  }

  function hydrateFromCache() {
    FIXED.forEach(function (id) {
      const data = loadCache(id);
      if (data && RENDERERS[id]) RENDERERS[id](data);
    });
    if (!usageOverride) {
      const u = loadCache('usage');
      if (u && window.JarvisV2 && JarvisV2.applyUsage) JarvisV2.applyUsage(normalizeUsage(u));
    }
  }

  function wire(l) {
    link = l;

    l.onConnection(function (c) {
      const state = c && c.state;
      setConnection(state === 'online' ? 'online' : state === 'connecting' ? 'connecting' : 'offline', c && c.detail);
      if (state === 'online') {
        const desk = document.getElementById('pill-desk-text');
        if (desk) desk.textContent = 'DESK LIVE';
      }
    });

    l.onVoiceState(function (s) {
      const map = { idle: 'idle', listening: 'listening', thinking: 'thinking', speaking: 'speaking', error: 'idle' };
      if (window.JarvisV2 && JarvisV2.applyVoicePreset) JarvisV2.applyVoicePreset(map[s] || 'idle');
      /* Do not clear next-turn free cards on idle — that fights same-turn display + Core unfocus. */
    });

    l.onAudioLevel(function (n) {
      if (window.JarvisV2 && typeof JarvisV2.setLiveAudioLevel === 'function') {
        JarvisV2.setLiveAudioLevel(n);
      }
    });

    l.onUsage(function (u) {
      if (usageOverride) return;
      const norm = normalizeUsage(u);
      if (window.JarvisV2 && JarvisV2.applyUsage) JarvisV2.applyUsage(norm);
      cachePanel('usage', norm);
    });

    l.onSystem(function (payload) {
      onPanelData('system', payload && payload.view ? payload.view : payload);
    });

    l.onPanelData(function (id, vm) {
      onPanelData(id, vm);
    });

    l.onDisplay(function (panelId, payload, meta) {
      onDisplay(panelId, payload, meta);
    });

    l.onDesk(function (slots) {
      renderPackStrip(slots);
      const desk = document.getElementById('pill-desk-text');
      if (desk) desk.textContent = 'DESK LIVE';
    });

    l.onFocus(function (panelId) {
      if (!window.JarvisV2) return;
      if (panelId) {
        JarvisV2.focusPanel(panelId);
        armStaleFocusGuard();
      } else {
        clearStaleFocusGuard();
        JarvisV2.unfocusPanel();
      }
    });

    l.onLang(function (lang) {
      if (lang) document.documentElement.lang = lang === 'nl' ? 'nl' : 'en';
    });

    l.on('transcript', function (m) {
      setTranscript(m && m.text, !!(m && m.final));
    });
    l.on('utterance', function (m) {
      setTranscript(m && m.text, true);
    });
    /* The footer line that used to carry these is gone; the command field is
       where the eye already is when a typed command could not be sent. */
    l.on('log', function (msg) {
      const input = document.getElementById('ask');
      if (!input || !msg) return;
      input.placeholder = String(msg);
      clearTimeout(askHintTimer);
      askHintTimer = setTimeout(function () { input.placeholder = ASK_PLACEHOLDER; }, 4000);
    });
    l.on('micError', function (err) {
      const el = document.getElementById('mic-error');
      if (!el) return;
      el.textContent = 'Mic: ' + (err || 'unavailable');
      el.hidden = false;
      setTimeout(function () { el.hidden = true; }, 5000);
    });
    l.on('displayClear', function (m) {
      if (m && m.id) dismissFreeCard(m.id, 'cleared');
      else Object.keys(freeCards).forEach(function (id) {
        dismissFreeCard(id, 'cleared');
      });
    });
    /* next-turn free cards: clear when a new turn begins, not on this turn's done. */
    l.on('utterance', function () {
      clearNextTurnFreeCards();
    });
    l.on('activity', function () {
      /* First activity of a new turn also ages out previous next-turn cards. */
      clearNextTurnFreeCards();
    });
  }

  const ASK_PLACEHOLDER = 'Type a command…';
  let askHintTimer = null;

  /* Enter sends the field as an utterance, the same turn a spoken one starts.
     Escape leaves the field so Space talks again. */
  function wireAsk(l) {
    const form = document.getElementById('ask-form');
    const input = document.getElementById('ask');
    if (!form || !input) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const text = input.value;
      if (!text.trim()) return;
      input.value = '';
      l.stopListen();
      l.sendUtterance(text);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') input.blur();
    });
  }

  function init() {
    hydrateFromCache();

    if (liveOff) {
      setConnection('offline', 'live=0 · offline');
      return null;
    }

    if (!window.CoreLink || typeof CoreLink.create !== 'function') {
      console.error('[live-bridge] CoreLink missing');
      setConnection('offline', 'CoreLink missing');
      return null;
    }

    const l = CoreLink.create({
      bindKeys: true,
      bindVoiceTestKeys: false,
    });
    wire(l);
    wireAsk(l);
    window.JarvisCoreLink = l;
    l.connect();
    return l;
  }

  window.LiveBridge = {
    init: init,
    renderPackStrip: renderPackStrip,
    showFreeCard: showFreeCard,
    dismissFreeCard: dismissFreeCard,
    FIXED: FIXED,
    RENDERERS: RENDERERS,
    fitAll: fitAll,
    fitPanel: fitPanel,
  };

  let fitTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitAll, 120);
  });

  function start() {
    if (window.__liveBridgeStarted) return;
    window.__liveBridgeStarted = true;
    init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
