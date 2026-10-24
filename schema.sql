-- 论坛帖子表（在 Cloudflare D1 中执行一次即可）
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    text TEXT DEFAULT '',
    image BLOB,
    image_mime TEXT,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
