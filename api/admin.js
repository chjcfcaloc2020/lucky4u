import { db } from "hatchable";

export const access = "admin";
export const methods = ["GET", "POST"];

const DENOMS = [10000, 20000, 50000, 100000, 200000, 500000];
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // dùng khi tên không có chữ cái nào để tạo mã
// "Trọc" -> "troc", "Minh Anh" -> "minhanh", "Đạt" -> "dat"
const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]/g, "").slice(0, 24);

function genCode() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join("").toLowerCase();
}

async function state() {
  const st = (await db.query("SELECT status, budget FROM settings WHERE id = 1")).rows[0];
  const prizes = (await db.query(
    "SELECT denom, count(*)::int AS total, count(player_id)::int AS drawn FROM slots GROUP BY denom ORDER BY denom"
  )).rows;
  const players = (await db.query(
    `SELECT p.id, p.name, p.code, p.drawn_at, s.denom AS amount, COALESCE(s.paid, false) AS paid, s.paid_at
     FROM players p LEFT JOIN slots s ON s.player_id = p.id ORDER BY p.id`
  )).rows;
  const qty = Object.fromEntries(DENOMS.map((d) => [d, prizes.find((p) => p.denom === d)?.total || 0]));
  const committed = prizes.reduce((a, p) => a + p.denom * p.total, 0);
  return { status: st.status, budget: Number(st.budget), qty, committed, prizes, players };
}

const bad = (res, message) => res.status(400).json({ error: "bad_request", message });

export default async function (req, res) {
  if (req.method === "GET") return res.json(await state());

  const { action } = req.body || {};

  if (action === "add_players") {
    const names = (Array.isArray(req.body.names) ? req.body.names : [])
      .map((n) => String(n).trim().slice(0, 60)).filter(Boolean).slice(0, 100);
    if (!names.length) return bad(res, "Chưa có tên nào.");
    for (const name of names) {
      let ok = false;
      const base = slug(name);
      for (let i = 1; i <= 60 && !ok; i++) {
        // trùng tên thì thêm số: troc, troc2, troc3...
        const code = !base ? genCode() : i === 1 ? base : base + i;
        const r = await db.query(
          "INSERT INTO players (name, code) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING id",
          [name, code]
        );
        ok = r.rows.length > 0;
      }
      if (!ok) return res.status(500).json({ error: "code_gen", message: "Không tạo được mã, thử lại." });
    }
    return res.json(await state());
  }

  if (action === "save_config") {
    const budget = Number(req.body.budget);
    const qty = req.body.qty || {};
    if (!Number.isInteger(budget) || budget < 0) return bad(res, "Ngân sách không hợp lệ.");
    let total = 0;
    const stmts = [
      { sql: "UPDATE settings SET budget = $1 WHERE id = 1 AND status = 'draft'", params: [budget] },
      { sql: "DELETE FROM slots WHERE player_id IS NULL AND (SELECT status FROM settings WHERE id = 1) = 'draft'", params: [] },
    ];
    for (const d of DENOMS) {
      const n = Number(qty[d] ?? 0);
      if (!Number.isInteger(n) || n < 0 || n > 500) return bad(res, `Số lượng giải ${d / 1000}k không hợp lệ.`);
      total += n * d;
      if (n > 0) {
        stmts.push({
          sql: "INSERT INTO slots (denom) SELECT $1::int FROM generate_series(1, $2::int) WHERE (SELECT status FROM settings WHERE id = 1) = 'draft'",
          params: [d, n],
        });
      }
    }
    if (total > budget) return bad(res, "Tổng giá trị giải vượt quá ngân sách.");
    const cur = (await db.query("SELECT status FROM settings WHERE id = 1")).rows[0].status;
    if (cur !== "draft") return bad(res, "Chương trình đã mở, không thể đổi cấu hình giải.");
    await db.transaction(stmts);
    return res.json(await state());
  }

  if (action === "set_status") {
    const next = req.body.status;
    const s = await state();
    if (next === "open") {
      if (s.status === "open") return res.json(s);
      if (s.status === "draft" && (s.committed <= 0 || s.committed > s.budget)) {
        return bad(res, "Cần cấu hình giải (tổng ≤ ngân sách) trước khi mở.");
      }
      await db.query("UPDATE settings SET status = 'open' WHERE id = 1");
    } else if (next === "closed") {
      if (s.status !== "open") return bad(res, "Chương trình chưa mở.");
      await db.query("UPDATE settings SET status = 'closed' WHERE id = 1");
    } else return bad(res, "Trạng thái không hợp lệ.");
    return res.json(await state());
  }

  if (action === "mark_paid") {
    const id = Number(req.body.player_id);
    const paid = !!req.body.paid;
    if (!Number.isInteger(id)) return bad(res, "Thiếu người chơi.");
    await db.query(
      "UPDATE slots SET paid = $2::boolean, paid_at = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE player_id = $1",
      [id, paid]
    );
    return res.json(await state());
  }

  return bad(res, "Hành động không hợp lệ.");
}