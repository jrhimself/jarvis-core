/* What was said, in writing.

   Two views of one conversation. The caption under the orb carries the answer
   being given now, as far as the voice has got, so the words keep pace with
   the sound rather than running ahead of it; what was asked is already in the
   chip above. It fades once the turn is over. The drawer is the whole of today, read
   from the brain (`/api/transcript`) each time it opens so that turns from the
   phone or a chat are in it too, with the turn in progress added live.

   Opened with the button in the footer or T; closed with the same, Escape or
   the cross. */
(function () {
  'use strict';

  /* How long the caption stays after the answer has been said. */
  const CAPTION_HOLD_MS = 6000;
  /* The caption shows the end of what has been said, about three lines: fewer
     characters on a phone, or the line clamp cuts off the newest words. */
  function captionChars() {
    return window.innerWidth <= 800 ? 110 : 220;
  }

  const MARKER = /⟦[^⟦⟧]{0,40}⟧/g;

  function clean(text) {
    return String(text || '').replace(MARKER, '').trim();
  }

  /* The tail of an answer that fits the caption, starting at a word. */
  function tail(text) {
    const max = captionChars();
    if (text.length <= max) return text;
    const cut = text.slice(-max);
    const sentence = cut.search(/[.!?]\s+\S/);
    if (sentence >= 0 && sentence < max / 2) return cut.slice(sentence + 1).trim();
    const space = cut.indexOf(' ');
    return '…' + (space >= 0 ? cut.slice(space + 1) : cut);
  }

  function clock(iso) {
    const d = iso ? new Date(iso) : new Date();
    const locale = window.JarvisI18n && JarvisI18n.locale ? JarvisI18n.locale() : undefined;
    return d.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function wire(link) {
    const caption = document.getElementById('caption');
    const captionText = document.getElementById('caption-text');
    const drawer = document.getElementById('transcript');
    const list = document.getElementById('transcript-list');
    const button = document.getElementById('btn-transcript');
    const close = document.getElementById('transcript-close');

    /* ---------- caption ---------- */
    let hideTimer = null;
    let captionTurn = null;

    function showCaption() {
      if (!caption) return;
      clearTimeout(hideTimer);
      caption.hidden = false;
      caption.classList.remove('fading');
    }

    function fadeCaption(hold) {
      if (!caption) return;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        caption.classList.add('fading');
        hideTimer = setTimeout(function () { caption.hidden = true; }, 600);
      }, hold == null ? CAPTION_HOLD_MS : hold);
    }

    /* An answer cut short -- the briefing stopped, the desk sent back to rest --
       has no `done` behind it, and the line it left would otherwise stay under
       an orb that is no longer saying anything. */
    JarvisTranscript.release = function () {
      captionTurn = null;
      if (caption && !caption.hidden) fadeCaption(0);
    };

    /* ---------- drawer ---------- */
    /* The turn in progress: its entry in the drawer, filled as it streams. */
    let live = null;

    function entry(who, text, at) {
      const li = document.createElement('li');
      li.className = 'tr-' + who;
      const head = document.createElement('div');
      head.className = 'tr-head';
      const time = document.createElement('span');
      time.className = 'tr-time';
      time.textContent = clock(at);
      const name = document.createElement('span');
      name.className = 'tr-who';
      name.textContent = who === 'you' ? 'You' : 'Jarvis';
      head.appendChild(time);
      head.appendChild(name);
      const body = document.createElement('div');
      body.className = 'tr-body';
      body.textContent = text;
      li.appendChild(head);
      li.appendChild(body);
      return li;
    }

    function nearBottom() {
      return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    }

    function add(li) {
      if (!list) return;
      const stick = nearBottom();
      list.appendChild(li);
      if (stick) list.scrollTop = list.scrollHeight;
    }

    function emptyLine() {
      const li = document.createElement('li');
      li.className = 'tr-empty';
      li.textContent = 'Nothing said yet today.';
      return li;
    }

    function load() {
      if (!list) return;
      fetch('/api/transcript', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function (data) {
          list.textContent = '';
          const turns = (data && data.turns) || [];
          turns.forEach(function (t) {
            list.appendChild(entry('you', t.asked, t.at));
            const answer = clean(t.answered);
            if (answer) list.appendChild(entry('jarvis', answer, t.at));
          });
          /* The turn in progress is not stored until it is over. */
          if (live) {
            list.appendChild(live.you);
            if (live.jarvis) list.appendChild(live.jarvis);
          }
          if (!list.children.length) list.appendChild(emptyLine());
          list.scrollTop = list.scrollHeight;
        })
        .catch(function () {
          list.textContent = '';
          const li = emptyLine();
          li.textContent = 'The transcript could not be loaded.';
          list.appendChild(li);
        });
    }

    function isOpen() {
      return !!drawer && drawer.classList.contains('open');
    }

    function setOpen(open) {
      if (!drawer) return;
      drawer.classList.toggle('open', open);
      drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (button) button.setAttribute('aria-pressed', open ? 'true' : 'false');
      if (open) load();
    }

    if (button) button.addEventListener('click', function () { setOpen(!isOpen()); });
    if (close) close.addEventListener('click', function () { setOpen(false); });
    window.addEventListener('keydown', function (e) {
      const el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'Escape' && isOpen()) { setOpen(false); return; }
      if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) setOpen(!isOpen());
    });

    /* ---------- the conversation as it happens ---------- */
    link.on('utterance', function (m) {
      const text = clean(m && m.text);
      if (!text) return;
      captionTurn = m.turnId;
      if (caption) {
        clearTimeout(hideTimer);
        caption.hidden = true;
        if (captionText) captionText.textContent = '';
      }

      live = { id: m.turnId, you: entry('you', text), jarvis: null };
      if (isOpen()) {
        const empty = list.querySelector('.tr-empty');
        if (empty) empty.remove();
        add(live.you);
      }
    });

    link.on('text', function (m) {
      if (!live || !m || m.turnId !== live.id || m.opening) return;
      const text = clean(m.full);
      if (!text) return;
      if (!live.jarvis) {
        live.jarvis = entry('jarvis', text);
        if (isOpen()) add(live.jarvis);
      } else {
        const stick = isOpen() && nearBottom();
        live.jarvis.querySelector('.tr-body').textContent = text;
        if (stick) list.scrollTop = list.scrollHeight;
      }
    });

    link.on('spoken', function (m) {
      if (!m || m.turnId !== captionTurn) return;
      const text = clean(m.text);
      if (!text || !caption) return;
      if (captionText) captionText.textContent = tail(text);
      showCaption();
    });

    link.on('done', function () {
      live = null;
      if (caption && !caption.hidden) fadeCaption();
    });

    /* Said without being asked: a notice, or the greeting on arrival. */
    link.on('announce', function (m) {
      const text = clean(m && m.text);
      if (!text) return;
      captionTurn = null;
      if (captionText) captionText.textContent = tail(text);
      showCaption();
      fadeCaption();
      if (isOpen()) add(entry('jarvis', text));
    });
  }

  window.JarvisTranscript = { wire: wire, _tail: tail };
})();
