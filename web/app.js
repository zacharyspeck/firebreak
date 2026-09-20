/* Firebreak — renders web/<DATA_DIR>/ (CONTRACT.md) as the one-screen demo.
   No frameworks, no CDN; Leaflet is vendored. DATA_DIR defaults to the real
   pipeline output; towns/index.json (multi-town) or ?data=mock override it.
   URL flags: ?offline=1 forces the offline basemap, ?intro=0 skips the title
   card, ?town=<id> picks a town, ?data=<dir> forces a data dir (testing). */

let DATA_DIR = new URLSearchParams(location.search).get('data') || 'data';
const UNREACHED = 65535;
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const PARAMS = new URLSearchParams(location.search);
const FORCE_OFFLINE = PARAMS.has('offline');
const SKIP_INTRO = PARAMS.get('intro') === '0';
const $ = id => document.getElementById(id);

async function loadJSON(name) {
  const r = await fetch(`${DATA_DIR}/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

/* CONTRACT.md: base64 of little-endian uint16, row-major, row 0 = north. */
function decodeGrid(b64, rows, cols) {
  const bin = atob(b64);
  if (bin.length !== rows * cols * 2) {
    throw new Error(`grid is ${bin.length} bytes, expected ${rows * cols * 2}`);
  }
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const dv = new DataView(bytes.buffer);
  const out = new Uint16Array(rows * cols);
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(i * 2, true);
  return out;
}

/* steps.json arrays: uint8, arrival bucketed to bucket_min minutes, `never` = not
   reached within the horizon. Expanded to uint16 minutes so the fire pipeline is
   uniform. */
function decodeStepGrid(b64, rows, cols, bucketMin, never) {
  const bin = atob(b64);
  if (bin.length !== rows * cols) {
    throw new Error(`step grid is ${bin.length} bytes, expected ${rows * cols}`);
  }
  const out = new Uint16Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    const v = bin.charCodeAt(i);
    out[i] = v === never ? UNREACHED : v * bucketMin;
  }
  return out;
}

/* Fire age ramp: #ffd166 → #ff7a1a → #c1121f → translucent charcoal #1a1a1a across
   RAMP_SPAN minutes of age, precomputed as a per-minute RGB lookup table. */
const RAMP_SPAN = 180;
const RAMP = (() => {
  const stops = [[255, 209, 102], [255, 122, 26], [193, 18, 31], [26, 26, 26]];
  const lut = new Uint8Array((RAMP_SPAN + 1) * 3);
  for (let m = 0; m <= RAMP_SPAN; m++) {
    const f = (m / RAMP_SPAN) * (stops.length - 1);
    const i = Math.min(Math.floor(f), stops.length - 2), t = f - i;
    for (let k = 0; k < 3; k++) {
      lut[m * 3 + k] = Math.round(stops[i][k] + (stops[i + 1][k] - stops[i][k]) * t);
    }
  }
  return lut;
})();

const fmtMoney = n =>       // 999500+ takes the M branch so nothing prints "$1000k"
  n >= 999500 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n}`;
const fmtM2 = n =>          // 2-decimal variant for the continuous budget readout
  n >= 999995 ? `$${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`
    : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n}`;
const fmtTime = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const merc = lat => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/* Fire canvas layer: 2 px per grid cell (blurred via CSS so cells read soft),
   stretched over meta.bounds; positioning mirrors L.ImageOverlay. A second,
   smooth-scaled canvas carries a blurred glow on cells ignited within the last
   GLOW_SPAN minutes. Break cells render as cleared ground until fire crosses them.
   draw() returns the count of fresh-front cells (feeds the audio level). */
const GLOW_SPAN = 30;
const FireLayer = L.Layer.extend({
  initialize(bounds, rows, cols, opts) {
    L.setOptions(this, opts);
    this._b = bounds; this._rows = rows; this._cols = cols;
    this._mask = null;          // Uint8Array: 0 none, 1 break, 2 break edge
    this._hover = -1;           // hovered break index (cells highlight green)
    this._cellBreak = null;     // Int16Array cell → break index (-1 none)
  },
  onAdd() {
    const c = this._canvas = L.DomUtil.create('canvas', 'fire-canvas leaflet-zoom-animated');
    const g = this._glow = L.DomUtil.create('canvas', 'glow-canvas leaflet-zoom-animated');
    c.width = this._cols * 2; c.height = this._rows * 2;
    g.width = this._cols; g.height = this._rows;
    this._ctx = c.getContext('2d');
    this._gctx = g.getContext('2d');
    this._off = document.createElement('canvas');
    this._off.width = this._cols; this._off.height = this._rows;
    this._octx = this._off.getContext('2d');
    this._img = this._ctx.createImageData(this._cols * 2, this._rows * 2);
    this._gimg = this._octx.createImageData(this._cols, this._rows);
    this._frame = 0;
    // Edge feather: fire alpha → 0 over the outer 25 cells, hard zero in the
    // outermost 5, so the fire never ends in the grid's straight boundary.
    const ef = this._ef = new Float32Array(this._rows * this._cols);
    for (let r = 0; r < this._rows; r++) {
      for (let c2 = 0; c2 < this._cols; c2++) {
        const dE = Math.min(r, c2, this._rows - 1 - r, this._cols - 1 - c2);
        ef[r * this._cols + c2] = dE < 5 ? 0 : dE >= 25 ? 1 : (dE - 5) / 20;
      }
    }
    this.getPane().appendChild(c);
    this.getPane().appendChild(g);
    this._reset();
  },
  onRemove() { this._canvas.remove(); this._glow.remove(); },
  getEvents() {
    const ev = { zoom: this._reset, viewreset: this._reset };
    if (this._zoomAnimated) ev.zoomanim = this._animateZoom;
    return ev;
  },
  _reset() {
    const nw = this._map.latLngToLayerPoint(this._b.getNorthWest());
    const se = this._map.latLngToLayerPoint(this._b.getSouthEast());
    for (const el of [this._canvas, this._glow]) {
      L.DomUtil.setPosition(el, nw);
      el.style.width = `${se.x - nw.x}px`;
      el.style.height = `${se.y - nw.y}px`;
    }
  },
  _animateZoom(e) {
    const nb = this._map._latLngBoundsToNewLayerBounds(this._b, e.zoom, e.center);
    const scale = this._map.getZoomScale(e.zoom);
    L.DomUtil.setTransform(this._canvas, nb.min, scale);
    L.DomUtil.setTransform(this._glow, nb.min, scale);
  },
  setBreaks(mask, cellBreak, edgeDir) {
    this._mask = mask; this._cellBreak = cellBreak; this._edir = edgeDir;
  },
  setHover(bi) { this._hover = bi; },
  // Homes live INSIDE this canvas (2×2 blocks at hx/hy in 2× grid px, sub-cell
  // jitter preserved) so they can never move independently of the grid.
  setHomes(hx, hy, states) { this._hx = hx; this._hy = hy; this._hst = states; },
  draw(arrival, t) {
    const frame = this._frame = (this._frame + 1) & 1023;
    const cols = this._cols, W2 = cols * 2, row4 = W2 * 4;
    const d = this._img.data, gd = this._gimg.data;
    const mask = this._mask, cb = this._cellBreak, hover = this._hover, ef = this._ef;
    let fresh = 0;
    for (let i = 0; i < arrival.length; i++) {
      const a = arrival[i], go = i * 4;
      const o = (((i / cols) | 0) * 2 * W2 + (i % cols) * 2) * 4;   // 2×2 block
      let R = 0, G = 0, B = 0, A = 0;
      if (a <= t) {
        const age = t - a;
        const k = Math.min(age, RAMP_SPAN) * 3;
        R = RAMP[k]; G = RAMP[k + 1]; B = RAMP[k + 2];
        if (age <= 15) {
          fresh++;
          // feathered fresh perimeter at 0.55, flickering ±0.1 (seeded, per frame)
          A = 140 + ((((i * 2654435761 ^ frame * 40503) >>> 0) & 255) - 128) * 0.2;
          A = A < 0 ? 0 : A;
        } else if (age >= RAMP_SPAN) A = 179;                    // charcoal at 0.70
        else if (age >= 120) A = 217 - ((age - 120) * 38) / 60;  // 0.85 → 0.70
        else A = 217;                                            // body at 0.85
        A *= ef[i];                               // fade out at the grid boundary
        if (age <= GLOW_SPAN) {                   // fresh ignition: amber-white glow
          gd[go] = 255; gd[go + 1] = 226; gd[go + 2] = 150;
          gd[go + 3] = Math.round((220 - (220 * age) / GLOW_SPAN) * ef[i]);
        } else gd[go + 3] = 0;
      } else {
        gd[go + 3] = 0;
        if (mask && mask[i]) {                    // cleared ground (fuel break)
          if (hover >= 0 && cb[i] === hover) { R = 61; G = 220; B = 132; A = 217; }
          else if (this._edir && this._edir[i]) {
            // strip perimeter: 1 px (sub-cell) lighter rim at 0.35 alpha
            const eb = this._edir[i];
            const put = (p, rim) => {
              if (rim) { d[p] = 233; d[p + 1] = 220; d[p + 2] = 188; d[p + 3] = 89; }
              else { d[p] = 217; d[p + 1] = 201; d[p + 2] = 163; d[p + 3] = 217; }
            };
            put(o, (eb & 1) || (eb & 4));
            put(o + 4, (eb & 1) || (eb & 8));
            put(o + row4, (eb & 2) || (eb & 4));
            put(o + row4 + 4, (eb & 2) || (eb & 8));
            continue;
          } else { R = 217; G = 201; B = 163; A = 217; }                   // #d9c9a3 .85
        }
      }
      d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = A;
      d[o + 4] = R; d[o + 5] = G; d[o + 6] = B; d[o + 7] = A;
      d[o + row4] = R; d[o + row4 + 1] = G; d[o + row4 + 2] = B; d[o + row4 + 3] = A;
      d[o + row4 + 4] = R; d[o + row4 + 5] = G; d[o + row4 + 6] = B; d[o + row4 + 7] = A;
    }
    if (this._hx) {
      const hx = this._hx, hy = this._hy, hst = this._hst;
      for (let i = 0; i < hx.length; i++) {
        const x = hx[i], y = hy[i], o = (y * W2 + x) * 4;
        const burned = hst[i] === 1;
        const R = burned ? 255 : 216, G = burned ? 59 : 216, B = burned ? 59 : 211;
        const A = burned ? 255 : 204;
        for (const p of [o, o + 4, o + row4, o + row4 + 4]) {
          d[p] = R; d[p + 1] = G; d[p + 2] = B; d[p + 3] = A;
        }
        if (hst[i] === 2) {          // saved: 1 px green ring around the block
          const top = o - row4 - 4, bot = o + 2 * row4 - 4;
          for (let k = 0; k < 4; k++) {
            for (const p of [top + k * 4, bot + k * 4]) {
              d[p] = 61; d[p + 1] = 220; d[p + 2] = 132; d[p + 3] = 255;
            }
          }
          for (const p of [o - 4, o + 8, o + row4 - 4, o + row4 + 8]) {
            d[p] = 61; d[p + 1] = 220; d[p + 2] = 132; d[p + 3] = 255;
          }
        }
      }
    }
    this._ctx.putImageData(this._img, 0, 0);
    this._octx.putImageData(this._gimg, 0, 0);
    const g = this._gctx;
    g.clearRect(0, 0, this._cols, this._rows);
    g.filter = 'blur(1.5px)';
    g.drawImage(this._off, 0, 0);
    g.filter = 'none';
    return fresh;
  },
});

/* Ghost of the baseline burn perimeter (state C): dashed white outline drawn from
   merged horizontal/vertical boundary runs of the baseline burned mask. */
const GhostLayer = L.Layer.extend({
  initialize(bounds, rows, cols, runs, opts) {
    L.setOptions(this, opts);
    this._b = bounds; this._rows = rows; this._cols = cols; this._runs = runs;
  },
  onAdd() {
    const c = this._canvas = L.DomUtil.create('canvas', 'ghost-canvas leaflet-zoom-animated');
    c.width = this._cols * 2; c.height = this._rows * 2;
    const x = c.getContext('2d');
    x.strokeStyle = 'rgba(255,255,255,0.55)';
    x.lineWidth = 1;
    x.setLineDash([5, 4]);
    x.beginPath();
    for (const [x0, y0, x1, y1] of this._runs) {
      x.moveTo(x0 * 2, y0 * 2); x.lineTo(x1 * 2, y1 * 2);
    }
    x.stroke();
    this.getPane().appendChild(c);
    this._reset();
  },
  onRemove() { this._canvas.remove(); },
  getEvents() {
    const ev = { zoom: this._reset, viewreset: this._reset };
    if (this._zoomAnimated) ev.zoomanim = this._animateZoom;
    return ev;
  },
  _reset() {
    const nw = this._map.latLngToLayerPoint(this._b.getNorthWest());
    const se = this._map.latLngToLayerPoint(this._b.getSouthEast());
    L.DomUtil.setPosition(this._canvas, nw);
    this._canvas.style.width = `${se.x - nw.x}px`;
    this._canvas.style.height = `${se.y - nw.y}px`;
  },
  _animateZoom(e) {
    const nb = this._map._latLngBoundsToNewLayerBounds(this._b, e.zoom, e.center);
    L.DomUtil.setTransform(this._canvas, nb.min, this._map.getZoomScale(e.zoom));
  },
});

/* Boundary of {arrival <= H}, as merged straight runs in cell coordinates.
   Edges on the domain border are skipped — where the fire runs off-grid there is
   no real perimeter to draw. */
function boundaryRuns(grid, rows, cols, H) {
  const burned = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && grid[r * cols + c] <= H;
  const runs = [];
  for (let r = 1; r < rows; r++) {           // horizontal edges at y = r (interior)
    let start = -1;
    for (let c = 0; c <= cols; c++) {
      const edge = c < cols && burned(r, c) !== burned(r - 1, c);
      if (edge && start < 0) start = c;
      if (!edge && start >= 0) { runs.push([start, r, c, r]); start = -1; }
    }
  }
  for (let c = 1; c < cols; c++) {           // vertical edges at x = c (interior)
    let start = -1;
    for (let r = 0; r <= rows; r++) {
      const edge = r < rows && burned(r, c) !== burned(r, c - 1);
      if (edge && start < 0) start = r;
      if (!edge && start >= 0) { runs.push([c, start, c, r]); start = -1; }
    }
  }
  return runs;
}

/* Tween a numeric display over ~150 ms (big numbers). */
const tweens = new Map();
function setNum(el, target, fmt) {
  const prev = tweens.get(el);
  if (prev && prev.target === target) return;
  if (!prev && el.textContent !== '–') {
    // seed from nothing: jump straight there on first write
  }
  const from = prev ? prev.value : target;
  const t0 = performance.now();
  const tw = { target, value: from };
  tweens.set(el, tw);
  const tick = now => {
    if (tweens.get(el) !== tw) return;
    const k = Math.min(1, (now - t0) / 150);
    tw.value = from + (target - from) * k;
    el.textContent = fmt(Math.round(tw.value));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* Offline basemap PNG with its edges feathered by a `feather`-px alpha ramp so it
   fades into the dark page instead of reading as a pasted rectangle. */
function featheredOverlay(src, bounds, feather) {
  return new Promise(resolve => {
    const img = new Image();
    img.onerror = () => resolve(L.imageOverlay(src, bounds));   // serve it raw
    img.onload = () => {
      const cv = document.createElement('canvas');
      const w = cv.width = img.width, h = cv.height = img.height;
      const x = cv.getContext('2d');
      x.drawImage(img, 0, 0);
      x.globalCompositeOperation = 'destination-out';
      const f = Math.min(feather, w / 4, h / 4);
      const edges = [
        [0, 0, f, 0, 0, 0, f, h], [w, 0, w - f, 0, w - f, 0, f, h],
        [0, 0, 0, f, 0, 0, w, f], [0, h, 0, h - f, 0, h - f, w, f],
      ];
      for (const [gx0, gy0, gx1, gy1, rx, ry, rw, rh] of edges) {
        const grad = x.createLinearGradient(gx0, gy0, gx1, gy1);
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = grad;
        x.fillRect(rx, ry, rw, rh);
      }
      resolve(L.imageOverlay(cv.toDataURL(), bounds));
    };
    img.src = src;
  });
}

/* Basemap: dimmed satellite tiles are the base; the feathered PNG is ONLY the
   offline fallback, never blended over satellite. Offline-first: the PNG shows
   until a clean tile batch lands; any tileerror brings it straight back. */
async function setupBasemap(map, bounds, onMode) {
  const png = await featheredOverlay(`${DATA_DIR}/basemap.png`, bounds, 40);
  png.addTo(map);
  onMode('OFFLINE');
  if (FORCE_OFFLINE) { onMode('OFFLINE (FORCED)'); return; }
  const probe = new Image();
  probe.onload = () => {
    const tiles = L.tileLayer(TILE_URL, { maxZoom: 17, attribution: 'Imagery © Esri' }).addTo(map);
    // Leaflet fires 'load' when a batch settles even if every tile errored, so a
    // clean-batch flag is needed or 'load' would undo the tileerror fallback.
    let errored = false;
    tiles.on('loading', () => { errored = false; });
    tiles.on('tileerror', () => {
      errored = true;
      if (!map.hasLayer(png)) png.addTo(map);
      onMode('OFFLINE (TILES FAILED)');
    });
    tiles.on('load', () => {
      if (!errored) {
        if (map.hasLayer(png)) map.removeLayer(png);
        onMode('SATELLITE');
      }
    });
  };
  probe.src = TILE_URL.replace('{z}', 0).replace('{y}', 0).replace('{x}', 0) + `?probe=${Date.now()}`;
}

/* Breaks → grid cells. Polygons are lat/lon; rows are uniform in mercator-y between
   the bounds, so lat converts through merc(). Returns per-break cell lists (+ edge
   flags baked later) and a cell → break-index map for hover. */
function rasterizeBreaks(breaksFC, meta) {
  const { rows, cols } = meta.grid, b = meta.bounds;
  const yN = merc(b.north), yS = merc(b.south);
  const latToRow = lat => ((yN - merc(lat)) / (yN - yS)) * rows;
  const lonToCol = lon => ((lon - b.west) / (b.east - b.west)) * cols;
  const cellBreak = new Int16Array(rows * cols).fill(-1);
  const pip = (x, y, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const breaks = breaksFC.features.map((ft, bi) => {
    if (Array.isArray(ft.properties.cell_idx)) {
      const cells = ft.properties.cell_idx;
      for (const i of cells) cellBreak[i] = bi;
      return { props: ft.properties, step: ft.properties.step ?? bi + 1, cells };
    }
    const ring = ft.geometry.coordinates[0].map(([lon, lat]) => [lonToCol(lon), latToRow(lat)]);
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const [x, y] of ring) {
      c0 = Math.min(c0, x); c1 = Math.max(c1, x);
      r0 = Math.min(r0, y); r1 = Math.max(r1, y);
    }
    const cells = [];
    for (let r = Math.max(0, Math.floor(r0)); r <= Math.min(rows - 1, Math.ceil(r1)); r++) {
      for (let c = Math.max(0, Math.floor(c0)); c <= Math.min(cols - 1, Math.ceil(c1)); c++) {
        if (pip(c + 0.5, r + 0.5, ring)) {
          cells.push(r * cols + c);
          cellBreak[r * cols + c] = bi;
        }
      }
    }
    return { props: ft.properties, step: ft.properties.step ?? bi + 1, cells };
  });
  return { breaks, cellBreak };
}

/* Fire crackle, synthesized — filtered brown-noise bed + random short bandpassed
   impulses. Level tracks the active front size. Must never throw. */
function makeAudio() {
  let ctx = null, master = null, muted = false, level = 0;
  function start() {
    if (ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
      master = ctx.createGain(); master.gain.value = 0;
      master.connect(ctx.destination);
      const len = ctx.sampleRate * 4;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = last * 3.5;
      }
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
      const bed = ctx.createGain(); bed.gain.value = 0.7;
      src.connect(lp); lp.connect(bed); bed.connect(master);
      src.start();
      setInterval(() => {
        try {
          if (!ctx || muted || level < 0.02) return;
          const n = 1 + Math.floor(Math.random() * 3 * level + 2 * level);
          for (let k = 0; k < n; k++) crackle();
        } catch (e) { /* audio must never break the page */ }
      }, 90);
    } catch (e) { ctx = null; }
  }
  function crackle() {
    const dur = 0.02 + Math.random() * 0.05;
    const len = Math.max(8, (ctx.sampleRate * dur) | 0);
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = b.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = ctx.createBufferSource(); s.buffer = b;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 3200; bp.Q.value = 1 + Math.random() * 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime((0.15 + Math.random() * 0.5) * level, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    s.connect(bp); bp.connect(g); g.connect(master);
    s.start(); s.stop(ctx.currentTime + dur + 0.02);
  }
  function setLevel(x) {
    level = x;
    if (!ctx || muted) return;
    try {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.linearRampToValueAtTime(Math.min(0.5, x * 0.5), ctx.currentTime + 0.15);
    } catch (e) { /* ignore */ }
  }
  function toggleMute() {
    muted = !muted;
    if (!ctx) return muted;
    try { master.gain.value = muted ? 0 : Math.min(0.5, level * 0.5); } catch (e) { /* ignore */ }
    return muted;
  }
  return { start, setLevel, toggleMute, isMuted: () => muted, isActive: () => !!ctx };
}

/* Inline SVG: step curve of cumulative cost vs cumulative homes saved (curve.json),
   with the current budget position marked. Returns {mark} to move the marker. */
function buildCurve(points) {
  const W = 308, H = 150, ML = 34, MR = 8, MT = 8, MB = 18;
  const pts = [{ cumulative_cost: 0, cumulative_saved: 0 }, ...points];
  const last = pts[pts.length - 1];
  const xmax = Math.max(last.cumulative_cost, 1), ymax = Math.max(last.cumulative_saved, 1);
  const X = c => ML + (c / xmax) * (W - ML - MR);
  const Y = s => H - MB - (s / ymax) * (H - MB - MT);
  let d = `M${X(0)} ${Y(0)}`;
  for (const p of pts.slice(1)) {
    d += `H${X(p.cumulative_cost).toFixed(1)}V${Y(p.cumulative_saved).toFixed(1)}`;
  }
  const svg = $('curve');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML =
    `<line class="grid" x1="${ML}" y1="${Y(ymax)}" x2="${W - MR}" y2="${Y(ymax)}"/>` +
    `<line class="grid" x1="${ML}" y1="${Y(ymax / 2)}" x2="${W - MR}" y2="${Y(ymax / 2)}"/>` +
    `<line class="axis" x1="${ML}" y1="${Y(0)}" x2="${W - MR}" y2="${Y(0)}"/>` +
    `<line class="axis" x1="${ML}" y1="${Y(0)}" x2="${ML}" y2="${MT}"/>` +
    `<text class="lbl" x="${ML - 4}" y="${Y(0) + 3}" text-anchor="end">0</text>` +
    `<text class="lbl" x="${ML - 4}" y="${Y(ymax / 2) + 3}" text-anchor="end">${Math.round(ymax / 2)}</text>` +
    `<text class="lbl" x="${ML - 4}" y="${Y(ymax) + 3}" text-anchor="end">${ymax}</text>` +
    `<text class="lbl" x="${ML}" y="${H - 4}">$0</text>` +
    `<text class="lbl" x="${W - MR}" y="${H - 4}" text-anchor="end">${fmtMoney(xmax)}</text>` +
    `<path class="curve-line" d="${d}"/>` +
    `<line id="curve-mark" class="mark" x1="0" x2="0" y1="${MT}" y2="${Y(0)}"/>` +
    `<circle id="curve-dot" r="4"/>`;
  let selText = '';
  const near = c => pts.reduce((b, p) =>
    Math.abs(p.cumulative_cost - c) < Math.abs(b.cumulative_cost - c) ? p : b);
  svg.onmousemove = e => {
    const r = svg.getBoundingClientRect();
    const cost = ((e.clientX - r.left) * (W / r.width) - ML) / (W - ML - MR) * xmax;
    const p = near(cost);
    $('curve-sentence').textContent =
      `${fmtMoney(p.cumulative_cost)} saves ${p.cumulative_saved} homes`;
  };
  svg.onmouseleave = () => { $('curve-sentence').textContent = selText; };
  return {
    mark(cost, saved, label) {
      $('curve-mark').setAttribute('x1', X(cost));
      $('curve-mark').setAttribute('x2', X(cost));
      $('curve-dot').setAttribute('cx', X(cost));
      $('curve-dot').setAttribute('cy', Y(saved));
      selText = label;
      $('curve-sentence').textContent = label;
    },
  };
}

/* Waffle: the primary panel visual — one square = `unit` homes. Red fills from the
   top-left as homes burn; green-ringed squares fill from the bottom-right as the
   baseline front passes homes the breaks protect. */
function buildWaffle(total) {
  const cv = $('waffle'), COLS = 20, CELL = 12, SQ = 10;
  const unit = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find(u => total / u <= 320) || 1000;
  const n = Math.ceil(total / unit), rows = Math.ceil(n / COLS);
  const dpr = window.devicePixelRatio || 1;
  cv.width = COLS * CELL * dpr; cv.height = rows * CELL * dpr;
  cv.style.width = `${COLS * CELL}px`; cv.style.height = `${rows * CELL}px`;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  $('waffle-caption').textContent = `1 square = ${unit} ${unit === 1 ? 'home' : 'homes'}`;
  return {
    draw(hitCount, savedCount) {
      const red = Math.min(n, Math.round(hitCount / unit));
      const green = Math.min(n - red, Math.round(savedCount / unit));
      ctx.clearRect(0, 0, COLS * CELL, rows * CELL);
      for (let i = 0; i < n; i++) {
        const cx = (i % COLS) * CELL + 1, cy = ((i / COLS) | 0) * CELL + 1;
        if (i < red) {
          ctx.fillStyle = '#ff3b3b'; ctx.fillRect(cx, cy, SQ, SQ);
        } else if (i >= n - green) {
          ctx.fillStyle = 'rgba(154,159,166,0.5)'; ctx.fillRect(cx, cy, SQ, SQ);
          ctx.strokeStyle = '#3ddc84'; ctx.lineWidth = 1;
          ctx.strokeRect(cx + 0.5, cy + 0.5, SQ - 1, SQ - 1);
        } else {
          ctx.fillStyle = 'rgba(154,159,166,0.28)'; ctx.fillRect(cx, cy, SQ, SQ);
        }
      }
    },
  };
}

/* The dense per-step model (steps.json array + breaks.geojson). CONTRACT.md: when
   those files are absent, degrade to the five snap budgets in solutions.json. */
async function loadModel() {
  try {
    const [arr, breaksFC] = await Promise.all([
      loadJSON('steps.json'), loadJSON('breaks.geojson'),
    ]);
    let cum = 0;
    const steps = arr.map(s => {
      cum += (s.break_ids || []).length;
      return {
        cost: s.cumulative_cost, saved: s.cumulative_saved,
        minutesBought: s.minutes_bought == null ? null : s.minutes_bought,
        b64u8: s.arrival_b64, breakCount: cum,
      };
    });
    return { steps, breaksFC, dense: true };
  } catch (err) {
    console.warn(`steps.json/breaks.geojson unavailable (${err.message}) — snap budgets only`);
    const solutions = await loadJSON('solutions.json');
    const feats = [], seen = new Set();
    const steps = [{ cost: 0, saved: 0, minutesBought: 0, breakCount: 0 }];
    solutions.forEach((sol, i) => {
      for (const f of sol.breaks.features) {
        if (!seen.has(f.properties.id)) {
          seen.add(f.properties.id);
          feats.push({ type: 'Feature', geometry: f.geometry,
            properties: Object.assign({}, f.properties, { step: i + 1 }) });
        }
      }
      steps.push({
        cost: sol.cost, saved: sol.stats.houses_saved,
        minutesBought: sol.stats.minutes_bought_town == null ? null : sol.stats.minutes_bought_town,
        b64u16: sol.arrival_min_b64, breakCount: seen.size,
      });
    });
    return { steps, breaksFC: { type: 'FeatureCollection', features: feats }, dense: false };
  }
}

/* Plans. The robust plan (steps.json, breaks.geojson) is the default. When the
   pipeline ran with --robust it also ships plan_historical.json (the plan solved
   for the historical fire only, no grids: the browser re-simulates them) and
   robust.json (both plans scored across the ignition+wind ensemble). */
async function loadPlans() {
  const optional = name => loadJSON(name).catch(() => null);
  const [model, robust, histPlan] = await Promise.all([
    loadModel(), optional('robust.json'), optional('plan_historical.json'),
  ]);
  if (!robust || !histPlan || !robust.historical_plan) {
    return { plans: { robust: model }, order: ['robust'], nScenarios: 0 };
  }
  const expected = steps => steps.map(s => s.mean_saved);
  // steps.json for the robust plan carries the ensemble mean; the panel's
  // "historical fire" number is scenario 0 (historical ignition, calibrated wind).
  robust.steps.forEach((s, i) => {
    if (model.steps[i]) model.steps[i].saved = s.per_scenario_saved[0];
  });
  let cum = 0;
  const histScored = robust.historical_plan.steps;
  const histSteps = histPlan.steps.map((s, i) => {
    cum += (s.break_ids || []).length;
    const scored = histScored[i];
    return {
      cost: s.cumulative_cost,
      saved: scored ? scored.per_scenario_saved[0] : s.cumulative_saved,
      minutesBought: s.minutes_bought == null ? null : s.minutes_bought,
      breakCount: cum, live: true,
    };
  });
  return {
    plans: {
      robust: Object.assign(model, { expected: expected(robust.steps) }),
      historical: { steps: histSteps, breaksFC: histPlan.breaks, dense: true,
                    expected: expected(robust.historical_plan.steps) },
    },
    order: ['robust', 'historical'],
    nScenarios: robust.scenarios.length,
  };
}

async function main() {
  // Town selector (CONTRACT.md web/towns/index.json): >1 entries → dropdown;
  // missing file or a single entry → none. Selecting reloads with ?town=<id>.
  let towns = null;
  try {
    const tr = await fetch('towns/index.json');
    if (tr.ok) towns = await tr.json();
  } catch (e) { /* no manifest — default data dir */ }
  if (Array.isArray(towns) && towns.length > 0) {
    const want = PARAMS.get('town');
    const entry = towns.find(t => t.id === want) || towns[0];
    if (!PARAMS.get('data')) DATA_DIR = entry.data_dir.replace(/\/+$/, '');
    if (towns.length > 1) {
      const sel = $('town-select');
      sel.hidden = false;
      document.body.classList.add('has-towns');
      sel.innerHTML = towns.map(t =>
        `<option value="${t.id}"${t.id === entry.id ? ' selected' : ''}>${t.name} — ${t.event}</option>`).join('');
      sel.onchange = () => {
        const p = new URLSearchParams(location.search);
        p.set('town', sel.value);
        location.search = p.toString();
      };
    }
  }

  const meta = await loadJSON('meta.json');
  const [baseline, curve, buildingsFC, legend, planSet, physics] = await Promise.all([
    loadJSON('baseline.json'), loadJSON('curve.json'),
    loadJSON('buildings.geojson'), loadJSON('fuel_legend.json'), loadPlans(),
    // physics.json is optional: without it there is no what-if mode.
    loadJSON('physics.json').catch(err => { console.warn(`no physics.json (${err.message})`); return null; }),
  ]);
  const { rows, cols } = meta.grid, b = meta.bounds;
  const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
  const H = meta.horizon_min;
  const maxBudget = meta.budgets[meta.budgets.length - 1];

  const { plans, nScenarios } = planSet;
  let planId = 'robust';
  let model = plans[planId];
  const hasPlans = planSet.order.length > 1;
  const planNotes = {
    robust: `Chosen to save the most homes on average across many plausible ignition points and winds — not just the fire that happened.`,
    historical: `Chosen for the historical ignition and wind only. Stronger on that fire, weaker when the fire starts somewhere else.`,
  };

  $('story').textContent = meta.story;
  $('legend').innerHTML = legend.map(g =>
    `<span class="chip"><i style="background:${g.color}"></i>${g.group}</span>`).join('');
  $('simp-list').innerHTML = meta.simplifications.map(s => `<li>${s}</li>`).join('');

  const map = L.map('map', {
    zoomSnap: 0.25, minZoom: 5, maxZoom: 17,
    wheelPxPerZoomLevel: 42, wheelDebounceTime: 12,   // faster, smoother wheel
  });
  // small "Reset view" that flies back to the town
  const ResetView = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const el = L.DomUtil.create('button', 'reset-view');
      el.type = 'button';
      el.textContent = 'Reset view';
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.on(el, 'click', () => map.flyToBounds(bounds, { padding: [10, 10], duration: 1.2 }));
      return el;
    },
  });
  map.addControl(new ResetView());
  map.fitBounds(bounds, { padding: [10, 10] });
  map.createPane('fire').style.zIndex = 405;
  window._fb = { map };   // debug/test handle

  const compass = deg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
  let wind = { speed_mph: meta.wind.speed_mph, from_deg: meta.wind.from_deg };
  let basemapMode = '…';
  const statusBits = () => [
    basemapMode, `${meta.grid.cell_m} m cells`,
    `wind ${compass(wind.from_deg)} ${wind.speed_mph} mph`,
  ].join(' · ');
  setupBasemap(map, bounds, mode => {
    basemapMode = mode;
    $('basemap-status').textContent = statusBits();
    $('legend').hidden = !mode.startsWith('OFFLINE');
  });

  // Buildings → flat arrays; homes render inside the fire canvas (2× grid px,
  // mercator-correct sub-cell position, clamped so the saved-ring fits).
  const feats = buildingsFC.features, nB = feats.length;
  const cells = new Uint32Array(nB), states = new Uint8Array(nB);
  const hx = new Int32Array(nB), hy = new Int32Array(nB);
  const yN = merc(b.north), yS = merc(b.south);
  const W2 = cols * 2, H2 = rows * 2;
  feats.forEach((f, i) => {
    cells[i] = f.properties.row * cols + f.properties.col;
    const [lon, lat] = f.geometry.coordinates;
    const gx = ((lon - b.west) / (b.east - b.west)) * W2;
    const gy = ((yN - merc(lat)) / (yN - yS)) * H2;
    hx[i] = Math.min(W2 - 3, Math.max(1, Math.round(gx) - 1));
    hy[i] = Math.min(H2 - 3, Math.max(1, Math.round(gy) - 1));
  });
  $('homes-label').textContent = hasPlans ? 'Expected homes saved' : `Homes saved (of ${nB.toLocaleString()})`;

  const fire = new FireLayer(bounds, rows, cols, { pane: 'fire' }).addTo(map);
  fire.setHomes(hx, hy, states);
  // 6:30 AM is the Camp Fire's ignition time — Paradise-only until meta grows a field.
  const ignTime = meta.town.startsWith('Paradise') ? ' · 6:30 AM' : '';
  const histIgnLabel = `${meta.ignition.label.split(' (')[0]}${ignTime}`;
  const ignIcon = label => L.divIcon({
    className: 'ign', iconSize: [0, 0],
    html: `<span class="ign-dot"></span><span class="ign-label">${label}</span>`,
  });
  const ignMarker = L.marker([meta.ignition.lat, meta.ignition.lon], {
    interactive: false, keyboard: false, icon: ignIcon(histIgnLabel),
  }).addTo(map);

  // Breaks → cells; mask marks active break cells, edge bits their outward rim.
  let braster = rasterizeBreaks(model.breaksFC, meta);
  const breakMask = new Uint8Array(rows * cols);
  const breakEdge = new Uint8Array(rows * cols);   // bits: 1 N, 2 S, 4 W, 8 E
  fire.setBreaks(breakMask, braster.cellBreak, breakEdge);
  function rebuildBreakMask(stepIdx) {
    breakMask.fill(0); breakEdge.fill(0);
    for (const bk of braster.breaks) {
      if (bk.step <= stepIdx) for (const c of bk.cells) breakMask[c] = 1;
    }
    for (const bk of braster.breaks) {
      if (bk.step > stepIdx) continue;
      for (const c of bk.cells) {
        const r = (c / cols) | 0, cc = c % cols;
        let e = 0;
        if (r === 0 || !breakMask[c - cols]) e |= 1;
        if (r === rows - 1 || !breakMask[c + cols]) e |= 2;
        if (cc === 0 || !breakMask[c - 1]) e |= 4;
        if (cc === cols - 1 || !breakMask[c + 1]) e |= 8;
        breakEdge[c] = e;
      }
    }
  }

  // Grids: step 0 = baseline (uint16 from baseline.json); later steps decode their
  // uint8 bucket grids — or uint16 grids in the snap-budget fallback — on demand.
  const histBase = decodeGrid(baseline.arrival_min_b64, rows, cols);
  let baseGrid = histBase;
  const stepGrids = [];
  // What-if scenario: user-placed ignition and/or wind, simulated in the browser
  // (sim.js) against the shipped breaks. null = the historical, precomputed run.
  const sim = physics && window.FireSim ? new FireSim(physics) : null;
  const histIgnCell = sim ? sim.cellOf(physics.ignition_rc[0], physics.ignition_rc[1]) : -1;
  if (hasPlans && !sim) plans.historical = undefined;   // its grids need the browser sim
  let scenario = null;            // { cell, wind: {speed_mph, from_deg} }
  let scenGrids = [], scenStats = [];
  const firstHomeMin = grid => {
    let first = Infinity;
    for (let i = 0; i < nB; i++) { const a = grid[cells[i]]; if (a <= H && a < first) first = a; }
    return first;
  };
  const gridForStep = s => {
    if (scenario) {
      if (s === 0) return baseGrid;
      if (scenGrids[s]) return scenGrids[s];
      const g = scenGrids[s] = sim.toU16(sim.run(scenario.cell, breakMask));
      let saved = 0;
      for (let i = 0; i < nB; i++) {
        const bb = baseGrid[cells[i]], cb = g[cells[i]];
        if (bb <= H && cb > H) saved++;
      }
      const f0 = firstHomeMin(baseGrid), f1 = firstHomeMin(g);
      scenStats[s] = { saved, minutesBought: f0 === Infinity ? null : Math.min(f1, H) - f0 };
      return g;
    }
    if (s === 0) return baseGrid;
    if (stepGrids[s]) return stepGrids[s];
    const st = model.steps[s];
    if (st.live) {   // plan shipped without grids: historical fire, simulated here
      sim.setWind(meta.wind.speed_mph, meta.wind.from_deg);
      return (stepGrids[s] = sim.toU16(sim.run(histIgnCell, breakMask)));
    }
    return (stepGrids[s] = st.b64u8
      ? decodeStepGrid(st.b64u8, rows, cols, 5, 255)
      : decodeGrid(st.b64u16, rows, cols));
  };
  // Per-step numbers: the solver's (historical run) or the live scenario's.
  const stepInfo = s => {
    const st = model.steps[s];
    const expected = model.expected ? model.expected[s] : null;
    if (!scenario) return Object.assign({}, st, { expected });
    const sc = s === 0 ? { saved: 0, minutesBought: 0 } : scenStats[s];
    return { cost: st.cost, breakCount: st.breakCount, saved: sc.saved, minutesBought: sc.minutesBought, expected };
  };
  const curvePoints = () => model.steps.slice(1).map((st, i) => ({
    cumulative_cost: st.cost, cumulative_saved: model.expected ? Math.round(model.expected[i + 1]) : st.saved,
  }));
  const stepForBudget = v => {
    let s = 0;
    for (let i = 0; i < model.steps.length; i++) {
      if (model.steps[i].cost <= v) s = i; else break;
    }
    return s;
  };

  let chart = buildCurve(curvePoints());
  const waffle = buildWaffle(nB);
  const audio = makeAudio();
  const state = { t: 0, budget: 0, step: 0, arrival: baseGrid };
  let maxFresh = 1;
  let flow = 'armed';   // walkthrough state (see setWalk)
  let lastCounts = { hit: 0, saved: 0 };

  const fmtInt = n => n.toLocaleString();
  function updateStats() {
    const st = stepInfo(state.step);
    const mb = st.minutesBought == null ? '—' : `+${Math.round(st.minutesBought)}`;
    if (st.expected != null) {
      setNum($('stat-saved'), Math.round(st.expected), fmtInt);
      $('stat-sub').textContent = `on average, across ${nScenarios} plausible fires · of ${nB.toLocaleString()} homes`;
      $('stat-line').textContent =
        `${scenario ? 'This fire' : 'The historical fire'}: ${st.saved.toLocaleString()} saved · ${mb} min evacuation · ${fmtMoney(st.cost)} spent`;
    } else {
      setNum($('stat-saved'), lastCounts.saved, fmtInt);
      $('stat-sub').textContent = '';
      $('stat-line').textContent = `Spent ${fmtMoney(st.cost)} · ${mb} min evacuation`;
    }
  }

  function render() {
    const { t, arrival } = state;
    let hit = 0, saved = 0;
    for (let i = 0; i < nB; i++) {
      const cb = arrival[cells[i]], bb = baseGrid[cells[i]];
      if (cb <= t) { states[i] = 1; hit++; }                    // burned — stays red
      else if (bb <= H && cb > H) {                             // saved by breaks
        states[i] = 2;
        if (bb <= t) saved++;   // counts up as the baseline front would pass it
      } else states[i] = 0;                                     // standing
    }
    lastCounts = { hit, saved };
    const fresh = fire.draw(arrival, t);
    maxFresh = Math.max(maxFresh, fresh);
    audio.setLevel(fresh / maxFresh);
    waffle.draw(hit, saved);
    updateStats();
    $('time-label').textContent = fmtTime(t);
  }

  function updateReadout() {
    const st = stepInfo(state.step);
    const mb = st.minutesBought == null ? '—' : Math.round(st.minutesBought);
    $('budget-value').textContent = fmtM2(state.budget);
    $('budget-readout').textContent =
      `${st.breakCount} break${st.breakCount === 1 ? '' : 's'} · ${fmtMoney(st.cost)} spent · ` +
      `${st.saved.toLocaleString()} homes saved · ${mb} min bought`;
  }

  function setBudgetValue(v, force) {
    state.budget = v;
    const s = stepForBudget(v);
    if (s !== state.step || force) {
      state.step = s;
      rebuildBreakMask(s);
      state.arrival = gridForStep(s);
      const st = stepInfo(s);
      const y = st.expected != null ? Math.round(st.expected) : st.saved;
      chart.mark(st.cost, y,
        s > 0 ? `${fmtMoney(st.cost)} saves ${y.toLocaleString()} homes${st.expected != null ? ' on average' : ''}`
              : '$0 saves 0 homes — move the budget slider');
      render();
    }
    updateReadout();
    // first drag in the pick state reveals the replay button
    if (flow === 'pick' && state.budget > 0 && capBtn.hidden) {
      capBtn.hidden = false;
      capBtn.textContent = 'Run it again →';
    }
  }

  // Controls — continuous budget slider (maps to the last step ≤ budget).
  const budgetEl = $('budget'), timeEl = $('time'), playEl = $('play');
  budgetEl.max = String(maxBudget);
  budgetEl.step = '10000';
  $('budget-ticks').innerHTML = [0, ...meta.budgets].map(v =>
    `<span style="left:${(v / maxBudget) * 100}%">${v ? fmtMoney(v) : ''}</span>`).join('');
  let budgetRaf = 0;
  budgetEl.oninput = () => {
    if (!budgetRaf) {
      budgetRaf = requestAnimationFrame(() => {
        budgetRaf = 0;
        setBudgetValue(Number(budgetEl.value));
      });
    }
  };

  timeEl.max = String(H);
  timeEl.oninput = () => {
    state.t = Number(timeEl.value);
    render();
    if (state.t >= H) { if (timer) stopPlay(); onRunEnd(); }
  };

  const TICK_MS = 20000 / (H / 5);   // full sweep ≈ 20 s
  let timer = null;
  function stopPlay() {
    clearInterval(timer); timer = null;
    playEl.innerHTML = '&#9654;&#xFE0E;'; playEl.setAttribute('aria-label', 'Play');
    audio.setLevel(0);
  }
  function startPlay() {
    if (timer) return;
    if (state.t >= H) { state.t = 0; timeEl.value = '0'; render(); }
    playEl.innerHTML = '&#10074;&#10074;'; playEl.setAttribute('aria-label', 'Pause');
    timer = setInterval(() => {
      state.t = Math.min(state.t + 5, H);
      timeEl.value = String(state.t);
      render();
      if (state.t >= H) { stopPlay(); onRunEnd(); }
    }, TICK_MS);
  }
  playEl.onclick = () => (timer ? stopPlay() : startPlay());
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !/^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(e.target.tagName)) {
      e.preventDefault(); playEl.click();
    }
  });

  // Sound toggle — never throws; first click may lazily create the context.
  const soundEl = $('sound');
  const soundLabel = () =>
    { soundEl.textContent = audio.isActive() && !audio.isMuted() ? 'Sound on' : 'Sound off'; };
  soundEl.onclick = () => {
    if (!audio.isActive()) audio.start(); else audio.toggleMute();
    soundLabel();
  };

  // --- walkthrough: armed → burn0 → pick → burn1 → done, plus free play.
  // Every state has a caption saying what is happening and what to do next. ---
  let ghost = null;
  function showGhost(on) {
    if (on && !ghost) {
      ghost = new GhostLayer(bounds, rows, cols, boundaryRuns(baseGrid, rows, cols, H), { pane: 'fire' });
    }
    if (on && !map.hasLayer(ghost)) ghost.addTo(map);
    if (!on && ghost && map.hasLayer(ghost)) map.removeLayer(ghost);
  }
  function dropGhost() {
    if (ghost && map.hasLayer(ghost)) map.removeLayer(ghost);
    ghost = null;
  }
  const capEl = $('caption'), capText = $('caption-text'), capBtn = $('caption-btn');
  const arrowEl = $('point-arrow');
  const townName = meta.town.split(',')[0];
  const openerLine = meta.town.startsWith('Paradise')
    ? 'Paradise, California. 6:30 AM, November 8, 2018. The Camp Fire started here.'
    : meta.story;
  function setCaption(text, btn) {
    capEl.hidden = !text;
    capText.textContent = text || '';
    capBtn.hidden = !btn;
    if (btn) capBtn.textContent = btn;
  }
  function pointAtBudget(on) {
    arrowEl.hidden = !on;
    if (on) {
      const r = $('budget-block').getBoundingClientRect();
      arrowEl.style.top = `${r.top + 26}px`;
    }
  }
  function setWalk(f) {
    flow = f;
    document.body.dataset.flow = f;
    showGhost(f === 'burn1' || f === 'done' || (f === 'scenario' && state.step > 0));
    pointAtBudget(f === 'pick');
    if (f === 'armed') setCaption(openerLine, 'Watch it happen →');
    if (f === 'burn0') setCaption('The fire spreads southwest with the wind — 12 hours in 20 seconds. Every red square is a home burning.', null);
    if (f === 'pick') setCaption(
      `${lastCounts.hit.toLocaleString()} of ${nB.toLocaleString()} homes gone. ` +
      `Now give ${townName} a budget for fuel breaks — drag the slider.`, null);
    if (f === 'burn1') setCaption('Same fire. Your fuel breaks are the pale strips of cleared ground.', null);
    if (f === 'scenario') setCaption(scenarioLine(), 'Run the fire →');
    if (f === 'done') {
      const st = stepInfo(state.step);
      const mb = st.minutesBought == null ? '—' : Math.round(st.minutesBought);
      setCaption(`${fmtMoney(st.cost)} · ${lastCounts.saved.toLocaleString()} homes saved · ` +
        `${mb} minutes of evacuation time bought.`, 'Try another budget');
    }
    if (f === 'free') setCaption(null, null);
    updateStats();
  }
  function onRunEnd() {
    if (flow === 'burn0') setWalk('pick');
    else if (flow === 'burn1') setWalk('done');
    else if (flow === 'scenario') {
      const st = stepInfo(state.step);
      const mb = st.minutesBought == null ? '—' : Math.round(st.minutesBought);
      setCaption(`${lastCounts.hit.toLocaleString()} of ${nB.toLocaleString()} homes hit. ` +
        (state.step > 0 ? `The ${fmtMoney(st.cost)} plan saved ${lastCounts.saved.toLocaleString()} here and bought ${mb} minutes.`
                        : 'Drag the budget slider to see what the breaks do to this fire.'), 'Run it again →');
    }
  }
  capBtn.onclick = e => {
    e.stopPropagation();
    if (flow === 'scenario') { state.t = 0; timeEl.value = '0'; render(); startPlay(); return; }
    if (flow === 'armed') { setWalk('burn0'); startPlay(); }
    else if (flow === 'pick') { setWalk('burn1'); state.t = 0; timeEl.value = '0'; render(); startPlay(); }
    else if (flow === 'done') { setWalk('pick'); setCaption(
      `Drag the budget slider, then run it again.`, 'Run it again →'); }
  };
  $('caption-skip').onclick = e => { e.stopPropagation(); setWalk('free'); };

  // --- what-if: click-to-ignite + wind sliders, simulated live via sim.js ---
  const igniteBtn = $('ignite-btn'), resetBtn = $('scenario-reset');
  const wsEl = $('wind-speed'), wdEl = $('wind-dir');
  let picking = false;
  function scenarioLine() {
    const where = scenario && scenario.cell !== histIgnCell ? 'your ignition point' : meta.ignition.label.split(' (')[0];
    return `A fire from ${where}, wind ${wind.speed_mph} mph from the ${compass(wind.from_deg)}. ` +
      (planId === 'historical' ? 'Breaks are the ones bought for the historical fire at this budget.'
                                : 'Breaks are the ones bought for any plausible fire at this budget.');
  }
  const isHistWind = () => wind.speed_mph === meta.wind.speed_mph && wind.from_deg === meta.wind.from_deg;
  function windLabels() {
    $('wind-speed-label').textContent = `${wind.speed_mph} mph`;
    $('wind-dir-label').textContent = `${wind.from_deg}° ${compass(wind.from_deg)}`;
    $('basemap-status').textContent = statusBits();
  }
  function setPicking(on) {
    picking = on;
    document.body.classList.toggle('picking', on);
    igniteBtn.textContent = on ? 'Click the map…' : 'Start your own fire';
  }
  function applyScenario() {
    if (timer) stopPlay();
    sim.setWind(wind.speed_mph, wind.from_deg);
    baseGrid = sim.toU16(sim.run(scenario.cell, null));
    scenGrids = []; scenStats = [];
    dropGhost();
    const [r, c] = [Math.floor(scenario.cell / cols), scenario.cell % cols];
    const lat = Math.atan(Math.sinh(yN - ((r + 0.5) / rows) * (yN - yS))) * 180 / Math.PI;
    const lon = b.west + ((c + 0.5) / cols) * (b.east - b.west);
    ignMarker.setLatLng(scenario.cell === histIgnCell ? [meta.ignition.lat, meta.ignition.lon] : [lat, lon]);
    ignMarker.setIcon(ignIcon(scenario.cell === histIgnCell ? histIgnLabel : 'your ignition'));
    $('scenario-value').textContent = scenario.cell === histIgnCell ? 'Historical ignition, your wind' : 'Your fire';
    resetBtn.hidden = false;
    windLabels();
    state.t = 0; timeEl.value = '0';
    setBudgetValue(state.budget, true);
    setWalk('scenario');
  }
  function resetScenario() {
    if (timer) stopPlay();
    scenario = null; scenGrids = []; scenStats = [];
    wind = { speed_mph: meta.wind.speed_mph, from_deg: meta.wind.from_deg };
    wsEl.value = String(wind.speed_mph); wdEl.value = String(wind.from_deg);
    baseGrid = histBase;
    dropGhost();
    ignMarker.setLatLng([meta.ignition.lat, meta.ignition.lon]);
    ignMarker.setIcon(ignIcon(histIgnLabel));
    $('scenario-value').textContent = 'Historical fire';
    resetBtn.hidden = true;
    setPicking(false);
    windLabels();
    state.t = 0; timeEl.value = '0';
    setBudgetValue(state.budget, true);
    setWalk('free');
  }
  // Nearest burnable cell within a few cells of (r, c), or -1 (water, bare rock).
  function snapIgnition(r, c) {
    for (let rad = 0; rad <= 6; rad++) {
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        if (sim.base[rr * cols + cc] > 0) return rr * cols + cc;
      }
    }
    return -1;
  }
  if (sim) {
    $('scenario-block').hidden = false;
    wsEl.value = String(wind.speed_mph); wdEl.value = String(wind.from_deg);
    windLabels();
    igniteBtn.onclick = () => setPicking(!picking);
    resetBtn.onclick = resetScenario;
    map.on('click', e => {
      // once the story is over, any click in the region ignites; during the
      // story the button (or picking mode) is still required
      const storyOver = flow === 'done' || flow === 'free' || flow === 'scenario';
      if (!picking && !storyOver) return;
      const fyF = (yN - merc(e.latlng.lat)) / (yN - yS);
      const fxF = (e.latlng.lng - b.west) / (b.east - b.west);
      if (fxF < 0 || fxF >= 1 || fyF < 0 || fyF >= 1) return;
      const cell = snapIgnition(Math.floor(fyF * rows), Math.floor(fxF * cols));
      if (cell < 0) { setCaption('Nothing to burn there — try a spot with fuel.', null); return; }
      setPicking(false);
      scenario = { cell, wind };
      applyScenario();
    });
    let windRaf = 0;
    const onWind = () => {
      wind = { speed_mph: Number(wsEl.value), from_deg: Number(wdEl.value) };
      windLabels();
      if (!scenario && isHistWind()) return;
      if (!windRaf) windRaf = requestAnimationFrame(() => {
        windRaf = 0;
        if (!scenario) scenario = { cell: histIgnCell, wind };
        scenario.wind = wind;
        applyScenario();
      });
    };
    wsEl.oninput = onWind; wdEl.oninput = onWind;
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && picking) setPicking(false); });
  }

  // --- plan toggle: robust (default) vs historical-only breaks ---
  const savedByStep = () => model.steps.map((st, i) =>
    i === 0 ? 0 : Math.round((model.expected ? model.expected[i] - model.expected[i - 1]
                                             : st.saved - model.steps[i - 1].saved)));
  let stepSaved = savedByStep();
  function setPlan(id) {
    if (!plans[id] || id === planId) return;
    if (timer) stopPlay();
    planId = id; model = plans[id];
    braster = rasterizeBreaks(model.breaksFC, meta);
    fire.setBreaks(breakMask, braster.cellBreak, breakEdge);
    stepGrids.length = 0; scenGrids = []; scenStats = [];
    chart = buildCurve(curvePoints());
    stepSaved = savedByStep();
    for (const btn of $('plan-toggle').children) {
      btn.setAttribute('aria-selected', String(btn.dataset.plan === id));
    }
    $('plan-note').textContent = planNotes[id];
    state.t = 0; timeEl.value = '0';
    setBudgetValue(state.budget, true);
    if (flow === 'done' || flow === 'burn1') {
      setWalk('pick');
      setCaption('Different breaks on the map now — run the fire again to see what they do.', 'Run it again →');
    }
  }
  if (hasPlans && plans.historical) {
    $('plan-block').hidden = false;
    $('plan-note').textContent = planNotes[planId];
    for (const btn of $('plan-toggle').children) btn.onclick = () => setPlan(btn.dataset.plan);
  }

  // --- break hover: cell → active break → green highlight + tooltip ---
  const tip = $('break-tip');
  let hoverBi = -1;
  map.on('mousemove', e => {
    const fyF = (yN - merc(e.latlng.lat)) / (yN - yS);
    const fxF = (e.latlng.lng - b.west) / (b.east - b.west);
    let bi = -1;
    if (fxF >= 0 && fxF < 1 && fyF >= 0 && fyF < 1) {
      const cell = Math.floor(fyF * rows) * cols + Math.floor(fxF * cols);
      const cand = braster.cellBreak[cell];
      if (cand >= 0 && braster.breaks[cand].step <= state.step) bi = cand;
    }
    if (bi !== hoverBi) {
      hoverBi = bi;
      fire.setHover(bi);
      fire.draw(state.arrival, state.t);
      tip.hidden = bi < 0;
    }
    if (bi >= 0) {
      const bk = braster.breaks[bi];
      tip.textContent =
        `Break ${bk.props.id} · #${bk.step} · ${fmtMoney(bk.props.cost)} · ` +
        `+${stepSaved[bk.step] ?? '—'} homes${model.expected ? ' on average' : ''}`;
      tip.style.left = `${e.containerPoint.x + 14}px`;
      tip.style.top = `${e.containerPoint.y + 14}px`;
    }
  });
  map.on('mouseout', () => {
    if (hoverBi >= 0) { hoverBi = -1; fire.setHover(-1); fire.draw(state.arrival, state.t); }
    tip.hidden = true;
  });

  // Intro: full-bleed title card over the undimmed, still map. Click anywhere skips.
  let startedApp = false;
  function startApp(withAudio) {
    if (startedApp) return;
    startedApp = true;
    if (withAudio) { audio.start(); soundLabel(); }
    document.body.classList.remove('intro');
    const intro = $('intro');
    intro.classList.add('gone');
    setTimeout(() => intro.remove(), 700);
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [10, 10] });
    setWalk('armed');   // walkthrough: fire waits for "Watch it happen →"
  }
  $('intro').addEventListener('click', () => startApp(true));

  setWalk('armed');
  setBudgetValue(0, true);
  soundLabel();
  if (SKIP_INTRO) startApp(false);
}

main().catch(err => {
  $('story').textContent = `FAILED to load web/${DATA_DIR}/ — ${err.message}`;
  const ir = $('intro-run');
  if (ir) ir.textContent = `FAILED: ${err.message}`;
  console.error(err);
});
