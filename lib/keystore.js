// Stores the user's Tavus/Anthropic API keys locally (data/keys.json,
// gitignored) instead of requiring them in .env. Keys reach this module only
// via the UI's settings form — never typed into a chat or committed to a
// tracked file. GET endpoints must never echo the raw key values back.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const KEYS_FILE = path.join(DATA_DIR, "keys.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readKeys() {
  ensureDataDir();
  if (!fs.existsSync(KEYS_FILE)) return { tavusApiKey: "", anthropicApiKey: "" };
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
  } catch {
    return { tavusApiKey: "", anthropicApiKey: "" };
  }
}

function writeKeys(keys) {
  ensureDataDir();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

// One-time migration: if keys.json doesn't exist yet but .env has keys
// (from before this feature existed), seed it so the app keeps working
// without forcing immediate re-entry.
function seedFromEnvIfEmpty() {
  if (fs.existsSync(KEYS_FILE)) return;
  const envTavus = process.env.TAVUS_API_KEY || "";
  const envAnthropic = process.env.ANTHROPIC_API_KEY || "";
  if (envTavus || envAnthropic) {
    writeKeys({ tavusApiKey: envTavus, anthropicApiKey: envAnthropic });
    console.log("Seeded data/keys.json from .env (one-time migration).");
  }
}

function getTavusApiKey() {
  return readKeys().tavusApiKey || "";
}

function getAnthropicApiKey() {
  return readKeys().anthropicApiKey || "";
}

function setKeys({ tavusApiKey, anthropicApiKey }) {
  const current = readKeys();
  const next = {
    tavusApiKey: typeof tavusApiKey === "string" ? tavusApiKey.trim() : current.tavusApiKey,
    anthropicApiKey: typeof anthropicApiKey === "string" ? anthropicApiKey.trim() : current.anthropicApiKey,
  };
  writeKeys(next);
  return next;
}

function getStatus() {
  const keys = readKeys();
  return {
    hasTavusKey: Boolean(keys.tavusApiKey),
    hasAnthropicKey: Boolean(keys.anthropicApiKey),
  };
}

module.exports = { seedFromEnvIfEmpty, getTavusApiKey, getAnthropicApiKey, setKeys, getStatus };
