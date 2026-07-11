const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "companion.json");
const MAX_FACTS = 40;

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "null");
}

function getCompanion() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}

function saveCompanion(companion) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(companion, null, 2));
  return companion;
}

function createCompanion({ name, personaId }) {
  return saveCompanion({
    name,
    personaId,
    summary: "",
    facts: [],
    greeting: "",
    sessionCount: 0,
    activeConversationId: null,
    createdAt: new Date().toISOString(),
  });
}

function setActiveConversation(conversationId) {
  const companion = getCompanion();
  if (!companion) throw new Error("No companion exists yet");
  companion.activeConversationId = conversationId;
  return saveCompanion(companion);
}

function clearActiveConversation() {
  const companion = getCompanion();
  if (!companion) return null;
  companion.activeConversationId = null;
  return saveCompanion(companion);
}

function applyMemoryUpdate({ updatedSummary, newFacts, greeting }) {
  const companion = getCompanion();
  if (!companion) throw new Error("No companion exists yet");

  companion.summary = updatedSummary || companion.summary;
  companion.greeting = greeting || companion.greeting;

  const merged = [...companion.facts, ...(newFacts || [])];
  companion.facts = merged.slice(Math.max(0, merged.length - MAX_FACTS));
  companion.sessionCount += 1;

  return saveCompanion(companion);
}

module.exports = {
  getCompanion,
  saveCompanion,
  createCompanion,
  applyMemoryUpdate,
  setActiveConversation,
  clearActiveConversation,
};
