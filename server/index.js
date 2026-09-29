import "dotenv/config";
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const PORT = Number(process.env.PORT || 3001);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";

const app = express();
app.use(express.json());

app.use(
  "/vendor/embedded-app-sdk",
  express.static(join(root, "node_modules", "@discord", "embedded-app-sdk", "output"))
);
app.use(
  express.static(join(root, "public"), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/\.(webp|png|jpe?g|svg|ico)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=86400");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  })
);

app.get("/api/config", (_req, res) => {
  res.json({
    clientId: CLIENT_ID,
    authAvailable: Boolean(CLIENT_ID && CLIENT_SECRET),
    configured: Boolean(CLIENT_ID),
  });
});

app.post("/api/token", async (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(501).json({ error: "oauth_not_configured" });
  }
  const code = req.body && req.body.code;
  if (!code) return res.status(400).json({ error: "missing_code" });

  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    });
    const r = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ access_token: data.access_token });
  } catch (err) {
    res.status(500).json({ error: "token_exchange_failed", detail: String(err) });
  }
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });
const rooms = new Map();
// Ephemeral drawing shapes per room (channel). Dropped when the room empties.
const roomDrawings = new Map();

function roomOf(name) {
  if (!rooms.has(name)) rooms.set(name, new Map());
  return rooms.get(name);
}

function drawingsOf(name) {
  if (!roomDrawings.has(name)) roomDrawings.set(name, []);
  return roomDrawings.get(name);
}

const DRAW_TYPES = new Set(["pen", "line", "dash", "rect", "ellipse", "text"]);

function sanitizeItem(item) {
  if (!item || typeof item !== "object") return null;
  const type = String(item.type || "");
  if (!DRAW_TYPES.has(type)) return null;
  const id = String(item.id || "").slice(0, 48);
  if (!id) return null;
  const out = {
    id,
    type,
    color: String(item.color || "#ff3b30").slice(0, 16),
    width: Math.max(1, Math.min(24, Number(item.width) || 4)),
    angle: Number(item.angle) || 0,
    mapId: String(item.mapId || "").slice(0, 40),
  };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (type === "pen") {
    const pts = Array.isArray(item.pts) ? item.pts : [];
    out.pts = pts.slice(0, 4000).map((p) => [Math.round(num(p && p[0])), Math.round(num(p && p[1]))]);
  } else if (type === "text") {
    out.x = num(item.x);
    out.y = num(item.y);
    out.text = String(item.text || "").slice(0, 200);
    out.size = Math.max(8, Math.min(200, Number(item.size) || 40));
  } else {
    out.x1 = num(item.x1);
    out.y1 = num(item.y1);
    out.x2 = num(item.x2);
    out.y2 = num(item.y2);
  }
  return out;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function peersPayload(room) {
  return [...room.values()].map((c) => c.state);
}

function broadcast(room, msg, except) {
  for (const client of room.values()) {
    if (client.ws !== except) send(client.ws, msg);
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const roomName = (url.searchParams.get("room") || "lobby").slice(0, 80);
  const room = roomOf(roomName);
  const id = Math.random().toString(36).slice(2, 10);

  const client = {
    ws,
    state: {
      id,
      name: "Гость",
      avatar: "",
      color: "#7289da",
      mapId: "",
      fx: 0.5,
      fy: 0.5,
    },
  };
  room.set(id, client);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "hello") {
      client.state.name = String(msg.name || "Гость").slice(0, 32);
      client.state.avatar = String(msg.avatar || "").slice(0, 300);
      client.state.color = String(msg.color || "#7289da").slice(0, 16);
      send(ws, { type: "welcome", id, peers: peersPayload(room) });
      send(ws, { type: "drawings", items: drawingsOf(roomName) });
      broadcast(room, { type: "peer-join", peer: client.state }, ws);
    } else if (msg.type === "state") {
      if (typeof msg.mapId === "string") client.state.mapId = msg.mapId.slice(0, 40);
      if (Number.isFinite(msg.fx)) client.state.fx = msg.fx;
      if (Number.isFinite(msg.fy)) client.state.fy = msg.fy;
      broadcast(room, { type: "peer-state", peer: client.state }, ws);
    } else if (msg.type === "draw") {
      const item = sanitizeItem(msg.item);
      if (item) {
        const list = drawingsOf(roomName);
        const i = list.findIndex((d) => d.id === item.id);
        if (i >= 0) list[i] = item;
        else list.push(item);
        if (list.length > 3000) list.splice(0, list.length - 3000);
        broadcast(room, { type: "draw", item }, ws);
      }
    } else if (msg.type === "draw-clear") {
      roomDrawings.set(roomName, []);
      broadcast(room, { type: "draw-clear" });
    }
  });

  ws.on("close", () => {
    room.delete(id);
    broadcast(room, { type: "peer-left", id }, ws);
    if (room.size === 0) {
      rooms.delete(roomName);
      roomDrawings.delete(roomName);
    }
  });
});

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`Active Matter Maps Activity running on http://localhost:${PORT}`);
  if (!CLIENT_ID) {
    console.log("  DISCORD_CLIENT_ID is not set — running in standalone web mode.");
  } else if (!CLIENT_SECRET) {
    console.log("  DISCORD_CLIENT_SECRET is not set — OAuth2 token exchange disabled.");
  }
});
