// api/approval.js — Vercel Serverless Function (Node.js)
// deps: @vercel/kv  (add Vercel KV integration in dashboard)
// env:  BOT_SECRET, KV_REST_API_URL, KV_REST_API_TOKEN (injected by Vercel KV)

import { kv } from '@vercel/kv';

const BOT_SECRET     = process.env.BOT_SECRET || 'rn_restnight_2024';
const TTL_MS         = 86_400_000;
const TTL_S          = 86_400;
const VALID_TIERS    = new Set(['high', 'ultra']);
const SESSION_KEY_RE = /^Rest-[A-Za-z0-9]{10,11}$/;

const rateBucket = new Map();
const RATE_WINDOW_MS = 10_000;
const RATE_MAX       = 5;

function checkRate(id) {
  const now = Date.now();
  const b   = rateBucket.get(id);
  if (!b || now - b.windowStart > RATE_WINDOW_MS) {
    rateBucket.set(id, { count: 1, windowStart: now });
    return true;
  }
  b.count++;
  return b.count <= RATE_MAX;
}

let lastPrune = 0;
function maybePrune() {
  const now = Date.now();
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [k, v] of rateBucket)
    if (now - v.windowStart > RATE_WINDOW_MS * 2) rateBucket.delete(k);
}

// Retry wrapper cho KV — 2 lần, delay 120ms giữa các lần.
// Cold-start trên Vercel REST adapter thường chỉ cần một lần retry.
async function kvWithRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { value: await fn(), err: null };
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise(r => setTimeout(r, 120));
    }
  }
  return { value: undefined, err: lastErr };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  maybePrune();

  if (req.method === 'GET') {
    const { key, tier } = req.query;
    if (!key || !tier)             return res.status(400).json({ error: 'Missing key or tier' });
    if (!SESSION_KEY_RE.test(key)) return res.status(400).json({ error: 'Invalid session key format' });
    if (!VALID_TIERS.has(tier))    return res.status(400).json({ error: 'Invalid tier' });

    const ip     = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? 'unknown';
    const rateId = ip + ':' + key;
    if (!checkRate(rateId))
      return res.status(429).json({ error: 'Too many requests', retryAfter: 10 });

    const { value: record, err } = await kvWithRetry(() => kv.get(`approval:${key}:${tier}`));
    if (err) return res.status(502).json({ error: 'KV unavailable' });

    if (!record) return res.json({ approved: false });

    const age = Date.now() - record.ts;
    if (age > TTL_MS) {
      kv.del(`approval:${key}:${tier}`).catch(() => {});
      return res.json({ approved: false, expired: true });
    }

    return res.json({ approved: true, tier: record.tier, ts: record.ts, by: record.by });
  }

  if (req.method === 'POST') {
    if (!BOT_SECRET || req.headers['x-bot-secret'] !== BOT_SECRET)
      return res.status(401).json({ error: 'Unauthorized' });

    const { key, tier, by, action = 'approve' } = req.body ?? {};
    if (!key || !tier)              return res.status(400).json({ error: 'Missing key or tier' });
    if (!SESSION_KEY_RE.test(key))  return res.status(400).json({ error: 'Invalid session key format' });
    if (!VALID_TIERS.has(tier))     return res.status(400).json({ error: 'Invalid tier' });
    if (!['approve', 'revoke'].includes(action))
                                    return res.status(400).json({ error: 'Invalid action' });

    const kvKey = `approval:${key}:${tier}`;

    if (action === 'revoke') {
      const { err } = await kvWithRetry(() => kv.del(kvKey));
      if (err) return res.status(502).json({ error: 'KV unavailable' });
      return res.json({ ok: true, action: 'revoked', tier, key });
    }

    const { err } = await kvWithRetry(() =>
      kv.set(kvKey, { tier, by: by ?? 'unknown', ts: Date.now(), key }, { ex: TTL_S })
    );
    if (err) return res.status(502).json({ error: 'KV unavailable' });
    return res.json({ ok: true, action: 'approved', tier, key });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
