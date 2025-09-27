// api/_db.js
import { createClient } from "@supabase/supabase-js";

export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export function makeJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export function normalizeName(s) {
  return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export async function createTree(name, ownerPhone) {
  const code = makeJoinCode();
  const { data: tree, error } = await db.from("trees").insert({ name, join_code: code }).select().single();
  if (error) throw error;
  await db.from("members").insert({ tree_id: tree.id, phone: ownerPhone });
  return tree;
}

export async function latestTreeFor(phone) {
  const { data } = await db
    .from("members")
    .select("tree_id, trees!inner(id, name, join_code)")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0]?.trees || null;
}

export async function joinTreeByCode(code, phone) {
  const { data: tree } = await db.from("trees").select("*").eq("join_code", code).single();
  if (!tree) return null;
  await db.from("members").upsert({ tree_id: tree.id, phone }, { onConflict: "tree_id,phone" });
  return tree;
}

export async function listPersonsForTree(phone) {
  const tree = await latestTreeFor(phone);
  if (!tree) return null;
  const [{ data: people }, { data: rels }] = await Promise.all([
    db.from("persons").select("id, primary_name, dob_dmy").eq("tree_id", tree.id),
    db.from("relationships").select("a, b, kind").eq("tree_id", tree.id),
  ]);
  return { tree, people: people || [], rels: rels || [] };
}

export async function findInTreeByName(treeId, q) {
  const norm = normalizeName(q);
  const { data: ppl } = await db.from("persons").select("*").eq("tree_id", treeId);
  return ppl?.find((p) => normalizeName(p.primary_name) === norm) || null;
}

export async function upsertPersonByName(treeId, name, dob = null) {
  const norm = normalizeName(name);
  const { data: all } = await db.from("persons").select("*").eq("tree_id", treeId);
  let person = all?.find((p) => normalizeName(p.primary_name) === norm);
  if (person) {
    if (dob && !person.dob_dmy) {
      await db.from("persons").update({ dob_dmy: dob }).eq("id", person.id);
      person.dob_dmy = dob;
    }
    return person;
  }
  const { data: created, error } = await db
    .from("persons")
    .insert({ tree_id: treeId, primary_name: name.trim(), dob_dmy: dob })
    .select()
    .single();
  if (error) throw error;
  return created;
}

function minmax(a, b) { return a < b ? [a, b] : [b, a]; }

export async function addRelationship(treeId, aId, kind, bId) {
  if (kind === "spouse_of" || kind === "partner_of") {
    // store ONE undirected spouse edge
    const [x, y] = minmax(aId, bId);
    const { error } = await db
      .from("relationships")
      .upsert({ tree_id: treeId, a: x, b: y, kind: "spouse_of" }, { onConflict: "a,b,kind" });
    if (error && error.code !== "23505") throw error;
    return;
  }
  if (kind === "parent_of") {
    const { error } = await db
      .from("relationships")
      .upsert({ tree_id: treeId, a: aId, b: bId, kind: "parent_of" }, { onConflict: "tree_id,a,b,kind" });
    if (error && error.code !== "23505") throw error;
    return;
  }
  if (kind === "divorced_from") {
    const [x, y] = minmax(aId, bId);
    await db.from("relationships").delete().match({ tree_id: treeId, a: x, b: y, kind: "spouse_of" });
  }
}

export async function addChildWithParents(treeId, childName, dob, parentAName, parentBName) {
  const child = await upsertPersonByName(treeId, childName, dob || null);
  const pa = await upsertPersonByName(treeId, parentAName);
  let pb = null;
  if (parentBName) pb = await upsertPersonByName(treeId, parentBName);
  await addRelationship(treeId, pa.id, "parent_of", child.id);
  if (pb) await addRelationship(treeId, pb.id, "parent_of", child.id);
  return child;
}

export async function editPerson(treeId, personId, { newName, dob_dmy }) {
  const patch = {};
  if (newName) patch.primary_name = newName.trim();
  if (dob_dmy) patch.dob_dmy = dob_dmy;
  if (Object.keys(patch).length) await db.from("persons").update(patch).eq("id", personId);
}

export async function personSummary(treeId, personId) {
  const [{ data: me }, { data: rels }, { data: ppl }] = await Promise.all([
    db.from("persons").select("*").eq("id", personId).single(),
    db.from("relationships").select("a,b,kind").eq("tree_id", treeId),
    db.from("persons").select("id,primary_name").eq("tree_id", treeId),
  ]);
  const nameById = new Map((ppl || []).map((p) => [p.id, p.primary_name]));
  const spouses = new Set(), parents = new Set(), children = new Set();
  for (const r of rels || []) {
    if (r.kind === "spouse_of" && (r.a === personId || r.b === personId))
      spouses.add(nameById.get(r.a === personId ? r.b : r.a));
    if (r.kind === "parent_of") {
      if (r.a === personId) children.add(nameById.get(r.b));
      if (r.b === personId) parents.add(nameById.get(r.a));
    }
  }
  return {
    me: me?.primary_name,
    spouses: [...spouses].filter(Boolean),
    parents: [...parents].filter(Boolean),
    children: [...children].filter(Boolean),
  };
}

export async function leaveCurrentTree(phone) {
  const tree = await latestTreeFor(phone);
  if (!tree) return { left: false };
  await db.from("members").delete().match({ tree_id: tree.id, phone });
  return { left: true, tree };
}

/* ---------- confirmations (pending actions) ---------- */

export async function savePending(phone, treeId, actionObj) {
  const { data, error } = await db
    .from("pending_actions")
    .insert({ phone, tree_id: treeId || null, action: actionObj })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function popPending(phone) {
  const { data } = await db
    .from("pending_actions")
    .select("*")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1);
  const pending = data?.[0];
  if (!pending) return null;
  await db.from("pending_actions").delete().eq("id", pending.id);
  return pending;
}
