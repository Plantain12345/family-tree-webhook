// api/tree.js
import { db } from "./_db.js";
import { dobRange, dobSortValue } from "./date-utils.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

    const code = (req.query.code || "").toString().trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ error: "Bad code" });

    const { data: tree, error: tErr } = await db
      .from("trees")
      .select("id, name, join_code, created_at")
      .eq("join_code", code)
      .single();

    if (tErr || !tree) {
      console.log("API /tree: not found or error for code", code, tErr);
      return res.status(404).json({ error: "Tree not found" });
    }

    const [peopleResult, relsResult] = await Promise.all([
      db
        .from("persons")
        .select("id, primary_name, dob_dmy, gender")
        .eq("tree_id", tree.id),
      db.from("relationships").select("a, b, kind").eq("tree_id", tree.id),
    ]);

    const people = peopleResult?.map((p) => ({
      ...p,
      normalized_name: normalizeNameKey(p.primary_name),
      normalized_dob: normalizeDob(p.dob_dmy),
    })) || [];

    const rels = relsResult || [];

    return res.status(200).json({ tree, people, rels });
  } catch (e) {
    console.error("API /tree fatal error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}

function formatPersonRef(person) {
  if (!person) return null;
  return {
    id: person.id,
    name: person.primary_name || "Unnamed",
    dob: person.dob_dmy || null,
  };
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

function normalizeDob(dob) {
  return dobSortValue(dob);
}

function normalizeNameKey(name) {
  if (!name) return "";
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeDobKey(dob) {
  const range = dobRange(dob);
  if (!range) return "unknown";
  const start = Number.isFinite(range.start) ? range.start : "start";
  const end = Number.isFinite(range.end) ? range.end : "end";
  return `${start}-${end}`;
}
