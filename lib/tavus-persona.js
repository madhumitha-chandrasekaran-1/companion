const { buildSystemPrompt, buildPersonaLayers, buildTriviaToolDefinition } = require("../persona-config");

// Finds an existing tool by name (tools are unique-per-account), or creates
// it fresh. Reuse-by-name keeps repeat calls (e.g. re-running the upgrade
// script) from erroring on a name conflict — the tradeoff is that if
// PUBLIC_BASE_URL changes later, the existing tool's delivery URL goes
// stale until it's deleted and recreated (DELETE /v2/tools/{id} is real
// and confirmed working, just not automated here since detecting "is this
// still correct" isn't safe to guess at).
async function findOrCreateTriviaTool(tavusFetch, toolDefinition) {
  const { data: existingTools } = await tavusFetch("/tools");
  const existing = (existingTools || []).find((t) => t.name === toolDefinition.name);
  if (existing) {
    console.log(`Reusing existing tool "${toolDefinition.name}" (${existing.tool_id})`);
    return existing.tool_id;
  }

  const created = await tavusFetch("/tools", {
    method: "POST",
    body: JSON.stringify(toolDefinition),
  });
  console.log(`Created tool "${toolDefinition.name}" (${created.tool_id})`);
  return created.tool_id;
}

async function enableMagicCanvas(tavusFetch, personaId) {
  try {
    await tavusFetch(`/pals/${personaId}/skills/magic_canvas`, {
      method: "PUT",
      body: JSON.stringify({ config: { components: { question: { enabled: true } } } }),
    });
    console.log(`Magic Canvas enabled for persona ${personaId}`);
  } catch (err) {
    console.warn(`Could not enable Magic Canvas for persona ${personaId} (continuing without it): ${err.message}`);
  }
}

// Applies trivia + perception + TTS-emotion + Magic Canvas to a persona.
// Used both at companion-creation time and by scripts/upgrade-persona.js to
// retrofit a persona created before this feature existed.
//
// System prompt / perception / TTS emotion don't depend on a public URL and
// always run first. Trivia's tool registration requires an HTTPS
// delivery.api.url (Tavus rejects anything else outright) — it's attempted
// last and failure there doesn't undo the rest.
async function upgradePersonaCapabilities(tavusFetch, { personaId, companionName, publicBaseUrl, toolWebhookSecret }) {
  const layers = buildPersonaLayers();
  await tavusFetch(`/pals/${personaId}`, {
    method: "PATCH",
    body: JSON.stringify([
      { op: "replace", path: "/system_prompt", value: buildSystemPrompt(companionName) },
      { op: "add", path: "/layers/perception", value: layers.perception },
      { op: "add", path: "/layers/tts", value: layers.tts },
      // Target the specific leaf field, not the whole conversational_flow
      // object — that object already has good defaults (turn_detection_model,
      // voice_isolation, etc.) that "add"-ing the whole sub-object would wipe.
      {
        op: "add",
        path: "/layers/conversational_flow/turn_taking_patience",
        value: layers.conversational_flow.turn_taking_patience,
      },
    ]),
  });
  console.log(`Patched system_prompt, perception, and tts layers on persona ${personaId}`);

  await enableMagicCanvas(tavusFetch, personaId);

  try {
    const toolDefinition = buildTriviaToolDefinition({ publicBaseUrl, toolWebhookSecret });
    const toolId = await findOrCreateTriviaTool(tavusFetch, toolDefinition);

    await tavusFetch(`/pals/${personaId}/tools`, {
      method: "POST",
      body: JSON.stringify({ tool_ids: [toolId] }),
    });
    console.log(`Attached tool ${toolId} to persona ${personaId}`);
  } catch (err) {
    console.warn(
      `Trivia tool not registered (continuing without it): ${err.message}\n` +
        `  This needs PUBLIC_BASE_URL to be a real HTTPS URL Tavus can reach — ` +
        `set it and re-run this script to enable trivia.`
    );
  }
}

module.exports = { upgradePersonaCapabilities };
