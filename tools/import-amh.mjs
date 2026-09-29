/**
 * Imports the interactive maps from activematterhelp.ru.
 *
 * - Downloads the WebP tile pyramid for each region (native zoom 3) and
 *   stitches it into a single image in public/maps/amh-<id>.webp
 * - Reads the site's marker/region dataset (data/amh/data-markers.mjs) and
 *   converts game coordinates to image fractions using the same CRS bounds
 * - Parses category groups / type labels / colors / mods from
 *   data/amh/MapsTab.js and writes public/data/amh-maps.json
 *
 * Source: https://activematterhelp.ru/maps  (community map project)
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const amhDir = join(root, "data", "amh");
const mapsDir = join(root, "public", "maps");
const outDir = join(root, "public", "data");
const TMP = join(root, "data", "amh", "tiles");

const SITE = "https://activematterhelp.ru";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const REGIONS = [
  { id: "dalniy", name: "Остров Дальний", prefix: "amh-dalniy" },
  { id: "forsaken_africa", name: "Штаб (Африка)", prefix: "amh-forsaken_africa" },
  { id: "america_abandoned", name: "Заброшенная Америка", prefix: "amh-america_abandoned" },
  { id: "bunker", name: "Бункер", prefix: "amh-bunker" },
];

const ZOOM = 3; // 8x8 tiles of 512px => 4096px image
const TILE = 512;
const SIZE = TILE * Math.pow(2, ZOOM);

const GROUP_STYLE = {
  exits: { color: "#22c55e", symbol: "⇱" },
  spawns: { color: "#60a5fa", symbol: "⬆" },
  access: { color: "#f5a623", symbol: "🔑" },
  valuables: { color: "#d97706", symbol: "₿" },
  loot: { color: "#a16207", symbol: "▣" },
  docs: { color: "#eab308", symbol: "📄" },
  enemies: { color: "#ef4444", symbol: "☠" },
  hazards: { color: "#c026d3", symbol: "☢" },
  quests: { color: "#ff6b00", symbol: "❗" },
  puzzles: { color: "#14b8a6", symbol: "⚙" },
  poi: { color: "#f59e0b", symbol: "◆" },
};

function balanced(src, startIdx, open, close) {
  let depth = 0, started = false;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) { depth++; started = true; }
    else if (ch === close) { depth--; if (started && depth === 0) return src.slice(startIdx, i + 1); }
  }
  return "";
}

function extractObject(text, marker, open = "{", close = "}") {
  const i = text.indexOf(marker);
  if (i < 0) return "";
  const braceIdx = text.indexOf(open, i + marker.length - 1);
  return balanced(text, braceIdx, open, close);
}

function objectContaining(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return "{}";
  const openIdx = text.lastIndexOf("{", i);
  return balanced(text, openIdx, "{", "}");
}

function stringPairs(objText) {
  const out = {};
  for (const m of objText.matchAll(/([A-Za-z_][A-Za-z0-9_]*):"((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2];
  return out;
}

function parseObj(text) {
  if (!text) return {};
  const json = text
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"');
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

async function loadMeta() {
  const mapsTab = await readFile(join(amhDir, "MapsTab.js"), "utf8");
  const naming = await readFile(join(amhDir, "markerNaming.mjs"), "utf8");

  const groups = parseObj(balanced(mapsTab, mapsTab.indexOf("[", mapsTab.indexOf("Pe=[")), "[", "]"));
  const modsObj = parseObj(extractObject(mapsTab, "Rt={"));
  const modOrder = JSON.parse(balanced(mapsTab, mapsTab.indexOf("[", mapsTab.indexOf("Vt=[")), "[", "]"));
  const typeLabels = stringPairs(objectContaining(mapsTab, 'extraction_always:"Постоянные"'));

  const locRaw = parseObj(extractObject(naming, "m={"));
  const locationNames = {};
  for (const [k, v] of Object.entries(locRaw)) locationNames[k] = v && v.ru ? v.ru : k;
  const regionRaw = parseObj(extractObject(naming, "l={"));
  const regionNames = {};
  for (const [k, v] of Object.entries(regionRaw)) regionNames[k] = v && v.ru ? v.ru : k;

  const colors = {};
  for (const m of mapsTab.matchAll(/([a-z_][a-z0-9_]*):"(#[0-9a-fA-F]{6})"/g)) colors[m[1]] = m[2];

  const typeToGroup = {};
  for (const g of groups) for (const t of g.types || []) typeToGroup[t] = g.id;

  return { groups, modsObj, modOrder, typeLabels, locationNames, regionNames, colors, typeToGroup };
}

async function downloadTile(folder, z, x, y) {
  const url = `${SITE}/map-tiles/${folder}/${z}/${x}/${y}.webp`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Referer: `${SITE}/maps`, Accept: "image/webp,image/*" } });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") || "";
    if (!type.includes("image")) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return null;
    return buf;
  } catch {
    return null;
  }
}

async function stitchRegion(region) {
  await mkdir(TMP, { recursive: true });
  const n = Math.pow(2, ZOOM);
  const composites = [];
  let ok = 0;
  const tasks = [];
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      tasks.push({ x, y, file: join(TMP, `${region.id}_${x}_${y}.webp`) });
    }
  }

  const pool = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const t = tasks[cursor++];
      let buf = null;
      if (existsSync(t.file)) buf = await readFile(t.file);
      else {
        buf = await downloadTile(region.id + "_tiles", ZOOM, t.x, t.y);
        if (buf) await writeFile(t.file, buf);
      }
      if (!buf) continue;
      const meta = await sharp(buf).metadata();
      let input = buf;
      if (meta.width !== TILE || meta.height !== TILE) {
        input = await sharp(buf).resize(TILE, TILE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      }
      composites.push({ input, left: t.x * TILE, top: t.y * TILE });
      ok++;
    }
  }
  await Promise.all(Array.from({ length: pool }, worker));

  const out = join(mapsDir, `${region.prefix}.webp`);
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .webp({ quality: 80, effort: 5 })
    .toFile(out);

  const out2 = await sharp(out).metadata();
  console.log(`  ${region.id.padEnd(18)} tiles ${ok}/${tasks.length} -> ${region.prefix}.webp ${out2.width}x${out2.height}`);
}

function frac(bounds, lat, lng) {
  const w = bounds.rightBottom[0] - bounds.leftTop[0];
  const h = bounds.rightBottom[1] - bounds.leftTop[1];
  return {
    fx: (lng - bounds.leftTop[0]) / w,
    fy: (bounds.rightBottom[1] - lat) / h,
  };
}

function ext(u) {
  if (typeof u !== "string") return u;
  return u.startsWith("/") ? SITE + u : u;
}

function pick(marker) {
  const out = { name: marker.name, type: marker.type, mod: marker.mod || "", locationId: marker.locationId || "" };
  const desc = marker.description || marker.desc;
  if (desc) out.description = desc;
  for (const k of ["key", "loot", "item", "group", "quest", "here", "entrance", "reward"]) {
    if (marker[k] != null && marker[k] !== "") out[k] = marker[k];
  }
  for (const k of ["image", "page", "link", "video"]) {
    if (marker[k] != null && marker[k] !== "") out[k] = ext(marker[k]);
  }
  return out;
}

/**
 * Locations of a region that are also exported as standalone maps.
 * They are cropped out of the region image and keep that region's markers,
 * zones and labels for the given locationId (so the area has full mapping).
 */
const LOCATION_MAPS = {
  dalniy: [
    { loc: "port", id: "port" },
    { loc: "schegolskoe", id: "shchegolskoe" }, // same id as the wiki map it replaces
    { loc: "ozernoe", id: "ozernoe" },
    { loc: "damba", id: "damba" },
  ],
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function buildLocationMaps(regionId, regionMap, dir) {
  const ids = LOCATION_MAPS[regionId];
  if (!ids) return [];
  const src = join(dir, regionMap.image.split("/").pop());
  const out = [];
  for (const spec of ids) {
    const locId = spec.loc;
    const outId = spec.id || spec.loc;
    const loc = regionMap.locations.find((l) => l.id === locId);
    if (!loc) continue;
    const ms = regionMap.markers.filter((m) => m.locationId === locId);
    if (!ms.length) continue;
    // Zones carry no locationId: assign them by centroid falling inside the
    // site's level bounds (loc.focus).
    const f = loc.focus;
    const zs = f
      ? regionMap.zones.filter((z) => {
          if (!z.points || !z.points.length) return false;
          const cx = z.points.reduce((s, p) => s + p[0], 0) / z.points.length;
          const cy = z.points.reduce((s, p) => s + p[1], 0) / z.points.length;
          return cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
        })
      : [];

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (x, y) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    ms.forEach((m) => add(m.x, m.y));
    zs.forEach((z) => z.points.forEach(([x, y]) => add(x, y)));
    if (loc.focus) {
      minX = Math.min(minX, loc.focus.x);
      minY = Math.min(minY, loc.focus.y);
      maxX = Math.max(maxX, loc.focus.x + loc.focus.w);
      maxY = Math.max(maxY, loc.focus.y + loc.focus.h);
    }
    const pad = 40;
    const x0 = clamp(Math.floor(minX - pad), 0, SIZE);
    const y0 = clamp(Math.floor(minY - pad), 0, SIZE);
    const x1 = clamp(Math.ceil(maxX + pad), 0, SIZE);
    const y1 = clamp(Math.ceil(maxY + pad), 0, SIZE);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) continue;

    await sharp(src)
      .extract({ left: x0, top: y0, width: w, height: h })
      .webp({ quality: 82, effort: 5 })
      .toFile(join(dir, `amh-loc-${outId}.webp`));

    const used = new Set(ms.map((m) => m.categoryId));
    if (zs.some((z) => z.kind === "enemies")) used.add("enemies");
    if (zs.some((z) => z.kind !== "enemies")) used.add("poi");
    const categories = regionMap.categories.filter((c) => used.has(c.id));
    const markers = ms.map((m) => ({ ...m, x: m.x - x0, y: m.y - y0 }));
    const zones = zs.map((z) => ({ ...z, points: z.points.map(([x, y]) => [x - x0, y - y0]) }));
    const labels = (regionMap.labels || [])
      .filter((l) => l.x >= x0 && l.x <= x1 && l.y >= y0 && l.y <= y1)
      .map((l) => ({ ...l, x: l.x - x0, y: l.y - y0 }));
    const modSet = new Set(ms.map((m) => m.mod).filter(Boolean));
    const mods = regionMap.mods.filter((md) => modSet.has(md.id));

    out.push({
      id: outId, // same id as the wiki map it replaces
      name: loc.name,
      image: `/maps/amh-loc-${outId}.webp`,
      bounds: [w, h],
      width: w,
      height: h,
      origin: "top-left",
      source: `${SITE}/maps`,
      categories,
      markers,
      zones,
      labels,
      locations: [],
      mods,
    });
    console.log(`  loc ${outId.padEnd(14)} ${w}x${h}  markers ${markers.length}  zones ${zones.length}`);
  }
  return out;
}

async function buildData() {
  const data = await import(pathToFileURL(join(amhDir, "data-markers.mjs")).href);
  const bounds = data.h;
  const meta = await loadMeta();

  const maps = [];
  for (const region of REGIONS) {
    const b = bounds[region.id];
    if (!b) continue;

    const markers = [];
    const locSet = new Set();
    const modSet = new Set();
    for (const m of data.A) {
      if (m.map !== region.id) continue;
      const pos = m.coords || (m.gameCoords ? [m.gameCoords[2], m.gameCoords[0]] : null);
      if (!pos) continue;
      const { fx, fy } = frac(b, pos[0], pos[1]);
      if (fx < -0.02 || fx > 1.02 || fy < -0.02 || fy > 1.02) continue;
      const groupId = meta.typeToGroup[m.type] || "poi";
      markers.push({
        id: m.id,
        categoryId: groupId,
        x: fx * SIZE,
        y: fy * SIZE,
        ...pick(m),
      });
      if (m.locationId) locSet.add(m.locationId);
      if (m.mod) modSet.add(m.mod);
    }

    const zones = [];
    for (const r of data.f) {
      if (r.map !== region.id || !r.points || r.points.length < 3) continue;
      const pts = r.points.map(([lat, lng]) => {
        const { fx, fy } = frac(b, lat, lng);
        return [Math.round(fx * SIZE), Math.round(fy * SIZE)];
      });
      zones.push({
        id: r.id,
        kind: r.type === "monster_region" ? "monster" : "poi",
        name: r.name,
        description: r.desc || "",
        mod: r.mod || "",
        locationId: r.locationId || "",
        points: pts,
      });
    }

    const usedGroups = new Set(markers.map((m) => m.categoryId));
    const categories = meta.groups
      .filter((g) => usedGroups.has(g.id))
      .map((g) => ({
        id: g.id,
        name: g.label,
        color: GROUP_STYLE[g.id]?.color || "#f59e0b",
        symbol: GROUP_STYLE[g.id]?.symbol || "•",
        defaultOff: ["enemies", "hazards"].includes(g.id),
      }));

    // data.L[region.id] is the site's location ("уровень") config: bounds/center/zoom/radius.
    const locCfg = new Map();
    for (const l of data.L[region.id] || []) locCfg.set(l.id, l);

    const locIds = [...locCfg.keys()];
    for (const id of locSet) if (!locCfg.has(id)) locIds.push(id);

    const locations = locIds.map((id) => {
      const entry = { id, name: meta.locationNames[id] || meta.locationNames[id.toLowerCase()] || id };
      const cfg = locCfg.get(id);
      if (cfg && Array.isArray(cfg.bounds) && cfg.bounds.length >= 2 && cfg.bounds[0] && cfg.bounds[1]) {
        const p1 = frac(b, cfg.bounds[0][0], cfg.bounds[0][1]);
        const p2 = frac(b, cfg.bounds[1][0], cfg.bounds[1][1]);
        const x0 = Math.min(p1.fx, p2.fx) * SIZE;
        const x1 = Math.max(p1.fx, p2.fx) * SIZE;
        const y0 = Math.min(p1.fy, p2.fy) * SIZE;
        const y1 = Math.max(p1.fy, p2.fy) * SIZE;
        entry.focus = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
      } else if (cfg && Array.isArray(cfg.center)) {
        const p = frac(b, cfg.center[0], cfg.center[1]);
        const w = SIZE * 0.5;
        const h = SIZE * 0.5;
        entry.focus = { x: Math.round(p.fx * SIZE - w / 2), y: Math.round(p.fy * SIZE - h / 2), w: Math.round(w), h: Math.round(h) };
      }
      if (cfg && Array.isArray(cfg.zoom) && cfg.zoom.length) entry.zoom = cfg.zoom[0];
      return entry;
    });
    const mods = meta.modOrder.filter((id) => modSet.has(id)).map((id) => ({ id, name: meta.modsObj[id]?.label || id, color: meta.modsObj[id]?.color || "#a855f7" }));

    const labels = [];
    for (const l of data.L[region.id] || []) {
      if (!l.center) continue;
      const { fx, fy } = frac(b, l.center[0], l.center[1]);
      labels.push({ id: l.id, name: meta.locationNames[l.id] || l.name, x: fx * SIZE, y: fy * SIZE });
    }

    maps.push({
      id: region.prefix,
      name: region.name,
      image: `/maps/${region.prefix}.webp`,
      bounds: [SIZE, SIZE],
      width: SIZE,
      height: SIZE,
      origin: "top-left",
      source: `${SITE}/maps`,
      categories,
      markers,
      zones,
      labels,
      locations,
      mods,
    });
    console.log(`  ${region.id.padEnd(18)} markers ${markers.length}  zones ${zones.length}  labels ${labels.length}  locations ${locations.length}  mods ${mods.length}`);
  }

  const locMaps = {};
  for (const regionId of Object.keys(LOCATION_MAPS)) {
    const prefix = REGIONS.find((r) => r.id === regionId)?.prefix;
    const regionMap = maps.find((m) => m.id === prefix);
    if (!regionMap) continue;
    locMaps[prefix] = await buildLocationMaps(regionId, regionMap, mapsDir);
  }

  // Put each region's standalone location maps right after that region.
  const ordered = [];
  for (const m of maps) {
    ordered.push(m);
    if (locMaps[m.id]) ordered.push(...locMaps[m.id]);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: `${SITE}/maps`,
    attribution: "Данные карт — activematterhelp.ru (сообщество Active Matter Help)",
    maps: ordered,
  };
  await writeFile(join(outDir, "amh-maps.json"), JSON.stringify(payload), "utf8");
  console.log(`Wrote public/data/amh-maps.json (${ordered.length} maps, ${ordered.reduce((n, m) => n + m.markers.length, 0)} markers, ${ordered.reduce((n, m) => n + m.zones.length, 0)} zones)`);
}

async function main() {
  await mkdir(mapsDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  if (!process.argv.includes("--no-tiles")) {
    console.log("Stitching tile images...");
    for (const region of REGIONS) await stitchRegion(region);
  }
  console.log("Building data...");
  await buildData();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
