// api/tree.js
// GET /api/tree?code=ABC123  -> { tree, nodes, edges }

import { db } from "./_db.js";

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
    if (tErr || !tree) return res.status(404).json({ error: "Tree not found" });

    const [{ data: people }, { data: rels }] = await Promise.all([
      db.from("persons").select("id, primary_name, dob_dmy").eq("tree_id", tree.id),
      db.from("relationships").select("a, b, kind").eq("tree_id", tree.id)
    ]);

    // Build nodes/edges for Cytoscape
    const nodes = (people || []).map(p => ({
      data: {
        id: p.id,
        label: p.primary_name + (p.dob_dmy ? `\n(b. ${p.dob_dmy})` : "")
      }
    }));

    const edges = (rels || []).map(r => ({
      data: {
        id: `${r.a}_${r.kind}_${r.b}`,
        source: r.a,
        target: r.b,
        kind: r.kind
      }
    }));

    return res.status(200).json({ tree: { id: tree.id, name: tree.name, code: tree.join_code }, nodes, edges });
  } catch (e) {
    console.error("tree api error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
