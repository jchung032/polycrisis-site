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
    const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
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
 
function extractNewsData(anthropicResponse) {
  const raw = (anthropicResponse.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  let cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found');
  let depth = 0, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  let jsonStr = cleaned.substring(start, end > -1 ? end + 1 : cleaned.length);
  try { return JSON.parse(jsonStr); }
  catch(e) {
    jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    return JSON.parse(jsonStr);
  }
}
 
module.exports = async function handler(req, res) {
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
 
    const anthropicData = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(anthropicData.error || anthropicData));
 
    console.log('Anthropic OK, parsing...');
    const newsData = extractNewsData(anthropicData);
    if (!newsData.articles || !newsData.articles.length) throw new Error('No articles in response');
 
    console.log('Parsed OK, articles:', newsData.articles.length);
    await redisSet(windowKey, newsData, 6 * 60 * 60);
 
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(newsData);
 
  } catch (error) {
    console.log('Handler error:', error.message);
    return res.status(500).json({ error: 'API call failed', details: error.message });
  }
}
