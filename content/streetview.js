// Runs in the page's MAIN world so it can reach RideWithGPS's MapLibre instance,
// which is not exposed globally but is held by a React component near the map element.
(() => {
  'use strict';

  if (window.__rwgpsStreetView) return;
  window.__rwgpsStreetView = true;

  const SNAP_PX = 30;        // clicks this close to the route snap onto it
  const STEP_M = 25;         // distance moved by the step buttons
  const BIG_STEP_M = 100;    // ...with Shift held
  const STORAGE_KEY = 'rwgps-sv-panel';

  const state = {
    map: null,
    mapEl: null,
    picking: false,
    point: null,           // { lat, lng, heading, along } — along is metres along the route, or null
    route: null,           // { coords: [[lng, lat]...], cum: [metres...] }
    ui: null,
  };

  // ---------- map discovery ----------

  const isMap = (o) =>
    o && typeof o === 'object' &&
    typeof o.unproject === 'function' &&
    typeof o.project === 'function' &&
    typeof o.getCanvas === 'function';

  function scan(value, depth, seen) {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return null;
    seen.add(value);
    if (isMap(value)) return value;
    if (value instanceof Node) return null;
    let keys;
    try { keys = Object.keys(value); } catch { return null; }
    for (const key of keys.slice(0, 60)) {
      if (key === '_owner' || key === 'return' || key === 'child' || key === 'sibling' || key === 'alternate') continue;
      let found = null;
      try { found = scan(value[key], depth + 1, seen); } catch { /* getters can throw */ }
      if (found) return found;
    }
    return null;
  }

  function findMap(mapEl) {
    const fiberKey = Object.keys(mapEl).find((k) => k.startsWith('__reactFiber'));
    let fiber = fiberKey && mapEl[fiberKey];
    for (let hops = 0; fiber && hops < 15; hops++, fiber = fiber.return) {
      const seen = new Set();
      const sn = fiber.stateNode instanceof Node ? null : fiber.stateNode;
      const found = scan(sn, 0, seen) || scan(fiber.memoizedProps, 0, seen) || scanHooks(fiber.memoizedState, seen);
      if (found && found.getContainer() === mapEl) return found;
    }
    return null;
  }

  function scanHooks(hook, seen) {
    for (let i = 0; hook && i < 40; i++, hook = hook.next) {
      const found = scan(hook.memoizedState, 0, seen);
      if (found) return found;
    }
    return null;
  }

  // ---------- geometry ----------

  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function distance([lng1, lat1], [lng2, lat2]) {
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function bearing([lng1, lat1], [lng2, lat2]) {
    const y = Math.sin(rad(lng2 - lng1)) * Math.cos(rad(lat2));
    const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
      Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lng2 - lng1));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  // ---------- route extraction ----------

  function sourceData(source) {
    let data = null;
    try { data = source.serialize().data; } catch { /* not a serializable source */ }
    if (!data) data = source._data;
    if (data && data.geojson) data = data.geojson;
    return typeof data === 'object' ? data : null;
  }

  function lineStrings(geojson) {
    const out = [];
    const visit = (g, props) => {
      if (!g) return;
      if (g.type === 'FeatureCollection') g.features.forEach((f) => visit(f, f.properties));
      else if (g.type === 'Feature') visit(g.geometry, g.properties);
      else if (g.type === 'LineString') out.push({ coords: g.coordinates, props: props || {} });
      else if (g.type === 'MultiLineString') g.coordinates.forEach((c) => out.push({ coords: c, props: props || {} }));
    };
    visit(geojson);
    return out;
  }

  function readRoute() {
    const map = state.map;
    const style = map && map.getStyle();
    if (!style) return null;
    const candidates = [];
    for (const [id, spec] of Object.entries(style.sources)) {
      if (spec.type !== 'geojson') continue;
      const data = sourceData(map.getSource(id));
      if (data) candidates.push(...lineStrings(data));
    }
    if (!candidates.length) return null;
    // RideWithGPS tags the full route line with subset "overall"; otherwise take the longest line.
    const overall = candidates.filter((c) => c.props.subset === 'overall');
    const pool = overall.length ? overall : candidates;
    const coords = pool.reduce((a, b) => (b.coords.length > a.coords.length ? b : a)).coords;
    if (coords.length < 2) return null;
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]));
    return { coords, cum };
  }

  // Position and direction of travel at a given distance along the route.
  function pointAlong(route, along) {
    const { coords, cum } = route;
    const total = cum[cum.length - 1];
    along = Math.max(0, Math.min(total, along));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < along) i++;
    const segLen = cum[i] - cum[i - 1];
    const t = segLen > 0 ? (along - cum[i - 1]) / segLen : 0;
    const [a, b] = [coords[i - 1], coords[i]];
    return {
      lng: a[0] + (b[0] - a[0]) * t,
      lat: a[1] + (b[1] - a[1]) * t,
      heading: bearing(a, b),
      along,
    };
  }

  // Nearest point on the route to a screen point, measured in screen pixels.
  function snapToRoute(route, screen) {
    const map = state.map;
    let best = null;
    let prev = map.project(route.coords[0]);
    for (let i = 1; i < route.coords.length; i++) {
      const cur = map.project(route.coords[i]);
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((screen.x - prev.x) * dx + (screen.y - prev.y) * dy) / len2)) : 0;
      const px = prev.x + dx * t;
      const py = prev.y + dy * t;
      const d = Math.hypot(screen.x - px, screen.y - py);
      if (!best || d < best.d) best = { d, i, t };
      prev = cur;
    }
    if (!best || best.d > SNAP_PX) return null;
    const along = route.cum[best.i - 1] + (route.cum[best.i] - route.cum[best.i - 1]) * best.t;
    return pointAlong(route, along);
  }

  // ---------- UI ----------

  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    children.forEach((c) => node.appendChild(c));
    return node;
  };

  function buildUI() {
    const toggle = el('button', {
      type: 'button',
      class: 'rwsv-toggle',
      title: 'Street View: click the map to preview a point (Alt+click works any time)',
      onclick: () => setPicking(!state.picking),
    });
    toggle.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="5" r="3" fill="currentColor"/>' +
      '<path d="M8 10h8l-1 7h-2l-1 5-1-5H9z" fill="currentColor"/></svg><span>Street View</span>';

    const marker = el('div', { class: 'rwsv-marker' }, [el('div', { class: 'rwsv-marker-arrow' }), el('div', { class: 'rwsv-marker-dot' })]);

    const coordsLabel = el('span', { class: 'rwsv-coords' });
    const iframe = el('iframe', { class: 'rwsv-frame', allowfullscreen: '', referrerpolicy: 'no-referrer-when-downgrade' });
    const empty = el('div', { class: 'rwsv-empty', text: 'Click the map to choose a point.' });
    const stepButtons = [];
    const btn = (label, title, onclick, opts = {}) => {
      const b = el('button', { type: 'button', class: 'rwsv-btn', title, onclick, text: label });
      if (opts.step) stepButtons.push(b);
      return b;
    };
    const openLink = el('a', { class: 'rwsv-btn', target: '_blank', rel: 'noopener', title: 'Open in Google Maps', text: '↗' });

    const header = el('div', { class: 'rwsv-header' }, [
      el('strong', { text: 'Street View' }),
      coordsLabel,
      el('span', { class: 'rwsv-spacer' }),
      btn('◀', `Back ${STEP_M} m along route (Shift: ${BIG_STEP_M} m)`, (e) => step(e.shiftKey ? -BIG_STEP_M : -STEP_M), { step: true }),
      btn('▶', `Forward ${STEP_M} m along route (Shift: ${BIG_STEP_M} m)`, (e) => step(e.shiftKey ? BIG_STEP_M : STEP_M), { step: true }),
      btn('⇅', 'Look the other way', () => turnAround()),
      openLink,
      btn('✕', 'Close', () => closePanel()),
    ]);
    const panel = el('div', { class: 'rwsv-panel', hidden: '' }, [header, el('div', { class: 'rwsv-body' }, [empty, iframe])]);
    makeDraggable(panel, header);
    restorePanelGeometry(panel);
    new ResizeObserver(() => savePanelGeometry(panel)).observe(panel);

    document.body.appendChild(panel);
    return { toggle, marker, panel, iframe, empty, coordsLabel, openLink, stepButtons };
  }

  function makeDraggable(panel, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, a')) return;
      const rect = panel.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - offX))}px`;
        panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY))}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        savePanelGeometry(panel);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  function savePanelGeometry(panel) {
    if (panel.hidden) return;
    const { left, top, width, height } = panel.getBoundingClientRect();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, top, width, height })); } catch { /* storage blocked */ }
  }

  function restorePanelGeometry(panel) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { /* storage blocked */ }
    if (!saved) return;
    const width = Math.min(saved.width, window.innerWidth);
    const height = Math.min(saved.height, window.innerHeight);
    Object.assign(panel.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${Math.max(0, Math.min(window.innerWidth - width, saved.left))}px`,
      top: `${Math.max(0, Math.min(window.innerHeight - height, saved.top))}px`,
      right: 'auto',
      bottom: 'auto',
    });
  }

  // ---------- behaviour ----------

  function setPicking(on) {
    state.picking = on;
    state.ui.toggle.classList.toggle('rwsv-active', on);
    state.mapEl && state.mapEl.classList.toggle('rwsv-picking', on);
  }

  function pickAt(clientX, clientY) {
    const rect = state.map.getCanvas().getBoundingClientRect();
    const screen = { x: clientX - rect.left, y: clientY - rect.top };
    state.route = readRoute();
    const snapped = state.route && snapToRoute(state.route, screen);
    if (snapped) {
      showPoint(snapped);
    } else {
      const { lng, lat } = state.map.unproject([screen.x, screen.y]);
      showPoint({ lat, lng, heading: state.map.getBearing(), along: null });
    }
  }

  function step(metres) {
    const p = state.point;
    if (!p || p.along == null) return;
    state.route = readRoute() || state.route;
    if (!state.route) return;
    const next = pointAlong(state.route, p.along + metres);
    // Keep facing the way the user was looking (forwards or backwards along the route).
    const turn = ((p.heading - next.heading + 540) % 360) - 180; // signed difference, -180..180
    if (Math.abs(turn) > 90) next.heading = (next.heading + 180) % 360;
    showPoint(next);
  }

  function turnAround() {
    if (!state.point) return;
    showPoint({ ...state.point, heading: (state.point.heading + 180) % 360 });
  }

  function showPoint(point) {
    state.point = point;
    const { ui } = state;
    const lat = point.lat.toFixed(6);
    const lng = point.lng.toFixed(6);
    const heading = Math.round(point.heading);
    ui.iframe.src = `https://maps.google.com/maps?layer=c&cbll=${lat},${lng}&cbp=11,${heading},0,0,0&output=svembed`;
    ui.openLink.href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}&heading=${heading}`;
    ui.coordsLabel.textContent = `${lat}, ${lng}`;
    ui.empty.hidden = true;
    ui.stepButtons.forEach((b) => { b.disabled = point.along == null; });
    ui.panel.hidden = false;
    positionMarker();
  }

  function closePanel() {
    state.point = null;
    state.ui.panel.hidden = true;
    state.ui.marker.style.display = 'none';
    setPicking(false);
  }

  function positionMarker() {
    const { marker } = state.ui;
    if (!state.point || !state.map) {
      marker.style.display = 'none';
      return;
    }
    const p = state.map.project([state.point.lng, state.point.lat]);
    marker.style.display = '';
    marker.style.transform = `translate(${p.x}px, ${p.y}px)`;
    marker.firstChild.style.transform = `rotate(${state.point.heading - state.map.getBearing()}deg)`;
  }

  // Intercept clicks on the map canvas before MapLibre/RideWithGPS see them, so a
  // Street View pick never adds a control point to the route.
  let pressed = null;
  function wantsPick(e) {
    if (!state.map || e.button !== 0) return false;
    const canvasContainer = state.map.getCanvasContainer();
    if (!canvasContainer.contains(e.target)) return false;
    return state.picking || e.altKey;
  }

  function onDown(e) {
    if (!wantsPick(e)) return;
    pressed = { x: e.clientX, y: e.clientY };
    e.stopPropagation();
    e.preventDefault();
  }

  // Swallows the rest of the press (pointerup, click, dblclick); the pick happens on pointerup.
  // preventDefault on pointerdown already stops the browser sending mousedown/mouseup.
  function onUp(e) {
    if (!pressed) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.type !== 'pointerup') return;
    if (Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < 6) pickAt(e.clientX, e.clientY);
    // The click event follows pointerup before any timer runs, so it is still swallowed.
    setTimeout(() => { pressed = null; }, 0);
  }

  for (const type of ['pointerdown', 'mousedown']) window.addEventListener(type, onDown, true);
  for (const type of ['pointerup', 'mouseup', 'click', 'dblclick']) window.addEventListener(type, onUp, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.picking) setPicking(false);
  });

  // ---------- attach / re-attach (the planner is a single-page app) ----------

  function attach() {
    const mapEl = document.querySelector('.maplibregl-map');
    if (!mapEl || (mapEl === state.mapEl && state.map)) return;
    const map = findMap(mapEl);
    if (!map) return;

    state.mapEl = mapEl;
    state.map = map;
    state.route = null;
    if (!state.ui) state.ui = buildUI();

    mapEl.appendChild(state.ui.toggle);
    map.getCanvasContainer().appendChild(state.ui.marker);
    map.on('move', positionMarker);
    map.on('rotate', positionMarker);
    setPicking(state.picking);
    positionMarker();
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; attach(); }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  attach();
})();
