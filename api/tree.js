// api/tree.js
import { db } from "./_db.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const code = (req.query.code || "").toString().trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return res.status(400).json({ error: "Bad code" });
    }

    const { data: tree, error: tErr } = await db
      .from("trees")
      .select("id, name, join_code, created_at")
      .eq("join_code", code)
      .single();

    if (tErr || !tree) {
      console.log("API /tree: not found or error for code", code, tErr);
      return res.status(404).json({ error: "Tree not found" });
    }

    const [{ data: peopleRows, error: pErr }, { data: relsRows, error: rErr }] =
      await Promise.all([
        db
          .from("persons")
          .select("id, primary_name, dob_dmy, gender")
          .eq("tree_id", tree.id),
        db.from("relationships").select("a, b, kind").eq("tree_id", tree.id),
      ]);

    if (pErr) console.error("API /tree persons error:", pErr);
    if (rErr) console.error("API /tree relationships error:", rErr);

    const people =
      (peopleRows || []).map((p) => ({
        ...p,
        normalized_name: normalizeNameKey(p.primary_name),
        normalized_dob: normalizeDob(p.dob_dmy), // sortable numeric or null
      })) || [];

    const rels = relsRows || [];

    return res.status(200).json({ tree, people, rels });
  } catch (e) {
    console.error("API /tree fatal error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}

/* ------------------------ local helpers (no date-utils) ------------------------ */

function normalizeNameKey(name) {
  if (!name) return "";
  return name.toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeGender(raw) {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim().toLowerCase();
  if (!value) return null;
  if (["m", "male", "man", "boy"].includes(value)) return "male";
  if (["f", "female", "woman", "girl"].includes(value)) return "female";
  if (["nb", "nonbinary", "non-binary", "non binary"].includes(value)) return "nonbinary";
  return value;
}

/**
 * parseFlexibleDate
 * Accepts: "YYYY", "YYYY-MM", "YYYY-MM-DD"
 * Returns { range: { start:number, end:number } } or null
 */
function parseFlexibleDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const y = Number.parseInt(s.slice(0, 4), 10);
    if (Number.isInteger(y)) return { range: { start: y, end: y } };
  }
  // YYYY-MM
  if (/^\d{4}-\d{2}$/.test(s)) {
    const y = Number.parseInt(s.slice(0, 4), 10);
    if (Number.isInteger(y)) return { range: { start: y, end: y } };
  }
  // YYYY
  if (/^\d{4}$/.test(s)) {
    const y = Number.parseInt(s, 10);
    if (Number.isInteger(y)) return { range: { start: y, end: y } };
  }
  return null;
}

/**
 * dobRange
 * Returns a coarse year range for overlap checks: {start, end} or null.
 */
function dobRange(dob) {
  const parsed = parseFlexibleDate(dob);
  return parsed?.range ? { start: parsed.range.start, end: parsed.range.end } : null;
}

/**
 * dobSortValue
 * Converts DOB strings into a sortable integer (YYYYMMDD/YYYYMM/YYYY0000).
 * Unknown/invalid returns null.
 */
function dobSortValue(dob) {
  if (!dob) return null;
  const s = String(dob).trim();
  if (!s) return null;

  // YYYY-MM-DD -> YYYYMMDD
  const mFull = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mFull) {
    const y = Number(mFull[1]);
    const m = Number(mFull[2]);
    const d = Number(mFull[3]);
    if (Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)) {
      return y * 10000 + m * 100 + d;
    }
  }

  // YYYY-MM -> YYYYMM00
  const mYM = s.match(/^(\d{4})-(\d{2})$/);
  if (mYM) {
    const y = Number(mYM[1]);
    const m = Number(mYM[2]);
    if (Number.isInteger(y) && Number.isInteger(m)) {
      return y * 10000 + m * 100; // day unknown -> 00
    }
  }

  // YYYY -> YYYY0000
  const mY = s.match(/^(\d{4})$/);
  if (mY) {
    const y = Number(mY[1]);
    if (Number.isInteger(y)) return y * 10000; // month/day unknown -> 0000
  }

  return null;
}

/**
 * normalizeDob
 * Public helper used above. Produces a sortable numeric or null.
 */
function normalizeDob(dob) {
  return dobSortValue(dob);
}

/* Optionally used elsewhere; kept for completeness. */
function normalizeDobKey(dob) {
  const range = dobRange(dob);
  if (!range) return "unknown";
  const start = Number.isFinite(range.start) ? range.start : "start";
  const end = Number.isFinite(range.end) ? range.end : "end";
  return `${start}-${end}`;
}
