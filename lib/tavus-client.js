const TAVUS_BASE = "https://tavusapi.com/v2";

// Accepts either a fixed key string or a function returning the current key
// (so callers can read a key that changes at runtime, e.g. set via the
// settings UI after the server already started) — resolved fresh per call.
function makeTavusFetch(apiKeyOrGetter) {
  return async function tavusFetch(pathname, options = {}) {
    const apiKey = typeof apiKeyOrGetter === "function" ? apiKeyOrGetter() : apiKeyOrGetter;
    if (!apiKey) {
      const err = new Error("No Tavus API key configured");
      err.status = 400;
      err.missingKeys = true;
      throw err;
    }

    const res = await fetch(`${TAVUS_BASE}${pathname}`, {
      ...options,
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!res.ok) {
      const message = body?.message || body?.error || text || `Tavus API error (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }

    return body;
  };
}

module.exports = { makeTavusFetch };
