/**
 * Preflight for running the app as a Discord Activity.
 * Usage: npm run discord:check
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const id = (process.env.DISCORD_CLIENT_ID || "").trim();
const secret = (process.env.DISCORD_CLIENT_SECRET || "").trim();
const port = process.env.PORT || "3001";

const ok = (b) => (b ? "OK  " : "!!  ");
const lines = [];
let good = true;

lines.push(`[${existsSync(join(root, ".env")) ? "OK  " : "!!  "}] .env ${existsSync(join(root, ".env")) ? "found" : "missing (copy .env.example -> .env)"}`);
if (!existsSync(join(root, ".env"))) good = false;

const idValid = /^\d{17,20}$/.test(id);
lines.push(`[${ok(idValid)}] DISCORD_CLIENT_ID ${idValid ? "set" : "not set / invalid (должен быть 17-20 цифр)"}`);
if (!idValid) good = false;

const secretValid = secret.length >= 20;
lines.push(`[${ok(secretValid)}] DISCORD_CLIENT_SECRET ${secretValid ? "set" : "not set"}`);
if (!secretValid) good = false;

const sdk = join(root, "node_modules", "@discord", "embedded-app-sdk", "output", "index.mjs");
lines.push(`[${ok(existsSync(sdk))}] embedded-app-sdk ${existsSync(sdk) ? "installed" : "missing (npm install)"}`);
if (!existsSync(sdk)) good = false;

const data = join(root, "public", "data", "amh-maps.json");
lines.push(`[${ok(existsSync(data))}] map data ${existsSync(data) ? "present" : "missing (npm run import-amh)"}`);
if (!existsSync(data)) good = false;

console.log("\nDiscord Activity preflight\n" + lines.join("\n") + "\n");

if (!good) {
  console.log("Исправь пункты с !! и запусти снова.\n");
}

console.log(`1) npm start              # сервер на http://localhost:${port}`);
console.log("2) npm run tunnel         # cloudflared выдаст https://<slug>.trycloudflare.com");
console.log("3) Discord Dev Portal -> Activities -> URL Mappings:");
console.log("     PREFIX: /      TARGET: <slug>.trycloudflare.com   (без https://)");
console.log("4) Activities -> Settings -> Enable Activities");
console.log("5) В канале: App Launcher -> выбери приложение\n");
console.log(good ? "Конфиг готов — можно запускать." : "Сначала заполни .env.");
process.exit(good ? 0 : 1);
