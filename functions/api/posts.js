// forum API with auto schema and base64 image compat

const SCHEMA_SQL = "CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, text TEXT DEFAULT '', image BLOB, image_mime TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now', 'localtime')))";

async function ensureSchema(env) {
  await env.DB.prepare(SCHEMA_SQL).run();
}

function toBytes(val) {
  if (val instanceof ArrayBuffer) return val;
  if (val && val.buffer) return val.buffer;
  if (typeof val === "string") {
    let s = val;
    const comma = s.indexOf(",");
    if (s.slice(0, 5) === "data:" && comma > 0) s = s.slice(comma + 1);
    const bin = atob(s);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }
  return null;
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
    if (!row || !row.image) return new Response("Not found", { status: 404 });
    const bytes = toBytes(row.image);
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(bytes, {
      headers: {
        "Content-Type": row.image_mime || "image/jpeg",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400"
      }
    });
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
    if (img) {
      if (typeof img === "string") {
        const comma = img.indexOf(",");
        if (img.slice(0, 5) === "data:" && comma > 0) {
          imageMime = img.slice(5, comma).split(";")[0] || "image/jpeg";
        }
        imageVal = img;
      } else {
        if (img.size > 1024 * 1024) return json({ ok: false, error: "photo too large" }, 400);
        imageMime = img.type || "image/jpeg";
        imageVal = await img.arrayBuffer();
      }
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

  let imageToStore = imageVal;
  if (typeof imageVal === "string") {
    const comma = imageVal.indexOf(",");
    imageToStore = comma > 0 ? imageVal.slice(comma + 1) : imageVal;
  }
  await env.DB.prepare("INSERT INTO posts (name, text, image, image_mime, ip) VALUES (?, ?, ?, ?, ?)")
    .bind(name, text, imageToStore, imageMime, ip).run();
  return json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "DB not bound" }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad request" }, 400); }
  if (!env.ADMIN_PASSWORD || String(body.password || "") !== env.ADMIN_PASSWORD) {
    return json({ ok: false, error: "wrong admin password" }, 401);
  }
  const id = Number(body.id);
  if (!id) return json({ ok: false, error: "missing id" }, 400);
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
  return json({ ok: true });
}
