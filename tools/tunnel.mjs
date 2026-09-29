/**
 * Starts a cloudflared quick tunnel to the local server and prints the public URL.
 * Usage: npm run tunnel
 *
 * Uses tools/cloudflared(.exe) if present, otherwise falls back to PATH.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "dotenv/config";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || "3001";

const local = join(root, "tools", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
const bin = existsSync(local) ? local : "cloudflared";

const args = ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"];
console.log(`Starting tunnel: ${bin} ${args.join(" ")}`);
console.log("Оставь это окно открытым. Скопируй публичный URL в Discord URL Mappings.\n");

const child = spawn(bin, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let found = false;

const onData = (buf) => {
  const text = buf.toString();
  process.stdout.write(text);
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m && !found) {
    found = true;
    const url = m[0];
    try {
      writeFileSync(join(root, ".tunnel-url.txt"), url + "\n");
    } catch {}
    console.log(`\n=== ПУБЛИЧНЫЙ URL: ${url}`);
    console.log(`=== URL Mapping TARGET (без https://): ${url.replace("https://", "")}\n`);
  }
};

child.stdout.on("data", onData);
child.stderr.on("data", onData);
child.on("error", (err) => {
  console.error("Не удалось запустить cloudflared:", err.message);
  console.error("Установи его или положи бинарник в tools/cloudflared(.exe).");
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
