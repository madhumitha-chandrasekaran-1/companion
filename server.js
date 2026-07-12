require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const store = require("./store");
const keystore = require("./lib/keystore");
const { fetchTriviaQuestion } = require("./lib/trivia");
const { makeTavusFetch } = require("./lib/tavus-client");
const { upgradePersonaCapabilities } = require("./lib/tavus-persona");
const { TOOL_WEBHOOK_PATH, CONVERSATION_WEBHOOK_PATH, buildSystemPrompt } = require("./persona-config");

// Tavus/Anthropic keys are no longer read from .env — they're entered once
// through the app's own settings form and stored in data/keys.json (never
// typed into a chat, never committed). One-time migration for anyone who
// already had them in .env from before this existed:
keystore.seedFromEnvIfEmpty();

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const TOOL_WEBHOOK_SECRET = process.env.TAVUS_TOOL_WEBHOOK_SECRET || "";
// re8e740a42 (Phoenix-1) was deprecated by Tavus; using a current Phoenix-3 stock replica.
const DEFAULT_REPLICA_ID = "r9d30b0e55ac"; // "Luna"

if (!PUBLIC_BASE_URL || PUBLIC_BASE_URL.includes("localhost")) {
  console.warn(
    "[warn] PUBLIC_BASE_URL is not set to a real public HTTPS URL — Tavus cannot reach " +
      "this server to deliver trivia tool calls or canvas interactions until it is " +
      "(e.g. via ngrok or a real deployment)."
  );
}

function getAnthropicClient() {
  return new Anthropic({ apiKey: keystore.getAnthropicApiKey() });
}

// Blocks a route until both keys are set, returning a specific error shape
// the frontend recognizes and shows as a "please enter your API keys" popup
// rather than a generic failure.
function requireKeys(req, res, next) {
  const status = keystore.getStatus();
  if (!status.hasTavusKey || !status.hasAnthropicKey) {
    return res.status(400).json({ error: "Missing API keys", missingKeys: true, ...status });
  }
  next();
}

const app = express();
// Capture the raw body alongside the parsed one — HMAC verification for the
// Tavus tool webhook must be computed over the exact bytes Tavus signed.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
// no-store during active dev — the UI has been changing rapidly and a stale
// cached app.js referencing removed elements would throw at runtime and
// leave the page stuck blank (looks like a bug, is actually just caching).
app.use(express.static("public", { setHeaders: (res) => res.set("Cache-Control", "no-store") }));

const tavusFetch = makeTavusFetch(keystore.getTavusApiKey);

// POST /api/keys { tavusApiKey, anthropicApiKey } — never echoes values back.
app.post("/api/keys", (req, res) => {
  const { tavusApiKey, anthropicApiKey } = req.body || {};
  keystore.setKeys({ tavusApiKey, anthropicApiKey });
  res.json(keystore.getStatus());
});

// GET /api/keys/status — booleans only, never the actual key values.
app.get("/api/keys/status", (req, res) => {
  res.json(keystore.getStatus());
});

function buildConversationalContext(companion) {
  if (!companion.summary && (!companion.facts || companion.facts.length === 0)) {
    return "This is the very first time you're talking to this person. You don't know anything about them yet — get to know them.";
  }

  const parts = [];
  if (companion.summary) {
    parts.push(`Here's what you remember from your last conversation: ${companion.summary}`);
  }
  if (companion.facts && companion.facts.length > 0) {
    parts.push(`Things you know about them:\n- ${companion.facts.join("\n- ")}`);
  }
  return parts.join("\n\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function turnsToText(turns) {
  // Only user/assistant turns matter for memory — "system" turns are the giant
  // injected persona/SSML boilerplate, not anything the person actually said.
  const lines = turns
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .map((turn) => {
      const text = (turn.content || turn.text || turn.message || "").trim();
      return text ? `${turn.role}: ${text}` : null;
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : null;
}

function extractTranscriptText(conversation) {
  // Some responses may carry a transcript directly at the top level.
  if (typeof conversation?.transcript === "string" && conversation.transcript.trim().length > 0) {
    return conversation.transcript;
  }
  if (Array.isArray(conversation?.transcript) && conversation.transcript.length > 0) {
    return turnsToText(conversation.transcript);
  }

  // Actual observed Tavus shape (verbose=true): the transcript lives inside
  // events[], under the event with event_type "application.transcription_ready",
  // at properties.transcript — NOT as a top-level field.
  const events = Array.isArray(conversation?.events) ? conversation.events : [];
  const transcriptEvent = events.find((e) => e.event_type === "application.transcription_ready");
  const turns = transcriptEvent?.properties?.transcript;
  if (Array.isArray(turns) && turns.length > 0) {
    return turnsToText(turns);
  }

  return null;
}

// POST /api/companion/create { name }
app.post("/api/companion/create", requireKeys, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    const existing = store.getCompanion();
    if (existing) {
      return res.status(409).json({ error: "A companion already exists", companion: existing });
    }

    const persona = await tavusFetch("/personas", {
      method: "POST",
      body: JSON.stringify({
        persona_name: name.trim(),
        system_prompt: buildSystemPrompt(name.trim()),
        pipeline_mode: "full",
        default_replica_id: DEFAULT_REPLICA_ID,
      }),
    });

    try {
      await upgradePersonaCapabilities(tavusFetch, {
        personaId: persona.persona_id,
        companionName: name.trim(),
        publicBaseUrl: PUBLIC_BASE_URL,
        toolWebhookSecret: TOOL_WEBHOOK_SECRET,
      });
    } catch (err) {
      // Trivia/perception/TTS-emotion are enhancements, not core to having a
      // companion at all — log and continue rather than fail creation.
      console.warn(`Could not fully upgrade persona ${persona.persona_id} (continuing): ${err.message}`);
    }

    const companion = store.createCompanion({
      name: name.trim(),
      personaId: persona.persona_id,
    });

    res.json(companion);
  } catch (err) {
    console.error("companion/create failed:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Ends the Tavus conversation (if not already ended), polls for a transcript,
// summarizes it into memory, and clears the active-conversation marker.
// Used both by the explicit "End call" button and by orphan recovery below —
// a call can stop being "live" without the client ever telling us (dropped
// connection, closed tab, crash), so this must be safely re-triggerable.
async function finalizeCall(conversationId) {
  const companion = store.getCompanion();
  if (!companion) throw new Error("No companion exists yet");

  try {
    await tavusFetch(`/conversations/${conversationId}/end`, { method: "POST" });
  } catch (err) {
    // The conversation may have already ended on Tavus's side (dropped call,
    // timeout) — that's fine, we still want to try to fetch the transcript.
    console.warn(`finalizeCall: /end failed for ${conversationId} (continuing): ${err.message}`);
  }

  let transcriptText = null;
  const MAX_TRIES = 8;
  const RETRY_DELAY_MS = 2500;

  for (let attempt = 0; attempt < MAX_TRIES && !transcriptText; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    const conversation = await tavusFetch(`/conversations/${conversationId}?verbose=true`);
    transcriptText = extractTranscriptText(conversation);
  }

  store.clearActiveConversation();

  if (!transcriptText) {
    // No transcript available — still count the session, but nothing new learned.
    const updated = store.applyMemoryUpdate({
      updatedSummary: companion.summary,
      newFacts: [],
      greeting: companion.greeting,
    });
    return { companion: updated, newFacts: [], note: "No transcript was available for this call." };
  }

  const memoryUpdate = await summarizeTranscript({
    companionName: companion.name,
    priorSummary: companion.summary,
    transcriptText,
  });

  const updated = store.applyMemoryUpdate(memoryUpdate);
  return { companion: updated, newFacts: memoryUpdate.newFacts || [] };
}

// GET /api/companion
app.get("/api/companion", async (req, res) => {
  try {
    let companion = store.getCompanion();

    // Recover a call that never got a clean /api/call/end (dropped connection,
    // closed tab, crash) so memory from it isn't silently lost.
    if (companion?.activeConversationId) {
      console.log(`Recovering orphaned call ${companion.activeConversationId}...`);
      try {
        const result = await finalizeCall(companion.activeConversationId);
        companion = result.companion;
      } catch (err) {
        console.error("Orphaned call recovery failed:", err);
        store.clearActiveConversation();
        companion = store.getCompanion();
      }
    }

    res.json(companion);
  } catch (err) {
    console.error("GET /api/companion failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/call/start
app.post("/api/call/start", requireKeys, async (req, res) => {
  try {
    let companion = store.getCompanion();
    if (!companion) {
      return res.status(404).json({ error: "No companion exists yet" });
    }

    // Recover any call left dangling from a prior disconnect before starting a new one.
    if (companion.activeConversationId) {
      console.log(`Recovering orphaned call ${companion.activeConversationId} before starting a new one...`);
      try {
        const result = await finalizeCall(companion.activeConversationId);
        companion = result.companion;
      } catch (err) {
        console.error("Orphaned call recovery failed:", err);
        store.clearActiveConversation();
        companion = store.getCompanion();
      }
    }

    const conversationPayload = {
      persona_id: companion.personaId,
      replica_id: DEFAULT_REPLICA_ID,
      conversational_context: buildConversationalContext(companion),
      properties: {
        // Tavus's unset default is short enough to cut a real conversation
        // off mid-call (seen live: shutdown_reason "max_call_duration" at
        // ~5 minutes). 30 min is plenty for a catch-up call; raise if needed.
        max_call_duration: 1800,
        // Grace period before ending the call after the last participant
        // disconnects, instead of ending instantly on a brief network blip.
        participant_left_timeout: 60,
      },
    };
    // Canvas interaction events (tapped trivia answers) arrive at this URL.
    // Without a reachable public URL, conversations still work — cards just
    // won't be able to report answers back to us.
    if (PUBLIC_BASE_URL && !PUBLIC_BASE_URL.includes("localhost")) {
      conversationPayload.callback_url = `${PUBLIC_BASE_URL}${CONVERSATION_WEBHOOK_PATH}`;
    }

    const conversation = await tavusFetch("/conversations", {
      method: "POST",
      body: JSON.stringify(conversationPayload),
    });

    store.setActiveConversation(conversation.conversation_id);

    res.json({
      conversationUrl: conversation.conversation_url,
      conversationId: conversation.conversation_id,
    });
  } catch (err) {
    console.error("call/start failed:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/call/end { conversation_id }
app.post("/api/call/end", requireKeys, async (req, res) => {
  try {
    const { conversation_id: conversationId } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "conversation_id is required" });
    }

    const result = await finalizeCall(conversationId);
    res.json(result);
  } catch (err) {
    console.error("call/end failed:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

async function summarizeTranscript({ companionName, priorSummary, transcriptText }) {
  const message = await getAnthropicClient().messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system:
      `You maintain the long-term memory for ${companionName}, an AI companion having ongoing ` +
      `conversations with one person. Given the prior summary and a new call transcript, produce an ` +
      `updated summary, a short list of new discrete facts worth remembering, and a greeting. Respond ` +
      `with ONLY valid JSON matching this shape, no prose, no markdown fences: ` +
      `{"updated_summary": "string, 2-4 sentences", "new_facts": ["short fact", "..."], "greeting": "string"}. ` +
      `Keep facts atomic (one idea each), concrete, and non-redundant with the prior summary. ` +
      `If nothing new and noteworthy came up, return an empty new_facts array. ` +
      `The "updated_summary" and "new_facts" are internal notes ${companionName} uses to recall context — ` +
      `write them factually, in third person. The "greeting" is different: it's the one line ${companionName} ` +
      `will show the person the NEXT time they open the app, before any call starts. Write it in ` +
      `${companionName}'s own warm, casual, first-person voice, speaking directly to the person ("you"). ` +
      `One short sentence, like a friend who's genuinely excited to see them again — not a summary, not a ` +
      `recap, no bullet points. If something specific and low-stakes from this call is worth teasing ` +
      `("can't wait to hear how the GTM roadmap is going"), do that; otherwise keep it simple and warm ` +
      `("hey, glad you're back — can't wait to catch up"). Never mention that this is stored context, ` +
      `memory, a summary, or a system of any kind.`,
    messages: [
      {
        role: "user",
        content:
          `Prior summary: ${priorSummary || "(none — this was the first conversation)"}\n\n` +
          `New call transcript:\n${transcriptText}`,
      },
    ],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  const raw = textBlock ? textBlock.text.trim() : "{}";

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (err) {
    console.error("Failed to parse memory update JSON:", raw);
    parsed = { updated_summary: priorSummary, new_facts: [], greeting: "" };
  }

  return {
    updatedSummary: parsed.updated_summary || priorSummary,
    newFacts: Array.isArray(parsed.new_facts) ? parsed.new_facts : [],
    greeting: parsed.greeting || "",
  };
}

// Verifies the X-Tavus-Signature header (HMAC-SHA256 of the raw request body)
// against our shared secret. If no secret is configured, verification is
// skipped — fine for early local testing, but the endpoint is then open to
// anyone who finds the URL, so this should always be set once deployed.
function verifyTavusSignature(req) {
  if (!TOOL_WEBHOOK_SECRET) return true;

  const signature = req.get("X-Tavus-Signature");
  if (!signature) return false;

  const expected = crypto.createHmac("sha256", TOOL_WEBHOOK_SECRET).update(req.rawBody || Buffer.alloc(0)).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false; // mismatched length, malformed header, etc.
  }
}

// Executes tool calls the LLM makes mid-conversation. Response body becomes
// the tool result fed back to the LLM (per Tavus's "api" delivery contract).
app.post(TOOL_WEBHOOK_PATH, async (req, res) => {
  if (!verifyTavusSignature(req)) {
    console.warn("Rejected tool webhook call: invalid or missing signature");
    return res.status(401).send("invalid signature");
  }

  const { name, arguments: argsRaw, tool_call_id: toolCallId } = req.body || {};
  console.log(`Tool call: ${name} (${toolCallId || "no id"})`);

  try {
    let args = {};
    if (typeof argsRaw === "string" && argsRaw.trim()) {
      args = JSON.parse(argsRaw);
    } else if (argsRaw && typeof argsRaw === "object") {
      args = argsRaw;
    }

    if (name === "get_trivia_question") {
      const trivia = await fetchTriviaQuestion(args.topic);
      return res.status(200).json(trivia);
    }

    return res.status(400).send(`Unknown tool: ${name}`);
  } catch (err) {
    console.error(`Tool call "${name}" failed:`, err);
    return res.status(500).send(`Tool execution failed: ${err.message}`);
  }
});

// Receives conversation-level events set via callback_url, including
// canvas.interaction when the user taps an answer on a trivia card.
app.post(CONVERSATION_WEBHOOK_PATH, (req, res) => {
  const event = req.body || {};
  if (event.event_type === "canvas.interaction") {
    console.log("Canvas interaction:", JSON.stringify(event.properties));
  } else {
    console.log(`Conversation webhook event: ${event.event_type || "(unknown)"}`);
  }
  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`tavus-companion server running at http://localhost:${PORT}`);
});
