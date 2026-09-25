/* The screen's language.

   The page is written in English. When the brain says the screen is in
   another language (`ui_lang`), every piece of text on the page that is one of
   the phrases below is shown translated -- what is there now, and whatever is
   drawn later, through one MutationObserver -- so the code that draws panels
   never has to know. Only exact phrases are touched: a mail subject that
   happens to read "Mail" is rare, and a dictionary that guessed at sentences
   would be wrong far more often. Dates follow the same language. */
(function () {
  'use strict';

  const NL = {
    'Weather': 'Weer',
    'Agenda': 'Agenda',
    'Facts': 'Feiten',
    'Fact': 'Feit',
    'Mail': 'Mail',
    'Work · PRs': 'Werk · PR’s',
    'System': 'Systeem',
    'Awaiting Core': 'Wacht op Core',
    'Type a command…': 'Typ een opdracht…',
    'Items today': 'Items vandaag',
    'Item today': 'Item vandaag',
    'Next up': 'Hierna',
    'Added': 'Toegevoegd',
    'New': 'Nieuw',
    'Unread': 'Ongelezen',
    'Recent': 'Recent',
    'inbox': 'inbox',
    'Open pull requests': 'Open pull requests',
    'Open pull request': 'Open pull request',
    'BRAIN ONLINE': 'BREIN ONLINE',
    'BRAIN CONNECTING': 'BREIN VERBINDT',
    'BRAIN OFFLINE': 'BREIN OFFLINE',
    'DESK LIVE': 'DESK LIVE',
    'DESK IDLE': 'DESK INACTIEF',
    'STANDBY': 'STAND-BY',
    'LISTENING': 'LUISTERT',
    'THINKING': 'DENKT NA',
    'SPEAKING': 'SPREEKT',
    'Neural core · idle breathe': 'Neurale kern · in rust',
    'Mic open · hearing': 'Microfoon open · luistert',
    'Composer · synthesizing': 'Antwoord · wordt opgesteld',
    'TTS · through-orb waveform': 'Stem · spreekt',
    'Close': 'Sluiten',
    'Hold to talk': 'Vasthouden om te praten',
    'Chart': 'Grafiek',
    'Image': 'Afbeelding',
    'Live': 'Live',
  };
  const DICTS = { nl: NL };
  const LOCALES = { en: 'en-GB', nl: 'nl-NL' };
  const ATTRS = ['placeholder', 'aria-label', 'title'];

  let lang = 'en';
  /* text node -> the English it was drawn with */
  const original = new WeakMap();

  function translate(text) {
    const dict = DICTS[lang];
    if (!dict) return null;
    const key = text.trim();
    if (!key || !Object.prototype.hasOwnProperty.call(dict, key)) return null;
    return text.replace(key, dict[key]);
  }

  function reverse(text) {
    /* for attributes, which have no node to remember them by */
    for (const code of Object.keys(DICTS)) {
      const dict = DICTS[code];
      for (const en of Object.keys(dict)) if (dict[en] === text.trim()) return text.replace(text.trim(), en);
    }
    return text;
  }

  function fixText(node) {
    const english = original.has(node) ? original.get(node) : node.nodeValue;
    const shown = translate(english);
    if (shown === null) {
      if (original.has(node)) { node.nodeValue = english; original.delete(node); }
      return;
    }
    if (!original.has(node)) original.set(node, english);
    if (node.nodeValue !== shown) node.nodeValue = shown;
  }

  function fixAttrs(el) {
    ATTRS.forEach(function (name) {
      const v = el.getAttribute && el.getAttribute(name);
      if (!v) return;
      const english = reverse(v);
      const shown = translate(english);
      const want = shown === null ? english : shown;
      if (v !== want) el.setAttribute(name, want);
    });
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { fixText(root); return; }
    if (root.nodeType !== 1) return;
    if (root.tagName === 'SCRIPT' || root.tagName === 'STYLE') return;
    fixAttrs(root);
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n = it.nextNode();
    while (n) {
      if (n.nodeType === 3) fixText(n); else fixAttrs(n);
      n = it.nextNode();
    }
  }

  let busy = false;
  const observer = new MutationObserver(function (records) {
    if (busy || lang === 'en') return;
    busy = true;
    try {
      records.forEach(function (r) {
        if (r.type === 'characterData') fixText(r.target);
        else if (r.type === 'attributes') fixAttrs(r.target);
        else r.addedNodes.forEach(walk);
      });
    } finally { busy = false; }
  });

  function set(next) {
    if (!LOCALES[next] || next === lang) return;
    lang = next;
    document.documentElement.lang = next;
    busy = true;
    try { walk(document.body); } finally { busy = false; }
    window.dispatchEvent(new CustomEvent('jarvis:ui-lang', { detail: next }));
  }

  function start() {
    observer.observe(document.body, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  window.JarvisI18n = {
    set: set,
    get lang() { return lang; },
    locale: function () { return LOCALES[lang] || 'en-GB'; },
    t: function (text) { const s = translate(text); return s === null ? text : s; },
  };
})();
