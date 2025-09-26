// api/tree.js
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

    if (tErr || !tree) {
      console.log("API /tree: not found or error for code", code, tErr);
      return res.status(404).json({ error: "Tree not found" });
    }

    const [{ data: people, error: pErr }, { data: rels, error: rErr }] = await Promise.all([
      db.from("persons").select("id, primary_name, dob_dmy").eq("tree_id", tree.id),
      db.from("relationships").select("a, b, kind").eq("tree_id", tree.id),
    ]);

    if (pErr || rErr) {
      console.log("API /tree persons/relationships error", pErr, rErr);
      return res.status(500).json({ error: "Query error" });
    }

    const nodes = (people || []).map((p) => ({
      data: { id: p.id, label: p.primary_name + (p.dob_dmy ? `\n(b. ${p.dob_dmy})` : "") },
    }));

    const edges = (rels || []).map((r) => ({
      data: { id: `${r.a}_${r.kind}_${r.b}`, source: r.a, target: r.b, kind: r.kind },
    }));

    const hasData = nodes.length > 0 || edges.length > 0;

    return res.status(200).json({
      tree: { id: tree.id, name: tree.name, code: tree.join_code },
      nodes,
      edges,
      hasData,
    });
  } catch (e) {
    console.error("API /tree fatal error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
