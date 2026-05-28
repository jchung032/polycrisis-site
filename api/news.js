
const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

// Helper for generic Redis commands
async function redisCommand(command, ...args) {
  try {
    const path = `/${command}/${args.map(encodeURIComponent).join("/")}`;
    const res = await fetch(`${UPSTASH_URL}${path}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.result;
  } catch(e) { console.error(`Redis command ${command} error:`, e.message); }
  return null;
}

async function redisGet(key) {
  const result = await redisCommand("get", key);
  if (result) {
    try {
      let parsed = JSON.parse(result);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      return parsed;
    } catch (e) {
      console.error(`Error parsing Redis GET result for key ${key}:`, e.message);
      return result;
    }
  }
  return null;
}

async function redisSet(key, value, exSeconds) {
  return redisCommand("set", key, JSON.stringify(value), "EX", exSeconds);
}

async function redisLpush(key, value) {
  return redisCommand("lpush", key, value);
}

async function redisLrange(key, start, end) {
  const result = await redisCommand("lrange", key, start, end);
  return result || [];
}

async function redisSetArticle(articleId, articleData, exSeconds) {
  return redisCommand("set", `article:${articleId}`, JSON.stringify(articleData), "EX", exSeconds);
}

async function redisGetArticle(articleId) {
  const result = await redisCommand("get", `article:${articleId}`);
  if (result) {
    try {
      return JSON.parse(result);
    } catch (e) {
      console.error(`Error parsing article ${articleId}:`, e.message);
      return null;
    }
  }
  return null;
}

function getWindowKey() {
  const now = new Date();
  const pst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  const h = pst.getUTCHours();
  const win = h >= 6 && h < 12 ? "geo" : h >= 12 && h < 18 ? "clim" : "econ";
  const dateStr = pst.toISOString().slice(0, 10);
  const key = `news:${dateStr}:${win}`;
  return key;
}

async function fetchRealNews(category) {
  const queries = {
    geopolitical: "geopolitical conflict military tension diplomatic crisis sanctions",
    climate: "extreme weather natural disaster climate emergency flooding wildfire",
    economic: "global market economic crisis trade dispute central bank inflation"
  };
  const query = queries[category] || "world news";
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  
  try {
    const res = await fetch(url, { timeout: 5000 });
    const text = await res.text();
    const items = [];
    const matches = text.matchAll(/<item>.*?<title>(.*?)<\/title>.*?<link>(.*?)<\/link>.*?<pubDate>(.*?)<\/pubDate>.*?<\/item>/gs);
    for (const match of matches) {
      items.push({ title: match[1], link: match[2], date: match[3] });
      if (items.length >= 15) break;
    }
    console.log(`Fetched ${items.length} headlines for ${category}`);
    return items;
  } catch (e) {
    console.error("RSS fetch error:", e.message);
    return [];
  }
}

function extractNewsData(anthropicResponse) {
  const raw = (anthropicResponse.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");
  let cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("No JSON object found");
  let depth = 0, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  let jsonStr = cleaned.substring(start, end > -1 ? end + 1 : cleaned.length);
  try { return JSON.parse(jsonStr); }
  catch(e) {
    jsonStr = jsonStr.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
    return JSON.parse(jsonStr);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const win = req.query && req.query.history;
    if (!win || !["geo","clim","econ"].includes(win)) {
      return res.status(400).json({ error: "Invalid history param" });
    }
    try {
      const historyListKey = `history:${win}:ids`;
      const articleIds = await redisLrange(historyListKey, 0, -1);
      const articles = [];
      const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000);
      for (const id of articleIds) {
        const article = await redisGetArticle(id);
        if (article && article.savedAt && article.savedAt >= twoDaysAgo) articles.push(article);
      }
      return res.status(200).json({ articles });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const windowKey = getWindowKey();
    const cached = await redisGet(windowKey);
    if (cached && cached.articles && cached.articles.length > 0) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached);
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const category = windowKey.split(":")[2] === "geo" ? "geopolitical" : windowKey.split(":")[2] === "clim" ? "climate" : "economic";
    
    // FETCH REAL NEWS FIRST
    const realNews = await fetchRealNews(category);
    let newsContext = realNews.map(n => `- ${n.title}`).join("\n");
    
    // FALLBACK: If no news found, provide context about what to do
    if (realNews.length === 0) {
      newsContext = `[No specific headlines fetched, but provide analysis of current ${category} trends and risks based on your knowledge]`;
    }

    // Update prompt to include real news context
    body.messages[0].content = `Here are relevant ${category.toUpperCase()} headlines for context:\n${newsContext}\n\nBased on these headlines and current ${category} trends, ${body.messages[0].content}`;
    body.max_tokens = 4000;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    const anthropicData = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(anthropicData.error || anthropicData));

    const newsData = extractNewsData(anthropicData);
    await redisSet(windowKey, newsData, 6 * 60 * 60);

    try {
      const win = windowKey.split(":")[2];
      const historyListKey = `history:${win}:ids`;
      const savedAt = Date.now();
      for (const article of newsData.articles) {
        const articleId = `article:${savedAt}:${Math.random().toString(36).substring(2, 15)}`; 
        const fullArticle = { ...article, id: articleId, savedAt, session: win };
        await redisSetArticle(articleId, fullArticle, 2 * 24 * 60 * 60); 
        await redisLpush(historyListKey, articleId);
      }
    } catch(e) { console.error("History error:", e.message); }

    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(newsData);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
