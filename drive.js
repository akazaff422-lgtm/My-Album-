// Google Drive helper (used by api/index.js) | author: JABED VAO
// Env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
const { Readable } = require("stream");

const CID = process.env.GOOGLE_CLIENT_ID || "";
const CSEC = process.env.GOOGLE_CLIENT_SECRET || "";
const RTOK = process.env.GOOGLE_REFRESH_TOKEN || "";
const OAUTH = process.env.GOOGLE_OAUTH_URL || "https://oauth2.googleapis.com/token";
const API = process.env.GOOGLE_API_BASE || "https://www.googleapis.com";
const FOLDER_NAME = "JABED Album";
const MAX_FETCH = 150 * 1024 * 1024;
const MIME = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", "3gp": "video/3gpp", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", opus: "audio/ogg", aac: "audio/aac", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };

const configured = () => !!(CID && CSEC && RTOK);

let tok = { v: "", exp: 0 };
async function token() {
  if (tok.v && Date.now() < tok.exp - 60000) return tok.v;
  if (!configured()) throw new Error("Google Drive is not set up yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN missing)");
  const r = await fetch(OAUTH, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CID, client_secret: CSEC, refresh_token: RTOK, grant_type: "refresh_token" })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Google login failed: " + (j.error_description || j.error || r.status));
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.v;
}
async function g(path, opt) {
  opt = opt || {};
  const t = await token();
  return fetch(API + path, Object.assign({}, opt, { headers: Object.assign({ Authorization: "Bearer " + t }, opt.headers || {}) }));
}

let folder = "";
async function folderId() {
  if (folder) return folder;
  const q = encodeURIComponent("name='" + FOLDER_NAME + "' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const r = await g("/drive/v3/files?q=" + q + "&fields=files(id)&spaces=drive");
  const j = await r.json();
  if (!r.ok) throw new Error("Google error: " + ((j.error && j.error.message) || r.status));
  if (j.files && j.files[0]) return (folder = j.files[0].id);
  const c = await g("/drive/v3/files?fields=id", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" })
  });
  const cj = await c.json();
  if (!c.ok) throw new Error("Could not create the Drive folder: " + ((cj.error && cj.error.message) || c.status));
  return (folder = cj.id);
}

async function startSession(name, type, size, origin) {
  const parent = await folderId();
  const headers = { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type };
  if (size) headers["X-Upload-Content-Length"] = String(size);
  if (origin) headers["Origin"] = origin; // lets the browser upload straight to Google
  const r = await g("/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size", {
    method: "POST", headers, body: JSON.stringify({ name, parents: [parent] })
  });
  if (!r.ok) throw new Error("Google refused: " + (await r.text()).slice(0, 200));
  const loc = r.headers.get("location");
  if (!loc) throw new Error("Google did not return an upload address");
  return loc;
}

async function status() {
  if (!configured()) return { ok: false, error: "Google Drive is not set up yet" };
  try {
    const r = await g("/drive/v3/about?fields=storageQuota,user(emailAddress)");
    const j = await r.json();
    if (!r.ok) return { ok: false, error: (j.error && j.error.message) || ("HTTP " + r.status) };
    const q = j.storageQuota || {};
    return { ok: true, email: (j.user && j.user.emailAddress) || "", limit: q.limit ? Number(q.limit) : null, usage: Number(q.usage || 0) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// server downloads a link (Messenger media etc.) and stores it in Drive
async function fetchIntoDrive(url, ext) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  if (!r.ok) throw new Error("could not download the file (HTTP " + r.status + ")");
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_FETCH) throw new Error("file is too large (max 150MB)");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_FETCH) throw new Error("file is too large (max 150MB)");
  const type = MIME[ext] || "application/octet-stream";
  const loc = await startSession("media_" + Date.now() + "." + ext, type, buf.length, "");
  const up = await fetch(loc, { method: "PUT", headers: { "Content-Type": type, "Content-Length": String(buf.length) }, body: buf });
  const j = await up.json().catch(() => ({}));
  if (!up.ok || !j.id) throw new Error("Google upload failed (HTTP " + up.status + ")");
  return { id: j.id, size: buf.length };
}

async function deleteFile(id) {
  if (!/^[\w-]+$/.test(id)) return false;
  const r = await g("/drive/v3/files/" + id, { method: "DELETE" });
  return r.ok || r.status === 404;
}

// public streaming of a stored file, with Range support (so videos can seek)
async function serveFile(req, res, rest) {
  const id = rest.split(".")[0];
  const ext = (rest.split(".")[1] || "").toLowerCase();
  const fail = (code, msg) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.setHeader("Access-Control-Allow-Origin", "*"); res.end(JSON.stringify({ error: msg })); };
  if (!/^[\w-]+$/.test(id)) return fail(400, "bad id");
  const r = await g("/drive/v3/files/" + id + "?alt=media&supportsAllDrives=true", { headers: req.headers.range ? { Range: req.headers.range } : {} });
  if (!r.ok && r.status !== 206) return fail(r.status === 404 ? 404 : 502, "Drive could not give this file (HTTP " + r.status + ")");
  let ct = r.headers.get("content-type") || "";
  if (!ct || /octet-stream/.test(ct)) ct = MIME[ext] || ct || "application/octet-stream";
  res.statusCode = r.status;
  res.setHeader("Content-Type", ct);
  ["content-length", "content-range"].forEach(h => { const v = r.headers.get(h); if (v) res.setHeader(h, v); });
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!r.body) return res.end();
  Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
}

module.exports = { configured, status, startSession, fetchIntoDrive, deleteFile, serveFile, MIME };
