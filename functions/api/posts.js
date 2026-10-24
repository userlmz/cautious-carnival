// Cloudflare Pages Functions — 论坛式纪念墙 API
// 绑定：D1 数据库（变量名 DB）、环境变量 ADMIN_PASSWORD（与管理员密码一致）

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });

// GET /api/posts          → 帖子列表（不含图片内容）
// GET /api/posts?img=12   → 返回某帖的照片
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "未绑定数据库 DB" }, 500);
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
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  const { results } = await env.DB.prepare(
    "SELECT id, name, text, (image IS NOT NULL) AS has_image, created_at FROM posts ORDER BY id DESC LIMIT 200"
  ).all();
  return json({ ok: true, posts: results });
}

// POST /api/posts  （FormData：name, text, image 可选）→ 发帖
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "未绑定数据库 DB" }, 500);
  let name = "匿名同学", text = "", imageBuf = null, imageMime = null;
  try {
    const form = await request.formData();
    name = String(form.get("name") || "匿名同学").trim().slice(0, 20) || "匿名同学";
    text = String(form.get("text") || "").trim().slice(0, 500);
    const img = form.get("image");
    if (img && typeof img !== "string") {
      if (img.size > 1024 * 1024) return json({ ok: false, error: "照片太大了" }, 400);
      imageBuf = await img.arrayBuffer();
      imageMime = img.type || "image/jpeg";
    }
  } catch {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  if (!text && !imageBuf) return json({ ok: false, error: "内容和照片至少要有一个" }, 400);

  // 简单防刷：同一 IP 每分钟最多 3 帖
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM posts WHERE ip = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(ip).first();
  if (recent.c >= 3) return json({ ok: false, error: "发帖太频繁，休息一下再发" }, 429);

  await env.DB.prepare("INSERT INTO posts (name, text, image, image_mime, ip) VALUES (?, ?, ?, ?, ?)")
    .bind(name, text, imageBuf, imageMime, ip).run();
  return json({ ok: true });
}

// DELETE /api/posts  （JSON：{id, password}）→ 管理员删帖
export async function onRequestDelete({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "未绑定数据库 DB" }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "请求格式错误" }, 400); }
  if (!env.ADMIN_PASSWORD || String(body.password || "") !== env.ADMIN_PASSWORD) {
    return json({ ok: false, error: "管理员密码错误" }, 401);
  }
  const id = Number(body.id);
  if (!id) return json({ ok: false, error: "缺少帖子 id" }, 400);
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
  return json({ ok: true });
}
