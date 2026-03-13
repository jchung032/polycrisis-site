const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

async function redisGet(key) {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    if (data.result) return JSON.parse(data.result);
  } catch(e) { console.log('Redis GET error:', e.message); }
  return null;
}

async function redisSet(key, value, exSeconds) {
  try {
    const encoded = encodeURIComponent(key);
    const res = await fetch(`${UPSTASH_URL}/set/${encoded}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([JSON.stringify(value), 'EX', exSeconds])
    });
    const data = await res.json();
    console.log('Redis SET result:', JSON.stringify(data));
  } catch(e) { console.log('Redis SET error:', e.message); }
}

function getWindowKey() {
  const now = new Date();
  const pst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  const h = pst.getUTCHours();
  const win = h >= 6 && h < 12 ? 'geo' : h >= 12 && h < 18 ? 'clim' : 'econ';
  const dateStr = pst.toISOString().slice(0, 10);
  const key = `news:${dateStr}:${win}`;
  console.log('Window key:', key, '| PST hour:', h);
  return key;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const windowKey = getWindowKey();
    console.log('Checking cache for key:', windowKey);

    const cached = await redisGet(windowKey);
    if (cached) {
      console.log('Cache HIT');
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cached);
    }

    console.log('Cache MISS - calling Anthropic');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data.error || data));

    console.log('Anthropic OK, saving to cache...');
    await redisSet(windowKey, data, 6 * 60 * 60);

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (error) {
    console.log('Handler error:', error.message);
    return res.status(500).json({ error: 'API call failed', details: error.message });
  }
}
