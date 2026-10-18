// Tiny fixed-window in-memory rate limiter, keyed by client IP.
function createLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  timer.unref();
  return function allow(key) {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    h.count++;
    return { ok: h.count <= max, retryAfter: Math.ceil((h.reset - now) / 1000) };
  };
}

module.exports = { createLimiter };
