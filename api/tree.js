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
          .select("id, primary_name, dob_dmy, gender") // <-- FIX: Added gender column
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

    // Build GEDCOM-like family groupings (partners + children)
    const families = buildFamilies(people, rels);

    return res.status(200).json({ tree, people, rels, families });
  } catch (e) {
    console.error("API /tree fatal error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}

/* ----------------------------- families builder ----------------------------- */

function buildFamilies(people, rels) {
  const personIds = new Set((people || []).map((p) => String(p.id)));
  const partnerKinds = new Set(["spouse_of", "partner_of", "divorced_from"]);
  const parentKind = "parent_of";

  // Map "A|B" -> { partners:[A,B], kinds:Set(), children:Set() }
  const partnerPairs = new Map();
  // Map childId -> Set(parentIds)
  const childParents = new Map();

  for (const rel of rels || []) {
    if (!rel) continue;
    const a = rel.a != null ? String(rel.a) : null;
    const b = rel.b != null ? String(rel.b) : null;
    // For directed relationships, b might not be a person (e.g., parent_of event)
    if (partnerKinds.has(rel.kind)) {
      if (!a || !b || !personIds.has(a) || !personIds.has(b)) continue;
      const key = pairKey(a, b);
      let entry = partnerPairs.get(key);
      if (!entry) {
        entry = { partners: [a, b], kinds: new Set(), children: new Set() };
        partnerPairs.set(key, entry);
      }
      entry.kinds.add(rel.kind);
    } else if (rel.kind === parentKind) {
      if (!a || !b || !personIds.has(a) || !personIds.has(b)) continue;
      if (!childParents.has(b)) childParents.set(b, new Set());
      childParents.get(b).add(a);
    }
  }


  // Attach children to partner pairs when BOTH parents are present
  for (const [childId, parentsSet] of childParents.entries()) {
    const parents = Array.from(parentsSet);
    if (parents.length < 2) continue;

    const sorted = parents
      .map(String)
      .filter((id) => personIds.has(id))
      .sort(); // stable pair key

    outer: for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = pairKey(sorted[i], sorted[j]);
        const pair = partnerPairs.get(key);
        if (pair) {
          pair.children.add(childId);
          // Mark parents as handled for this child to avoid single-parent family creation
          parentsSet.delete(sorted[i]);
          parentsSet.delete(sorted[j]);
          break outer;
        }
      }
    }
  }

  const families = [];
  let counter = 1;

  // Convert partner pairs to family objects
  for (const pair of partnerPairs.values()) {
    const kinds = Array.from(pair.kinds);
    const status = kinds.includes("divorced_from") ? "divorced" : "partnered";
    families.push({
      id: `fam_${counter++}`,
      partners: pair.partners,                // [idA, idB]
      children: Array.from(pair.children),    // [childId...]
      partnership_kinds: kinds,               // e.g., ["spouse_of"]
      status,                                 // "partnered" | "divorced"
    });
  }

  // Make single-parent families for remaining parent links
  const singleParentFamilies = new Map(); // parentId -> family
  for (const [childId, parentsSet] of childParents.entries()) {
    if (!parentsSet || !parentsSet.size) continue;
    for (const parentIdRaw of parentsSet) {
      const parentId = String(parentIdRaw);
      if (!personIds.has(parentId)) continue;
      let fam = singleParentFamilies.get(parentId);
      if (!fam) {
        fam = {
          id: `fam_${counter++}`,
          partners: [parentId],
          children: [],
          partnership_kinds: [],
          status: "single",
        };
        singleParentFamilies.set(parentId, fam);
      }
      fam.children.push(childId);
    }
  }

  families.push(...singleParentFamilies.values());
  return families;
}


function pairKey(a, b) {
  return [String(a), String(b)].sort().join("|");
}

/* ------------------------ local helpers (no date-utils) ------------------------ */

function normalizeNameKey(name) {
  if (!name) return "";
  return name.toString().trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Convert DOB to sortable integer (YYYYMMDD / YYYYMM00 / YYYY0000).
 * Unknown/invalid -> null.
 */
function dobSortValue(dob) {
  if (!dob) return null;
  const s = String(dob).trim();
  if (!s) return null;

  const mFull = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mFull) {
    const y = Number(mFull[1]);
    const m = Number(mFull[2]);
    const d = Number(mFull[3]);
    if (Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)) {
      return y * 10000 + m * 100 + d;
    }
  }

  const mYM = s.match(/^(\d{4})-(\d{2})$/);
  if (mYM) {
    const y = Number(mYM[1]);
    const m = Number(mYM[2]);
    if (Number.isInteger(y) && Number.isInteger(m)) {
      return y * 10000 + m * 100; // day unknown -> 00
    }
  }

  const mY = s.match(/^(\d{4})$/);
  if (mY) {
    const y = Number(mY[1]);
    if (Number.isInteger(y)) return y * 10000; // month/day unknown -> 0000
  }

  return null;
}

function normalizeDob(dob) {
  return dobSortValue(dob);
}
