// forum API v5 - image fix + delete fix

const ADMIN_KEY = "135790LMZuser";

const SCHEMA_SQL = "CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, text TEXT DEFAULT '', image BLOB, image_mime TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now', 'localtime')))";

async function ensureSchema(env) {
  await env.DB.prepare(SCHEMA_SQL).run();
}

function imageToResponse(imageVal, mime) {
  let bytes = null;
  if (imageVal instanceof ArrayBuffer) {
    bytes = new Uint8Array(imageVal);
  } else if (ArrayBuffer.isView(imageVal)) {
    bytes = new Uint8Array(imageVal.buffer, imageVal.byteOffset, imageVal.byteLength);
  } else if (typeof imageVal === "string") {
    let s = imageVal;
    const comma = s.indexOf(",");
    if (s.slice(0, 5) === "data:" && comma > 0) s = s.slice(comma + 1);
    s = s.replace(/\s/g, "");
    try {
      const bin = atob(s);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      bytes = arr;
    } catch (e) {
      return null;
    }
  }
  if (!bytes || bytes.length === 0) return null;
  let type = mime || "image/jpeg";
  const h0 = bytes[0];
  const h1 = bytes[1];
  if (h0 === 0xFF && h1 === 0xD8) type = "image/jpeg";
  else if (h0 === 0x89 && h1 === 0x50) type = "image/png";
  else if (h0 === 0x47 && h1 === 0x49) type = "image/gif";
  else if (h0 === 0x52 && h1 === 0x49) type = "image/webp";
  else if (h0 === 0x3C) return null;
  return new Response(bytes, {
    headers: {
      "Content-Type": type,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400",
      "Content-Length": String(bytes.length)
    }
  });
}

const json = (data, status) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    }
  });

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "DB not bound" }, 500);
  await ensureSchema(env);
  const url = new URL(request.url);
  const imgId = url.searchParams.get("img");

  if (imgId) {
    const row = await env.DB.prepare("SELECT image, image_mime FROM posts WHERE id = ?")
      .bind(Number(imgId)).first();
    if (!row || row.image === null || row.image === undefined) {
      return new Response("Not found", { status: 404 });
    }
    if (url.searchParams.get("debug") === "1") {
      let len = null;
      if (typeof row.image === "string") len = row.image.length;
      else if (row.image && row.image.byteLength !== undefined) len = row.image.byteLength;
      let head = "";
      if (typeof row.image === "string") head = row.image.slice(0, 40);
      return json({
        kind: Object.prototype.toString.call(row.image),
        type: typeof row.image,
        len: len,
        mime: row.image_mime,
        head: head
      });
    }
    const resp = imageToResponse(row.image, row.image_mime);
    if (!resp) return new Response("Unreadable image data", { status: 415 });
    return resp;
  }

  const { results } = await env.DB.prepare(
    "SELECT id, name, text, (image IS NOT NULL) AS has_image, created_at FROM posts ORDER BY id DESC LIMIT 200"
  ).all();
  return json({ ok: true, posts: results });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "DB not bound" }, 500);
  await ensureSchema(env);
  let name = "匿名同学";
  let text = "";
  let imageVal = null;
  let imageMime = "image/jpeg";
  try {
    const form = await request.formData();
    name = String(form.get("name") || "匿名同学").trim().slice(0, 20) || "匿名同学";
    text = String(form.get("text") || "").trim().slice(0, 500);
    const img = form.get("image");
    if (img && typeof img !== "string") {
      if (img.size > 1024 * 1024) return json({ ok: false, error: "photo too large" }, 400);
      imageMime = img.type || "image/jpeg";
      imageVal = await img.arrayBuffer();
    }
  } catch (e) {
    return json({ ok: false, error: "bad request" }, 400);
  }
  if (!text && !imageVal) return json({ ok: false, error: "empty post" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM posts WHERE ip = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(ip).first();
  if (recent.c >= 3) return json({ ok: false, error: "too many posts" }, 429);

  await env.DB.prepare("INSERT INTO posts (name, text, image, image_mime, ip) VALUES (?, ?, ?, ?, ?)")
    .bind(name, text, imageVal, imageMime, ip).run();
  return json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "DB not bound" }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad request" }, 400); }

  const given = String(body.password || "").trim();
  const fromEnv = String(env.ADMIN_PASSWORD || "").trim();
  const ok = given === ADMIN_KEY || (fromEnv && given === fromEnv);
  if (!ok) return json({ ok: false, error: "wrong admin password" }, 401);

  const id = Number(body.id);
  if (!id) return json({ ok: false, error: "missing id" }, 400);
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
  return json({ ok: true });
}
