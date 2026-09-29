import { WebSocket } from "ws";

const base = process.env.BASE || "http://localhost:3001";
const wsUrl = base.replace(/^http/, "ws") + "/ws?room=selftest";
const log = (...a) => console.log("[test]", ...a);

function client(name, color) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", name, color }));
      ws.send(JSON.stringify({ type: "state", mapId: "port", fx: 0.5, fy: 0.5 }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      log(name, "<=", JSON.stringify(msg));
      if (msg.type === "welcome") resolve(ws);
    });
  });
}

const a = await client("Tester A", "#43b581");
const b = await client("Tester B", "#faa61a");

b.send(JSON.stringify({ type: "state", mapId: "ozernoe", fx: 0.25, fy: 0.75 }));
await new Promise((r) => setTimeout(r, 300));

log("done");
a.close();
b.close();
setTimeout(() => process.exit(0), 200);
