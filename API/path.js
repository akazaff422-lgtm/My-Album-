// Album API for Vercel | author: JABED VAO
// Env vars (Vercel -> Settings -> Environment Variables):
//   ADMIN_KEY                          password for the website + add/delete calls
//   KV_REST_API_URL, KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN)  from the Upstash Redis integration
const crypto = require("crypto");

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const HASH = "album:cats"; // field = category name, value = JSON array of items
const MAX_UPLOAD = 4 * 1024 * 1024; // Vercel request limit is 4.5MB

// ---------- redis (Upstash REST, no packages) ----------
async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Redis env vars missing (KV_REST_API_URL / KV_REST_API_TOKEN)");
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error("redis: " + j.error);
  return j.result;
}
async function loadAll() {
  const flat = (await redis(["HGETALL", HASH])) || [];
  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) { try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) { out[flat[i]] = []; } }
  } else if (flat && typeof flat === "object") {
    for (const k of Object.keys(flat)) { try { out[k] = JSON.parse(flat[k]); } catch (e) { out[k] = []; } }
  }
  return out;
}
const saveCat = (name, arr) => redis(["HSET", HASH, name, JSON.stringify(arr)]);
const loadCat = async name => { const v = await redis(["HGET", HASH, name]); return v ? JSON.parse(v) : null; };

// ---------- helpers ----------
const normCat = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const newId = () => crypto.randomBytes(4).toString("hex");

function kindFromExt(url) {
  const ext = (url.split("?")[0].split(".").pop() || "").toLowerCase();
  if (["mp4", "mov", "webm", "mkv", "3gp"].includes(ext)) return "video";
  if (["mp3", "m4a", "ogg", "wav", "opus", "aac", "oga"].includes(ext)) return "audio";
  if (ext === "gif") return "gif";
  return "photo";
}
const EXT_BY_KIND = { video: "mp4", audio: "mp3", gif: "gif", photo: "jpg", file: "bin" };
const MIME_BY_EXT = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav", opus: "audio/ogg", aac: "audio/aac", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

async function addItem(category, url, kind) {
  const c = normCat(category);
  if (!c) throw new Error("category missing");
  const arr = (await loadCat(c)) || [];
  const item = { id: newId(), url, kind: kind || kindFromExt(url), added: Date.now() };
  arr.push(item);
  await saveCat(c, arr);
  return { category: c, ...item };
}

async function uploadCatbox(buf, filename) {
  const ext = filename.split(".").pop().toLowerCase();
  const fd = new FormData();
  fd.append("reqtype", "fileupload");
  fd.append("fileToUpload", new Blob([buf], { type: MIME_BY_EXT[ext] || "application/octet-stream" }), filename);
  const r = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: fd });
  const t = (await r.text()).trim();
  if (!/^https?:\/\//.test(t)) throw new Error("catbox error: " + t.slice(0, 120));
  return t;
}
async function rehostUrl(url, kind) {
  if (/^https?:\/\/(files\.catbox\.moe|litter\.catbox\.moe)\//.test(url)) return url;
  const r = await fetch(url);
  if (!r.ok) throw new Error("download failed: HTTP " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  let ext = (new URL(url).pathname.split(".").pop() || "").toLowerCase();
  if (!MIME_BY_EXT[ext]) ext = EXT_BY_KIND[kind] || "bin";
  return uploadCatbox(buf, "media_" + Date.now() + "." + ext);
}

function send(res, code, data, type) {
  res.statusCode = code;
  res.setHeader("Content-Type", type || "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}
function authed(req) {
  const k = String(req.headers["x-api-key"] || "");
  if (!ADMIN_KEY || k.length !== ADMIN_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));
}
function readStream(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("file too large (max 4MB here - use a catbox link for big files)")); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function getBuffer(req, limit) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return readStream(req, limit);
}
async function getJson(req) {
  let b = req.body;
  if (b === undefined) { const buf = await readStream(req, 5 * 1024 * 1024); b = buf.length ? buf.toString() : "{}"; }
  if (Buffer.isBuffer(b)) b = b.toString();
  if (typeof b === "string") b = b ? JSON.parse(b) : {};
  return b || {};
}

// ---------- handler ----------
module.exports = async function handler(req, res) {
  const u = new URL(req.url, "http://x");
  const p = u.pathname.replace(/\/+$/, "") || "/";
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");

    // public: random item
    if (req.method === "GET" && p === "/api/album") {
      const q = normCat(u.searchParams.get("type"));
      const all = await loadAll();
      let name = all[q] && all[q].length ? q : null;
      if (!name) name = Object.keys(all).find(k => all[k].length && (k.startsWith(q) || k.includes(q)));
      if (!q || !name) return send(res, 404, { error: "category not found or empty" });
      const arr = all[name];
      const it = arr[Math.floor(Math.random() * arr.length)];
      return send(res, 200, { category: name, id: it.id, url: it.url, kind: it.kind, total: arr.length });
    }

    // public: category list
    if (req.method === "GET" && p === "/api/categories") {
      const all = await loadAll();
      return send(res, 200, Object.keys(all).sort().map(k => ({ name: k, count: all[k].length })));
    }

    if (!authed(req)) return send(res, 401, { error: "wrong or missing key" });

    if (req.method === "GET" && (p === "/api/all" || p === "/api/export")) {
      return send(res, 200, { categories: await loadAll() });
    }

    if (req.method === "POST" && p === "/api/add") {
      const b = await getJson(req);
      if (!b.category || !b.url) return send(res, 400, { error: "category and url required" });
      const kind = b.kind || kindFromExt(b.url);
      const url = b.rehost ? await rehostUrl(b.url, kind) : b.url;
      return send(res, 200, await addItem(b.category, url, kind));
    }

    if (req.method === "POST" && p === "/api/upload") {
      const category = u.searchParams.get("category");
      const name = (u.searchParams.get("name") || "file.bin").replace(/[^\w.\-]/g, "_");
      if (!category) return send(res, 400, { error: "category required" });
      const buf = await getBuffer(req, MAX_UPLOAD);
      if (!buf.length) return send(res, 400, { error: "empty file" });
      const url = await uploadCatbox(buf, name);
      return send(res, 200, await addItem(category, url, kindFromExt(name)));
    }

    if (req.method === "DELETE" && p === "/api/item") {
      const id = u.searchParams.get("id");
      const all = await loadAll();
      for (const c of Object.keys(all)) {
        const i = all[c].findIndex(x => x.id === id);
        if (i > -1) {
          const [removed] = all[c].splice(i, 1);
          await saveCat(c, all[c]);
          return send(res, 200, { category: c, ...removed });
        }
      }
      return send(res, 404, { error: "id not found" });
    }

    if (req.method === "DELETE" && p === "/api/category") {
      const c = normCat(u.searchParams.get("name"));
      const n = await redis(["HDEL", HASH, c]);
      if (!n) return send(res, 404, { error: "category not found" });
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && p === "/api/rename") {
      const b = await getJson(req);
      const from = normCat(b.from), to = normCat(b.to);
      const src = await loadCat(from);
      if (!src || !to) return send(res, 400, { error: "bad names" });
      if (to !== from) {
        const dst = (await loadCat(to)) || [];
        await saveCat(to, dst.concat(src));
        await redis(["HDEL", HASH, from]);
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && p === "/api/import") {
      const data = await getJson(req);
      if (!data || typeof data.categories !== "object") return send(res, 400, { error: "invalid backup" });
      await redis(["DEL", HASH]);
      const args = ["HSET", HASH];
      for (const k of Object.keys(data.categories)) args.push(normCat(k), JSON.stringify(data.categories[k]));
      if (args.length > 2) await redis(args);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(p, e.message);
    return send(res, 500, { error: e.message });
  }
};
