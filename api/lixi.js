import { db } from "hatchable";

export const access = "public";
export const methods = ["GET", "POST"];

const norm = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getStatus() {
  const { rows } = await db.query("SELECT status FROM settings WHERE id = 1");
  return rows[0]?.status || "draft";
}

// Chỉ trả dữ liệu của chính người giữ mã này.
async function lookup(code) {
  const { rows } = await db.query(
    "SELECT p.name, p.drawn_at, s.denom FROM players p LEFT JOIN slots s ON s.player_id = p.id WHERE p.code = $1",
    [code]
  );
  return rows[0] || null;
}

function view(status, p) {
  return { status, name: p.name, drawn: !!p.drawn_at, amount: p.denom || null };
}

// Một câu lệnh duy nhất: khóa người chơi, chọn ngẫu nhiên 1 giải còn trống (SKIP LOCKED),
// gán giải và đánh dấu đã rút. Mọi thứ xảy ra cùng lúc hoặc không gì cả.
const DRAW_SQL = `
WITH p AS (
  SELECT id FROM players
  WHERE code = $1 AND drawn_at IS NULL
    AND (SELECT status FROM settings WHERE id = 1) = 'open'
  FOR UPDATE
),
s AS (
  SELECT id FROM slots
  WHERE player_id IS NULL AND EXISTS (SELECT 1 FROM p)
  ORDER BY random() LIMIT 1
  FOR UPDATE SKIP LOCKED
),
u AS (
  UPDATE slots SET player_id = (SELECT id FROM p)
  WHERE id IN (SELECT id FROM s)
  RETURNING denom
),
d AS (
  UPDATE players SET drawn_at = now()
  WHERE id IN (SELECT id FROM p) AND EXISTS (SELECT 1 FROM u)
  RETURNING id
)
SELECT (SELECT denom FROM u) AS denom`;

export default async function (req, res) {
  if (req.method === "GET") {
    const status = await getStatus();
    const code = norm(req.query?.code);
    if (!code) return res.json({ status });
    const p = await lookup(code);
    if (!p) return res.status(404).json({ error: "not_found", message: "Mã không đúng rồi, kiểm tra lại nha!" });
    return res.json(view(status, p));
  }

  // POST: rút lì xì
  const code = norm(req.body?.code);
  if (!code) return res.status(400).json({ error: "not_found", message: "Nhập mã tham gia trước nha!" });

  for (let attempt = 0; attempt < 6; attempt++) {
    const { rows } = await db.query(DRAW_SQL, [code]);
    const denom = rows[0]?.denom;
    if (denom) {
      return res.json({ status: "open", drawn: true, amount: Number(denom), fresh: true });
    }

    const p = await lookup(code);
    if (!p) return res.status(404).json({ error: "not_found", message: "Mã không đúng rồi, kiểm tra lại nha!" });
    const status = await getStatus();
    if (p.drawn_at) return res.json({ ...view(status, p), fresh: false });
    if (status !== "open") {
      return res.status(403).json({ error: "not_open", status, message: status === "closed" ? "Chương trình đã đóng rồi." : "Chương trình chưa mở, chờ chị xíu nha!" });
    }
    const left = await db.query("SELECT count(*)::int AS n FROM slots WHERE player_id IS NULL");
    if (left.rows[0].n === 0) {
      return res.status(409).json({ error: "sold_out", message: "Hết lì xì mất rồi, lần sau nhanh tay hơn nha!" });
    }
    await sleep(80); // còn giải nhưng đang bị request khác giữ khóa -> thử lại
  }
  return res.status(503).json({ error: "busy", message: "Hệ thống đang đông, thử lại sau vài giây nha!" });
}