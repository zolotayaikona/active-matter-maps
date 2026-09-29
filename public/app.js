import { DiscordSDK } from "/vendor/embedded-app-sdk/index.mjs";

/* ------------------------------------------------------------------ *
 * Active Matter · Интерактивные карты (Discord Activity)
 * ------------------------------------------------------------------ */

const els = {
  maplist: document.getElementById("maplist"),
  layers: document.getElementById("layers"),
  search: document.getElementById("search"),
  results: document.getElementById("results"),
  viewport: document.getElementById("viewport"),
  world: document.getElementById("world"),
  image: document.getElementById("map-image"),
  markers: document.getElementById("markers"),
  canvas: document.getElementById("canvas"),
  zlabels: document.getElementById("zlabels"),
  pinlayer: document.getElementById("pinlayer"),
  hitlayer: document.getElementById("hitlayer"),
  cursors: document.getElementById("cursors"),
  tooltip: document.getElementById("tooltip"),
  popup: document.getElementById("popup"),
  loading: document.getElementById("loading"),
  readout: document.getElementById("coord-readout"),
  toast: document.getElementById("toast"),
  user: document.getElementById("user"),
  userAvatar: document.getElementById("user-avatar"),
  userName: document.getElementById("user-name"),
  peersPanel: document.getElementById("peers-panel"),
  peers: document.getElementById("peers"),
  peerCount: document.getElementById("peer-count"),
  mapCount: document.getElementById("map-count"),
  filtersPanel: document.getElementById("filters-panel"),
  filterLocation: document.getElementById("filter-location"),
  filterMod: document.getElementById("filter-mod"),
  sidebar: document.getElementById("sidebar"),
  menuBtn: document.getElementById("menu-btn"),
};

const view = { scale: 1, tx: 0, ty: 0, fit: 1, min: 0.1, max: 8 };
let currentMap = null;
let worldW = 0;
let worldH = 0;
let pendingSelect = null;
let selected = null;
let popupAnchor = null;
let currentUser = { name: "Гость", avatar: "", color: colorFor("guest") };
const activeCats = new Set();
let filterLocation = "";
let filterMod = "";

/* per-map prepared data */
let catById = new Map();
let markerList = [];      // { id, x, y, color, m } in world pixels
let renderMarkers = [];   // subset passing layer + filters
let renderZones = [];     // subset passing layer + filters
let selectedEntry = null;
let hoverEntry = null;
let lastPointer = null;   // viewport-relative {x,y}, for hover detection
let lastReadout = "";
let popupSize = null;     // cached popup size, avoids per-frame reflow

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SITE = "https://activematterhelp.ru";

function colorFor(seed) {
  const palette = ["#7289da", "#43b581", "#faa61a", "#eb459e", "#fa005a", "#00b0f4", "#f04747", "#9b59b6"];
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function avatarUrl(user) {
  if (!user) return "";
  if (user.avatarUrl) return user.avatarUrl;
  if (user.id && user.avatar) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=64`;
  }
  if (user.id) {
    const idx = Number((BigInt(user.id) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }
  return "";
}

let toastTimer;
function toast(msg, ms = 4200) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

/* ------------------------------------------------------------------ *
 * Viewer: pan / zoom
 * ------------------------------------------------------------------ */
const ctx = els.canvas.getContext("2d", { alpha: true });
let dpr = 1;
let canvasW = 0;
let canvasH = 0;
let rafPending = false;
let benchDrawn = 0;
const zoneLabelEls = [];

/* Offscreen layer with a margin: panning just blits the cached vectors
 * instead of re-rasterising thousands of markers every frame. */
const LAYER_MARGIN = 320;
const layerCanvas = document.createElement("canvas");
const lctx = layerCanvas.getContext("2d", { alpha: true });
const layerView = { scale: 0, tx: 0, ty: 0 };
let layerReady = false;

function invalidateLayer() {
  layerReady = false;
}

let vpRect = { left: 0, top: 0, width: 0, height: 0 };
function measureViewport() {
  const r = els.viewport.getBoundingClientRect();
  vpRect = { left: r.left, top: r.top, width: r.width, height: r.height };
}
/* Cached rect: reading getBoundingClientRect on every pointer move forces layout. */
function viewportRect() {
  return vpRect;
}

function resizeCanvas() {
  const r = viewportRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvasW = Math.max(1, Math.round(r.width));
  canvasH = Math.max(1, Math.round(r.height));
  els.canvas.width = Math.round(canvasW * dpr);
  els.canvas.height = Math.round(canvasH * dpr);
  layerCanvas.width = Math.round((canvasW + 2 * LAYER_MARGIN) * dpr);
  layerCanvas.height = Math.round((canvasH + 2 * LAYER_MARGIN) * dpr);
  invalidateLayer();
}

function screenX(wx) {
  return wx * view.scale + view.tx;
}
function screenY(wy) {
  return wy * view.scale + view.ty;
}

/* marker size on screen, growing with zoom */
function screenDotSize(scale) {
  const rel = scale / (view.fit || scale);
  return clamp(4 + rel * 2.2, 4, 13);
}

/* Draw zones + markers into a 2D context. `margin` expands the cull area. */
function paintVectors(g, margin) {
  els.zlabels.classList.toggle("show", view.scale > (view.fit || 1) * 1.6);

  const wx0 = (-view.tx - margin) / view.scale;
  const wy0 = (-view.ty - margin) / view.scale;
  const wx1 = (canvasW + margin - view.tx) / view.scale;
  const wy1 = (canvasH + margin - view.ty) / view.scale;

  // zones: build one Path2D per colour, culled by world bbox
  g.lineWidth = 1.5;
  const zonePaths = new Map();
  for (const z of renderZones) {
    const b = z.bbox;
    if (b && (b[2] < wx0 || b[0] > wx1 || b[3] < wy0 || b[1] > wy1)) continue;
    const color = z.kind === "monster" ? "#ef4444" : "#f59e0b";
    let path = zonePaths.get(color);
    if (!path) {
      path = new Path2D();
      zonePaths.set(color, path);
    }
    const pts = z.points;
    for (let i = 0; i < pts.length; i++) {
      const x = screenX(pts[i][0]);
      const y = screenY(pts[i][1]);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    path.closePath();
  }
  for (const [color, path] of zonePaths) {
    g.fillStyle = color + "1f";
    g.fill(path);
    g.strokeStyle = color;
    g.stroke(path);
  }

  // markers: dots in screen space, batched by colour
  const size = screenDotSize(view.scale);
  const r = size / 2;
  const pad = size + 2;
  const small = size <= 7;
  const withSymbols = size >= 11;
  const visible = withSymbols ? [] : null;
  const buckets = new Map();
  for (const e of renderMarkers) {
    const x = e.x * view.scale + view.tx;
    const y = e.y * view.scale + view.ty;
    if (x < -margin - pad || x > canvasW + margin + pad || y < -margin - pad || y > canvasH + margin + pad) continue;
    let arr = buckets.get(e.color);
    if (!arr) {
      arr = [];
      buckets.set(e.color, arr);
    }
    arr.push(x, y);
    if (visible) visible.push({ s: e.symbol, x, y });
    benchDrawn++;
  }
  for (const [color, pts] of buckets) {
    g.fillStyle = color;
    if (small) {
      // fast path: tiny dots as squares (visually indistinguishable at this size)
      for (let i = 0; i < pts.length; i += 2) {
        g.fillRect(pts[i] - r, pts[i + 1] - r, size, size);
      }
    } else {
      g.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        g.moveTo(pts[i] + r, pts[i + 1]);
        g.arc(pts[i], pts[i + 1], r, 0, Math.PI * 2);
      }
      g.fill();
    }
  }
  // category glyphs, only when zoomed in enough that they stay readable
  if (visible && visible.length <= 400) {
    g.font = `${Math.round(size * 0.62)}px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#fff";
    for (const it of visible) {
      if (it.s) g.fillText(it.s, it.x, it.y + 0.5);
    }
  }
}

function renderLayer() {
  benchDrawn = 0;
  lctx.setTransform(dpr, 0, 0, dpr, LAYER_MARGIN * dpr, LAYER_MARGIN * dpr);
  lctx.clearRect(-LAYER_MARGIN, -LAYER_MARGIN, canvasW + 2 * LAYER_MARGIN, canvasH + 2 * LAYER_MARGIN);
  paintVectors(lctx, LAYER_MARGIN);
  layerView.scale = view.scale;
  layerView.tx = view.tx;
  layerView.ty = view.ty;
  layerReady = true;
}

function renderCanvas() {
  if (!currentMap) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    return;
  }

  const sameScale = Math.abs(view.scale - layerView.scale) < 1e-6;
  const dx = view.tx - layerView.tx;
  const dy = view.ty - layerView.ty;
  if (!layerReady || !sameScale || Math.abs(dx) > LAYER_MARGIN || Math.abs(dy) > LAYER_MARGIN) {
    renderLayer();
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.drawImage(
    layerCanvas,
    view.tx - layerView.tx - LAYER_MARGIN,
    view.ty - layerView.ty - LAYER_MARGIN,
    canvasW + 2 * LAYER_MARGIN,
    canvasH + 2 * LAYER_MARGIN
  );

  const r = screenDotSize(view.scale) / 2;
  if (hoverEntry && hoverEntry !== selectedEntry) drawRing(hoverEntry.x, hoverEntry.y, r, hoverEntry.color, "hover");
  if (selectedEntry) drawRing(selectedEntry.x, selectedEntry.y, r, selectedEntry.color, "selected");
}

function drawRing(wx, wy, r, color, kind) {
  const x = wx * view.scale + view.tx;
  const y = wy * view.scale + view.ty;
  if (x < -20 || x > canvasW + 20 || y < -20 || y > canvasH + 20) return;
  ctx.beginPath();
  ctx.arc(x, y, r + 6, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = kind === "selected" ? 5 : 3;
  ctx.globalAlpha = kind === "selected" ? 0.45 : 0.35;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(x, y, r + 6, 0, Math.PI * 2);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function renderScreenOverlays() {
  if (!currentMap) return;
  const showZones = els.zlabels.classList.contains("show");
  // zone labels projected to screen; off-screen ones are clipped by overflow,
  // so only transforms are written (no display toggling -> fewer reflows)
  for (let i = 0; i < zoneLabelEls.length; i++) {
    const item = zoneLabelEls[i];
    if (item.hidden) continue;
    if (item.zone && !showZones) continue;
    const x = screenX(item.cx);
    const y = screenY(item.cy);
    item.el.style.transform = `translate(-50%, -50%) translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // hover tooltip
  const tip = els.tooltip;
  if (hoverEntry) {
    if (tip.hidden) tip.hidden = false;
    const label = hoverEntry.m.title || hoverEntry.m.name || "Точка";
    if (tip.textContent !== label) tip.textContent = label;
    const x = screenX(hoverEntry.x);
    const y = screenY(hoverEntry.y);
    tip.style.transform = `translate(-50%, -100%) translate(${Math.round(x)}px, ${Math.round(y - 12)}px)`;
  } else if (!tip.hidden) {
    tip.hidden = true;
  }
}

function flush() {
  rafPending = false;
  const { scale, tx, ty } = view;
  els.world.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  renderCanvas();
  renderScreenOverlays();
  if (popupAnchor) positionPopup();
  drawCursors();
}

/* Change the cursor over clickable markers. Runs on plain mouse moves only. */
function updateHover() {
  const hit = lastPointer ? markerAt(lastPointer.x, lastPointer.y) : null;
  if (hit === hoverEntry) return;
  hoverEntry = hit;
  els.viewport.classList.toggle("hovering", !!hit);
  applyTransform();
}

function scheduleFlush() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(flush);
}

function applyTransform() {
  scheduleFlush();
}

function clampView() {
  const r = viewportRect();
  const pad = 90;
  view.tx = clamp(view.tx, pad - worldW * view.scale, r.width - pad);
  view.ty = clamp(view.ty, pad - worldH * view.scale, r.height - pad);
}

function fitToView() {
  const r = viewportRect();
  if (!worldW || !worldH || r.width < 4 || r.height < 4) return;
  const s = Math.min(r.width / worldW, r.height / worldH) * 0.94;
  view.fit = s;
  view.min = s * 0.55;
  view.max = Math.max(s * 18, 6);
  view.scale = s;
  view.tx = (r.width - worldW * s) / 2;
  view.ty = (r.height - worldH * s) / 2;
  applyTransform();
}

function zoomAt(sx, sy, factor) {
  const next = clamp(view.scale * factor, view.min, view.max);
  const k = next / view.scale;
  view.tx = sx - (sx - view.tx) * k;
  view.ty = sy - (sy - view.ty) * k;
  view.scale = next;
  clampView();
  applyTransform();
}

/* Fit the camera to a rectangle in world pixels (used by location buttons). */
function fitRect(x0, y0, x1, y1, padFrac = 0.88) {
  const r = viewportRect();
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const s = Math.min(r.width / w, r.height / h) * padFrac;
  view.scale = clamp(s, view.min, view.max);
  view.tx = r.width / 2 - (x0 + w / 2) * view.scale;
  view.ty = r.height / 2 - (y0 + h / 2) * view.scale;
  clampView();
  applyTransform();
}

function focusLocation(loc) {
  if (loc && loc.focus && loc.focus.w > 0) {
    const f = loc.focus;
    fitRect(f.x, f.y, f.x + f.w, f.y + f.h);
  } else {
    fitToView();
  }
}

function flyTo(wx, wy, scale) {
  const r = viewportRect();
  view.scale = clamp(scale ?? view.fit * 4, view.min, view.max);
  view.tx = r.width / 2 - wx * view.scale;
  view.ty = r.height / 2 - wy * view.scale;
  clampView();
  applyTransform();
}

function applyZoomParam() {
  const p = new URLSearchParams(location.search);
  const zq = Number(p.get("z"));
  if (!(zq > 0) || !worldW) return;
  const r = viewportRect();
  const cx = 1 - (Number(p.get("cx")) || 0.5);
  const cy = 1 - (Number(p.get("cy")) || 0.5);
  view.scale = clamp(view.fit * zq, view.min, view.max);
  view.tx = r.width / 2 - worldW * cx * view.scale;
  view.ty = r.height / 2 - worldH * cy * view.scale;
  clampView();
  scheduleFlush();
}

/* pointer interactions */
const pointers = new Map();
let panStart = null;
let pinchStart = null;
let downInfo = null;

els.viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".spin")) return;
  try {
    els.viewport.setPointerCapture(e.pointerId);
  } catch {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  downInfo = { id: e.pointerId, x: e.clientX, y: e.clientY };

  if (pointers.size === 1) {
    panStart = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    els.viewport.classList.add("dragging");
  } else {
    panStart = null;
    downInfo = null;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: view.scale,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        tx: view.tx,
        ty: view.ty,
      };
    }
  }
});

els.viewport.addEventListener("pointermove", (e) => {
  const r = viewportRect();
  lastPointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  const p = pointers.get(e.pointerId);
  if (p) {
    p.x = e.clientX;
    p.y = e.clientY;
  }

  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const cx = (a.x + b.x) / 2 - r.left;
    const cy = (a.y + b.y) / 2 - r.top;
    const next = clamp(pinchStart.scale * (dist / pinchStart.dist), view.min, view.max);
    const k = next / pinchStart.scale;
    view.scale = next;
    view.tx = cx - (cx - pinchStart.tx) * k;
    view.ty = cy - (cy - pinchStart.ty) * k;
    clampView();
    applyTransform();
    return;
  }

  if (panStart && pointers.size === 1) {
    view.tx = panStart.tx + (e.clientX - panStart.x);
    view.ty = panStart.ty + (e.clientY - panStart.y);
    clampView();
    applyTransform();
  }

  updateReadout(e);
  sendCursor(e);
  if (pointers.size === 0) updateHover();
});

function endPointer(e) {
  try {
    if (els.viewport.hasPointerCapture?.(e.pointerId)) {
      els.viewport.releasePointerCapture(e.pointerId);
    }
  } catch {}
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    panStart = null;
    els.viewport.classList.remove("dragging");
  }
  if (pointers.size < 2) pinchStart = null;
}

/* tap / click: pick nearest marker, otherwise close the popup */
els.viewport.addEventListener("pointerup", (e) => {
  const info = downInfo && downInfo.id === e.pointerId ? downInfo : null;
  downInfo = null;
  endPointer(e);
  if (!info) return;
  const moved = Math.hypot(e.clientX - info.x, e.clientY - info.y);
  if (moved >= 6) return;
  const r = viewportRect();
  const hit = markerAt(e.clientX - r.left, e.clientY - r.top);
  if (hit) selectMarker(hit.id, false);
  else closePopup();
});
els.viewport.addEventListener("pointercancel", endPointer);
els.viewport.addEventListener("pointerleave", () => {
  lastPointer = null;
  lastReadout = "—";
  els.readout.textContent = "—";
  if (hoverEntry) {
    hoverEntry = null;
    els.viewport.classList.remove("hovering");
    applyTransform();
  }
});

els.viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const r = viewportRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
  },
  { passive: false }
);

els.viewport.addEventListener("dblclick", (e) => {
  if (e.target.closest(".pin")) return;
  const r = viewportRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, 1.8);
});

/* ------------------------------------------------------------------ *
 * Coordinate readout
 * ------------------------------------------------------------------ */
function updateReadout(e) {
  if (!currentMap) return;
  const r = viewportRect();
  const wx = (e.clientX - r.left - view.tx) / view.scale;
  const wy = (e.clientY - r.top - view.ty) / view.scale;
  const rx = worldW / currentMap.bounds[0];
  const ry = worldH / currentMap.bounds[1];
  const mx = Math.round(wx / rx);
  const my = Math.round((worldH - wy) / ry);
  let text = "—";
  if (mx >= 0 && my >= 0 && mx <= currentMap.bounds[0] && my <= currentMap.bounds[1]) {
    text = `${currentMap.name}  ·  x: ${mx}  y: ${my}`;
  }
  if (text !== lastReadout) {
    lastReadout = text;
    els.readout.textContent = text;
  }
}

/* ------------------------------------------------------------------ *
 * Markers
 * ------------------------------------------------------------------ */
function markerWorld(marker) {
  const rx = worldW / currentMap.bounds[0];
  const ry = worldH / currentMap.bounds[1];
  if (currentMap.origin === "bottom-left") {
    return { x: marker.x * rx, y: worldH - marker.y * ry };
  }
  return { x: marker.x * rx, y: marker.y * ry };
}

function categoryOf(map, id) {
  return map.categories.find((c) => c.id === id) || { name: "—", color: "#fa005a", symbol: "●" };
}

function passesFilters(item) {
  if (filterLocation && item.locationId !== filterLocation) return false;
  if (filterMod && item.mod && item.mod !== filterMod) return false;
  return true;
}

/* Convert and cache map data once, so the render loop only transforms numbers. */
function prepareMap() {
  selectedEntry = null;
  hoverEntry = null;
  lastPointer = null;
  els.viewport.classList.remove("hovering");
  catById = new Map();
  for (const c of currentMap.categories) catById.set(c.id, c);

  const rx = worldW / currentMap.bounds[0];
  const ry = worldH / currentMap.bounds[1];
  const bottom = currentMap.origin === "bottom-left";
  markerList = currentMap.markers.map((m) => {
    const cat = catById.get(m.categoryId);
    return {
      id: m.id,
      x: m.x * rx,
      y: bottom ? worldH - m.y * ry : m.y * ry,
      color: cat ? cat.color : "#fa005a",
      symbol: cat && cat.symbol ? cat.symbol : "",
      catId: m.categoryId,
      m,
    };
  });

  for (const z of currentMap.zones || []) {
    if (!z.points || !z.points.length) {
      z.bbox = null;
      continue;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of z.points) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    z.bbox = [minX, minY, maxX, maxY];
  }
}

/* Recompute the visible subsets whenever layers/filters change. */
function rebuildVisible() {
  renderMarkers = [];
  renderZones = [];
  const zoneGroups = new Set(currentMap.categories.map((c) => c.id));
  for (const e of markerList) {
    if (activeCats.has(e.m.categoryId) && passesFilters(e.m)) renderMarkers.push(e);
  }
  // Zones (building outlines / regions) are not tied to a location or mod:
  // like the source site, they stay visible and only depend on the layer toggle.
  for (const z of currentMap.zones || []) {
    const groupId = z.kind === "monster" ? "enemies" : "poi";
    if (zoneGroups.has(groupId) && !activeCats.has(groupId)) continue;
    renderZones.push(z);
  }
}

/* Nearest visible marker to a viewport-relative point (for tap / click). */
function markerAt(sx, sy) {
  const thresh = Math.max(11, screenDotSize(view.scale)) + 8;
  let best = null;
  let bestD = thresh * thresh;
  for (const e of renderMarkers) {
    const dx = e.x * view.scale + view.tx - sx;
    const dy = e.y * view.scale + view.ty - sy;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function buildZoneLabels() {
  els.zlabels.replaceChildren();
  zoneLabelEls.length = 0;
  if (!currentMap) return;
  for (const l of currentMap.labels || []) {
    const el = document.createElement("div");
    el.className = "zlabel location";
    el.textContent = l.name;
    els.zlabels.appendChild(el);
    zoneLabelEls.push({ el, cx: l.x, cy: l.y });
  }
  for (const z of currentMap.zones || []) {
    if (!z.name || !z.points.length) continue;
    const cx = z.points.reduce((s, p) => s + p[0], 0) / z.points.length;
    const cy = z.points.reduce((s, p) => s + p[1], 0) / z.points.length;
    const color = z.kind === "monster" ? "#ef4444" : "#f59e0b";
    const el = document.createElement("div");
    el.className = "zlabel";
    el.textContent = z.name;
    el.style.borderColor = color;
    els.zlabels.appendChild(el);
    zoneLabelEls.push({ el, cx, cy, zone: z });
  }
}

function renderAll() {
  rebuildVisible();
  buildZoneLabels();
  // hide labels that are filtered out
  for (const item of zoneLabelEls) {
    if (!item.zone) continue;
    const z = item.zone;
    const groupId = z.kind === "monster" ? "enemies" : "poi";
    item.hidden = currentMap.categories.some((c) => c.id === groupId) && !activeCats.has(groupId);
  }
  for (const item of zoneLabelEls) item.el.style.display = item.hidden ? "none" : "";
  invalidateLayer();
  scheduleFlush();
}

function selectMarker(id, center) {
  const entry = markerList.find((e) => e.id === id);
  const marker = entry ? entry.m : currentMap.markers.find((m) => m.id === id);
  if (!marker) return;
  selected = marker;
  selectedEntry = entry || null;
  const cat = categoryOf(currentMap, marker.categoryId);
  const w = markerWorld(marker);

  const links = [];
  const norm = normalizeLink(marker.link);
  if (norm) links.push(norm);
  if (marker.page) links.push({ url: marker.page, label: "Страница" });
  if (marker.video) links.push({ url: marker.video, label: "Видео" });
  if (marker.loot) links.push({ url: `${SITE}/loot/${marker.loot}`, label: "Что можно найти" });

  const modName = marker.mod ? currentMap.mods?.find((m) => m.id === marker.mod)?.name || marker.mod : "";

  openPopup({
    title: marker.title || marker.name || "Точка",
    subtitle: `${cat.symbol ? cat.symbol + " " : ""}${cat.name}`,
    color: cat.color,
    badge: modName,
    description: marker.description || "",
    image: marker.image || "",
    links,
    anchor: w,
    share: shareUrlFor(w.x, w.y, view.scale, marker.id),
  });
  if (center) flyTo(w.x, w.y, Math.max(view.scale, view.fit * 4));
}

function normalizeLink(link) {
  if (!link) return null;
  if (typeof link === "string") return { url: link, label: "Открыть" };
  if (link.url) return { url: link.url, label: link.label || "Открыть" };
  return null;
}

/* Build a deep link that restores the map, camera and optionally a marker. */
function shareUrlFor(wx, wy, scale, markerId) {
  const z = (scale || view.scale) / (view.fit || 1);
  const cx = 1 - wx / worldW;
  const cy = 1 - wy / worldH;
  const p = new URLSearchParams({
    map: currentMap.id,
    z: z.toFixed(3),
    cx: cx.toFixed(5),
    cy: cy.toFixed(5),
  });
  if (markerId) p.set("m", markerId);
  return `${location.origin}${location.pathname}?${p.toString()}`;
}

function shareCurrentView() {
  const r = viewportRect();
  const wx = (r.width / 2 - view.tx) / view.scale;
  const wy = (r.height / 2 - view.ty) / view.scale;
  copyText(shareUrlFor(wx, wy, view.scale, null), "Ссылка на вид скопирована");
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || "Скопировано");
  } catch {
    toast(text, 8000);
  }
}

function openZone(z) {
  const cx = z.points.reduce((s, p) => s + p[0], 0) / z.points.length;
  const cy = z.points.reduce((s, p) => s + p[1], 0) / z.points.length;
  openPopup({
    title: z.name || "Зона",
    subtitle: z.kind === "monster" ? "☠ Область монстров" : "◆ POI-район",
    color: z.kind === "monster" ? "#ef4444" : "#f59e0b",
    description: z.description || "",
    anchor: { x: cx, y: cy },
  });
}

function openPopup({ title, subtitle, color, badge, description, image, links, anchor, share }) {
  popupAnchor = anchor || null;
  els.popup.style.setProperty("--c", color || "var(--accent)");
  const img = image
    ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
    : "";
  const badgeHtml = badge ? `<div class="badge-line">Режим: ${escapeHtml(badge)}</div>` : "";
  const linksHtml = (links || [])
    .filter((l) => l && l.url)
    .map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer">${escapeHtml(l.label || "Открыть")}</a>`)
    .join("");
  els.popup.innerHTML = `
    <div class="bar"></div>
    <button class="close" title="Закрыть">✕</button>
    <div class="content">
      ${subtitle ? `<div class="cat">${escapeHtml(subtitle)}</div>` : ""}
      <h3>${escapeHtml(title)}</h3>
      ${badgeHtml}
      ${img}
      ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      ${linksHtml ? `<div class="links">${linksHtml}</div>` : ""}
      ${share ? `<button class="share">🔗 Скопировать ссылку</button>` : ""}
    </div>`;
  els.popup.hidden = false;
  popupSize = null;
  els.popup.querySelector(".close").addEventListener("click", closePopup);
  const shareBtn = els.popup.querySelector(".share");
  if (shareBtn) shareBtn.addEventListener("click", () => copyText(share, "Ссылка на точку скопирована"));
  const im = els.popup.querySelector("img");
  if (im) {
    im.addEventListener("load", () => {
      popupSize = null;
      positionPopup();
    });
  }
  positionPopup();
}

function positionPopup() {
  if (els.popup.hidden || !popupAnchor) return;
  if (!popupSize) {
    const pr = els.popup.getBoundingClientRect();
    popupSize = { w: pr.width, h: pr.height };
  }
  const r = viewportRect();
  const sx = r.left + popupAnchor.x * view.scale + view.tx;
  const sy = r.top + popupAnchor.y * view.scale + view.ty;
  let x = sx - popupSize.w / 2;
  let y = sy - popupSize.h - 26;
  if (y < 8) y = sy + 26;
  x = clamp(x, 8, window.innerWidth - popupSize.w - 8);
  y = clamp(y, 8, window.innerHeight - popupSize.h - 8);
  els.popup.style.left = `${x}px`;
  els.popup.style.top = `${y}px`;
}

function closePopup() {
  els.popup.hidden = true;
  selected = null;
  selectedEntry = null;
  popupAnchor = null;
  popupSize = null;
  scheduleFlush();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------------ *
 * Sidebar: maps, layers, search
 * ------------------------------------------------------------------ */
function renderMapList(maps) {
  els.maplist.replaceChildren();
  if (els.mapCount) els.mapCount.textContent = String(maps.length);
  for (const map of maps) {
    const btn = document.createElement("button");
    btn.dataset.id = map.id;
    btn.innerHTML = `<span class="dot" style="background:${map.markers.length ? "var(--accent)" : "#555"}"></span>
      <span>${escapeHtml(map.name)}</span>
      ${map.markers.length ? `<span class="count">${map.markers.length}</span>` : `<span class="pill">пусто</span>`}`;
    btn.addEventListener("click", () => setMap(map.id));
    els.maplist.appendChild(btn);
  }
}

function renderLayers() {
  els.layers.replaceChildren();
  if (!currentMap) return;
  if (!currentMap.categories.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "У этой карты нет размеченных слоёв";
    els.layers.appendChild(d);
    return;
  }
  for (const cat of currentMap.categories) {
    const count = currentMap.markers.filter((m) => m.categoryId === cat.id).length;
    const label = document.createElement("label");
    label.className = "layer" + (activeCats.has(cat.id) ? " on" : "");
    label.style.setProperty("--swatch", cat.color);
    label.innerHTML = `<span class="tick">✓</span><span class="swatch"></span>
      <span>${escapeHtml(cat.name)}</span><span class="layer-count">${count}</span>`;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = activeCats.has(cat.id);
    input.addEventListener("change", () => {
      if (input.checked) activeCats.add(cat.id);
      else activeCats.delete(cat.id);
      label.classList.toggle("on", input.checked);
      renderAll();
    });
    label.prepend(input);
    els.layers.appendChild(label);
  }
}

function chipEl(label, active, color, onClick) {
  const b = document.createElement("button");
  b.className = "chip" + (active ? " active" : "");
  b.innerHTML = `<span class="dotc" style="background:${color}"></span>${escapeHtml(label)}`;
  b.addEventListener("click", onClick);
  return b;
}

function renderFilters() {
  const locs = currentMap?.locations || [];
  const mods = currentMap?.mods || [];
  const show = locs.length > 1 || mods.length > 1;
  els.filtersPanel.hidden = !show;
  els.filterLocation.replaceChildren();
  els.filterMod.replaceChildren();
  if (!show) return;

  if (locs.length > 1) {
    els.filterLocation.appendChild(
      chipEl("Вся карта", !filterLocation, "#8b90a4", () => {
        filterLocation = "";
        renderFilters();
        renderAll();
        fitToView();
      })
    );
    for (const l of locs) {
      els.filterLocation.appendChild(
        chipEl(l.name, filterLocation === l.id, "#8b90a4", () => {
          const on = filterLocation !== l.id;
          filterLocation = on ? l.id : "";
          renderFilters();
          renderAll();
          if (on) focusLocation(l);
          else fitToView();
        })
      );
    }
  }
  if (mods.length > 1) {
    els.filterMod.appendChild(
      chipEl("Все режимы", !filterMod, "#8b90a4", () => {
        filterMod = "";
        renderFilters();
        renderAll();
      })
    );
    for (const m of mods) {
      els.filterMod.appendChild(
        chipEl(m.name, filterMod === m.id, m.color || "#a855f7", () => {
          filterMod = filterMod === m.id ? "" : m.id;
          renderFilters();
          renderAll();
        })
      );
    }
  }
}

let searchFirstId = null;

function renderSearch(q) {
  els.results.replaceChildren();
  searchFirstId = null;
  if (!currentMap) return;
  const query = q.trim().toLowerCase();
  if (!query) return;
  const nameOf = (m) => (m.title || m.name || "").toLowerCase();
  const hits = currentMap.markers
    .filter((m) => nameOf(m).includes(query) || (m.description || "").toLowerCase().includes(query))
    .sort((a, b) => (nameOf(a).startsWith(query) ? 0 : 1) - (nameOf(b).startsWith(query) ? 0 : 1))
    .slice(0, 40);
  if (!hits.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Ничего не найдено";
    els.results.appendChild(d);
    return;
  }
  searchFirstId = hits[0].id;
  for (const m of hits) {
    const cat = categoryOf(currentMap, m.categoryId);
    const loc = currentMap.locations?.find((l) => l.id === m.locationId);
    const row = document.createElement("div");
    row.className = "result";
    row.innerHTML = `<span class="pin-dot" style="background:${cat.color}"></span>
      <span>${escapeHtml(m.title || m.name || "")}</span>
      <small>${escapeHtml(loc ? loc.name : cat.name)}</small>`;
    row.addEventListener("click", () => selectMarker(m.id, true));
    els.results.appendChild(row);
  }
}

els.search.addEventListener("input", () => renderSearch(els.search.value));
els.search.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && searchFirstId) {
    selectMarker(searchFirstId, true);
    els.search.blur();
  } else if (e.key === "Escape") {
    els.search.value = "";
    renderSearch("");
  }
});

/* ------------------------------------------------------------------ *
 * Map loading
 * ------------------------------------------------------------------ */
function setMap(id) {
  const map = MAPS.find((m) => m.id === id);
  if (!map) return;
  closePopup();
  currentMap = map;
  filterLocation = "";
  filterMod = "";
  activeCats.clear();
  map.categories.forEach((c) => {
    if (!c.defaultOff) activeCats.add(c.id);
  });

  els.maplist.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.id === id));
  els.loading.hidden = false;
  els.loading.classList.remove("done");
  els.image.src = map.image;

  const onReady = () => {
    worldW = els.image.naturalWidth || map.width;
    worldH = els.image.naturalHeight || map.height;
    els.world.style.width = `${worldW}px`;
    els.world.style.height = `${worldH}px`;
    resizeCanvas();
    prepareMap();
    renderLayers();
    renderFilters();
    renderAll();
    fitToView();
    applyZoomParam();
    requestAnimationFrame(() => {
      resizeCanvas();
      fitToView();
      applyZoomParam();
      if (pendingSelect) {
        const id = pendingSelect;
        pendingSelect = null;
        selectMarker(id, true);
      }
    });
    els.loading.classList.add("done");
    setTimeout(() => (els.loading.hidden = true), 260);
    sendPresence({ mapId: map.id });
  };

  els.image.onerror = () => {
    els.loading.hidden = false;
    els.loading.textContent = "Не удалось загрузить изображение карты";
  };
  if (els.image.complete && els.image.naturalWidth) onReady();
  else els.image.onload = onReady;
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */
document.querySelectorAll(".zoom-controls button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const r = viewportRect();
    const cx = r.width / 2;
    const cy = r.height / 2;
    const act = btn.dataset.act;
    if (act === "zoom-in") zoomAt(cx, cy, 1.4);
    else if (act === "zoom-out") zoomAt(cx, cy, 1 / 1.4);
    else if (act === "reset") fitToView();
    else if (act === "share") shareCurrentView();
    else if (act === "fullscreen") toggleFullscreen();
  });
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

els.menuBtn.addEventListener("click", () => els.sidebar.classList.toggle("open"));
els.viewport.addEventListener("pointerdown", () => els.sidebar.classList.remove("open"));

/* Disable native HTML5 drag (image dragging) so panning always works */
document.addEventListener("dragstart", (e) => e.preventDefault(), true);
document.addEventListener("dragover", (e) => e.preventDefault(), true);
document.addEventListener("drop", (e) => e.preventDefault(), true);
els.image.draggable = false;
els.world.draggable = false;
els.image.setAttribute("draggable", "false");

window.addEventListener("resize", () => {
  measureViewport();
  if (!currentMap) return;
  resizeCanvas();
  view.min = view.fit * 0.55;
  clampView();
  applyTransform();
});

if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    measureViewport();
    if (!currentMap) return;
    resizeCanvas();
    clampView();
    applyTransform();
  }).observe(els.viewport);
}

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const r = viewportRect();
  if (e.key === "Escape") closePopup();
  else if (e.key === "+" || e.key === "=") zoomAt(r.width / 2, r.height / 2, 1.3);
  else if (e.key === "-" || e.key === "_") zoomAt(r.width / 2, r.height / 2, 1 / 1.3);
  else if (e.key === "0") fitToView();
});

/* ------------------------------------------------------------------ *
 * Presence (WebSocket)
 * ------------------------------------------------------------------ */
let socket = null;
let myId = null;
let reconnectTimer = null;
const peers = new Map();
let roomName = "local";
let lastCursorSent = 0;

function send(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function sendPresence(partial) {
  if (!partial) return;
  send({ type: "state", ...partial });
}

function sendCursor(e) {
  if (!currentMap) return;
  const now = performance.now();
  if (now - lastCursorSent < 60) return;
  lastCursorSent = now;
  const r = viewportRect();
  const wx = (e.clientX - r.left - view.tx) / view.scale;
  const wy = (e.clientY - r.top - view.ty) / view.scale;
  sendPresence({ mapId: currentMap.id, fx: wx / worldW, fy: wy / worldH });
}

function connectPresence(room) {
  roomName = room || "local";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  try {
    socket = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(roomName)}`);
  } catch {
    return;
  }
  socket.addEventListener("open", () => {
    send({ type: "hello", name: currentUser.name, avatar: currentUser.avatar, color: currentUser.color });
    if (currentMap) sendPresence({ mapId: currentMap.id });
  });
  socket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      myId = msg.id;
      peers.clear();
      (msg.peers || []).forEach((p) => peers.set(p.id, p));
      renderPeers();
    } else if (msg.type === "peer-join" || msg.type === "peer-state") {
      peers.set(msg.peer.id, msg.peer);
      renderPeers();
      drawCursors();
    } else if (msg.type === "peer-left") {
      peers.delete(msg.id);
      renderPeers();
      drawCursors();
    }
  });
  socket.addEventListener("close", () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connectPresence(roomName), 2500);
  });
}

function renderPeers() {
  const others = [...peers.values()].filter((p) => p.id !== myId);
  els.peersPanel.hidden = others.length === 0;
  els.peerCount.textContent = String(others.length + 1);
  els.peers.replaceChildren();
  const list = [selfPeer(), ...others];
  for (const p of list) {
    const row = document.createElement("div");
    row.className = "peer";
    const av = p.avatar
      ? `<img src="${p.avatar}" alt="" />`
      : `<span class="avatar-fallback" style="background:${p.color}"></span>`;
    row.innerHTML = `${av}<span>${escapeHtml(p.name)}${p.id === myId ? " (вы)" : ""}</span><span class="online"></span>`;
    els.peers.appendChild(row);
  }
}

function selfPeer() {
  return { id: myId || "self", name: currentUser.name, avatar: currentUser.avatar, color: currentUser.color };
}

function drawCursors() {
  els.cursors.replaceChildren();
  if (!currentMap) return;
  for (const p of peers.values()) {
    if (p.id === myId) continue;
    if (p.mapId !== currentMap.id) continue;
    if (!Number.isFinite(p.fx) || !Number.isFinite(p.fy)) continue;
    const x = screenX(p.fx * worldW);
    const y = screenY(p.fy * worldH);
    if (x < -60 || x > canvasW + 60 || y < -40 || y > canvasH + 40) continue;
    const el = document.createElement("div");
    el.className = "cursor";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.setProperty("--c", p.color);
    el.innerHTML = `<div class="dot"></div><div class="label">${escapeHtml(p.name)}</div>`;
    els.cursors.appendChild(el);
  }
}

/* ------------------------------------------------------------------ *
 * Discord SDK
 * ------------------------------------------------------------------ */
async function initDiscord() {
  let cfg = { clientId: "", authAvailable: false, configured: false };
  try {
    cfg = await fetch("/api/config").then((r) => r.json());
  } catch {}

  const params = new URLSearchParams(location.search);
  const embedded = params.has("frame_id") || params.has("instance_id");
  if (!embedded) {
    return { room: params.get("room") || "local", user: null };
  }

  try {
    const sdk = new DiscordSDK(cfg.clientId);
    await sdk.ready();
    if (cfg.authAvailable) {
      const { code } = await sdk.commands.authorize({
        client_id: cfg.clientId,
        response_type: "code",
        state: "",
        prompt: "none",
        scope: ["identify", "guilds"],
      });
      const tokenRes = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const token = await tokenRes.json();
      if (!token.access_token) throw new Error(token.error || "token_error");
      const auth = await sdk.commands.authenticate({ access_token: token.access_token });
      const u = auth.user;
      return {
        room: sdk.instanceId,
        user: {
          id: u.id,
          name: u.global_name || u.username || "Игрок",
          avatar: avatarUrl(u),
          color: colorFor(u.id),
        },
      };
    }
    toast("Discord OAuth не настроен — гостевой режим.");
    return { room: sdk.instanceId, user: null };
  } catch (err) {
    console.warn("Discord init failed:", err);
    toast(`Не удалось войти через Discord: ${err.message}. Демонстрационный режим.`, 6000);
    return { room: params.get("instance_id") || params.get("room") || "local", user: null };
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
let MAPS = [];

async function boot() {
  measureViewport();
  const [fandom, amh] = await Promise.all([
    fetch(`/data/maps.json?v=${Date.now()}`, { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => ({ maps: [] })),
    fetch(`/data/amh-maps.json?v=${Date.now()}`, { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => ({ maps: [] })),
  ]);
  // AMH location maps come first and shadow the wiki maps with the same id;
  // hide maps that end up without any points (keep Дамба if it is unmarked).
  const seen = new Set();
  MAPS = [...(amh.maps || []), ...(fandom.maps || [])].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return (m.markers?.length || 0) > 0 || m.id === "damba";
  });

  const session = await initDiscord();
  if (session.user) {
    currentUser = session.user;
  } else {
    let saved = "";
    try {
      saved = localStorage.getItem("am-maps-name") || "";
    } catch {}
    currentUser = { name: saved || "Гость", avatar: "", color: colorFor(saved || "guest-" + Math.random()) };
  }
  if (currentUser.avatar) {
    els.user.hidden = false;
    els.userAvatar.src = currentUser.avatar;
    els.userName.textContent = currentUser.name;
  } else if (session.user === null && session.room !== "local") {
    els.user.hidden = false;
    els.userName.textContent = currentUser.name;
    els.userAvatar.style.display = "none";
  }

  renderMapList(MAPS);
  const params = new URLSearchParams(location.search);
  const startId = params.get("map");
  pendingSelect = params.get("m") || null;
  const fallback =
    MAPS.find((m) => m.id === "amh-dalniy") ||
    MAPS.find((m) => m.markers.length > 500) ||
    MAPS.find((m) => m.markers.length) ||
    MAPS[0];
  setMap(MAPS.some((m) => m.id === startId) ? startId : fallback?.id);

  connectPresence(session.room);
}

boot().catch((err) => {
  console.error(err);
  els.loading.textContent = "Не удалось загрузить карты: " + err.message;
});

function runBench() {
  const N = 200;
  const baseTx = view.tx;
  const baseTy = view.ty;
  const move = (i) => {
    view.tx = baseTx + ((i % 40) - 20);
    view.ty = baseTy + ((i % 30) - 15);
  };

  let t0 = performance.now();
  for (let i = 0; i < N; i++) {
    move(i);
    invalidateLayer(); // worst case: full vector repaint (zoom)
    renderCanvas();
  }
  const repaint = (performance.now() - t0) / N;

  view.tx = baseTx;
  view.ty = baseTy;
  invalidateLayer();
  renderCanvas();
  t0 = performance.now();
  for (let i = 0; i < N; i++) {
    move(i);
    renderCanvas(); // blit only (pan)
  }
  const pan = (performance.now() - t0) / N;

  console.log(
    `BENCH markers=${currentMap?.markers.length} drawn=${benchDrawn} cats=${activeCats.size} canvas=${canvasW}x${canvasH} fit=${(view.fit || 0).toFixed(3)} | repaint ${repaint.toFixed(2)}ms/frame | pan ${pan.toFixed(2)}ms/frame`
  );
  view.tx = baseTx;
  view.ty = baseTy;
  invalidateLayer();
  scheduleFlush();
}

const benchParam = new URLSearchParams(location.search).get("bench");
if (benchParam !== null) {
  setTimeout(runBench, Number(benchParam) || 2500);
}
