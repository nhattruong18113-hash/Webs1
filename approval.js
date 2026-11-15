// api/approval.js — Vercel Serverless Function (Node.js)
// deps: @vercel/kv  (add Vercel KV integration → env vars injected automatically)
// env:  BOT_SECRET, KV_URL, KV_REST_API_TOKEN, KV_REST_API_URL (all from Vercel dashboard)

import { kv } from '@vercel/kv';

const BOT_SECRET      = process.env.BOT_SECRET;
const TTL_MS          = 86_400_000;          // 24 h in ms  (manual expire check)
const TTL_S           = 86_400;              // 24 h in s   (Upstash TTL — belt + suspenders)
const VALID_TIERS     = new Set(['high', 'ultra']);
const SESSION_KEY_RE  = /^Rest-[A-Za-z0-9]{10,11}$/;

// Simple in-process rate limiter for GET poll — keyed by (ip, session_key).
// Resets on cold start; good enough to protect Upstash free tier from runaway polls.
const rateBucket = new Map(); // key → { count, windowStart }
const RATE_WINDOW_MS = 10_000; // 10 s window
const RATE_MAX       = 5;      // max 5 GET per key per 10 s

function checkRate(id) {
  const now = Date.now();
  const b   = rateBucket.get(id);
  if (!b || now - b.windowStart > RATE_WINDOW_MS) {
    rateBucket.set(id, { count: 1, windowStart: now });
    return true;
  }
  b.count++;
  if (b.count > RATE_MAX) return false;
  return true;
}

// Prune the rate bucket periodically so it doesn't grow forever in long-lived instances.
// Called at most once per request — cheap.
let lastPrune = 0;
function maybePrune() {
  const now = Date.now();
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [k, v] of rateBucket) {
    if (now - v.windowStart > RATE_WINDOW_MS * 2) rateBucket.delete(k);
  }
}

export default async function handler(req, res) {
  // CORS — allow any origin so the hosted index.html can poll from wherever
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  maybePrune();

  // ── GET — frontend poll ──────────────────────────────────────────────────────
  // ?key=Rest-XXXXXXXXXX&tier=high|ultra
  if (req.method === 'GET') {
    const { key, tier } = req.query;

    if (!key || !tier)                  return res.status(400).json({ error: 'Missing key or tier' });
    if (!SESSION_KEY_RE.test(key))      return res.status(400).json({ error: 'Invalid session key format' });
    if (!VALID_TIERS.has(tier))         return res.status(400).json({ error: 'Invalid tier' });

    // Rate limit by IP + key so one browser can't hammer Upstash
    const ip      = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? 'unknown';
    const rateId  = `${ip}:${key}`;
    if (!checkRate(rateId)) {
      return res.status(429).json({ error: 'Too many requests', retryAfter: 10 });
    }

    let record;
    try {
      record = await kv.get(`approval:${key}:${tier}`);
    } catch (err) {
      console.error('[GET] kv.get failed', err);
      return res.status(502).json({ error: 'KV unavailable' });
    }

    if (!record) return res.json({ approved: false });

    // Manual age check as a second layer (Upstash TTL is the primary eviction)
    const age = Date.now() - record.ts;
    if (age > TTL_MS) {
      // Already expired — Upstash should have evicted it, but clean up anyway
      kv.del(`approval:${key}:${tier}`).catch(() => {});
      return res.json({ approved: false, expired: true });
    }

    return res.json({
      approved: true,
      tier:     record.tier,
      ts:       record.ts,
      by:       record.by,
    });
  }

  // ── POST — bot writes approval or revoke ─────────────────────────────────────
  // body: { key, tier, by, action: 'approve' | 'revoke' }
  if (req.method === 'POST') {
    if (!BOT_SECRET || req.headers['x-bot-secret'] !== BOT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { key, tier, by, action = 'approve' } = req.body ?? {};

    if (!key || !tier)              return res.status(400).json({ error: 'Missing key or tier' });
    if (!SESSION_KEY_RE.test(key))  return res.status(400).json({ error: 'Invalid session key format' });
    if (!VALID_TIERS.has(tier))     return res.status(400).json({ error: 'Invalid tier' });
    if (!['approve', 'revoke'].includes(action))
                                    return res.status(400).json({ error: 'Invalid action' });

    const kvKey = `approval:${key}:${tier}`;

    try {
      if (action === 'revoke') {
        await kv.del(kvKey);
        return res.json({ ok: true, action: 'revoked', tier, key });
      }

      // approve — set with Upstash TTL so it auto-evicts even if the expire check is never hit
      await kv.set(
        kvKey,
        { tier, by: by ?? 'unknown', ts: Date.now(), key },
        { ex: TTL_S },
      );
      return res.json({ ok: true, action: 'approved', tier, key });

    } catch (err) {
      console.error('[POST] kv operation failed', err);
      return res.status(502).json({ error: 'KV unavailable' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
