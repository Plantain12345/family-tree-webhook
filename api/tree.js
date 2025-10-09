// api/tree.js
import { db } from "./_db.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET")
      return res.status(405).json({ error: "Method Not Allowed" });

    const code = (req.query.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code))
      return res.status(400).json({ error: "Bad code" });

    // Fetch tree
    const { data: tree, error: tErr } = await db
      .from("trees")
      .select("id, name, join_code, created_at")
      .eq("join_code", code)
      .single();

    if (tErr || !tree)
      return res.status(404).json({ error: "Tree not found" });

    // Fetch persons and relationships - FIXED column names
    const [{ data: personRows, error: pErr }, { data: relRows, error: rErr }] =
      await Promise.all([
        db.from("persons").select("id, data").eq("tree_id", tree.id),
        db.from("relationships").select("person_a_id, person_b_id, kind").eq("tree_id", tree.id),
      ]);

    if (pErr) console.error("Persons fetch error:", pErr);
    if (rErr) console.error("Relationships fetch error:", rErr);

    const persons = (personRows || []).map((p) => ({
      id: p.id,
      data: normalizePersonData(p.data),
      rels: { father: null, mother: null, spouses: [], children: [] },
    }));

    // Build relationship links
    const byId = new Map(persons.map((p) => [String(p.id), p]));
    const rels = relRows || [];

    for (const r of rels) {
      const a = String(r.person_a_id);
      const b = String(r.person_b_id);
      if (!byId.has(a) || !byId.has(b)) continue;

      // Handle the 3 allowed relationship kinds: 'parent', 'child', 'spouse'
      if (r.kind === "parent") {
        const parent = byId.get(a);
        const child = byId.get(b);
        if (parent && child) {
          parent.rels.children.push(b);
          if (parent.data.gender === "M") child.rels.father = a;
          else if (parent.data.gender === "F") child.rels.mother = a;
        }
      } else if (r.kind === "child") {
        // Reverse: B is parent of A
        const parent = byId.get(b);
        const child = byId.get(a);
        if (parent && child) {
          parent.rels.children.push(a);
          if (parent.data.gender === "M") child.rels.father = b;
          else if (parent.data.gender === "F") child.rels.mother = b;
        }
      } else if (r.kind === "spouse") {
        byId.get(a)?.rels.spouses.push(b);
        byId.get(b)?.rels.spouses.push(a);
      }
    }

    return res.status(200).json({
      tree,
      persons: persons,
      relationships: rels,
      original_relationships: rels,
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
