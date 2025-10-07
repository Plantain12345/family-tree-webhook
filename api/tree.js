// api/tree.js
import { db } from "./_db.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // --- validate code ---
    const code = (req.query.code || "").toString().trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return res.status(400).json({ error: "Bad code" });
    }

    // --- load tree by join_code ---
    const { data: tree, error: tErr } = await db
      .from("trees")
      .select("id, name, join_code, created_at")
      .eq("join_code", code)
      .single();

    if (tErr || !tree) {
      console.log("API /tree: not found or error for code", code, tErr);
      return res.status(404).json({ error: "Tree not found" });
    }

    // --- load persons and relationships for tree ---
    const [
      { data: peopleRows, error: pErr },
      { data: relsRows, error: rErr },
    ] = await Promise.all([
      db
        .from("persons")
        .select("id, primary_name, dob_dmy, dod_dmy, gender")
        .eq("tree_id", tree.id),
      db.from("relationships").select("a, b, kind").eq("tree_id", tree.id),
    ]);

    if (pErr) console.error("API /tree persons error:", pErr);
    if (rErr) console.error("API /tree relationships error:", rErr);

    const people = (peopleRows || []).map((p) => ({
      ...p,
      normalized_name: normalizeNameKey(p.primary_name),
      normalized_dob: normalizeDob(p.dob_dmy),
    }));

    const original_relationships = relsRows || [];

    // --- normalize relationships to only {parent_of, spouse_of} ---
    // We collapse partner kinds (spouse_of | partner_of | divorced_from) -> spouse_of
    const partnerKinds = new Set(["spouse_of", "partner_of", "divorced_from"]);
    const normalized_relationships = [];
    const personIds = new Set(people.map((p) => String(p.id)));

    for (const rel of original_relationships) {
      if (!rel) continue;
      const a = rel.a != null ? String(rel.a) : null;
      const b = rel.b != null ? String(rel.b) : null;
      if (!a || !b || !personIds.has(a) || !personIds.has(b)) continue;

      if (rel.kind === "parent_of") {
        normalized_relationships.push({ kind: "parent_of", a, b });
      } else if (partnerKinds.has(rel.kind)) {
        // normalize all partner-status to 'spouse_of' for the layout engine
        normalized_relationships.push({ kind: "spouse_of", a, b });
      }
      // any other kinds are ignored for Option A viewer (can be re-added later)
    }

    // --- build 'rels' per person (father/mother/spouses/children) ---
    const byId = new Map(people.map((p) => [String(p.id), p]));
    const relsMap = new Map(
      people.map((p) => [
        String(p.id),
        { father: undefined, mother: undefined, spouses: [], children: [] },
      ])
    );

    // 1) spouse links (undirected)
    for (const rel of normalized_relationships) {
      if (rel.kind !== "spouse_of") continue;
      const { a, b } = rel;
      const ra = relsMap.get(a);
      const rb = relsMap.get(b);
      if (ra && !ra.spouses.includes(b)) ra.spouses.push(b);
      if (rb && !rb.spouses.includes(a)) rb.spouses.push(a);
    }

    // 2) parent/child links (directed)
    // Also try to assign father/mother if parent has a known gender.
    for (const rel of normalized_relationships) {
      if (rel.kind !== "parent_of") continue;
      const { a: parentId, b: childId } = rel;
      const parent = byId.get(parentId);
      const childRels = relsMap.get(childId);
      const parentRels = relsMap.get(parentId);
      if (!parent || !childRels || !parentRels) continue;

      // push child under parent
      if (!parentRels.children.includes(childId)) parentRels.children.push(childId);

      // set father/mother on child if we can infer from parent.gender
      const g = normalizeGenderToMF(parent.gender);
      if (g === "M") {
        // set father only if empty or matches same parentId
        if (!childRels.father || childRels.father === parentId) {
          childRels.father = parentId;
        }
      } else if (g === "F") {
        if (!childRels.mother || childRels.mother === parentId) {
          childRels.mother = parentId;
        }
      }
      // if unknown gender, we leave both unset (tree still renders fine)
    }

    // --- final persons array in Family-Chart 'Datum' shape ---
    // We keep your raw text fields but split primary_name to first/last for nicer cards.
    const fcPersons = people.map((p) => {
      const { first, last } = splitName(p.primary_name);
      const genderMF = normalizeGenderToMF(p.gender); // 'M' | 'F' | undefined
      const rels = relsMap.get(String(p.id)) || {
        father: undefined,
        mother: undefined,
        spouses: [],
        children: [],
      };
      return {
        id: String(p.id),
        // Family-Chart expects gender inside 'data'
        data: {
          gender: genderMF, // 'M' | 'F' (undefined is ok too)
          "first name": first,
          "last name": last,
          "birthday": p.dob_dmy || "",
          "death date": p.dod_dmy || "",
          // Keep anything else you might later want to display:
          primary_name: p.primary_name || "",
        },
        rels,
      };
    });

    // Response: clean FC format + original rows for reference
    return res.status(200).json({
      tree,
      persons: fcPersons,
      relationships: normalized_relationships,
      original_relationships,
    });
  } catch (e) {
    console.error("API /tree fatal error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}

/* ------------------------------ local helpers ------------------------------ */

function splitName(name) {
  if (!name) return { first: "", last: "" };
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

function normalizeGenderToMF(g) {
  if (!g) return undefined;
  const s = String(g).trim().toLowerCase();
  if (s.startsWith("m")) return "M";
  if (s.startsWith("f")) return "F";
  return undefined;
}

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
