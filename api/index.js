// Album API v2 for Vercel (file: api/index.js) | author: JABED VAO
// Env vars: ADMIN_KEY (you set it) + Upstash Redis vars + BLOB_READ_WRITE_TOKEN (set by Vercel when you connect Blob storage)
const crypto = require("crypto");

const ADMIN_KEY = process.env.ADMIN_KEY || "";
function findEnv(suffixes) {
  const key = Object.keys(process.env).find(k => suffixes.some(s => k === s || k.endsWith("_" + s)));
  return key ? process.env[key] : "";
}
const REDIS_URL = findEnv(["KV_REST_API_URL", "REST_API_URL", "UPSTASH_REDIS_REST_URL", "REST_URL"]);
const REDIS_TOKEN = findEnv(["KV_REST_API_TOKEN", "REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN", "REST_TOKEN"]);
const BLOB_TOKEN = findEnv(["BLOB_READ_WRITE_TOKEN", "READ_WRITE_TOKEN"]);

const CATS = "album:cats"; // field = folder key, value = JSON array of items
const META = "album:meta"; // field = folder key, value = {title, icon, order}
const MAX_RAW = 4 * 1024 * 1024;      // Vercel request-body limit is 4.5MB
const MAX_FETCH = 250 * 1024 * 1024;  // max size when the server copies a file from a link
const drive = require("../lib/drive");
const BLOB_LIMIT = Number(process.env.BLOB_LIMIT_GB || 1) * 1024 * 1024 * 1024;
const isDriveUrl = u => String(u || "").includes("/api/dfile/");
const isBlobUrl = u => /\.public\.blob\.vercel-storage\.com\//.test(u || "");
const isCatbox = u => /^https?:\/\/([\w-]+\.)?catbox\.moe\//i.test(u || "");

// ---------- libs (loaded lazily so a missing package never breaks the whole API) ----------
let _blob = null;
function blobLib() {
  if (_blob) return _blob;
  try { _blob = Object.assign({}, require("@vercel/blob"), require("@vercel/blob/client")); }
  catch (e) { throw new Error("Storage library missing - make sure package.json has @vercel/blob and redeploy"); }
  return _blob;
}
function needBlob() {
  if (!BLOB_TOKEN) throw new Error("Blob storage is not connected yet (Vercel -> Storage -> create a Blob store -> connect to this project -> Redeploy)");
}

// ---------- redis (Upstash REST, no packages) ----------
async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Redis env vars missing (connect the Upstash Redis store to this project)");
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error("redis: " + j.error);
  return j.result;
}
function parseHash(flat) {
  const out = {};
  const put = (k, v) => { try { out[k] = JSON.parse(v); } catch (e) { out[k] = null; } };
  if (Array.isArray(flat)) { for (let i = 0; i < flat.length; i += 2) put(flat[i], flat[i + 1]); }
  else if (flat && typeof flat === "object") { for (const k of Object.keys(flat)) put(k, flat[k]); }
  return out;
}

// ---------- helpers ----------
const normCat = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());
const newId = () => crypto.randomBytes(4).toString("hex");
const MIME = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", "3gp": "video/3gpp", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", opus: "audio/ogg", aac: "audio/aac", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const EXT_BY_KIND = { video: "mp4", audio: "mp3", gif: "gif", photo: "jpg", file: "bin" };
const extOf = s => { try { return (new URL(s).pathname.split(".").pop() || "").toLowerCase(); } catch (e) { return (String(s).split("?")[0].split(".").pop() || "").toLowerCase(); } };
function kindFromExt(s) {
  const e = extOf(s);
  if (["mp4", "mov", "webm", "mkv", "3gp"].includes(e)) return "video";
  if (["mp3", "m4a", "ogg", "wav", "opus", "aac", "oga"].includes(e)) return "audio";
  if (e === "gif") return "gif";
  if (["pdf", "zip", "rar", "7z", "apk", "txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(e)) return "file";
  return "photo";
}
function safeEq(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function loadAll() {
  const [c, m] = await Promise.all([redis(["HGETALL", CATS]), redis(["HGETALL", META])]);
  const raw = parseHash(c), metaRaw = parseHash(m);
  const categories = {}, meta = {};
  Object.keys(raw).sort().forEach((k, i) => {
    categories[k] = Array.isArray(raw[k]) ? raw[k] : [];
    const x = metaRaw[k] && typeof metaRaw[k] === "object" ? metaRaw[k] : {};
    meta[k] = { title: x.title || titleCase(k), icon: x.icon || "📁", order: Number.isFinite(x.order) ? x.order : 100000 + i };
  });
  const folders = Object.keys(categories).map(k => ({ key: k, title: meta[k].title, icon: meta[k].icon, order: meta[k].order, count: categories[k].length }))
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  return { categories, meta, folders };
}
const maxOrder = folders => folders.reduce((m, f) => Math.max(m, f.order), 0);
const saveCat = (key, arr) => redis(["HSET", CATS, key, JSON.stringify(arr)]);
const saveMeta = (key, m) => redis(["HSET", META, key, JSON.stringify(m)]);

async function createFolder(title, icon) {
  const key = normCat(title);
  if (!key) throw new Error("folder name missing");
  const all = await loadAll();
  if (all.categories[key]) { const e = new Error("folder already exists"); e.code = 409; throw e; }
  const m = { title: String(title).trim().slice(0, 60), icon: icon || "📁", order: maxOrder(all.folders) + 10 };
  await saveCat(key, []);
  await saveMeta(key, m);
  return { key, ...m, count: 0 };
}

async function addItem(category, url, kind, name, size) {
  const key = normCat(category);
  if (!key) throw new Error("folder name missing");
  let arr = await redis(["HGET", CATS, key]);
  let created = false;
  if (arr === null || arr === undefined) { await createFolder(category.trim()); arr = []; created = true; }
  else arr = JSON.parse(arr);
  const item = { id: newId(), url, kind: kind || kindFromExt(url), added: Date.now() };
  if (name) item.name = String(name).slice(0, 80);
  if (Number(size) > 0) item.size = Number(size);
  arr.push(item);
  await saveCat(key, arr);
  return { category: key, number: arr.length, total: arr.length, created, ...item };
}

async function dropBlobs(urls) {
  const list = urls.filter(isBlobUrl);
  if (!list.length || !BLOB_TOKEN) return;
  try { await blobLib().del(list, { token: BLOB_TOKEN }); } catch (e) { console.error("blob delete:", e.message); }
}

async function copyToBlob(url, kind) {
  needBlob();
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  if (!r.ok) throw new Error("could not download the file (HTTP " + r.status + ")");
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_FETCH) throw new Error("file is too large (max 250MB)");
  let ext = extOf(url);
  if (!MIME[ext]) ext = EXT_BY_KIND[kind] || "bin";
  const b = await blobLib().put("album/media." + ext, r.body, {
    access: "public", token: BLOB_TOKEN, addRandomSuffix: true, contentType: MIME[ext] || "application/octet-stream", multipart: !len || len > 20 * 1024 * 1024
  });
  return b.url;
}


async function dropFiles(urls) {
  await dropBlobs(urls);
  for (const u of urls) {
    if (!isDriveUrl(u)) continue;
    try { await drive.deleteFile(u.split("/api/dfile/")[1].split(".")[0]); } catch (e) { console.error("drive delete:", e.message); }
  }
}

async function getSettings() {
  try { const v = await redis(["GET", "album:settings"]); return v ? JSON.parse(v) : {}; } catch (e) { return {}; }
}
async function blobUsage(fresh) {
  if (!BLOB_TOKEN) return { used: 0, count: 0 };
  if (!fresh) {
    try { const c = await redis(["GET", "album:usage:blob"]); if (c) { const j = JSON.parse(c); if (Date.now() - j.t < 3 * 60 * 1000) return j; } } catch (e) {}
  }
  let used = 0, count = 0, cursor;
  const { list } = blobLib();
  do {
    const r = await list({ token: BLOB_TOKEN, limit: 1000, cursor });
    (r.blobs || []).forEach(b => { used += b.size || 0; count++; });
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  const j = { t: Date.now(), used, count };
  try { await redis(["SET", "album:usage:blob", JSON.stringify(j)]); } catch (e) {}
  return j;
}
async function driveStatus() {
  if (!drive.configured()) return { connected: false };
  return Object.assign({ connected: true }, await drive.status());
}
// where new files go: your choice, or "auto" = own storage until it is 90% full, then Google Drive
async function pickDest() {
  const want = (await getSettings()).dest || "auto";
  const haveDrive = drive.configured(), haveBlob = !!BLOB_TOKEN;
  if (want === "drive" && haveDrive) return "drive";
  if (want === "blob" && haveBlob) return "blob";
  if (haveBlob && haveDrive) {
    try { return (await blobUsage()).used >= BLOB_LIMIT * 0.9 ? "drive" : "blob"; } catch (e) { return "blob"; }
  }
  return haveBlob ? "blob" : haveDrive ? "drive" : "blob";
}
async function copyToDrive(url, kind, base) {
  let ext = extOf(url);
  if (!MIME[ext]) ext = EXT_BY_KIND[kind] || "bin";
  const j = await drive.fetchIntoDrive(url, ext);
  return { url: base + "/api/dfile/" + j.id + "." + ext, size: j.size };
}
async function copyAuto(url, kind, base) {
  const first = await pickDest();
  const order = first === "drive" ? ["drive", "blob"] : ["blob", "drive"];
  let err;
  for (const d of order) {
    if (d === "drive" && !drive.configured()) continue;
    if (d === "blob" && !BLOB_TOKEN) continue;
    try { return d === "drive" ? await copyToDrive(url, kind, base) : { url: await copyToBlob(url, kind) }; } catch (e) { err = e; }
  }
  throw err || new Error("No storage is connected yet");
}

// ---------- http ----------
function send(res, code, data, type) {
  res.statusCode = code;
  res.setHeader("Content-Type", type || "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}
const authed = req => safeEq(req.headers["x-api-key"], ADMIN_KEY);
function readStream(req, limit, msg) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error(msg || "body too large")); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function getBuffer(req, limit, msg) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return readStream(req, limit, msg);
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
  let p = u.pathname.replace(/\/+$/, "") || "/";
  const rp = u.searchParams.get("path"); // vercel.json rewrite passes the original path here
  if (rp !== null && (p === "/api/index" || p === "/api")) p = "/api/" + rp.replace(/^\/+|\/+$/g, "");
  const M = req.method;
  const siteBase = (req.headers["x-forwarded-proto"] || "https") + "://" + req.headers.host;
  try {
    if (M === "OPTIONS") return send(res, 204, "");
    if (M === "GET" && p.startsWith("/api/dfile/")) return await drive.serveFile(req, res, p.slice("/api/dfile/".length));

    // ----- public (read only) -----
    if (M === "GET" && p === "/api/folders") return send(res, 200, (await loadAll()).folders);
    if (M === "GET" && p === "/api/categories") {
      return send(res, 200, (await loadAll()).folders.map(f => ({ name: f.key, title: f.title, icon: f.icon, count: f.count })));
    }
    if (M === "GET" && p === "/api/album") {
      const q = normCat(u.searchParams.get("type"));
      const n = parseInt(u.searchParams.get("n"), 10);
      const { categories, meta, folders } = await loadAll();
      let key = null;
      if (/^\d+$/.test(q) && folders[Number(q) - 1]) key = folders[Number(q) - 1].key;
      if (!key && categories[q]) key = q;
      if (!key) key = Object.keys(categories).find(k => k.startsWith(q) || k.includes(q) || normCat(meta[k].title).includes(q));
      if (!q || !key) return send(res, 404, { error: "folder not found" });
      const arr = categories[key];
      if (!arr.length) return send(res, 404, { error: "folder is empty" });
      if (Number.isFinite(n) && (n < 1 || n > arr.length)) return send(res, 404, { error: "number " + n + " not found (this folder has " + arr.length + ")" });
      const idx = Number.isFinite(n) ? n - 1 : Math.floor(Math.random() * arr.length);
      const it = arr[idx];
      return send(res, 200, { category: key, title: meta[key].title, icon: meta[key].icon, id: it.id, url: it.url, kind: it.kind, name: it.name || "", number: idx + 1, total: arr.length });
    }

    // ----- direct browser upload token (auth is checked via clientPayload) -----
    if (M === "POST" && p === "/api/blob-upload") {
      needBlob();
      const body = await getJson(req);
      const json = await blobLib().handleUpload({
        token: BLOB_TOKEN, body, request: req,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          if (!safeEq(clientPayload, ADMIN_KEY)) throw new Error("wrong key");
          // default token life is only 30 seconds - far too short for a big video on a phone
          return { addRandomSuffix: true, maximumSizeInBytes: 500 * 1024 * 1024, validUntil: Date.now() + 3 * 60 * 60 * 1000 };
        }
      });
      return send(res, 200, json);
    }

    // ----- everything below needs the key -----
    if (!authed(req)) return send(res, 401, { error: "wrong or missing key" });

    if (M === "GET" && p === "/api/status") {
      let redisOk = false;
      try { redisOk = (await redis(["PING"])) === "PONG"; } catch (e) {}
      return send(res, 200, { redis: redisOk, blob: !!BLOB_TOKEN, version: "2.0" });
    }
    // where should new uploads go + storage meters
    if (M === "GET" && p === "/api/dest") return send(res, 200, { dest: await pickDest(), drive: drive.configured() });
    if (M === "POST" && p === "/api/drive/session") {
      const b = await getJson(req);
      if (!b.name) return send(res, 400, { error: "name required" });
      return send(res, 200, { sessionUrl: await drive.startSession(String(b.name).slice(0, 120), b.type || "application/octet-stream", Number(b.size) || 0, req.headers.origin || "") });
    }
    if (M === "GET" && p === "/api/usage") {
      const fresh = u.searchParams.get("fresh") === "1";
      const out = { blob: { connected: !!BLOB_TOKEN, limit: BLOB_LIMIT }, drive: await driveStatus(), catbox: { count: 0 }, items: 0 };
      if (BLOB_TOKEN) { try { const b = await blobUsage(fresh); out.blob.used = b.used; out.blob.count = b.count; } catch (e) { out.blob.error = e.message; } }
      const { categories } = await loadAll();
      Object.keys(categories).forEach(k => categories[k].forEach(it => { out.items++; if (isCatbox(it.url)) out.catbox.count++; }));
      const st = await getSettings();
      out.setting = st.dest || "auto";
      out.dest = await pickDest();
      return send(res, 200, out);
    }
    if (M === "POST" && p === "/api/settings") {
      const b = await getJson(req);
      if (!["auto", "blob", "drive"].includes(b.dest)) return send(res, 400, { error: "bad value" });
      await redis(["SET", "album:settings", JSON.stringify({ dest: b.dest })]);
      return send(res, 200, { ok: true, dest: b.dest });
    }

    // check that a link really works (from the server's side)
    if (M === "GET" && p === "/api/check") {
      const target = u.searchParams.get("url") || "";
      if (!/^https?:\/\//i.test(target)) return send(res, 400, { error: "bad link" });
      try {
        const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0", Range: "bytes=0-1023" }, redirect: "follow" });
        const range = r.headers.get("content-range") || "";
        const size = Number((range.split("/")[1]) || r.headers.get("content-length") || 0);
        try { await r.arrayBuffer(); } catch (e) {}
        return send(res, 200, { ok: r.ok || r.status === 206, status: r.status, type: r.headers.get("content-type") || "", size });
      } catch (e) {
        return send(res, 200, { ok: null, error: e.message });
      }
    }
    // remove a single file from blob storage (used by the upload self-test)
    if (M === "DELETE" && p === "/api/blob") {
      const target = u.searchParams.get("url") || "";
      if (!isBlobUrl(target)) return send(res, 400, { error: "not a storage link" });
      await dropBlobs([target]);
      return send(res, 200, { ok: true });
    }
    if (M === "GET" && (p === "/api/all" || p === "/api/export")) return send(res, 200, await loadAll());

    // add by link / copy from link
    if (M === "POST" && p === "/api/add") {
      const b = await getJson(req);
      if (!b.category || !b.url) return send(res, 400, { error: "folder and url required" });
      const kind = b.kind || kindFromExt(b.url);
      let url = b.url, size = b.size;
      const wantCopy = b.fetch !== undefined ? b.fetch : b.rehost;
      if (wantCopy && !isCatbox(url) && !isBlobUrl(url) && !isDriveUrl(url)) {
        const c = await copyAuto(url, kind, siteBase);
        url = c.url; size = c.size || size;
      }
      return send(res, 200, await addItem(b.category, url, kind, b.name, size));
    }

    // small raw upload (<=4MB), used by the bot as a fallback
    if (M === "POST" && p === "/api/upload") {
      needBlob();
      const category = u.searchParams.get("category");
      const name = (u.searchParams.get("name") || "file.bin").replace(/[^\w.\-]/g, "_");
      if (!category) return send(res, 400, { error: "folder required" });
      const buf = await getBuffer(req, MAX_RAW, "file too large for this route (max 4MB)");
      if (!buf.length) return send(res, 400, { error: "empty file" });
      let ext = extOf(name);
      if (!MIME[ext]) ext = "bin";
      const b = await blobLib().put("album/" + name, buf, { access: "public", token: BLOB_TOKEN, addRandomSuffix: true, contentType: MIME[ext] || "application/octet-stream" });
      return send(res, 200, await addItem(category, b.url, kindFromExt(name), "", buf.length));
    }

    // rename item / move item to another folder
    if (M === "POST" && p === "/api/item/update") {
      const b = await getJson(req);
      const all = await loadAll();
      let from = null, idx = -1;
      for (const k of Object.keys(all.categories)) {
        idx = all.categories[k].findIndex(x => x.id === b.id);
        if (idx > -1) { from = k; break; }
      }
      if (!from) return send(res, 404, { error: "item not found" });
      const item = all.categories[from][idx];
      if (b.kind && ["video", "audio", "photo", "gif", "sticker", "file"].includes(b.kind)) item.kind = b.kind;
      if (b.name !== undefined) { if (String(b.name).trim()) item.name = String(b.name).trim().slice(0, 80); else delete item.name; }
      if (b.category) {
        const to = normCat(b.category);
        if (!all.categories[to]) return send(res, 404, { error: "target folder not found" });
        if (to !== from) {
          all.categories[from].splice(idx, 1);
          all.categories[to].push(item);
          await saveCat(from, all.categories[from]);
          await saveCat(to, all.categories[to]);
          return send(res, 200, { ok: true });
        }
      }
      await saveCat(from, all.categories[from]);
      return send(res, 200, { ok: true });
    }

    if (M === "DELETE" && p === "/api/item") {
      const id = u.searchParams.get("id");
      const { categories } = await loadAll();
      for (const k of Object.keys(categories)) {
        const i = categories[k].findIndex(x => x.id === id);
        if (i > -1) {
          const [removed] = categories[k].splice(i, 1);
          await saveCat(k, categories[k]);
          await dropFiles([removed.url]);
          return send(res, 200, { category: k, ...removed });
        }
      }
      return send(res, 404, { error: "id not found" });
    }

    // folders
    if (M === "POST" && p === "/api/folder") {
      const b = await getJson(req);
      try { return send(res, 200, await createFolder(b.title, b.icon)); }
      catch (e) { return send(res, e.code || 400, { error: e.message }); }
    }
    if (M === "POST" && p === "/api/folders/bulk") {
      const b = await getJson(req);
      const all = await loadAll();
      let order = maxOrder(all.folders), made = 0;
      const cArgs = ["HSET", CATS], mArgs = ["HSET", META];
      for (const f of b.folders || []) {
        const key = normCat(f.title);
        if (!key || all.categories[key]) continue;
        order += 10; made++;
        cArgs.push(key, "[]");
        mArgs.push(key, JSON.stringify({ title: String(f.title).trim().slice(0, 60), icon: f.icon || "📁", order }));
        all.categories[key] = [];
      }
      if (made) { await redis(cArgs); await redis(mArgs); }
      return send(res, 200, { created: made });
    }
    if (M === "POST" && p === "/api/folder/update") {
      const b = await getJson(req);
      const old = normCat(b.key);
      const all = await loadAll();
      if (!all.categories[old]) return send(res, 404, { error: "folder not found" });
      const m = Object.assign({}, all.meta[old]);
      if (b.icon) m.icon = b.icon;
      let key = old;
      if (b.title && String(b.title).trim()) {
        m.title = String(b.title).trim().slice(0, 60);
        key = normCat(b.title);
      }
      if (key !== old) {
        if (all.categories[key]) return send(res, 409, { error: "a folder with that name already exists" });
        await saveCat(key, all.categories[old]);
        await redis(["HDEL", CATS, old]);
        await redis(["HDEL", META, old]);
      }
      await saveMeta(key, m);
      return send(res, 200, { ok: true, key });
    }
    if (M === "POST" && p === "/api/folder/move") {
      const b = await getJson(req);
      const { folders, meta } = await loadAll();
      const i = folders.findIndex(f => f.key === normCat(b.key));
      const j = b.dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= folders.length) return send(res, 200, { ok: true });
      [folders[i], folders[j]] = [folders[j], folders[i]];
      const args = ["HSET", META];
      folders.forEach((f, idx) => args.push(f.key, JSON.stringify(Object.assign({}, meta[f.key], { order: (idx + 1) * 10 }))));
      await redis(args);
      return send(res, 200, { ok: true });
    }
    if (M === "DELETE" && p === "/api/category") {
      const key = normCat(u.searchParams.get("name"));
      const raw = await redis(["HGET", CATS, key]);
      if (raw === null || raw === undefined) return send(res, 404, { error: "folder not found" });
      let items = []; try { items = JSON.parse(raw); } catch (e) {}
      await dropFiles(items.map(x => x.url));
      await redis(["HDEL", CATS, key]);
      await redis(["HDEL", META, key]);
      return send(res, 200, { ok: true });
    }

    // backup restore
    if (M === "POST" && p === "/api/import") {
      const data = await getJson(req);
      if (!data || typeof data.categories !== "object") return send(res, 400, { error: "invalid backup" });
      await redis(["DEL", CATS]); await redis(["DEL", META]);
      const cArgs = ["HSET", CATS], mArgs = ["HSET", META];
      let i = 0;
      for (const k of Object.keys(data.categories)) {
        const key = normCat(k);
        if (!key) continue;
        i++;
        cArgs.push(key, JSON.stringify(Array.isArray(data.categories[k]) ? data.categories[k] : []));
        const m = (data.meta && data.meta[k]) || {};
        mArgs.push(key, JSON.stringify({ title: m.title || titleCase(key), icon: m.icon || "📁", order: Number.isFinite(m.order) ? m.order : i * 10 }));
      }
      if (cArgs.length > 2) { await redis(cArgs); await redis(mArgs); }
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(p, e.message);
    return send(res, 500, { error: e.message });
  }
};
