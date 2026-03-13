const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

async function redisGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(key, value, exSeconds) {
  await fetch(`${UPSTASH_URL}/set/${key}?EX=${exSeconds}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(value))
  });
}

function getWindowKey() {
  const now = new Date();
  // Use US/Pacific time offset (UTC-7) for window boundaries
  const pst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  const h = pst.getUTCHours();
  const window = h >= 6 && h < 12 ? 'geo' : h >= 12 && h < 18 ? 'clim' : 'econ';
  const dateStr = pst.toISOString().slice(0, 10);
  return `news:${dateStr}:${window}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const windowKey = getWindowKey();

    // Check Upstash cache first
    const cached = await redisGet(windowKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cached);
    }

    // Cache miss — call Anthropic
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

    // Cache for 6 hours (one full time window)
    await redisSet(windowKey, data, 6 * 60 * 60);

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'API call failed', details: error.message });
  }
}
