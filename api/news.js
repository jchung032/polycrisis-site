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
    await res.json();
  } catch(e) { console.log('Redis SET error:', e.message); }
}

async function addToArchiveIndex(windowKey, meta) {
  try {
    let index = await redisGet(ARCHIVE_INDEX_KEY) || [];
    if (!index.find(e => e.key === windowKey)) {
      index.unshift({ key: windowKey, ...meta });
      index = index.slice(0, 42); // Keep last 2 weeks of windows
      await redisSet(ARCHIVE_INDEX_KEY, index, SEVEN_DAYS);
    }
  } catch(e) { console.log('Archive index error:', e.message); }
}

/**
 * FIXED: Uses official IANA timezone strings to prevent mismatch 
 * between server location and user location.
 */
function getWindowInfo() {
  const now = new Date();
  // Forces the calculation to stay in Pacific Time regardless of server location
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: "America/Los_Angeles",
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit'
  });
  
  const parts = formatter.formatToParts(now);
  const getPart = (type) => parts.find(p => p.type === type).value;
  
  const h = parseInt(getPart('hour'));
  const dateStr = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
  
  // Define windows: 6am-12pm (Geopolitical), 12pm-6pm (Climate), 6pm-6am (Economic)
  const win = h >= 6 && h < 12 ? 'geo' : h >= 12 && h < 18 ? 'clim' : 'econ';
  const key = `news:${dateStr}:${win}`;
  
  return { key, win, dateStr, hour: h };
}

function extractNewsData(anthropicResponse) {
  const raw = (anthropicResponse.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
    
  let cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  let jsonStr = cleaned.substring(start, end + 1);
  return JSON.parse(jsonStr);
}

module.exports = async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { key: windowKey, win, dateStr } = getWindowInfo();

  // Archive retrieval logic
  if (req.method === 'GET' && req.query.archive === 'true') {
    const index = await redisGet(ARCHIVE_INDEX_KEY) || [];
    const pastEntries = index.filter(e => e.key !== windowKey);
    const results = await Promise.all(pastEntries.map(async (e) => {
      const data = await redisGet(e.key);
      return data ? { ...e, articles: data.articles } : null;
    }));
    return res.status(200).json({ archive: results.filter(Boolean) });
  }

  try {
    // 1. Check Cache
    const cached = await redisGet(windowKey);
    if (cached) {
      console.log('CACHE HIT:', windowKey);
      return res.status(200).json(cached);
    }

    // 2. Cache Miss - Call Anthropic
    console.log('CACHE MISS:', windowKey);
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    
    const response = await fetch('[https://api.anthropic.com/v1/messages](https://api.anthropic.com/v1/messages)', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        ...body,
        max_tokens: 4000
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'Anthropic API error');
    }

    const anthropicData = await response.json();
    const newsData = extractNewsData(anthropicData);

    // 3. Save to Redis and Archive
    await redisSet(windowKey, newsData, SEVEN_DAYS);
    await addToArchiveIndex(windowKey, { win, dateStr, savedAt: Date.now() });

    return res.status(200).json(newsData);
  } catch (error) {
    console.error('Handler Error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch news', details: error.message });
  }
};
