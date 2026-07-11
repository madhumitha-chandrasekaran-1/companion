const TAVUS_BASE = "https://tavusapi.com/v2";

function makeTavusFetch(apiKey) {
  return async function tavusFetch(pathname, options = {}) {
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
