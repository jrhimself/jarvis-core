/*!
 * CoreLink — DOM-agnostic port of jarvis-core v1 HUD non-visual logic (bd72bd5).
 * Exposes window.CoreLink (IIFE; matches /v2 plain <script> loading).
 *
 * FINAL Core focus contract (jarvis-core PR #11):
 *   {kind:'focus', panel:string, cue?: DisplayCue} — panel = desk topic; cue-gated like displays
 *   {kind:'unfocus'} — end of turn (done / error / client cancel)
 *   done.briefing?: boolean (typed)
 * Interim client derivation is fallback ONLY when Core never sent focus on this connection.
 * Typed done.briefing is FINAL (PR #11). Usage arrives on connect after ≥1 turn (server-persisted).
 * usage always-on-connect. Handlers already accept them.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CoreLink = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- constants (from v1) ---------- */
  const WS_PATH = '/ws';
  const CAP_SR = 16000;
  const CAP_CHUNK = 1600;
  const CAP_PREROLL = 20;
  const CAP_ANSWER_MS = 2000;
  const VOICE_SR = 16000;
  const VOICE_LEAD = 0.12;
  const VOICE_FIRST_MS = 9000;
  const VOICE_STALL_MS = 20000;
  /* spoken characters per second, for audio that arrives without alignment */
  const VOICE_CPS = 15;
  const FOLLOWUP_MS = 7000;
  const REPLY_MS = 15000;
  const HEARD_MS = 8000;
  const SILENCE_MS = 1500;
  const SILENCE_UNFINISHED_MS = 2600;
  const UNFINISHED = /(,|\b(en|of|maar|dus|want|omdat|zodat|die|dat|als|met|voor|naar|om|te|bij|in|op)\s*)$/i;
  const FIXED_PANELS = ['weather', 'agenda', 'notes', 'mail', 'work', 'system'];

  const DEFAULT_WINDOW_TOPICS = {
    agenda: 'agenda', calendar: 'agenda', kalender: 'agenda',
    afspraak: 'agenda', afspraken: 'agenda',
    mail: 'mail', email: 'mail', inbox: 'mail',
    weer: 'weather', weather: 'weather', forecast: 'weather', weersverwachting: 'weather',
    huis: 'house', house: 'house',
    muziek: 'music', music: 'music', spotify: 'music',
    telegram: 'messages', message: 'messages',
    televisie: 'tv', netflix: 'tv',
    werk: 'work', work: 'work', pull: 'work', pulls: 'work',
    request: 'work', requests: 'work', pr: 'work', prs: 'work',
    note: 'notes', notes: 'notes', notitie: 'notes', notities: 'notes',
  };

  const DEFAULT_STICKY_ORDER = ['weather', 'agenda', 'mail', 'work', 'notes'];

  const CAP_WORKLET = `
class MicTap extends AudioWorkletProcessor {
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if(ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('mic-tap', MicTap);
`;

  /* ---------- helpers ---------- */
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function createEmitter() {
    const map = new Map();
    return {
      on(ev, fn) {
        if (!map.has(ev)) map.set(ev, new Set());
        map.get(ev).add(fn);
        return () => map.get(ev) && map.get(ev).delete(fn);
      },
      off(ev, fn) {
        if (map.has(ev)) map.get(ev).delete(fn);
      },
      emit(ev, ...args) {
        const set = map.get(ev);
        if (!set) return;
        for (const fn of [...set]) {
          try { fn(...args); } catch (e) { console.error('CoreLink handler', ev, e); }
        }
      },
    };
  }

  /* ---------- topic mapping (v1 stickyTopicOf / WINDOW_TOPICS) ---------- */
  function createTopicMap() {
    let WINDOW_TOPICS = Object.assign({}, DEFAULT_WINDOW_TOPICS);
    let STICKY_ORDER = DEFAULT_STICKY_ORDER.slice();
    const STICKY_LABEL = {
      weather: 'Weer', agenda: 'Agenda', mail: 'Mail',
      work: 'Pull requests', notes: 'Notities',
    };

    function windowTopic(title) {
      const t = String(title || '').trim().toLowerCase();
      if (!t) return '';
      const words = t.split(/[^a-z0-9]+/).filter(Boolean);
      for (const w of words) {
        if (WINDOW_TOPICS[w]) return WINDOW_TOPICS[w];
      }
      return words[0] || '';
    }

    function stickyTopicOf(p) {
      if (!p) return '';
      if (p.type === 'weather') return 'weather';
      const fromTitle = windowTopic(p.title || '');
      if (STICKY_ORDER.includes(fromTitle)) return fromTitle;
      if (p.type === 'text') {
        const t = windowTopic(p.title || 'note');
        if (t === 'notes' || !p.title) return 'notes';
      }
      return '';
    }

    /** Map topic → fixed panel id, or pass-through pack topic id. */
    function panelIdOfTopic(topic) {
      if (!topic) return null;
      const t = String(topic).toLowerCase().trim();
      if (FIXED_PANELS.includes(t)) return t;
      if (t === 'system') return 'system';
      const mapped = WINDOW_TOPICS[t] || t;
      if (FIXED_PANELS.includes(mapped)) return mapped;
      return mapped; // pack pass-through (house, music, …)
    }

    function applyDeskSlots(slots) {
      if (!Array.isArray(slots) || !slots.length) return { order: STICKY_ORDER.slice(), slots: [] };
      const order = [];
      const out = [];
      for (const slot of slots) {
        const topic = String(slot.topic || '').trim();
        if (!topic) continue;
        const label = String(slot.label || topic).trim() || topic;
        STICKY_LABEL[topic] = label;
        WINDOW_TOPICS[topic] = topic;
        order.push(topic);
        out.push({
          topic,
          label,
          briefing: slot.briefing === true,
          panelId: panelIdOfTopic(topic),
        });
      }
      if (order.length) STICKY_ORDER = order;
      return { order: STICKY_ORDER.slice(), slots: out };
    }

    return {
      get WINDOW_TOPICS() { return WINDOW_TOPICS; },
      get STICKY_ORDER() { return STICKY_ORDER.slice(); },
      STICKY_LABEL,
      windowTopic,
      stickyTopicOf,
      panelIdOfTopic,
      applyDeskSlots,
    };
  }

  /* ---------- payload normalizers ---------- */
  const Normalizers = {
    weather(payload, tiles) {
      if (payload && payload.type === 'weather') {
        const days = Array.isArray(payload.days) ? payload.days : [];
        const today = days[0] || {};
        const now = payload.now || {};
        const unit = (payload.units && payload.units.temperature) || '°C';
        const temp = Number.isFinite(now.temperature) ? now.temperature
          : Number.isFinite(today.high) ? today.high : null;
        const condition = now.summary || today.summary || now.condition || today.condition || '';
        return {
          title: payload.title || 'Weather',
          icon: now.condition || today.condition || '',
          temp,
          unit,
          condition,
          sun: payload.sun || null,
          forecast: days.slice(1).map((d) => ({
            label: d.label,
            high: d.high,
            low: d.low,
            condition: d.condition || d.summary,
          })),
          hours: Array.isArray(payload.hours) ? payload.hours : [],
          raw: payload,
        };
      }
      const tilesArr = (tiles && tiles.tiles) || [];
      let temp = null, condition = '';
      for (const t of tilesArr) {
        const v = String(t.value || '');
        const m = v.match(/(-?\d+(?:[.,]\d+)?)\s*°/);
        if (m && temp == null) temp = parseFloat(m[1].replace(',', '.'));
        if (/cond|weer|sky|summary/i.test(t.label) || (!condition && !m)) condition = condition || v;
      }
      return {
        title: (tiles && tiles.topicLabel) || 'Weather',
        temp, unit: '°C', condition,
        forecast: [], hours: [], tiles: tilesArr,
        gap: 'Structured forecast only arrives via display type=weather; tiles are label/value only.',
      };
    },

    /* The desk lists (agenda, mail, work) take their rows from the window a
       tool put up and their figures from the tiles that tick in beside it.
       Tiles alone are never rows: the agenda's two readings ("6 today",
       "Next up") were drawn as a two-item agenda over the six it had. A vm
       without a payload is `partial`; the page keeps the rows it has. */
    agenda(payload, tiles) {
      const items = [];
      if (payload && payload.type === 'panel' && Array.isArray(payload.rows)) {
        for (const r of payload.rows) {
          items.push({ time: r.label || '', title: r.value || '', sub: r.hint || '', mark: !!r.mark });
        }
      }
      let count = null, nextUp = null;
      for (const t of (tiles && tiles.tiles) || []) {
        if (/^next/i.test(t.label || '')) nextUp = String(t.value || '');
        else {
          const n = String(t.value || '').match(/^(\d+)\b/);
          if (n && count == null) count = parseInt(n[1], 10);
        }
      }
      return {
        title: (payload && payload.title) || (tiles && tiles.topicLabel) || 'Agenda',
        items,
        count,
        nextUp,
        partial: !payload,
      };
    },

    mail(payload, tiles) {
      const items = [];
      let unread = null;
      if (payload && payload.type === 'panel' && Array.isArray(payload.rows)) {
        for (const r of payload.rows) {
          items.push({ from: r.label || '', subject: r.value || '', hint: r.hint || '', mark: !!r.mark });
        }
      }
      for (const t of (tiles && tiles.tiles) || []) {
        if (/unread|ongelezen/i.test(t.label)) {
          const n = parseInt(String(t.value).replace(/\D/g, ''), 10);
          if (Number.isFinite(n)) unread = n;
        }
      }
      const figure = payload && payload.figure && Number.isFinite(Number(payload.figure.value))
        ? { value: Number(payload.figure.value), label: String(payload.figure.label || '') }
        : null;
      return {
        unread,
        figure,
        items,
        title: (payload && payload.title) || (tiles && tiles.topicLabel) || 'Mail',
        partial: !payload,
      };
    },

    work(payload, tiles) {
      const items = [];
      let more = 0;
      if (payload && payload.type === 'panel' && Array.isArray(payload.rows)) {
        for (const r of payload.rows) {
          const label = String(r.label || '');
          const hint = String(r.hint || '');
          if (label === '…') {                       /* "3 more" / "nog 3" */
            const n = String(r.value || '').match(/\d+/);
            if (n) more += parseInt(n[0], 10);
            continue;
          }
          if (label === '—') continue;              /* "none" */
          const id = hint.match(/#\d+/);
          const rest = hint.replace(/#\d+\s*(·\s*)?/, '').trim();
          items.push({
            id: id ? id[0] : '',
            title: r.value || '',
            state: [label, rest].filter(Boolean).join(' · '),
            mark: !!r.mark,
          });
        }
      }
      let openCount = null;
      for (const t of (tiles && tiles.tiles) || []) {
        if (/open|pr|pull/i.test(t.label) && /\d/.test(t.value)) {
          const n = parseInt(String(t.value).replace(/\D/g, ''), 10);
          if (Number.isFinite(n)) openCount = n;
        }
      }
      if (openCount == null && payload) openCount = items.length + more;
      return {
        openCount,
        items,
        title: (payload && payload.title) || (tiles && tiles.topicLabel) || 'Work',
        partial: !payload,
      };
    },

    notes(payload, tiles) {
      const items = [];
      if (payload && payload.type === 'text') {
        items.push({ tag: payload.title || 'Note', text: payload.body || '' });
      } else if (payload && payload.type === 'panel' && Array.isArray(payload.rows)) {
        for (const r of payload.rows) items.push({ tag: r.label || '', text: r.value || '' });
      }
      const tilesArr = (tiles && tiles.tiles) || [];
      if (!items.length) {
        for (const t of tilesArr) items.push({ tag: t.label, text: t.value });
      }
      return {
        items,
        title: (payload && payload.title) || (tiles && tiles.topicLabel) || 'Notes',
      };
    },

    system(metrics, health) {
      const m = metrics || {};
      const GB = 1024 * 1024 * 1024;
      const cpu = m.cpuShare == null ? null : Math.round(m.cpuShare * 100);
      const mem = m.rssBytes == null ? null : +(m.rssBytes / GB).toFixed(2);
      const disk = m.diskUsed == null ? null : Math.round(m.diskUsed * 100);
      let uptime = null;
      if (m.uptimeMs != null) {
        const s = Math.floor(m.uptimeMs / 1000);
        const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), mi = Math.floor((s % 3600) / 60);
        uptime = d > 0 ? d + 'd ' + h + 'h' : h > 0 ? h + 'h ' + mi + 'm' : mi + 'm';
      }
      return {
        cpu, mem, disk, uptime,
        rssBytes: m.rssBytes, cpuShare: m.cpuShare, uptimeMs: m.uptimeMs, diskUsed: m.diskUsed,
        health: Array.isArray(health) ? health : [],
        gap: 'v2 mock shows NET; Core metrics have no network field.',
      };
    },

    pack(topic, payload, tiles) {
      return {
        topic,
        title: (payload && payload.title) || (tiles && tiles.topicLabel) || topic,
        payload: payload || null,
        tiles: (tiles && tiles.tiles) || [],
      };
    },
  };

  /* ---------- CoreLink instance ---------- */
  function create(opts) {
    opts = opts || {};
    const bus = createEmitter();
    const topics = createTopicMap();
    const wsUrl = opts.wsUrl || null; // override for tests
    const bindKeys = opts.bindKeys !== false;
    const bindGestures = opts.bindGestures !== false;

    let ws = null, wsRetry = 0, wsTimer = null, wsWasOpen = false;
    let connState = 'offline';
    let sessionId = null;
    let speechLang = 'en';
    let turn = null;
    let inBriefing = false;
    let focusedPanel = null;
    let coreFocusSeen = false; /* true once Core sends focus/unfocus — disables interim derive */
    /* Panels raised during a turn, each waiting for the words that name it:
       {panel, anchors, chars}. A briefing raises five at once -- one per tool,
       before a word is said -- and they must open one by one as he gets to
       them, not all at once and not only the last. */
    let focusQueue = [];
    let sectionTurn = false;   /* this turn's answer carries section markers */
    let spokenCursor = 0;      /* how far into spokenText a queued panel has been found */
    let spokenText = '';       /* cumulative answer text for cue gating */
    let metrics = null;
    let health = [];
    let tileCache = Object.create(null); // topic → last tiles msg
    let payloadCache = Object.create(null); // topic → last display payload
    let followUntil = 0, followTimer = null;
    let pending = '', silenceTimer = null;
    let t0 = 0;
    let levelTimer = null;

    const mic = {
      active: false, avail: null, gen: 0, blocked: false, reason: '',
      ctx: null, stream: null, src: null, node: null, sink: null, answerTimer: null,
      queue: [], partial: '',
      acc: 0, accN: 0, phase: 0, ratio: 1, last: 0,
      bytes: new Uint8Array(CAP_CHUNK * 2), fill: 0,
    };
    mic.view = new DataView(mic.bytes.buffer);

    const voice = {
      ctx: null, gain: null, an: null, freq: null, fx: 'none',
      turnId: null, ok: false, done: false, gapWarned: false, armed: false,
      sources: new Set(), nextStart: 0, playing: false,
      firstTimer: null, stallTimer: null, levelIv: null,
      lastSeq: null,
      /* {at: context time, n: characters spoken}, from the audio's alignment */
      timeline: [], charCursor: 0, spokenN: 0, aligned: false, estChars: 0,
      /* what the turn's end waits for: run once the last chunk has played */
      after: null, afterTimer: null,
    };

    let mode = 'idle'; // idle|listening|thinking|speaking|error

    function setConn(state, detail) {
      connState = state;
      bus.emit('connection', { state, detail: detail || state, retry: wsRetry });
      if (typeof link.onConnection === 'function') { /* convenience reserved */ }
    }

    function setMode(m) {
      if (mode === m) return;
      mode = m;
      const vs = m === 'error' ? 'idle' : m;
      bus.emit('voiceState', vs);
    }

    function setFocus(panelId) {
      if (focusedPanel === panelId) return;
      focusedPanel = panelId;
      bus.emit('focus', panelId);
    }

    /** v1-style cue gate (simplified): anchor any-of, else chars into spoken text. */
    function cueReached(cue, text) {
      if (!cue) return true;
      const spoken = String(text || '');
      const anchors = String(cue.anchor || '')
        .split('|')
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean);
      if (anchors.length) {
        const lower = spoken.toLowerCase();
        for (const a of anchors) {
          if (a.length >= 4 ? lower.indexOf(a) >= 0 : new RegExp('(?:^|[^\\p{L}\\p{N}])' + a.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '(?:$|[^\\p{L}\\p{N}])', 'u').test(lower)) {
            return true;
          }
        }
        return false;
      }
      return spoken.length >= (cue.chars || 0);
    }

    /* The words Core's cue names, and nothing guessed: a vocabulary per topic
       opened the notes panel on a pull request called "notes". A cue without
       an anchor (a tool's tiles) has nothing to wait for and never opens. */
    function anchorsFor(panel, cue) {
      const out = [];
      String((cue && cue.anchor) || '').split('|').forEach((a) => {
        a = a.trim().toLowerCase();
        if (a && out.indexOf(a) < 0) out.push(a);
      });
      return out;
    }

    /* Where an anchor is first said at or after `from`, or -1. */
    function anchorAt(lower, anchor, from) {
      if (anchor.length >= 4) return lower.indexOf(anchor, from);
      const safe = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|[^\\p{L}\\p{N}])' + safe + '(?![\\p{L}\\p{N}])', 'gu');
      re.lastIndex = from > 0 ? from - 1 : 0;
      const m = re.exec(lower);
      return m ? m.index + m[1].length : -1;
    }

    /* A section marker in the answer (focus.section): exact, no words to wait
       for. The first one says this turn is marked, and focus from anything
       else in it -- tiles, displays with their anchors -- is dropped. */
    function queueSection(panel, chars) {
      if (!panel) return;
      if (!turn) { setFocus(String(panel)); return; }
      sectionTurn = true;
      focusQueue = focusQueue.filter((q) => q.section);
      focusQueue.push({ panel: String(panel), anchors: [], chars: Number(chars) || 0, section: true });
      flushPendingFocus(false);
    }

    function queueOrApplyFocus(panel, cue) {
      if (!panel) return;
      panel = String(panel);
      /* Outside a turn there is nothing to wait for. */
      if (!turn) { setFocus(panel); return; }
      if (sectionTurn) return;
      const anchors = anchorsFor(panel, cue);
      const known = focusQueue.find((q) => q.panel === panel);
      if (known) anchors.forEach((a) => { if (known.anchors.indexOf(a) < 0) known.anchors.push(a); });
      else focusQueue.push({ panel, anchors, chars: (cue && cue.chars) || 0 });
      flushPendingFocus(false);
    }

    /* Open the queued panels whose words have now been said, in the order they
       were said. `force` is the end of the turn: a panel never talked about is
       dropped rather than opened as he stops talking. */
    function flushPendingFocus(force) {
      if (force) { focusQueue = []; return; }
      /* Nothing goes up on the opening line ("let me review your day" is not
         the pull requests), as in v1: search from where the answer starts. */
      if (turn && turn.openingLen > spokenCursor) spokenCursor = turn.openingLen;
      const lower = spokenText.toLowerCase();
      for (;;) {
        /* Sections first: open when the voice reaches where the part begins. */
        let due = -1;
        focusQueue.forEach((q, i) => {
          if (q.section && spokenText.length >= q.chars && (due < 0 || q.chars < focusQueue[due].chars)) due = i;
        });
        if (due >= 0) {
          setFocus(focusQueue.splice(due, 1)[0].panel);
          continue;
        }
        let best = -1, at = Infinity, end = 0;
        focusQueue.forEach((q, i) => {
          if (q.section) return;
          for (const a of q.anchors) {
            const pos = anchorAt(lower, a, spokenCursor);
            if (pos >= 0 && pos < at) { best = i; at = pos; end = pos + a.length; }
          }
        });
        if (best < 0) return;
        const q = focusQueue.splice(best, 1)[0];
        spokenCursor = end;
        setFocus(q.panel);
      }
    }

    function resetCueGate() {
      focusQueue = [];
      sectionTurn = false;
      spokenCursor = 0;
      spokenText = '';
    }

    let deferredUnfocus = false;

    /* ---- local voice: the browser's own, when the brain has none ----
       The brain says so when its voice is off or out of credits, and then the
       page speaks. /v2-next had no such fallback: it stayed silent and took
       the whole text as said the moment it arrived, so every window of a
       briefing opened one after another in a few seconds. Ported from v1:
       sentence by sentence as the text streams, with the word boundaries of
       the browser voice moving the cue gate the way audio alignment does. */
    const LOCAL_TAGS = { en: 'en-GB', nl: 'nl-NL' };
    const LOCAL_MAX = 180;          /* Chrome stops an utterance after ~15s */
    const LOCAL_CPS = 15;           /* until a boundary event says otherwise */
    const LOCAL_END = /[.!?\u2026]["'\u2019\u201d)\]]*(?=\s|$)/g;
    const local = { on: false, handed: 0, queue: [], speaking: false, reached: 0, after: null, afterTimer: null, tick: null, closed: false };

    function localAvailable() {
      return typeof window !== 'undefined' && !!window.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined';
    }

    function localSpeaksTurn() { return !!turn && local.on; }

    function localPending() {
      return localSpeaksTurn() && (local.speaking || local.queue.length > 0 || local.handed < String(turn.text || '').length);
    }

    function startLocal() {
      if (!localAvailable() || !turn) return false;
      localStop();
      local.on = true;
      return true;
    }

    function localStop() {
      const was = local.on || local.speaking;
      local.on = false; local.handed = 0; local.queue = []; local.speaking = false;
      local.reached = 0; local.after = null; local.closed = false;
      clearTimeout(local.afterTimer); local.afterTimer = null;
      clearInterval(local.tick); local.tick = null;
      if (was && localAvailable()) { try { speechSynthesis.cancel(); } catch (e) {} }
    }

    function localVoice() {
      const vs = speechSynthesis.getVoices();
      const tag = LOCAL_TAGS[speechLang] || 'en-GB';
      const short = tag.split('-')[0];
      return vs.find((v) => v.lang === tag && v.localService) || vs.find((v) => v.lang.startsWith(short)) || null;
    }

    /* Hand complete sentences (or, when `final`, everything) to the queue. */
    function localFeed(final) {
      if (!localSpeaksTurn()) return;
      const text = String(turn.text || '');
      let upto = local.handed;
      LOCAL_END.lastIndex = local.handed;
      for (let m = LOCAL_END.exec(text); m !== null; m = LOCAL_END.exec(text)) upto = m.index + m[0].length;
      if (final) upto = text.length;
      while (local.handed < upto) {
        let piece = text.slice(local.handed, upto);
        if (piece.length > LOCAL_MAX) {
          let cut = piece.lastIndexOf(',', LOCAL_MAX);
          if (cut < 40) cut = piece.lastIndexOf(' ', LOCAL_MAX);
          if (cut < 40) cut = LOCAL_MAX;
          piece = piece.slice(0, cut + 1);
        }
        if (piece.trim()) local.queue.push({ text: piece, base: local.handed });
        local.handed += piece.length;
      }
      localNext();
    }

    function localReach(n) {
      if (!turn || n <= local.reached) return;
      local.reached = n;
      spokenText = String(turn.text || '').slice(0, n);
      flushPendingFocus(false);
    }

    function localNext() {
      if (local.speaking || !local.on) return;
      const seg = local.queue.shift();
      if (!seg) {
        if (local.after && local.handed >= String((turn && turn.text) || '').length) {
          const after = local.after;
          local.after = null;
          clearTimeout(local.afterTimer); local.afterTimer = null;
          after();
        }
        return;
      }
      local.speaking = true;
      if (mode !== 'speaking') setMode('speaking');
      const u = new SpeechSynthesisUtterance(seg.text);
      u.lang = LOCAL_TAGS[speechLang] || 'en-GB';
      u.rate = 1.03; u.pitch = 0.92;
      const v = localVoice();
      if (v) u.voice = v;
      const done = () => {
        clearInterval(local.tick); local.tick = null;
        if (!local.speaking) return;
        local.speaking = false;
        localReach(seg.base + seg.text.length);
        localNext();
      };
      u.onstart = () => {
        const t = performance.now();
        clearInterval(local.tick);
        local.tick = setInterval(() => {
          localReach(seg.base + Math.min(seg.text.length, Math.floor((performance.now() - t) / 1000 * LOCAL_CPS * u.rate)));
        }, 60);
      };
      u.onboundary = (e) => {
        clearInterval(local.tick); local.tick = null;
        localReach(seg.base + (e.charIndex || 0));
      };
      u.onend = done;
      u.onerror = done;
      try { speechSynthesis.speak(u); } catch (e) { done(); }
    }

    /** Whether the brain's own voice is speaking the current turn. */
    function voiceSpeaksTurn() {
      return !!turn && voice.ok && voice.turnId === turn.id;
    }

    /** Whether some of this turn's voice is still to be played. */
    function voicePending() {
      return voiceSpeaksTurn() && (voice.sources.size > 0 || !voice.done);
    }

    /** Either voice, brain or browser, still has some of this turn to say. */
    function speechPending() {
      return voicePending() || localPending();
    }

    function clearFocus(reason) {
      focusQueue = [];
      setFocus(null);
    }

    function send(obj) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }

    function connOk() { return !!ws && ws.readyState === WebSocket.OPEN; }

    /* ---- WS ---- */
    function connect() {
      clearTimeout(wsTimer);
      setConn('connecting', 'connecting…');
      const url = wsUrl || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + WS_PATH);
      let sock;
      try { sock = new WebSocket(url); }
      catch (e) { scheduleReconnect(); return; }
      ws = sock;
      sock.onopen = () => { wsRetry = 0; wsWasOpen = true; coreFocusSeen = false; resetCueGate(); setConn('online', 'online'); };
      sock.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && typeof m.kind === 'string') route(m);
      };
      sock.onerror = () => {};
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        if (wsWasOpen) { wsWasOpen = false; bus.emit('log', 'lost connection to the brain'); }
        failTurn('no connection');
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      const delay = Math.min(30000, 1000 * Math.pow(2, wsRetry++));
      setConn('offline', 'offline · retrying in ' + Math.round(delay / 1000) + 's');
      wsTimer = setTimeout(connect, delay);
    }

    function disconnect() {
      clearTimeout(wsTimer);
      wsRetry = 0;
      if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
      setConn('offline', 'offline');
    }

    /* ---- message router ---- */
    function route(m) {
      bus.emit('message', m);
      bus.emit('kind:' + m.kind, m);

      /* FINAL Core focus contract (PR #11) — source of truth when present */
      if (m.kind === 'focus' && m.panel) {
        coreFocusSeen = true;
        if (m.section === true) queueSection(String(m.panel), m.cue ? m.cue.chars : 0);
        else queueOrApplyFocus(String(m.panel), m.cue || null);
        return;
      }
      if (m.kind === 'unfocus') {
        coreFocusSeen = true;
        /* Core unfocuses when the turn ends, which is before the voice does. */
        if (speechPending()) {
          deferredUnfocus = true;
          return;
        }
        clearFocus('core-unfocus');
        return;
      }

      if (m.kind === 'ready') {
        sessionId = m.sessionId === undefined ? null : m.sessionId;
        setConn('online', 'online');
        bus.emit('ready', m);
        return;
      }
      if (m.kind === 'lang') {
        if (m.lang === 'nl' || m.lang === 'en') {
          speechLang = m.lang;
          bus.emit('lang', m.lang);
        }
        return;
      }
      if (m.kind === 'desk') {
        const applied = topics.applyDeskSlots(m.slots || []);
        const briefing = (m.slots || []).some((s) => s && s.briefing === true);
        if (briefing) inBriefing = true;
        bus.emit('desk', applied.slots);
        return;
      }
      if (m.kind === 'tiles') {
        handleTiles(m);
        return;
      }
      if (m.kind === 'metrics') {
        metrics = m.metrics || {};
        emitSystem();
        return;
      }
      if (m.kind === 'health') {
        health = m.checks || [];
        emitSystem();
        return;
      }
      if (m.kind === 'usage') {
        bus.emit('usage', m.usage || null);
        return;
      }
      if (m.kind === 'display_clear') {
        bus.emit('displayClear', m.id || null);
        return;
      }
      if (m.kind === 'listen') { onListen(m); return; }
      if (m.kind === 'transcript') { onTranscript(m); return; }
      if (m.kind === 'announce') {
        bus.emit('announce', { text: m.text, lang: m.lang });
        // Auto-say when idle
        if (!turn) say(m.text, m.lang);
        return;
      }
      if (m.kind === 'error') {
        if (m.turnId && (!turn || m.turnId !== turn.id)) return;
        bus.emit('error', m.message || 'unknown error');
        flushPendingFocus(true);
        if (!coreFocusSeen) clearFocus('error-fallback');
        spokenText = '';
        setMode('error');
        setTimeout(() => { if (mode === 'error' && !turn) setMode('idle'); }, 2600);
        return;
      }

      if (!turn || m.turnId !== turn.id) return;
      if (m.kind === 'display') handleDisplay(m);
      else if (m.kind === 'voice') onVoice(m);
      else if (m.kind === 'audio') onAudio(m);
      else if (m.kind === 'audio_done') onAudioDone(m);
      else if (m.kind === 'activity') onActivity(m);
      else if (m.kind === 'text') onText(m);
      else if (m.kind === 'done') onDone(m);
    }

    function emitSystem() {
      const vm = Normalizers.system(metrics, health);
      bus.emit('system', { metrics, health, view: vm });
      bus.emit('panelData', 'system', vm);
    }

    function emitPanel(topic, payload) {
      if (payload) payloadCache[topic] = payload;
      else payload = payloadCache[topic] || null;
      const panelId = topics.panelIdOfTopic(topic) || topic;
      const tiles = tileCache[topic] || null;
      let vm;
      if (panelId === 'weather') vm = Normalizers.weather(payload, tiles);
      else if (panelId === 'agenda') vm = Normalizers.agenda(payload, tiles);
      else if (panelId === 'mail') vm = Normalizers.mail(payload, tiles);
      else if (panelId === 'work') vm = Normalizers.work(payload, tiles);
      else if (panelId === 'notes') vm = Normalizers.notes(payload, tiles);
      else if (panelId === 'system') vm = Normalizers.system(metrics, health);
      else vm = Normalizers.pack(topic, payload, tiles);
      bus.emit('panelData', panelId, vm);
      return { panelId, vm };
    }

    function handleTiles(m) {
      const topic = m.topic || m.source || 'context';
      tileCache[topic] = m;
      emitPanel(topic, null);
      // Standing tiles do not focus outside briefing (v2-next interim rule).
    }

    function handleDisplay(m) {
      const sticky = topics.stickyTopicOf(m.payload);
      /* Title → topic only when a WINDOW_TOPICS key hits (desk alias / pack). Do not
         invent panel ids from the first title word (v1 used that for transient cards;
         v2-next routes topic-less displays to free cards via panelId 'display'). */
      let topic = sticky || '';
      if (!topic) {
        const title = (m.payload && m.payload.title) || '';
        const words = String(title).trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        for (const w of words) {
          if (topics.WINDOW_TOPICS[w]) { topic = topics.WINDOW_TOPICS[w]; break; }
        }
      }
      if (!topic) topic = 'display';
      let panelId;
      if (topic === 'display') {
        /* Topic-less → free card only; do not emit panelData (would invent a pack card). */
        panelId = 'display';
      } else {
        panelId = emitPanel(topic, m.payload).panelId;
      }
      bus.emit('display', panelId, m.payload, {
        turnId: m.turnId,
        id: m.id,
        dismiss: m.dismiss,
        cue: m.cue,
        stickyTopic: sticky || null,
        topic,
      });
      /* Interim focus derivation: ONLY if Core never sent focus on this connection.
         When Core is current (PR #11), it emits focus with the same cue — do not double-fire. */
      if (!coreFocusSeen && turn) {
        const pid = sticky
          ? (topics.panelIdOfTopic(sticky) || sticky)
          : (panelId && panelId !== 'display' ? panelId : null);
        if (pid) queueOrApplyFocus(pid, m.cue || null);
      }
    }

    function onActivity(m) {
      const STAGE_MODE = { stt: 'listening', llm: 'thinking', memory: 'thinking', tool: 'thinking', tts: 'speaking' };
      const modeWanted = STAGE_MODE[m.stage];
      if (modeWanted && turn && !turn.answering) setMode(modeWanted);
      bus.emit('activity', m);
      keepVoiceAlive();
    }

    function onText(m) {
      if (typeof m.text !== 'string' || !m.text) return;
      if (m.opening !== true && turn && !turn.answering) {
        turn.answering = true;
        setMode('speaking');
      }
      if (turn) {
        if (m.opening === true && !turn.answering) turn.openingLen = (turn.openingLen || 0) + m.text.length;
        turn.text = (turn.text || '') + m.text;
        /* With the brain's voice, cues wait for the audio (see voiceTick):
           the text of a briefing is in long before it has been said. */
        if (m.opening !== true && !voiceSpeaksTurn() && !localSpeaksTurn()) spokenText = turn.text;
        if (localSpeaksTurn()) localFeed(false);
        bus.emit('text', { turnId: turn.id, text: m.text, full: turn.text, opening: !!m.opening });
        flushPendingFocus(false);
      }
      keepVoiceAlive();
    }

    function onDone(m) {
      /* The brain is done long before the voice is: every chunk of a briefing
         has arrived while most of it is still to be played. Stopping the voice
         here cut the briefing off, and settling the desk here put it away while
         it was still being talked about. Both wait for the last chunk, as in v1. */
      if (voicePending()) {
        const t = turn;
        voice.after = () => { if (turn === t) finishDone(m); };
        clearTimeout(voice.afterTimer);
        const left = voice.ctx ? Math.max(0, voice.nextStart - voice.ctx.currentTime) : 0;
        /* a suspended audio context never reaches the end; do not wait for ever */
        voice.afterTimer = setTimeout(voiceFinish, (left + 10) * 1000);
        return;
      }
      if (localPending()) {
        const t = turn;
        local.after = () => { if (turn === t) finishDone(m); };
        const left = String(turn.text || '').length - local.reached;
        clearTimeout(local.afterTimer);
        /* a browser voice that never ends (no voices, blocked) is not waited on for ever */
        local.afterTimer = setTimeout(() => { const a = local.after; local.after = null; if (a) a(); }, (left / 8 + 10) * 1000);
        localFeed(true);
        return;
      }
      finishDone(m);
    }

    function finishDone(m) {
      /* Typed done.briefing (PR #11). Core also sends unfocus; clearFocus is idempotent.
         Flush any cue-held focus before settling so mid-cue content still lands. */
      flushPendingFocus(true);
      if (deferredUnfocus) {
        deferredUnfocus = false;
        clearFocus('core-unfocus');
      }
      if (m.briefing === true || inBriefing) {
        inBriefing = false;
        bus.emit('settleDesk');
      }
      /* If Core didn't send unfocus (older Core), settle focus ourselves. */
      if (!coreFocusSeen) clearFocus('done-fallback');
      spokenText = '';
      voiceStop();
      turn = null;
      setTimeout(() => {
        if (turn) return;
        startFollowUp(m.expectsReply ? REPLY_MS : FOLLOWUP_MS);
        if (!listeningOn()) setMode('idle');
      }, 400);
      bus.emit('done', m);
    }

    function failTurn(reason) {
      voiceStop();
      if (!turn) return;
      turn = null;
      spokenText = '';
      flushPendingFocus(true);
      if (!coreFocusSeen) clearFocus('fail-fallback');
      bus.emit('log', 'turn abandoned — ' + reason);
      setMode('idle');
    }

    /* ---- turns ---- */
    function cancelTurn() {
      if (!turn) return;
      send({ kind: 'cancel', turnId: turn.id });
      voiceStop();
      turn = null;
      spokenText = '';
      flushPendingFocus(true);
      /* Core sends unfocus on cancel; fallback if not. A turn cancelled while
         its voice was still playing already had its unfocus, held back. */
      if (!coreFocusSeen || deferredUnfocus) clearFocus('cancel-fallback');
      deferredUnfocus = false;
      setMode('idle');
    }

    function sendUtterance(text) {
      text = (text || '').trim();
      if (!text) return null;
      if (!connOk()) { bus.emit('log', 'brain unreachable — nothing sent'); setMode('idle'); return null; }
      if (turn) cancelTurn();
      voiceStop();
      followUntil = 0; clearTimeout(followTimer);
      const id = uuid();
      turn = { id, t0: performance.now(), answering: false, text: '', voiceOk: false };
      resetCueGate();
      setMode('thinking');
      send({ kind: 'utterance', text, turnId: id });
      bus.emit('utterance', { text, turnId: id });
      return id;
    }

    function say(text, lang) {
      text = (text || '').trim();
      if (!text) return null;
      if (!connOk()) return null;
      if (turn) cancelTurn();
      voiceStop();
      followUntil = 0; clearTimeout(followTimer);
      const id = uuid();
      turn = { id, t0: performance.now(), answering: false, text: '', voiceOk: false };
      resetCueGate();
      setMode('speaking');
      const msg = { kind: 'say', text, turnId: id, lang: lang === 'en' ? 'en' : (lang === 'nl' ? 'nl' : speechLang) };
      send(msg);
      return id;
    }

    function setLang(lang) {
      if (lang !== 'nl' && lang !== 'en') return;
      send({ kind: 'set_lang', lang });
    }

    /* ---- mic ---- */
    function listeningOn() { return Date.now() < followUntil; }

    function micUsable() {
      return !mic.blocked && connOk()
        && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
        && !!(window.AudioContext || window.webkitAudioContext);
    }

    function micB64(u8, len) {
      let s = '';
      for (let i = 0; i < len; i += 0x8000) {
        s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(len, i + 0x8000)));
      }
      return btoa(s);
    }

    function micFlush() {
      if (!mic.fill) return;
      const data = micB64(mic.bytes, mic.fill * 2);
      mic.fill = 0;
      if (mic.avail === false) return;
      if (mic.avail === null) {
        if (mic.queue.length < CAP_PREROLL) mic.queue.push(data);
        return;
      }
      if (!connOk()) { stopListen(); return; }
      send({ kind: 'listen_audio', data });
      bus.emit('micFrame', { bytes: data.length, format: 'pcm16le-16k-mono-b64' });
    }

    function micFrames(f32, gen) {
      if (gen !== mic.gen || !mic.active || !f32 || !f32.length) return;
      if (turn || mode === 'speaking' || mode === 'thinking') return;
      const r = mic.ratio;
      for (let i = 0; i < f32.length; i++) {
        mic.acc += f32[i]; mic.accN++; mic.phase++;
        while (mic.phase >= r) {
          mic.phase -= r;
          let v = mic.accN ? mic.acc / mic.accN : mic.last;
          if (mic.accN) { mic.last = v; mic.acc = 0; mic.accN = 0; }
          v = v < -1 ? -1 : v > 1 ? 1 : v;
          mic.view.setInt16(mic.fill * 2, Math.round(v * 32767), true);
          if (++mic.fill >= CAP_CHUNK) micFlush();
        }
      }
    }

    async function micAddWorklet(ctx) {
      if (ctx._coreLinkMicTap) return true;
      if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') return false;
      const url = URL.createObjectURL(new Blob([CAP_WORKLET], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        ctx._coreLinkMicTap = true;
        return true;
      } catch (e) { return false; }
      finally { URL.revokeObjectURL(url); }
    }

    async function micStart() {
      if (mic.active) return;
      mic.active = true; mic.avail = null; mic.partial = '';
      mic.queue.length = 0;
      mic.acc = 0; mic.accN = 0; mic.phase = 0; mic.last = 0; mic.fill = 0;
      const gen = ++mic.gen;
      send({ kind: 'listen_start' });
      clearTimeout(mic.answerTimer);
      mic.answerTimer = setTimeout(() => {
        if (mic.active && mic.avail === null) onListen({ available: false, reason: 'no answer from the brain' });
      }, CAP_ANSWER_MS);
      try {
        const ms = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (gen !== mic.gen || !mic.active) {
          for (const t of ms.getTracks()) { try { t.stop(); } catch (e) {} }
          return;
        }
        mic.stream = ms;
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = mic.ctx = new AC();
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
        if (gen !== mic.gen || !mic.active) return;
        mic.ratio = ctx.sampleRate / CAP_SR;
        mic.src = ctx.createMediaStreamSource(ms);
        let node;
        if (await micAddWorklet(ctx)) {
          if (gen !== mic.gen || !mic.active) return;
          node = new AudioWorkletNode(ctx, 'mic-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          node.port.onmessage = (e) => micFrames(e.data, gen);
        } else {
          node = ctx.createScriptProcessor(4096, 1, 1);
          node.onaudioprocess = (e) => micFrames(e.inputBuffer.getChannelData(0), gen);
        }
        mic.node = node;
        mic.sink = ctx.createGain();
        mic.sink.gain.value = 0;
        mic.src.connect(node);
        node.connect(mic.sink);
        mic.sink.connect(ctx.destination);
      } catch (e) {
        mic.blocked = true;
        micStop();
        bus.emit('log', 'microphone capture failed');
        bus.emit('micError', e && e.name ? e.name : 'capture failed');
      }
    }

    function micStop() {
      const was = mic.active;
      clearTimeout(mic.answerTimer); mic.answerTimer = null;
      if (was && mic.avail === true) micFlush();
      mic.gen++;
      mic.active = false; mic.avail = null; mic.partial = '';
      mic.queue.length = 0;
      mic.fill = 0; mic.acc = 0; mic.accN = 0; mic.phase = 0; mic.last = 0;
      if (mic.node) {
        try { if (mic.node.port) mic.node.port.onmessage = null; } catch (e) {}
        try { mic.node.onaudioprocess = null; } catch (e) {}
        try { mic.node.disconnect(); } catch (e) {}
        mic.node = null;
      }
      if (mic.src) { try { mic.src.disconnect(); } catch (e) {} mic.src = null; }
      if (mic.sink) { try { mic.sink.disconnect(); } catch (e) {} mic.sink = null; }
      if (mic.stream) {
        for (const t of mic.stream.getTracks()) { try { t.stop(); } catch (e) {} }
        mic.stream = null;
      }
      if (mic.ctx) { try { mic.ctx.close(); } catch (e) {} mic.ctx = null; }
      if (was && connOk()) send({ kind: 'listen_stop' });
    }

    function onListen(m) {
      if (!mic.active) return;
      clearTimeout(mic.answerTimer); mic.answerTimer = null;
      if (m.available === true) {
        mic.avail = true;
        if (connOk()) for (const d of mic.queue) send({ kind: 'listen_audio', data: d });
        mic.queue.length = 0;
        bus.emit('listen', { available: true });
        return;
      }
      mic.avail = false;
      micStop();
      bus.emit('listen', { available: false, reason: m.reason });
      // Web Speech fallback is UI-owned when DOM SpeechRecognition exists;
      // CoreLink emits and lets UI decide (DOM-agnostic).
    }

    function onTranscript(m) {
      if (!mic.active || mic.avail !== true) return;
      const text = typeof m.text === 'string' ? m.text.trim() : '';
      if (!text) return;
      if (m.final) {
        mic.partial = '';
        collect(text);
      } else {
        mic.partial = text;
        if (listeningOn()) followUntil = Math.max(followUntil, Date.now() + HEARD_MS);
        bus.emit('transcript', { text, final: false });
      }
      armSilence();
    }

    function collect(fragment) {
      pending = (pending + ' ' + fragment).replace(/\s+/g, ' ').trim();
      bus.emit('transcript', { text: pending, final: false, collecting: true });
    }

    function armSilence() {
      clearTimeout(silenceTimer);
      const wait = UNFINISHED.test(pending) ? SILENCE_UNFINISHED_MS : SILENCE_MS;
      silenceTimer = setTimeout(flushUtterance, wait);
    }

    function flushUtterance() {
      clearTimeout(silenceTimer); silenceTimer = null;
      if (!pending && mic.partial) collect(mic.partial);
      mic.partial = '';
      const text = pending.trim();
      pending = '';
      if (!text) {
        followUntil = 0;
        stopListen();
        if (!turn) setMode('idle');
        return;
      }
      stopListen();
      sendUtterance(text);
    }

    function startFollowUp(ms) {
      if (turn || !connOk()) return;
      followUntil = Date.now() + ms;
      setMode('listening');
      beginCapture();
      clearTimeout(followTimer);
      followTimer = setTimeout(() => {
        if (!turn && !listeningOn()) endFollowUp();
      }, ms + 250);
    }

    function endFollowUp() {
      followUntil = 0;
      clearTimeout(followTimer);
      stopListen();
      if (!turn) setMode('idle');
    }

    function beginCapture() {
      if (micUsable()) { micStart(); return; }
      bus.emit('listenFallback', { reason: mic.blocked ? 'blocked' : 'unavailable' });
    }

    function startListen() {
      if (mic.active || mode === 'thinking' || mode === 'speaking') return;
      setMode('listening');
      t0 = performance.now();
      pending = '';
      beginCapture();
      bus.emit('listenStart');
    }

    function stopListen() {
      clearTimeout(silenceTimer); silenceTimer = null;
      micStop();
    }

    function toggleListen() {
      if (mode === 'listening') flushUtterance();
      else if (turn) cancelTurn();
      else startListen();
    }

    /* ---- voice playback ---- */
    function ensureVoiceCtx() {
      if (voice.ctx) return voice.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { voice.ctx = new AC({ sampleRate: VOICE_SR }); }
      catch (e) {
        try { voice.ctx = new AC(); } catch (e2) { return null; }
      }
      voice.gain = voice.ctx.createGain();
      voice.gain.gain.value = 1;
      voice.an = voice.ctx.createAnalyser();
      voice.an.fftSize = 512;
      voice.an.smoothingTimeConstant = 0.7;
      voice.freq = new Uint8Array(voice.an.frequencyBinCount);
      voice.gain.connect(voice.an);
      voice.an.connect(voice.ctx.destination);
      return voice.ctx;
    }

    function resumeVoiceCtx() {
      const ctx = voice.ctx;
      if (!ctx || ctx.state !== 'suspended') return;
      ctx.resume().catch(() => {});
    }

    function pcm16ToFloat32(b64) {
      const bin = atob(b64);
      const n = bin.length >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let v = (bin.charCodeAt(i * 2 + 1) << 8) | bin.charCodeAt(i * 2);
        if (v >= 0x8000) v -= 0x10000;
        out[i] = v / 32768;
      }
      return out;
    }

    /* Character timings onto the clock the audio is scheduled on (v1). Without
       alignment the characters are spread over the chunk at a spoken rate. */
    function pushVoiceTimeline(start, duration, alignment) {
      const chars = alignment && Array.isArray(alignment.chars) ? alignment.chars : null;
      if (chars && chars.length) {
        /* A turn that has alignment is counted by it alone. Estimates made
           before the first one are taken back, or they would stay ahead. */
        if (!voice.aligned) {
          voice.aligned = true;
          voice.charCursor -= voice.estChars;
          voice.estChars = 0;
          voice.timeline = voice.timeline.filter((e) => !e.est);
        }
        const st = Array.isArray(alignment.startMs) ? alignment.startMs : [];
        const du = Array.isArray(alignment.durMs) ? alignment.durMs : [];
        for (let i = 0; i < chars.length; i++) {
          const a = Number(st[i]) || 0, d = Number(du[i]) || 0;
          voice.timeline.push({ at: start + (a + d) / 1000, n: voice.charCursor + i + 1 });
        }
        voice.charCursor += chars.length;
        return;
      }
      /* The brain sends alignment on some chunks only, and each one's timings
         run on over the chunks after it that carry none: those are not more
         characters. Counting them at a speaking rate put the gate a sentence
         or more ahead of the voice by the middle of a briefing. */
      if (voice.aligned) return;
      const total = Math.max(1, Math.round(duration * VOICE_CPS));
      for (let i = 1; i <= total; i++) {
        voice.timeline.push({ at: start + duration * (i / total), n: voice.charCursor + i, est: true });
      }
      voice.charCursor += total;
      voice.estChars += total;
    }

    /* What has been said so far moves the cue gate, so a panel opens on the
       word that names it rather than when the text happened to arrive. */
    function voiceTick() {
      const ctx = voice.ctx;
      if (!ctx || !voiceSpeaksTurn()) return;
      const t = ctx.currentTime;
      let n = -1;
      while (voice.timeline.length && voice.timeline[0].at <= t) n = voice.timeline.shift().n;
      if (n > voice.spokenN) {
        voice.spokenN = n;
        spokenText = String(turn.text || '').slice(0, n);
        flushPendingFocus(false);
      }
    }

    function voiceEnqueue(pcm, alignment) {
      const ctx = ensureVoiceCtx();
      if (!ctx) return;
      resumeVoiceCtx();
      let buf;
      try {
        buf = ctx.createBuffer(1, pcm.length, VOICE_SR);
        buf.copyToChannel(pcm, 0);
      } catch (e) { return; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(voice.gain);
      const now = ctx.currentTime;
      const start = voice.nextStart > now + 0.01 ? voice.nextStart : now + VOICE_LEAD;
      try { src.start(start); } catch (e) { return; }
      voice.sources.add(src);
      src.onended = () => { voice.sources.delete(src); try { src.disconnect(); } catch (e) {} };
      voice.nextStart = start + buf.duration;
      voice.playing = true;
      pushVoiceTimeline(start, buf.duration, alignment);
      startLevelTicker();
    }

    function startLevelTicker() {
      if (voice.levelIv) return;
      voice.levelIv = setInterval(() => {
        voiceTick();
        if (voice.done && voice.ctx && voice.ctx.currentTime > voice.nextStart + 0.05) {
          voice.playing = false;
          voiceFinish();
          return;
        }
        if (!voice.playing || !voice.an || !voice.freq) {
          bus.emit('audioLevel', 0);
          return;
        }
        /* RMS of what is playing right now. The smoothed spectrum this used to
           sum, times 2.4, sat at 1 through most of a sentence, so the orb's
           wave stood at full height instead of moving with the syllables.
           The raw level goes out; the HUD scales it to the voice's loudness. */
        if (!voice.td) voice.td = new Float32Array(voice.an.fftSize);
        voice.an.getFloatTimeDomainData(voice.td);
        let sq = 0;
        for (let i = 0; i < voice.td.length; i++) sq += voice.td[i] * voice.td[i];
        const level = clamp(Math.sqrt(sq / voice.td.length), 0, 1);
        bus.emit('audioLevel', level);
        if (voice.ctx && voice.ctx.currentTime > voice.nextStart + 0.05) {
          voice.playing = false;
          if (voice.done) voiceFinish();
        }
      }, 40);
    }

    /* Everything played (or the voice gave out): stop, then let the turn end. */
    function voiceFinish() {
      const after = voice.after;
      voice.after = null;
      voiceStop();
      if (after) after();
    }

    function voiceStop() {
      localStop();
      clearTimeout(voice.firstTimer); voice.firstTimer = null;
      clearTimeout(voice.stallTimer); voice.stallTimer = null;
      clearInterval(voice.levelIv); voice.levelIv = null;
      for (const src of voice.sources) {
        try { src.onended = null; src.stop(); } catch (e) {}
        try { src.disconnect(); } catch (e) {}
      }
      voice.sources.clear();
      voice.turnId = null; voice.ok = false; voice.done = false; voice.gapWarned = false;
      voice.nextStart = 0; voice.playing = false; voice.lastSeq = null; voice.armed = false;
      voice.timeline.length = 0; voice.charCursor = 0; voice.spokenN = 0;
      voice.aligned = false; voice.estChars = 0;
      voice.after = null; clearTimeout(voice.afterTimer); voice.afterTimer = null;
      bus.emit('audioLevel', 0);
    }

    function armVoiceStall() {
      clearTimeout(voice.stallTimer);
      voice.stallTimer = setTimeout(() => {
        if (!voice.ok || voice.done) return;
        bus.emit('log', 'voice stream stalled');
        voiceFinish();
      }, VOICE_STALL_MS);
    }

    function keepVoiceAlive() {
      if (voice.stallTimer !== null) armVoiceStall();
    }

    function onVoice(m) {
      voiceStop();
      if (turn) turn.voiceOk = m.available === true;
      if (m.available !== true) {
        startLocal();
        bus.emit('voice', { available: false, reason: m.reason, local: local.on });
        return;
      }
      voice.turnId = turn && turn.id;
      voice.ok = true;
      voice.fx = m.fx === 'echo' ? 'echo' : 'none';
      ensureVoiceCtx();
      resumeVoiceCtx();
      voice.armed = false;
      bus.emit('voice', { available: true, lang: m.lang, fx: voice.fx });
    }

    function armVoiceFallback() {
      if (!voice.ok || voice.armed) return;
      voice.armed = true;
      clearTimeout(voice.firstTimer);
      voice.firstTimer = setTimeout(() => {
        const after = voice.after;
        voice.after = null;
        voiceStop();
        if (startLocal()) {
          local.after = after;
          localFeed(after !== null);
        } else if (after) after();
        bus.emit('log', 'no audio from the brain — local voice takes over');
      }, VOICE_FIRST_MS);
    }

    function onAudio(m) {
      if (!voice.ok || !turn || m.turnId !== voice.turnId) return;
      if (typeof m.data !== 'string' || !m.data) return;
      if (!voice.armed) armVoiceFallback();
      clearTimeout(voice.firstTimer); voice.firstTimer = null;
      if (typeof m.seq === 'number') {
        if (voice.lastSeq !== null && m.seq !== voice.lastSeq + 1 && !voice.gapWarned) {
          voice.gapWarned = true;
          bus.emit('log', 'gap in the voice stream');
        }
        voice.lastSeq = m.seq;
      }
      let pcm;
      try { pcm = pcm16ToFloat32(m.data); } catch (e) { return; }
      if (!pcm.length) return;
      if (mode !== 'speaking') setMode('speaking');
      voiceEnqueue(pcm, m.alignment);
      armVoiceStall();
    }

    function onAudioDone(m) {
      if (!voice.ok || m.turnId !== voice.turnId) return;
      clearTimeout(voice.firstTimer); voice.firstTimer = null;
      clearTimeout(voice.stallTimer); voice.stallTimer = null;
      voice.done = true;
      startLevelTicker();
    }

    /* ---- key / gesture bindings (v1 Space + 1-4; skip v2 W/A/N/M/P/S/B) ---- */
    function onKey(e) {
      const el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        resumeVoiceCtx();
        toggleListen();
      }
      // 1-4: collide with v2 voice-state test keys — emit only; do not steal if UI handles them.
      // CoreLink does NOT bind 1-4 when opts.bindVoiceTestKeys === false (default false to avoid collision).
      if (opts.bindVoiceTestKeys) {
        if (e.key === '1') setMode('idle');
        if (e.key === '2') setMode('listening');
        if (e.key === '3') setMode('thinking');
        if (e.key === '4') setMode('speaking');
      }
    }

    if (bindKeys && typeof window !== 'undefined') {
      window.addEventListener('keydown', onKey);
      window.addEventListener('pointerdown', resumeVoiceCtx);
    }

    /* ---- public API ---- */
    const link = {
      connect,
      disconnect,
      on: bus.on,
      off: bus.off,
      /** Convenience subscriptions */
      onPanelData(fn) { return bus.on('panelData', fn); },
      onDisplay(fn) { return bus.on('display', fn); },
      onDesk(fn) { return bus.on('desk', fn); },
      onVoiceState(fn) { return bus.on('voiceState', fn); },
      onAudioLevel(fn) { return bus.on('audioLevel', fn); },
      onUsage(fn) { return bus.on('usage', fn); },
      onSystem(fn) { return bus.on('system', fn); },
      onFocus(fn) { return bus.on('focus', fn); },
      onLang(fn) { return bus.on('lang', fn); },
      onConnection(fn) { return bus.on('connection', fn); },

      startListen,
      stopListen,
      toggleListen,
      flushUtterance,
      sendUtterance,
      say,
      setLang,
      cancelTurn,
      resumeAudio: resumeVoiceCtx,

      get mode() { return mode; },
      get lang() { return speechLang; },
      get connected() { return connOk(); },
      get connectionState() { return connState; },
      get sessionId() { return sessionId; },
      get inBriefing() { return inBriefing; },
      get focusedPanel() { return focusedPanel; },
      get stickyOrder() { return topics.STICKY_ORDER; },

      topics,
      Normalizers,
      /** Test hook: inject a server message without a socket. */
      _inject: route,
      /** Test hook: what the cue gate counts as said so far. */
      get _spoken() { return spokenText; },
      /** Mark briefing for interim focus derivation (tests / until desk arrives). */
      _setBriefing(v) { inBriefing = !!v; },
    };

    return link;
  }

  return {
    create,
    Normalizers,
    FIXED_PANELS,
    DEFAULT_STICKY_ORDER,
    DEFAULT_WINDOW_TOPICS,
    stickyTopicOf: function (p, map) {
      const t = map || createTopicMap();
      return t.stickyTopicOf(p);
    },
    version: 'live-port-bd72bd5',
  };
});
