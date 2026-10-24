// forum API with auto schema

const SCHEMA_SQL = "CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, text TEXT DEFAULT '', image BLOB, image_mime TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now', 'localtime')))";

async function ensureSchema(env) {
  await env.DB.prepare(SCHEMA_SQL).run();
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
    return new Response(row.image, {
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
  let imageBuf = null;
  let imageMime = null;
  try {
    const form = await request.formData();
    name = String(form.get("name") || "匿名同学").trim().slice(0, 20) || "匿名同学";
    text = String(form.get("text") || "").trim().slice(0, 500);
    const img = form.get("image");
    if (img && typeof img !== "string") {
      if (img.size > 1024 * 1024) return json({ ok: false, error: "photo too large" }, 400);
      imageBuf = await img.arrayBuffer();
      imageMime = img.type || "image/jpeg";
    }
  } catch (e) {
    return json({ ok: false, error: "bad request" }, 400);
  }
  if (!text && !imageBuf) return json({ ok: false, error: "empty post" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM posts WHERE ip = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(ip).first();
  if (recent.c >= 3) return json({ ok: false, error: "too many posts" }, 429);

  await env.DB.prepare("INSERT INTO posts (name, text, image, image_mime, ip) VALUES (?, ?, ?, ?, ?)")
    .bind(name, text, imageBuf, imageMime, ip).run();
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
