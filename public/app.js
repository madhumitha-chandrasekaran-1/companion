const greetingLayer = document.getElementById("greeting-layer");
const interludeLayer = document.getElementById("interlude-layer");
const waitingText = document.getElementById("waiting-text");
const btnCall = document.getElementById("btn-call");

let currentConversationId = null;
let currentCompanionName = "";
let readyHasTalkedBefore = false;
let callTimerInterval = null;
let callStartedAt = null;

const MIN_INTERLUDE_MS = 1400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startCallTimer() {
  callStartedAt = Date.now();
  const el = document.getElementById("call-timer");
  el.textContent = "00:00";
  callTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartedAt) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");
    el.textContent = `${m}:${s}`;
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = null;
}

// ---------- App views ----------

const views = {
  setup: document.getElementById("view-setup"),
  ready: document.getElementById("view-ready"),
  call: document.getElementById("view-call"),
  recap: document.getElementById("view-recap"),
  ending: document.getElementById("view-ending"),
};

function showView(name) {
  Object.values(views).forEach((el) => el.classList.add("hidden"));
  views[name].classList.remove("hidden");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    if (body.missingKeys) err.missingKeys = true;
    throw err;
  }
  return body;
}

// ---------- Toast ----------

let toastTimeout = null;

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("show"), 4000);
}

// ---------- Settings modal ----------

const settingsBackdrop = document.getElementById("settings-backdrop");

function setKeyStatusDot(el, hasKey) {
  el.classList.toggle("ok", hasKey);
}

async function refreshKeyStatus() {
  try {
    const status = await api("/api/keys/status");
    const anyMissing = !status.hasTavusKey || !status.hasAnthropicKey;
    setKeyStatusDot(document.getElementById("key-status-dot"), !anyMissing);
    setKeyStatusDot(document.getElementById("tavus-status-dot"), status.hasTavusKey);
    setKeyStatusDot(document.getElementById("anthropic-status-dot"), status.hasAnthropicKey);
    document.getElementById("tavus-status-text").textContent = status.hasTavusKey ? "Saved" : "Not set";
    document.getElementById("anthropic-status-text").textContent = status.hasAnthropicKey ? "Saved" : "Not set";
    return status;
  } catch {
    return { hasTavusKey: false, hasAnthropicKey: false };
  }
}

function openSettings() {
  document.getElementById("input-tavus-key").value = "";
  document.getElementById("input-anthropic-key").value = "";
  refreshKeyStatus();
  settingsBackdrop.classList.remove("hidden");
}

function closeSettings() {
  settingsBackdrop.classList.add("hidden");
}

document.getElementById("btn-open-settings").addEventListener("click", openSettings);
document.getElementById("btn-close-settings").addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", (e) => {
  if (e.target === settingsBackdrop) closeSettings();
});

document.getElementById("form-keys").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tavusApiKey = document.getElementById("input-tavus-key").value.trim();
  const anthropicApiKey = document.getElementById("input-anthropic-key").value.trim();
  const btn = document.getElementById("btn-save-keys");

  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    await api("/api/keys", {
      method: "POST",
      body: JSON.stringify({ tavusApiKey, anthropicApiKey }),
    });
    document.getElementById("input-tavus-key").value = "";
    document.getElementById("input-anthropic-key").value = "";
    await refreshKeyStatus();
    showToast("API keys saved.");
  } catch (err) {
    showToast(`Couldn't save keys: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
});

function handleMissingKeys() {
  showToast("Please enter your Tavus and Anthropic API key.");
  openSettings();
}

function renderReady(companion) {
  currentCompanionName = companion.name;
  readyHasTalkedBefore = Boolean(companion.summary || (companion.facts && companion.facts.length > 0));

  document.getElementById("ready-eyebrow").textContent = readyHasTalkedBefore ? "Welcome back" : "New here";
  document.getElementById("ready-heading").textContent = `Call ${companion.name}`;
  document.getElementById("ready-summary").textContent =
    companion.greeting ||
    (readyHasTalkedBefore ? "So excited to catch up with you." : "Let's get to know each other.");

  const sessionCount = companion.sessionCount || 0;
  document.getElementById("ready-session-count").textContent =
    sessionCount === 0 ? "No calls yet" : `${sessionCount} call${sessionCount === 1 ? "" : "s"} so far`;

  document.getElementById("ready-error").classList.add("hidden");
  interludeLayer.classList.add("hidden");
  greetingLayer.classList.remove("hidden");
  btnCall.disabled = false;

  showView("ready");
}

async function loadInitialState() {
  const companion = await api("/api/companion");
  if (!companion) {
    showView("setup");
  } else {
    renderReady(companion);
  }
}

document.getElementById("form-setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("companion-name");
  const errorEl = document.getElementById("setup-error");
  const btn = document.getElementById("btn-create");

  errorEl.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Creating…";

  try {
    const companion = await api("/api/companion/create", {
      method: "POST",
      body: JSON.stringify({ name: nameInput.value.trim() }),
    });
    renderReady(companion);
  } catch (err) {
    if (err.missingKeys) {
      handleMissingKeys();
    } else {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Create companion";
  }
});

btnCall.addEventListener("click", async () => {
  if (btnCall.disabled) return;
  document.getElementById("ready-error").classList.add("hidden");

  const status = await refreshKeyStatus();
  if (!status.hasTavusKey || !status.hasAnthropicKey) {
    handleMissingKeys();
    return;
  }

  btnCall.disabled = true;
  greetingLayer.classList.add("hidden");
  waitingText.textContent = readyHasTalkedBefore ? "Pulling up your memories…" : "Setting things up…";
  interludeLayer.classList.remove("hidden");

  let apiDone = false;
  let apiResult = null;
  let apiError = null;
  const apiPromise = api("/api/call/start", { method: "POST" })
    .then((r) => { apiDone = true; apiResult = r; })
    .catch((e) => { apiDone = true; apiError = e; });

  await sleep(MIN_INTERLUDE_MS);
  if (!apiDone) {
    waitingText.textContent = `Connecting to ${currentCompanionName}…`;
  }
  await apiPromise;

  interludeLayer.classList.add("hidden");

  if (apiError) {
    greetingLayer.classList.remove("hidden");
    btnCall.disabled = false;
    if (apiError.missingKeys) {
      handleMissingKeys();
    } else {
      const errorEl = document.getElementById("ready-error");
      errorEl.textContent = apiError.message;
      errorEl.classList.remove("hidden");
    }
    return;
  }

  currentConversationId = apiResult.conversationId;
  document.getElementById("call-iframe").src = apiResult.conversationUrl;
  showView("call");
  startCallTimer();
});

document.getElementById("btn-end-call").addEventListener("click", async () => {
  if (!currentConversationId) return;

  stopCallTimer();
  showView("ending");
  document.getElementById("call-iframe").src = "about:blank";

  try {
    const result = await api("/api/call/end", {
      method: "POST",
      body: JSON.stringify({ conversation_id: currentConversationId }),
    });

    const factsEl = document.getElementById("recap-facts");
    const noteEl = document.getElementById("recap-note");
    factsEl.innerHTML = "";

    if (result.newFacts && result.newFacts.length > 0) {
      result.newFacts.forEach((fact) => {
        const li = document.createElement("li");
        li.textContent = fact;
        factsEl.appendChild(li);
      });
      noteEl.classList.add("hidden");
    } else {
      noteEl.textContent = result.note || "Nothing new to add this time — just a good chat.";
      noteEl.classList.remove("hidden");
    }

    currentConversationId = null;
    showView("recap");

    // Keep the ready view current for when the user clicks "Back".
    if (result.companion) renderReady(result.companion);
  } catch (err) {
    document.getElementById("recap-facts").innerHTML = "";
    const noteEl = document.getElementById("recap-note");
    noteEl.textContent = `Couldn't save what we talked about: ${err.message}`;
    noteEl.classList.remove("hidden");
    showView("recap");
  }
});

document.getElementById("btn-recap-continue").addEventListener("click", async () => {
  try {
    const companion = await api("/api/companion");
    if (companion) renderReady(companion);
    else showView("setup");
  } catch {
    showView("recap");
  }
});

// Dev-only: ?preview=recap|ending|call jumps straight to that screen with
// sample data, so screens that normally require a live call can be checked
// visually without spending call credits. Safe to remove any time.
function runDevPreview() {
  const preview = new URLSearchParams(location.search).get("preview");
  if (!preview) return false;

  if (preview === "recap") {
    const factsEl = document.getElementById("recap-facts");
    factsEl.innerHTML = "";
    ["Sample fact one", "Sample fact two", "Sample fact three"].forEach((fact) => {
      const li = document.createElement("li");
      li.textContent = fact;
      factsEl.appendChild(li);
    });
    document.getElementById("recap-note").classList.add("hidden");
    showView("recap");
    return true;
  }

  if (preview === "ending") {
    showView("ending");
    return true;
  }

  if (preview === "call") {
    document.getElementById("call-iframe").src = "about:blank";
    showView("call");
    startCallTimer();
    return true;
  }

  return false;
}

refreshKeyStatus();

if (!runDevPreview()) {
  loadInitialState().catch((err) => {
    console.error("Failed to load companion state:", err);
    showView("setup");
  });
}
