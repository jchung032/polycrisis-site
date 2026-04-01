const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

const SEVEN_DAYS = 7 * 24 * 60 * 60;
const ARCHIVE_INDEX_KEY = 'archive:index';

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

// Store archive index as a JSON array in a single Redis key
async function addToArchiveIndex(windowKey, meta) {
  try {
    let index = await redisGet(ARCHIVE_INDEX_KEY) || [];
    // Avoid duplicates
    if (!index.find(e => e.key === windowKey)) {
      index.unshift({ key: windowKey, ...meta }); // newest first
      // Keep max 42 entries (7 days * 3 sessions/day)
      index = index.slice(0, 42);
      await redisSet(ARCHIVE_INDEX_KEY, index, SEVEN_DAYS);
      console.log('Archive index updated, total entries:', index.length);
    }
  } catch(e) { console.log('Archive index error:', e.message); }
}

function getWindowInfo() {
  const now = new Date();
  const pst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  const h = pst.getUTCHours();
  const win = h >= 6 && h < 12 ? 'geo' : h >= 12 && h < 18 ? 'clim' : 'econ';
  const dateStr = pst.toISOString().slice(0, 10);
  const key = `news:${dateStr}:${win}`;
  console.log('Window key:', key, '| PST hour:', h);
  return { key, win, dateStr, hour: h };
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET /api/news?archive=true ── return past sessions from Redis
  if (req.method === 'GET') {
    if (req.query && req.query.archive === 'true') {
      try {
        const index = await redisGet(ARCHIVE_INDEX_KEY) || [];
        console.log('Archive index fetched, entries:', index.length);

        const { key: currentKey } = getWindowInfo();
        const pastEntries = index.filter(e => e.key !== currentKey);

        const results = await Promise.all(
          pastEntries.map(async (entry) => {
            const data = await redisGet(entry.key);
            if (!data || !data.articles) return null;
            return {
              key: entry.key,
              win: entry.win,
              dateStr: entry.dateStr,
              savedAt: entry.savedAt,
              articles: data.articles
            };
          })
        );

        const archive = results.filter(Boolean);
        console.log('Archive sessions returned:', archive.length);
        return res.status(200).json({ archive });
      } catch(error) {
        console.log('Archive fetch error:', error.message);
        return res.status(500).json({ error: 'Archive fetch failed', details: error.message });
      }
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── POST /api/news ── serve current window articles
  try {
    const { key: windowKey, win, dateStr } = getWindowInfo();
    console.log('Checking cache for key:', windowKey);

    const cached = await redisGet(windowKey);
    if (cached && cached.articles && cached.articles.length > 0) {
      console.log('Cache HIT, articles:', cached.articles.length);
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cached);
    }

    console.log('Cache MISS - calling Anthropic');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    body.max_tokens = 4000;

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

    if (!newsData.articles || !newsData.articles.length) {
      console.log('No articles found, keys:', Object.keys(newsData).join(', '));
      throw new Error('No articles in response');
    }

    console.log('Parsed OK, articles:', newsData.articles.length);

    // Store for 7 days so archive can access past sessions
    await redisSet(windowKey, newsData, SEVEN_DAYS);

    // Register in archive index
    await addToArchiveIndex(windowKey, { win, dateStr, savedAt: Date.now() });

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(newsData);

  } catch (error) {
    console.log('Handler error:', error.message);
    return res.status(500).json({ error: 'API call failed', details: error.message });
  }
}
