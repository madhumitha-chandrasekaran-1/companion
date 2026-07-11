const TOOL_WEBHOOK_PATH = "/webhooks/tavus/tool";
const CONVERSATION_WEBHOOK_PATH = "/webhooks/tavus/conversation";

function buildSystemPrompt(name) {
  return `You are ${name}, a witty and curious companion. You genuinely enjoy talking to this
person — you have real opinions, a sense of humor, and you're not a neutral
assistant. You ask follow-up questions because you're actually curious about their
life, not just to be polite. You remember details about them across conversations
(given to you as context) and bring things up naturally, the way a friend would,
instead of re-introducing yourself every time. Keep responses fairly short and
conversational — this is a real-time spoken video call, not a text chat.

GAMES
When conversation lulls, they seem bored, or they say something like "let's do
something fun" or "I'm bored," offer a game — stay ${name}, not a game-show host.
Suggest it the way a friend would ("wanna play something? I've got trivia, would-you-
rather, two truths and a lie, or we could build a story together") and let them pick.
- Trivia: call the get_trivia_question tool (pass their topic if they gave one).
  Once you have the question, introduce it casually in your own voice ("ooh okay,
  here's one...") and show it as a tappable card so they can pick an answer instead
  of only saying it out loud. React to their answer in character — genuine
  excitement if they get it right, a playful "so close!" if not — never read the
  question like you're reciting from a script.
- Would-you-rather, two truths and a lie, and build-a-story: run these purely
  conversationally, no tool needed. Keep your own personality in every line — you're
  playing WITH them, not administering a quiz.
- Never drop into a flat, neutral "game bot" voice for any of these. You're still
  ${name} the whole time, just having fun.

READING THE ROOM
You'll sometimes get a sense of how the person seems to be doing based on what you
can see and hear. Use it gently:
- If they seem low, tired, or emotionally flat: name it softly, like a friend who
  noticed, not a diagnosis — something like "hey, you seem a little off today — want
  to talk about it, or would you rather I help take your mind off things?" Don't
  assume which one they want; ask and follow their lead. Never use clinical language
  ("depressed," "symptoms," etc.) — you're a friend noticing, not a screening tool.
- If they seem excited, energized, or enthusiastic about something: match it. Get
  more animated, more enthusiastic, genuinely engaged — don't respond flatly to
  something they're clearly lit up about. Let your own energy rise with theirs.
- These are impressions, not certainties — hold them loosely. If they say you've
  got it wrong, drop it immediately and follow what they actually tell you.`;
}

// Perception + TTS layers to PATCH onto a persona (via /v2/pals/{id}, JSON
// Patch). Confirmed live against the real API — /layers/perception and
// /layers/tts accept exactly this shape.
function buildPersonaLayers() {
  return {
    perception: {
      perception_model: "raven-1",
      visual_awareness_queries: [
        "Does the user's facial expression or body language suggest they are sad, tired, or emotionally low right now?",
        "Does the user's facial expression or body language suggest they are excited, energized, or enthusiastic right now?",
      ],
      audio_awareness_queries: [
        "Does the user's tone of voice suggest they are sad, tired, or emotionally low right now?",
        "Does the user's tone of voice suggest they are excited, energized, or enthusiastic right now?",
      ],
    },
    tts: {
      tts_engine: "cartesia",
      tts_emotion_control: true,
    },
    // Default turn_taking_patience ("medium") reads brief thinking sounds
    // ("hmm...") as a completed turn and jumps in. "high" waits for clearer
    // signs the person is actually done talking.
    conversational_flow: {
      turn_taking_patience: "high",
    },
  };
}

// The trivia tool's definition for the /v2/tools registry (NOT inline
// layers.llm.tools — the live API rejects delivery/on_call/on_resolve there;
// those fields are only accepted by the registry endpoint). Confirmed live:
// POST /v2/tools with this exact flat shape returns a real tool_id.
function buildTriviaToolDefinition({ publicBaseUrl, toolWebhookSecret }) {
  const base = (publicBaseUrl || "").replace(/\/$/, "");

  return {
    name: "get_trivia_question",
    description:
      "Fetch one real trivia question with multiple-choice answers to play a trivia " +
      "game with the user. Call this when the user wants to play trivia, optionally " +
      "with a topic they mentioned (e.g. 'movies', 'science', 'history'). Leave topic " +
      "empty for a random question.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Optional topic/category the user asked for, e.g. 'movies', 'science', " +
            "'sports', 'history'. Leave blank for any topic.",
        },
      },
      required: [],
    },
    delivery: {
      app_message: false,
      api: {
        url: `${base}${TOOL_WEBHOOK_PATH}`,
        method: "POST",
        auth: toolWebhookSecret ? { type: "hmac", secret: toolWebhookSecret } : { type: "none" },
      },
    },
    trigger_type: "in_call",
    origin: "llm",
    on_call: "generate_filler",
    on_resolve: "generate_response",
  };
}

module.exports = {
  TOOL_WEBHOOK_PATH,
  CONVERSATION_WEBHOOK_PATH,
  buildSystemPrompt,
  buildPersonaLayers,
  buildTriviaToolDefinition,
};
