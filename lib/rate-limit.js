'use strict';

function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.startedAt >= windowMs) {
        hits.delete(key);
      }
    }
  }, Math.min(windowMs, 60_000));
  cleanupTimer.unref?.();

  return function rateLimiter(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || now - entry.startedAt >= windowMs) {
      entry = { startedAt: now, count: 0 };
      hits.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));

    if (entry.count > max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((entry.startedAt + windowMs - now) / 1000)
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: message || 'Too many requests. Please slow down and try again.'
      });
    }

    return next();
  };
}

module.exports = { createRateLimiter };
