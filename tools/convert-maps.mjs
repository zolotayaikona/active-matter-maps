import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const outDir = join(root, "public", "data");

const BASE = "https://active-matter.fandom.com";

const MAPS = [
  { id: "damba", name: "Дамба", file: "damba.webp", source: "damba_wikitext.txt", wiki: "Дамба" },
  { id: "dogorsk", name: "Догорск", file: "dogorsk.webp", source: "dogorsk_wikitext.txt", wiki: "Догорск" },
  { id: "ozernoe", name: "Озёрное", file: "ozernoe.webp", source: "ozernoe_wikitext.txt", wiki: "Озёрное" },
  { id: "port", name: "Порт", file: "port.webp", source: "port_wikitext.txt", wiki: "Порт" },
  { id: "shchegolskoe", name: "Щегольское", file: "shchegolskoe.webp", source: "shchegolskoe_wikitext.txt", wiki: "Щегольское" },
  { id: "dalnii", name: "Остров Дальний · секторы", file: "dalnii.webp", plain: true, width: 1024, height: 1024 },
  { id: "ozernoe_sat", name: "Озёрное · спутник", file: "ozernoe_sat.webp", plain: true, width: 1024, height: 1024 },
  { id: "dogorsk_plan", name: "Догорск · план", file: "dogorsk_plan.webp", plain: true, width: 632, height: 632 },
  { id: "shchegolskoe_plan", name: "Щегольское · план", file: "shchegolskoe_plan.webp", plain: true, width: 496, height: 495 },
];

const CATEGORY_STYLE = {
  "Навигация": { color: "#43b581", symbol: "➤" },
  "Порталы": { color: "#7289da", symbol: "◈" },
  "Точки эвакуации": { color: "#faa61a", symbol: "⇧" },
  "Места аномальной активности": { color: "#eb459e", symbol: "?" },
  "General": { color: "#fa005a", symbol: "●" },
};

const LOCAL_POI = {
  "Map Schegolskoe portal 9.jpg": "/poi/map-schegolskoe-portal-9.webp",
  "Map Schegolskoe exit 1.jpg": "/poi/map-schegolskoe-exit-1.webp",
  "Map Schegolskoe portal 8.jpg": "/poi/map-schegolskoe-portal-8.webp",
};

function wikiName(value) {
  return String(value || "").replace(/^Файл:/, "").replace(/^File:/, "");
}

function localImage(value) {
  const name = wikiName(value);
  return LOCAL_POI[name] || "";
}

function normalizeLink(link) {
  if (!link || !link.url) return null;
  return { url: link.url, label: link.label || link.url };
}

async function buildMap(meta) {
  if (meta.plain) {
    return {
      id: meta.id,
      name: meta.name,
      image: `/maps/${meta.file}`,
      bounds: [meta.width, meta.height],
      width: meta.width,
      height: meta.height,
      origin: "bottom-left",
      coordinateOrder: "xy",
      categories: [],
      markers: [],
    };
  }

  const raw = await readFile(join(dataDir, meta.source), "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const [bw, bh] = parsed.mapBounds[1];

  const categories = (parsed.categories || []).map((cat) => {
    const style = CATEGORY_STYLE[cat.name] || { color: cat.color || "#fa005a", symbol: cat.symbol || "●" };
    return {
      id: String(cat.id),
      name: cat.name,
      color: style.color,
      symbol: cat.symbol || style.symbol,
      icon: "",
    };
  });

  const markers = (parsed.markers || []).map((m, i) => {
    const popup = m.popup || {};
    return {
      id: String(m.id ?? i + 1),
      categoryId: String(m.categoryId),
      x: m.position[0],
      y: m.position[1],
      title: popup.title || "Точка интереса",
      description: popup.description || "",
      link: normalizeLink(popup.link),
      image: localImage(popup.image),
    };
  });

  return {
    id: meta.id,
    name: meta.name,
    image: `/maps/${meta.file}`,
    bounds: [bw, bh],
    width: bw,
    height: bh,
    origin: parsed.origin || "bottom-left",
    coordinateOrder: parsed.coordinateOrder || "xy",
    categories,
    markers,
  };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const maps = [];
  for (const meta of MAPS) {
    try {
      const map = await buildMap(meta);
      maps.push(map);
      console.log(`  ${meta.id.padEnd(14)} ${map.bounds[0]}x${map.bounds[1]}  markers=${map.markers.length}`);
    } catch (err) {
      console.warn(`  skip ${meta.id}: ${err.message}`);
    }
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    source: BASE,
    attribution: "Карты и данные о точках интереса — Active Matter Wiki (CC-BY-SA)",
    maps,
  };
  await writeFile(join(outDir, "maps.json"), JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote public/data/maps.json (${maps.length} maps, ${maps.reduce((n, m) => n + m.markers.length, 0)} markers)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
