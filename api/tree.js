// api/tree.js
// Serves tree data to the webpage with proper relationship handling

import { db } from "./_db.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const code = (req.query.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return res.status(400).json({ error: "Invalid code format. Code must be 6 alphanumeric characters." });
    }

    // Fetch tree
    const { data: tree, error: tErr } = await db
      .from("trees")
      .select("id, name, join_code, created_at")
      .eq("join_code", code)
      .single();

    if (tErr || !tree) {
      return res.status(404).json({ error: "Tree not found" });
    }

    // Fetch persons and relationships
    const [{ data: personRows, error: pErr }, { data: relRows, error: rErr }] =
      await Promise.all([
        db.from("persons").select("id, data").eq("tree_id", tree.id),
        db.from("relationships").select("person_a_id, person_b_id, kind").eq("tree_id", tree.id),
      ]);

    if (pErr) console.error("Persons fetch error:", pErr);
    if (rErr) console.error("Relationships fetch error:", rErr);

    const persons = (personRows || []).map((p) => ({
      id: String(p.id),  // Ensure ID is string
      data: normalizePersonData(p.data),
      rels: { 
        father: null, 
        mother: null, 
        spouses: [],  // Array of string IDs
        children: []  // Array of string IDs
      },
    }));

    // Build relationship links
    const byId = new Map(persons.map((p) => [p.id, p]));
    const rels = relRows || [];

    for (const r of rels) {
      const a = String(r.person_a_id);
      const b = String(r.person_b_id);
      if (!byId.has(a) || !byId.has(b)) continue;

      // Handle relationship types
      if (r.kind === "parent") {
        // A is parent of B
        const parent = byId.get(a);
        const child = byId.get(b);
        if (parent && child) {
          // Add to parent's children array (ensure no duplicates)
          if (!parent.rels.children.includes(b)) {
            parent.rels.children.push(b);
          }
          // Set child's father or mother (single value, not array)
          if (parent.data.gender === "M" && !child.rels.father) {
            child.rels.father = a;
          } else if (parent.data.gender === "F" && !child.rels.mother) {
            child.rels.mother = a;
          } else if (!parent.data.gender || parent.data.gender === "U") {
            // If gender unknown, assign to whichever parent slot is empty
            if (!child.rels.father) {
              child.rels.father = a;
            } else if (!child.rels.mother) {
              child.rels.mother = a;
            }
          }
        }
      } else if (r.kind === "child") {
        // Reverse: B is parent of A
        const parent = byId.get(b);
        const child = byId.get(a);
        if (parent && child) {
          // Add to parent's children array (ensure no duplicates)
          if (!parent.rels.children.includes(a)) {
            parent.rels.children.push(a);
          }
          // Set child's father or mother
          if (parent.data.gender === "M" && !child.rels.father) {
            child.rels.father = b;
          } else if (parent.data.gender === "F" && !child.rels.mother) {
            child.rels.mother = b;
          } else if (!parent.data.gender || parent.data.gender === "U") {
            if (!child.rels.father) {
              child.rels.father = b;
            } else if (!child.rels.mother) {
              child.rels.mother = b;
            }
          }
        }
      } else if (["spouse", "divorced", "separated"].includes(r.kind)) {
        // Bidirectional relationships - ensure no duplicates
        const personA = byId.get(a);
        const personB = byId.get(b);
        if (personA && personB) {
          if (!personA.rels.spouses.includes(b)) {
            personA.rels.spouses.push(b);
          }
          if (!personB.rels.spouses.includes(a)) {
            personB.rels.spouses.push(a);
          }
        }
      }
    }

    return res.status(200).json({
      tree,
      persons: persons,
      relationships: rels,
    });
  } catch (e) {
    console.error("API /tree fatal error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}

function normalizePersonData(data) {
  if (!data) return {};
  const clean = {
    first_name: data.first_name || "",
    last_name: data.last_name || "",
    gender: normalizeGender(data.gender),
    birthday: normalizeBirthday(data.birthday),
    deathday: data.deathday || null,
  };
  return clean;
}

function normalizeGender(g) {
  if (!g) return "U";
  g = String(g).toUpperCase();
  if (["M", "F"].includes(g)) return g;
  return "U";
}

function normalizeBirthday(b) {
  if (!b) return "";
  const match = b.match(/\d{4}/);
  return match ? match[0] : b;
}
