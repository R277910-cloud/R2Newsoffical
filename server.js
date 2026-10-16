require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const Parser = require("rss-parser");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const parser = new Parser({ timeout: 12000, headers: { "User-Agent": "R2News/1.0 (+news aggregator)" } });
const hasDb = Boolean(process.env.DATABASE_URL);
const pool = hasDb ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
}) : null;

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "300kb" }));
app.use(express.urlencoded({ extended: false, limit: "50kb" }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }));
app.use(session({
  name: "r2.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));

const categories = ["مصر", "عالمي", "الدوري الإنجليزي", "الدوري الإسباني", "الدوري الإيطالي", "الدوري الألماني", "دوري أبطال أوروبا", "انتقالات"];
const defaultFeeds = [
  // Add only verified feeds whose terms permit fetching and displaying their metadata.
  // Do not assume that an RSS feed grants rights to republish full articles or images.
];
const extraFeeds = (process.env.RSS_FEEDS || "").split(",").map(s => s.trim()).filter(Boolean);
let memoryNews = [];
let memorySources = extraFeeds.map((url, i) => ({ id: i + 1, name: new URL(url).hostname, url, enabled: true }));
let nextId = 1;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news (
      id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, summary TEXT DEFAULT '',
      image_url TEXT DEFAULT '', source_name TEXT DEFAULT '', source_url TEXT UNIQUE,
      category TEXT DEFAULT 'عالمي', published_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(), approved BOOLEAN DEFAULT TRUE,
      urgent BOOLEAN DEFAULT FALSE, status TEXT DEFAULT 'published'
    );
    CREATE TABLE IF NOT EXISTS feed_sources (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, url TEXT UNIQUE NOT NULL,
      category TEXT DEFAULT 'عالمي', enabled BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  for (const feed of extraFeeds) {
    try { await pool.query("INSERT INTO feed_sources(name,url) VALUES($1,$2) ON CONFLICT(url) DO NOTHING", [new URL(feed).hostname, feed]); } catch {}
  }
}
async function allNews({ pending = false, category = "", q = "" } = {}) {
  if (pool) {
    const vals = []; let where = pending ? "status='pending'" : "status='published' AND approved=TRUE";
    if (category && category !== "الكل") { vals.push(category); where += ` AND category=$${vals.length}`; }
    if (q) { vals.push(`%${q}%`); where += ` AND (title ILIKE $${vals.length} OR summary ILIKE $${vals.length})`; }
    const { rows } = await pool.query(`SELECT * FROM news WHERE ${where} ORDER BY urgent DESC, published_at DESC LIMIT 100`, vals);
    return rows;
  }
  return memoryNews.filter(n => (pending ? n.status === "pending" : n.status === "published" && n.approved) &&
    (!category || category === "الكل" || n.category === category) &&
    (!q || (n.title + " " + n.summary).toLowerCase().includes(q.toLowerCase())))
    .sort((a,b) => Number(b.urgent)-Number(a.urgent) || new Date(b.published_at)-new Date(a.published_at)).slice(0,100);
}
async function getSources() {
  if (pool) return (await pool.query("SELECT * FROM feed_sources ORDER BY id")).rows;
  return memorySources;
}
async function upsertNews(n, autoPublish = true) {
  const status = autoPublish ? "published" : "pending";
  if (pool) {
    await pool.query(`INSERT INTO news(title,summary,image_url,source_name,source_url,category,published_at,approved,urgent,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9)
      ON CONFLICT(source_url) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary,
      image_url=CASE WHEN EXCLUDED.image_url<>'' THEN EXCLUDED.image_url ELSE news.image_url END`,
      [n.title,n.summary,n.image_url,n.source_name,n.source_url,n.category,n.published_at,autoPublish,status]);
  } else {
    const found = memoryNews.find(x => x.source_url && x.source_url === n.source_url);
    if (found) { found.title = n.title; found.summary = n.summary; if (n.image_url) found.image_url = n.image_url; return; }
    memoryNews.unshift({ id: nextId++, ...n, approved: autoPublish, urgent: false, status, created_at: new Date().toISOString() });
    memoryNews = memoryNews.slice(0, 500);
  }
}
function cleanText(s = "") { return String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200); }
async function fetchFeed(feed) {
  const parsed = await parser.parseURL(feed.url);
  let count = 0;
  for (const item of (parsed.items || []).slice(0, 30)) {
    const title = cleanText(item.title);
    const link = item.link || item.guid;
    if (!title || !link) continue;
    const content = cleanText(item.contentSnippet || item.content || item.summary || "");
    let image = item.enclosure && item.enclosure.url ? item.enclosure.url : "";
    if (!image) {
      const match = String(item.content || "").match(/<img[^>]+src=["']([^"']+)["']/i);
      if (match) image = match[1];
    }
    await upsertNews({
      title, summary: content, image_url: image, source_name: parsed.title || feed.name || new URL(feed.url).hostname,
      source_url: link, category: feed.category || "عالمي",
      published_at: item.isoDate || item.pubDate || new Date().toISOString()
    }, process.env.AUTO_PUBLISH !== "false");
    count++;
  }
  return count;
}
let syncRunning = false;
async function syncFeeds() {
  if (syncRunning) return { skipped: true };
  syncRunning = true;
  try {
    const sources = (await getSources()).filter(s => s.enabled);
    let imported = 0, failed = 0;
    for (const source of sources) {
      try { imported += await fetchFeed(source); }
      catch (e) { failed++; console.error("Feed error:", source.url, e.message); }
    }
    return { imported, failed, checked: sources.length, at: new Date().toISOString() };
  } finally { syncRunning = false; }
}
function adminOnly(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: "يجب تسجيل دخول الإدارة أولًا." });
}
app.get("/api/health", async (_req,res) => res.json({ ok: true, database: hasDb ? "postgresql" : "memory-demo", time: new Date().toISOString() }));
app.get("/api/categories", (_req,res) => res.json(categories));
app.get("/api/news", async (req,res) => {
  try { res.json(await allNews({ category: req.query.category || "", q: cleanText(req.query.q || "") })); }
  catch(e) { console.error(e); res.status(500).json({ error: "تعذر تحميل الأخبار حاليًا." }); }
});
app.get("/api/news/:id", async (req,res) => {
  try {
    const rows = await allNews();
    const item = rows.find(n => String(n.id) === String(req.params.id));
    if (!item) return res.status(404).json({ error: "الخبر غير موجود." });
    res.json(item);
  } catch { res.status(500).json({ error: "خطأ في تحميل الخبر." }); }
});
app.get("/api/admin/status", (req,res) => res.json({ authenticated: Boolean(req.session && req.session.admin) }));
app.post("/api/admin/login", rateLimit({ windowMs: 15*60*1000, limit: 8 }), async (req,res) => {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password === "change-this-password-now") return res.status(503).json({ error: "اضبط ADMIN_PASSWORD في متغيرات البيئة قبل تسجيل الدخول." });
  if (req.body.username !== username || !await bcrypt.compare(String(req.body.password || ""), await bcrypt.hash(password, 10))) {
    return res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة." });
  }
  req.session.admin = true;
  res.json({ ok: true });
});
app.post("/api/admin/logout", adminOnly, (req,res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/admin/news", adminOnly, async (_req,res) => {
  try {
    if (pool) return res.json((await pool.query("SELECT * FROM news ORDER BY created_at DESC LIMIT 200")).rows);
    res.json(memoryNews.slice(0,200));
  } catch { res.status(500).json({ error: "تعذر تحميل لوحة الأخبار." }); }
});
app.post("/api/admin/news", adminOnly, async (req,res) => {
  const title = cleanText(req.body.title || "");
  if (!title) return res.status(400).json({ error: "عنوان الخبر مطلوب." });
  const n = { title, summary: cleanText(req.body.summary || ""), image_url: String(req.body.image_url || "").slice(0,1500),
    source_name: cleanText(req.body.source_name || "R2 NEWS"), source_url: String(req.body.source_url || `manual:${Date.now()}`).slice(0,2000),
    category: categories.includes(req.body.category) ? req.body.category : "عالمي",
    published_at: req.body.published_at || new Date().toISOString() };
  try {
    if (pool) {
      const result = await pool.query(`INSERT INTO news(title,summary,image_url,source_name,source_url,category,published_at,approved,urgent,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [n.title,n.summary,n.image_url,n.source_name,n.source_url,n.category,n.published_at,req.body.approved !== false,Boolean(req.body.urgent),req.body.approved === false ? "pending":"published"]);
      return res.json(result.rows[0]);
    }
    const item = { id: nextId++, ...n, approved: req.body.approved !== false, urgent: Boolean(req.body.urgent), status: req.body.approved === false ? "pending":"published", created_at: new Date().toISOString() };
    memoryNews.unshift(item); return res.json(item);
  } catch(e) { res.status(400).json({ error: "لم يتم حفظ الخبر. تحقق من رابط المصدر وعدم تكراره." }); }
});
app.post("/api/admin/news/:id/approve", adminOnly, async (req,res) => {
  try {
    if (pool) await pool.query("UPDATE news SET approved=TRUE,status='published' WHERE id=$1", [req.params.id]);
    else { const n=memoryNews.find(x=>String(x.id)===req.params.id); if(n){n.approved=true;n.status="published";} }
    res.json({ ok:true });
  } catch { res.status(500).json({error:"تعذر اعتماد الخبر."}); }
});
app.delete("/api/admin/news/:id", adminOnly, async (req,res) => {
  try {
    if (pool) await pool.query("DELETE FROM news WHERE id=$1", [req.params.id]);
    else memoryNews = memoryNews.filter(x=>String(x.id)!==req.params.id);
    res.json({ok:true});
  } catch { res.status(500).json({error:"تعذر حذف الخبر."}); }
});
app.get("/api/admin/sources", adminOnly, async (_req,res) => { try { res.json(await getSources()); } catch { res.status(500).json({error:"تعذر تحميل المصادر."}); } });
app.post("/api/admin/sources", adminOnly, async (req,res) => {
  let url;
  try { url = new URL(req.body.url); if (!["https:","http:"].includes(url.protocol)) throw Error(); } catch { return res.status(400).json({error:"أدخل رابط RSS صحيحًا."}); }
  const name = cleanText(req.body.name || url.hostname);
  const category = categories.includes(req.body.category) ? req.body.category : "عالمي";
  try {
    if (pool) {
      const r=await pool.query("INSERT INTO feed_sources(name,url,category) VALUES($1,$2,$3) ON CONFLICT(url) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category RETURNING *",[name,url.href,category]);
      return res.json(r.rows[0]);
    }
    if (!memorySources.some(s=>s.url===url.href)) memorySources.push({id:Date.now(),name,url:url.href,category,enabled:true});
    res.json({ok:true});
  } catch { res.status(400).json({error:"تعذر إضافة المصدر."}); }
});
app.post("/api/admin/sync", adminOnly, async (_req,res) => res.json(await syncFeeds()));
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req,res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const syncMinutes = Math.max(1, Number(process.env.SYNC_MINUTES || 5));
initDb().then(() => {
  app.listen(PORT, () => console.log(`R2 NEWS listening on ${PORT}; database=${hasDb ? "postgresql":"memory-demo"}`));
  // Frequent polling is not the same as guaranteed live data; source publication and API limits apply.
  setTimeout(() => syncFeeds().catch(console.error), 3000);
  setInterval(() => syncFeeds().catch(console.error), syncMinutes * 60 * 1000);
}).catch(err => { console.error("Startup error:", err); process.exit(1); });
