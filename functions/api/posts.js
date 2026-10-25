// Yixin Album - Posts API (v6 final)
// Fixes: D1 returns BLOB as plain JS Array -> support Array of numbers

const ADMIN_KEY = "135790LMZuser";
const SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS posts (",
  "id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "name TEXT NOT NULL,",
  "text TEXT NOT NULL,",
  "image BLOB,",
  "image_mime TEXT,",
  "ip TEXT,",
  "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
  ")"
].join(" ");

async function ensureSchema(env) {
  await env.DB.prepare(SCHEMA_SQL).run();
}

function getIp(request) {
  return (request.headers.get("cf-connecting-ip") || "unknown").slice(0, 64);
}

// v6: D1 BLOB may come back as Array of numbers, ArrayBuffer, TypedArray, or base64 string
function imageToBytes(imageVal) {
  try {
    if (imageVal == null) return null;
    if (typeof imageVal === "string") {
      // base64 string (some runtimes return this)
      const bin = atob(imageVal);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
    if (Array.isArray(imageVal)) {
      // D1 actually returns a plain JS Array of numbers
      if (imageVal.length && typeof imageVal[0] === "number") {
        return new Uint8Array(imageVal);
      }
      // Array of chars (rare) -> join to string, treat as base64
      const bin = imageVal.join("");
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
    if (imageVal instanceof ArrayBuffer) return new Uint8Array(imageVal);
    if (ArrayBuffer.isView(imageVal)) return new Uint8Array(imageVal.buffer, imageVal.byteOffset, imageVal.byteLength);
    if (typeof imageVal.length === "number") {
      // last resort: array-like of numbers
      const arr = new Uint8Array(imageVal.length);
      for (let i = 0; i < imageVal.length; i++) arr[i] = imageVal[i] & 0xff;
      return arr;
    }
  } catch (e) {
    return null;
  }
  return null;
}

function sniffMime(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    }
  });
}

async function checkRateLimit(env, ip) {
  try {
    const cutoff = new Date(Date.now() - 60000).toISOString();
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM posts WHERE ip = ? AND created_at > ?"
    ).bind(ip, cutoff).first();
    return r && r.c < 3;
  } catch (e) {
    return true; // never block posting because of rate check failure
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env || !env.DB) return json({ error: "db not bound" }, 500);

  const url = new URL(request.url);
  const imgId = url.searchParams.get("img");
  const debug = url.searchParams.get("debug");

  if (imgId) {
    try {
      const row = await env.DB.prepare(
        "SELECT image, image_mime FROM posts WHERE id = ?"
      ).bind(parseInt(imgId, 10)).first();
      if (!row || !row.image) return new Response("no image", { status: 404 });

      const bytes = imageToBytes(row.image);
      if (!bytes) return new Response("bad image data", { status: 415 });

      if (debug) {
        let kind = Object.prototype.toString.call(row.image);
        try { kind = row.image.constructor ? row.image.constructor.name : kind; } catch (e) {}
        return json({
          kind: kind,
          type: typeof row.image,
          len: bytes.length,
          mime: sniffMime(bytes),
          storedMime: row.image_mime,
          head: Array.from(bytes.slice(0, 8))
        });
      }

      const mime = sniffMime(bytes) || row.image_mime || "image/jpeg";
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (e) {
      return json({ error: String(e && e.message) }, 500);
    }
  }

  try {
    await ensureSchema(env);
    const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 50, 200);
    const rs = await env.DB.prepare(
      "SELECT id, name, text, image, image_mime, created_at FROM posts ORDER BY id DESC LIMIT ?"
    ).bind(limit).all();
    const posts = (rs.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      text: r.text,
      hasImage: !!r.image,
      imageUrl: r.image ? ("/api/posts?img=" + r.id) : null,
      createdAt: r.created_at
    }));
    return json({ ok: true, posts: posts });
  } catch (e) {
    return json({ error: String(e && e.message) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env || !env.DB) return json({ error: "db not bound" }, 500);

  try {
    await ensureSchema(env);
    const ip = getIp(request);
    if (!(await checkRateLimit(env, ip))) {
      return json({ error: "Too many posts, please wait a minute" }, 429);
    }

    let name = "", text = "";
    let file = null;

    const ct = request.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      name = (form.get("name") || "").toString().trim();
      text = (form.get("text") || "").toString().trim();
      file = form.get("image");
    } else {
      const body = await request.json();
      name = (body.name || "").toString().trim();
      text = (body.text || "").toString().trim();
    }

    if (!name) return json({ error: "name required" }, 400);
    if (!text && !file) return json({ error: "empty post" }, 400);
    if (name.length > 20) name = name.slice(0, 20);
    if (text.length > 500) text = text.slice(0, 500);

    let imgBytes = null, imgMime = null;
    if (file && typeof file === "object" && file.size > 0) {
      if (file.size > 4 * 1024 * 1024) return json({ error: "image too large (max 4MB)" }, 413);
      imgBytes = new Uint8Array(await file.arrayBuffer());
      imgMime = file.type || "image/jpeg";
      const sniffed = sniffMime(imgBytes);
      if (!sniffed) return json({ error: "not a valid image" }, 415);
      imgMime = sniffed;
    }

    const ins = await env.DB.prepare(
      "INSERT INTO posts (name, text, image, image_mime, ip, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).bind(name, text, imgBytes, imgMime, ip).run();

    return json({ ok: true, id: ins.meta && ins.meta.last_row_id });
  } catch (e) {
    return json({ error: String(e && e.message) }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!env || !env.DB) return json({ error: "db not bound" }, 500);

  try {
    const url = new URL(request.url);
    let id = parseInt(url.searchParams.get("id"), 10);
    let given = url.searchParams.get("password") || "";
    // Fallback: also accept JSON body (old frontend sends id/password in body)
    if (!id) {
      try {
        const body = await request.json();
        id = parseInt(body && body.id, 10);
        if (!given) given = (body && body.password || "").toString();
      } catch (e) {}
    }
    if (!id) return json({ error: "id required" }, 400);

    let fromEnv = "";
    try { fromEnv = (env.ADMIN_PASSWORD || "").toString(); } catch (e) {}
    if (given !== ADMIN_KEY && (!fromEnv || given !== fromEnv)) {
      return json({ error: "wrong admin password" }, 403);
    }

    await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e && e.message) }, 500);
  }
}
