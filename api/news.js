
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
      // Handle double-stringified values from older redisSet calls
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      return parsed;
    } catch (e) {
      console.error(`Error parsing Redis GET result for key ${key}:`, e.message);
      return result; // Return raw result if parsing fails
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

async function redisLtrim(key, start, end) {
  return redisCommand("ltrim", key, start, end);
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
  console.log("Window key:", key, "| PST hour:", h);
  return key;
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

  // GET /api/news?history=geo|clim|econ
  if (req.method === "GET") {
    const win = req.query && req.query.history;
    if (!win || !["geo","clim","econ"].includes(win)) {
      return res.status(400).json({ error: "Missing or invalid ?history= param. Use geo, clim, or econ." });
    }
    try {
      const historyListKey = `history:${win}:ids`;
      const articleIds = await redisLrange(historyListKey, 0, -1);
      
      const articles = [];
      const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000); // Timestamp for 2 days ago

      for (const id of articleIds) {
        const article = await redisGetArticle(id);
        // Only include articles that are not null (i.e., not expired) and are within the last 2 days
        if (article && article.savedAt && article.savedAt >= twoDaysAgo) {
          articles.push(article);
        }
      }
      return res.status(200).json({ articles: articles });
    } catch(e) {
      console.error("Failed to fetch history:", e.message);
      return res.status(500).json({ error: "Failed to fetch history", details: e.message });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const windowKey = getWindowKey();
    console.log("Checking cache for key:", windowKey);

    const cached = await redisGet(windowKey);
    if (cached && cached.articles && cached.articles.length > 0) {
      console.log("Cache HIT, articles:", cached.articles.length);
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached);
    }

    console.log("Cache MISS - calling Anthropic");
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    // Force higher token limit to prevent truncation
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

    console.log("Anthropic OK, parsing...");
    const newsData = extractNewsData(anthropicData);
    
    if (!newsData.articles || !newsData.articles.length) {
      console.log("No articles found, keys:", Object.keys(newsData).join(", "));
      throw new Error("No articles in response");
    }

    console.log("Parsed OK, articles:", newsData.articles.length);
    await redisSet(windowKey, newsData, 6 * 60 * 60);

    // Update rolling history for this category (2 days retention)
    try {
      const win = windowKey.split(":")[2]; // "geo", "clim", or "econ"
      const historyListKey = `history:${win}:ids`;
      const savedAt = Date.now();
      const session = win;
      
      // Store each new article individually and add its ID to the list
      for (const article of newsData.articles) {
        // Generate a unique ID for each article
        const articleId = `article:${savedAt}:${Math.random().toString(36).substring(2, 15)}`; 
        const fullArticle = { ...article, id: articleId, savedAt, session };
        // Set TTL for individual articles to 2 days
        await redisSetArticle(articleId, fullArticle, 2 * 24 * 60 * 60); 
        await redisLpush(historyListKey, articleId);
      }

      // No fixed LTRIM here, relying on individual article TTL and frontend filtering
      console.log(`History updated: ${historyListKey}, articles added.`);
    } catch(e) {
      console.error("History update error:", e.message);
    }

    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(newsData);

  } catch (error) {
    console.error("Handler error:", error.message);
    return res.status(500).json({ error: "API call failed", details: error.message });
  }
}
