/* intro.js — the cinematic opening, grafted in front of app.js without editing it.
   Loads after leaflet.js and before app.js.

   Sequence: FIREBREAK title card with an animated red heat haze and one Enter
   button. Enter is the user gesture, so it hands straight to the app (which starts
   its audio and loads the town) while this overlay stays on top. The map then flies
   from state scale to the region over 10 s while meta.crawl plays a line at a time.
   When the crawl ends, or Skip is pressed, the overlay lifts and the app's own
   walkthrough is advanced one step so the fire plays.

   The app is never modified: handoff is a click on its own intro element, and then
   a click on its own caption button. */
(function () {
  const PARAMS = new URLSearchParams(location.search);
  if (PARAMS.get('intro') === '0') return;            // test flag: no opening

  // Leaflet hands us every map it builds, so we can fly the app's own map.
  if (window.L && L.Map && L.Map.addInitHook) {
    L.Map.addInitHook(function () { window.__fbMap = this; });
  }

  const STATE_ZOOM = 6, FLY_SECONDS = 10, HOLD = 2500, FADE = 700;
  let timers = [], handedOff = false;
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  document.addEventListener('DOMContentLoaded', build);
  if (document.readyState !== 'loading') build();
  let built = false;

  function build() {
    if (built) return;
    built = true;
    document.body.classList.add('fb-intro');

    const wrap = document.createElement('div');
    wrap.id = 'fb-intro';
    wrap.innerHTML =
      '<svg id="fb-heat-defs" aria-hidden="true">' +
        '<filter id="fb-heat" x="-20%" y="-20%" width="140%" height="140%">' +
          '<feTurbulence id="fb-heat-turb" type="fractalNoise" baseFrequency="0.011 0.026"' +
          ' numOctaves="2" seed="2" result="noise"/>' +
          '<feDisplacementMap id="fb-heat-disp" in="SourceGraphic" in2="noise" scale="34"' +
          ' xChannelSelector="R" yChannelSelector="G"/>' +
        '</filter>' +
      '</svg>' +
      '<div id="fb-intro-inner">' +
        '<div id="fb-title-wrap">' +
          '<span id="fb-title-back" aria-hidden="true">FIREBREAK</span>' +
          '<h1 id="fb-title-front">FIREBREAK</h1>' +
        '</div>' +
        '<button id="fb-enter" type="button">Enter</button>' +
      '</div>';

    const crawl = document.createElement('div');
    crawl.id = 'fb-crawl';
    crawl.hidden = true;
    crawl.innerHTML = '<p id="fb-crawl-line"></p>';

    const skip = document.createElement('button');
    skip.id = 'fb-skip';
    skip.type = 'button';
    skip.hidden = true;
    skip.textContent = 'Skip intro';

    document.body.appendChild(wrap);
    document.body.appendChild(crawl);
    document.body.appendChild(skip);

    animateHeat();
    wrap.addEventListener('click', onEnter);
    skip.addEventListener('click', e => { e.stopPropagation(); finish(); });
  }

  /* Drift the turbulence so the red edge waves. The white copy carries no filter,
     so it never flickers. Stops as soon as the card is gone. */
  function animateHeat() {
    const turb = document.getElementById('fb-heat-turb');
    const card = document.getElementById('fb-intro');
    if (!turb || !card) return;
    const disp = document.getElementById('fb-heat-disp');
    let t = 0;
    const tick = () => {
      if (!card.isConnected || card.classList.contains('gone')) return;
      t += 1;
      // new noise every 3rd frame, frequency breathing on a slow sine: the red
      // edge visibly ripples while the white word stays untouched
      turb.setAttribute('seed', String(2 + ((t / 3) | 0) % 128));
      const s = Math.sin(t / 60);
      const fx = 0.009 + (s + 1) * 0.5 * (0.018 - 0.009);        // 0.009..0.018
      const fy = 0.020 + (Math.cos(t / 47) + 1) * 0.5 * 0.016;   // 0.020..0.036
      turb.setAttribute('baseFrequency', fx.toFixed(5) + ' ' + fy.toFixed(5));
      if (disp) disp.setAttribute('scale', (34 + s * 6).toFixed(1));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // the app publishes window._fb.map; the init hook is a belt-and-braces second route
  function theMap() {
    return window.__fbMap || (window._fb && window._fb.map) || null;
  }
  // ready once the map exists and the story line has been filled from meta
  function appReady() {
    const story = document.getElementById('story');
    return !!theMap() && !!story && !/loading/i.test(story.textContent || '');
  }

  function onEnter() {
    const card = document.getElementById('fb-intro');
    if (!card || card.classList.contains('gone')) return;
    card.classList.add('gone');
    document.body.classList.add('fb-crawl');
    document.getElementById('fb-skip').hidden = false;
    setTimeout(() => card.remove(), 700);

    // Hand to the app now, on the gesture, so its audio context is allowed to
    // start. Its walkthrough parks at "armed" and waits, so no fire runs yet.
    waitFor(appReady, 12000, () => {
      const appIntro = document.getElementById('intro');
      if (appIntro) appIntro.click();
      startCrawl();
    });
  }

  function waitFor(test, timeoutMs, done) {
    const t0 = Date.now();
    (function poll() {
      if (test() || Date.now() - t0 > timeoutMs) return done();
      setTimeout(poll, 80);
    })();
  }

  /* Resolve the town's own meta the same way the app does, so the crawl text and
     the fly target belong to whichever town is loaded. */
  async function loadMeta() {
    let dir = 'data';
    try {
      const ti = await fetch('towns/index.json');
      if (ti.ok) {
        const towns = await ti.json();
        if (Array.isArray(towns) && towns.length) {
          const want = PARAMS.get('town');
          const entry = towns.find(t => t.id === want) || towns[0];
          if (entry && entry.data_dir) dir = entry.data_dir.replace(/\/+$/, '');
        }
      }
    } catch (e) { /* no manifest: the default dir is right */ }
    try {
      const r = await fetch(dir + '/meta.json');
      if (!r.ok) return null;
      const m = await r.json();
      if (m && m.bounds) {
        window.__fbBounds = L.latLngBounds(
          [m.bounds.south, m.bounds.west], [m.bounds.north, m.bounds.east]);
      }
      return m;
    } catch (e) { return null; }
  }

  function linesFrom(meta) {
    if (meta && Array.isArray(meta.crawl) && meta.crawl.length) return meta.crawl.slice(0, 6);
    const story = (meta && meta.story) || '';
    if (story) return story.split(/(?<=[.?])\s+/).filter(Boolean).slice(0, 4);
    return ['The fire is about to start.'];
  }

  async function startCrawl() {
    const crawl = document.getElementById('fb-crawl');
    const line = document.getElementById('fb-crawl-line');
    crawl.hidden = false;
    crawl.classList.remove('clear');

    const meta = await loadMeta();          // small file, resolves before scheduling
    if (handedOff) return;
    const lines = linesFrom(meta);
    const map = theMap();

    if (map) {
      const b = window.__fbBounds;
      const c = b ? b.getCenter() : map.getCenter();
      map.setView(c, STATE_ZOOM, { animate: false });
      at(350, () => {
        crawl.classList.add('clear');
        map.invalidateSize();
        map.flyTo(c, targetZoom(map), { duration: FLY_SECONDS, easeLinearity: 0.25 });
      });
    } else {
      at(350, () => crawl.classList.add('clear'));
    }

    lines.forEach((text, i) => {
      at(600 + i * HOLD, () => { line.textContent = text; line.classList.add('on'); });
      at(600 + i * HOLD + (HOLD - FADE), () => line.classList.remove('on'));
    });
    at(600 + lines.length * HOLD, finish);
  }

  function targetZoom(map) {
    // frame the whole burn area for the narrower map the panel leaves behind
    const b = window.__fbBounds;
    if (b && map.getBoundsZoom) {
      try { return map.getBoundsZoom(b, false, L.point(24, 24)); } catch (e) { /* fall through */ }
    }
    return 12.5;
  }

  /* Lift the overlay and advance the app's own walkthrough by one step, which is
     what starts the fire. */
  function finish() {
    if (handedOff) return;
    handedOff = true;
    clearTimers();
    const crawl = document.getElementById('fb-crawl');
    if (crawl) crawl.remove();
    const skip = document.getElementById('fb-skip');
    if (skip) skip.remove();
    document.body.classList.remove('fb-crawl', 'fb-intro');
    const card = document.getElementById('fb-intro');
    if (card) card.remove();

    const map = theMap();
    if (map) {
      map.invalidateSize();
      const b = window.__fbBounds;
      if (b) { try { map.fitBounds(b, { padding: [10, 10] }); } catch (e) { /* ignore */ } }
    }
    waitFor(() => {
      const btn = document.getElementById('caption-btn');
      return btn && !btn.hidden;
    }, 6000, () => {
      const appIntro = document.getElementById('intro');
      if (appIntro) appIntro.click();          // no-op if already handed over
      const btn = document.getElementById('caption-btn');
      if (btn && !btn.hidden) btn.click();     // "Watch it happen": the fire runs
    });
  }
})();
