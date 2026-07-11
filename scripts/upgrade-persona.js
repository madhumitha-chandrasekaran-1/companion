// One-off: retrofits trivia/perception/TTS-emotion/Magic Canvas onto a persona
// that was created before this feature existed (i.e. the existing "Sage").
// New companions get all of this from POST /api/companion/create directly —
// this script exists only to bring an already-created persona up to date.
//
// Usage: node scripts/upgrade-persona.js

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("../store");
const { makeTavusFetch } = require("../lib/tavus-client");
const { upgradePersonaCapabilities } = require("../lib/tavus-persona");

const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
const ENV_PATH = path.join(__dirname, "..", ".env");

function ensureToolWebhookSecret() {
  let envText = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf-8") : "";
  const match = envText.match(/^TAVUS_TOOL_WEBHOOK_SECRET=(.*)$/m);

  if (match && match[1].trim()) {
    return match[1].trim();
  }

  const secret = crypto.randomBytes(24).toString("hex");
  if (match) {
    envText = envText.replace(/^TAVUS_TOOL_WEBHOOK_SECRET=.*$/m, `TAVUS_TOOL_WEBHOOK_SECRET=${secret}`);
  } else {
    envText += `${envText.endsWith("\n") || envText === "" ? "" : "\n"}TAVUS_TOOL_WEBHOOK_SECRET=${secret}\n`;
  }
  fs.writeFileSync(ENV_PATH, envText);
  console.log("Generated TAVUS_TOOL_WEBHOOK_SECRET and saved it to .env");
  return secret;
}

async function main() {
  const companion = store.getCompanion();
  if (!companion) {
    console.error("No companion found in data/companion.json — nothing to upgrade.");
    process.exit(1);
  }

  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!publicBaseUrl || publicBaseUrl.includes("localhost")) {
    console.warn(
      "\n[warn] PUBLIC_BASE_URL is not set to a real public HTTPS URL in .env.\n" +
        "       The persona will still be upgraded, but trivia tool calls and canvas\n" +
        "       interactions can't reach this server until PUBLIC_BASE_URL points to\n" +
        "       one (e.g. an ngrok tunnel: `ngrok http 3000`, then set\n" +
        "       PUBLIC_BASE_URL=https://<your-subdomain>.ngrok-free.app in .env and\n" +
        "       re-run this script).\n"
    );
  }

  const toolWebhookSecret = ensureToolWebhookSecret();
  const tavusFetch = makeTavusFetch(TAVUS_API_KEY);

  console.log(`Upgrading persona ${companion.personaId} (${companion.name})...`);
  await upgradePersonaCapabilities(tavusFetch, {
    personaId: companion.personaId,
    companionName: companion.name,
    publicBaseUrl,
    toolWebhookSecret,
  });

  console.log(`\n${companion.name} is upgraded. Trivia, perception, and TTS emotion are configured.`);
  if (!publicBaseUrl || publicBaseUrl.includes("localhost")) {
    console.log("Remember: set a real PUBLIC_BASE_URL and re-run this script before testing trivia live.");
  }
}

main().catch((err) => {
  console.error("Upgrade failed:", err);
  process.exit(1);
});
