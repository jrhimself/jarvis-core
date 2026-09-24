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

  /* ---------- Renderers ---------- */
  function renderWeather(vm) {
    if (!vm || (vm.temp == null && !vm.condition && !(vm.forecast && vm.forecast.length) && !(vm.tiles && vm.tiles.length))) {
      setMeta('weather', '');
      setBody('weather', emptyHtml());
      return;
    }
    setMeta('weather', vm.title && vm.title !== 'Weather' ? vm.title : '');
    let html = '<div class="weather-temp">';
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

  function renderAgenda(vm) {
    const now = new Date();
    setMeta(
      'agenda',
      now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    );
    if (!vm || !vm.items || !vm.items.length) {
      setBody('agenda', emptyHtml());
      return;
    }
    let html = '<ul class="list">';
    vm.items.slice(0, 6).forEach(function (it) {
      html += '<li' + (it.mark ? ' class="mark"' : '') + '>';
      html += '<span class="t">' + esc(it.time) + '</span>';
      html += '<span class="body">' + esc(it.title);
      if (it.sub) html += '<span class="sub">' + esc(it.sub) + '</span>';
      html += '</span></li>';
    });
    html += '</ul>';
    setBody('agenda', html);
  }

  function renderNotes(vm) {
    setMeta('notes', vm && vm.items && vm.items.length ? vm.items.length + ' items' : '');
    if (!vm || !vm.items || !vm.items.length) {
      setBody('notes', emptyHtml());
      return;
    }
    let html = '';
    vm.items.slice(0, 6).forEach(function (it) {
      html += '<div class="note-item">';
      if (it.tag) html += '<div class="tag">' + esc(it.tag) + '</div>';
      html += '<div class="text">' + esc(it.text) + '</div></div>';
    });
    setBody('notes', html);
  }

  function renderMail(vm) {
    const unread = vm && vm.unread != null ? vm.unread : null;
    setMeta('mail', unread != null ? unread + ' unread' : 'inbox');
    if (!vm || ((!vm.items || !vm.items.length) && unread == null)) {
      setBody('mail', emptyHtml());
      return;
    }
    let html = '';
    if (unread != null) {
      html +=
        '<div class="hero-metric"><div class="value">' +
        esc(unread) +
        '</div><div class="label">Unread</div></div>';
    }
    (vm.items || []).slice(0, 5).forEach(function (it) {
      html += '<div class="mail-item' + (it.mark ? ' mark' : '') + '">';
      html += '<span class="from">' + esc(it.from) + '</span>';
      html += '<span class="subj">' + esc(it.subject) + '</span></div>';
    });
    setBody('mail', html || emptyHtml());
  }

  function renderWork(vm) {
    const n = vm && (vm.openCount != null ? vm.openCount : vm.openCount);
    const count = vm && (vm.openCount != null ? vm.openCount : null);
    setMeta('work', count != null ? count + ' open' : '');
    if (!vm || ((!vm.items || !vm.items.length) && count == null)) {
      setBody('work', emptyHtml());
      return;
    }
    let html = '';
    if (count != null) {
      html +=
        '<div class="hero-metric"><div class="value">' +
        esc(count) +
        '</div><div class="label">Open pull requests</div></div>';
    }
    (vm.items || []).slice(0, 5).forEach(function (it) {
      html += '<div class="pr-item' + (it.mark ? ' mark' : '') + '">';
      html += '<span class="badge">' + esc(it.id) + '</span>';
      html += '<div><div class="title">' + esc(it.title) + '</div>';
      if (it.state) html += '<div class="repo">' + esc(it.state) + '</div>';
      html += '</div></div>';
    });
    setBody('work', html || emptyHtml());
  }

  function renderSystem(vm) {
    setMeta('system', '');
    if (!vm || (vm.cpu == null && vm.mem == null && vm.disk == null && vm.uptime == null)) {
      setBody('system', emptyHtml());
      return;
    }
    let html = '<ul class="list">';
    if (vm.cpu != null) html += '<li><span class="t">CPU</span><span class="body">' + esc(vm.cpu) + '%</span></li>';
    if (vm.mem != null) html += '<li><span class="t">MEM</span><span class="body">' + esc(vm.mem) + ' GB</span></li>';
    if (vm.disk != null) html += '<li><span class="t">DISK</span><span class="body">' + esc(vm.disk) + '%</span></li>';
    if (vm.uptime != null) html += '<li><span class="t">UP</span><span class="body">' + esc(vm.uptime) + '</span></li>';
    if (vm.health && vm.health.length) {
      vm.health.slice(0, 3).forEach(function (h) {
        html +=
          '<li><span class="t">' +
          esc(String(h.server || '').toUpperCase()) +
          '</span><span class="body">' +
          esc(h.state || '') +
          (h.detail ? ' · ' + esc(h.detail) : '') +
          '</span></li>';
      });
    }
    html += '</ul>';
    setBody('system', html);

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
    ctx.strokeStyle = 'hsla(200,100%,70%,0.75)';
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
        if (window.JarvisV2 && JarvisV2.focusPanel) JarvisV2.focusPanel(btn.dataset.topic);
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
            if (window.JarvisV2 && JarvisV2.focusPanel) JarvisV2.focusPanel(b.dataset.topic);
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
    if (p.type === 'image') {
      return (
        '<h3>' +
        esc(p.caption || p.alt || 'Image') +
        '</h3><img class="free-img" src="' +
        esc(p.url) +
        '" alt="' +
        esc(p.alt || '') +
        '">'
      );
    }
    if (p.type === 'text') {
      return '<h3>' + esc(p.title || '') + '</h3><div class="free-text">' + esc(p.body || '') + '</div>';
    }
    return '<h3>Display</h3><pre class="free-text">' + esc(JSON.stringify(p).slice(0, 400)) + '</pre>';
  }

  function showFreeCard(id, payload, meta) {
    const layer = document.getElementById('free-card-layer');
    if (!layer) return;
    layer.hidden = false;
    let card = freeCards[id];
    if (!card) {
      card = document.createElement('article');
      card.className = 'free-card';
      card.dataset.displayId = id;
      freeCards[id] = card;
      layer.appendChild(card);
    }
    card.innerHTML = renderDisplayPayload(payload);
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
    card.remove();
    delete freeCards[id];
    const layer = document.getElementById('free-card-layer');
    if (layer && !Object.keys(freeCards).length) layer.hidden = true;
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
    const hint = document.getElementById('footer-hint');
    if (hint && detail && state !== 'online') hint.textContent = detail;
    if (hint && state === 'online') hint.textContent = 'live · Core over /ws';
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
    if (RENDERERS[id]) {
      RENDERERS[id](vm);
      cachePanel(id, vm);
    } else if (id) {
      renderPackCard(Object.assign({ topic: id }, vm || {}));
      cachePanel('pack:' + id, vm);
    }
  }

  function onDisplay(panelId, payload, meta) {
    if (panelId && FIXED.indexOf(panelId) >= 0) {
      let vm = null;
      if (window.CoreLink && CoreLink.Normalizers) {
        const N = CoreLink.Normalizers;
        if (panelId === 'weather') vm = N.weather(payload, null);
        else if (panelId === 'agenda') vm = N.agenda(payload, null);
        else if (panelId === 'mail') vm = N.mail(payload, null);
        else if (panelId === 'work') vm = N.work(payload, null);
        else if (panelId === 'notes') vm = N.notes(payload, null);
      }
      if (vm) onPanelData(panelId, vm);
      return;
    }
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
    l.on('log', function (msg) {
      const hint = document.getElementById('footer-hint');
      if (hint && msg) hint.textContent = String(msg);
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
  };

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
