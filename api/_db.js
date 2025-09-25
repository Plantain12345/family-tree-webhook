// api/_db.js
// Requires Vercel env vars: SUPABASE_URL, SUPABASE_ANON_KEY
import { createClient } from "@supabase/supabase-js";

export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

/* ----------------------------- utils ----------------------------- */

export function makeJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* --------------------------- core entities --------------------------- */

export async function createTree(name, ownerPhone) {
  const code = makeJoinCode();
  const { data: tree, error } = await db
    .from("trees")
    .insert({ name, join_code: code })
    .select()
    .single();
  if (error) throw error;

  // create membership
  const { error: mErr } = await db.from("members").insert({ tree_id: tree.id, phone: ownerPhone });
  if (mErr) throw mErr;

  return tree;
}

/** Join OR switch to a tree by code (idempotent). */
export async function joinTreeByCode(code, phone) {
  const { data: tree, error } = await db
    .from("trees")
    .select("*")
    .eq("join_code", code.toUpperCase())
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // not found
    throw error;
  }
  if (!tree) return null;

  // try insert membership
  const { error: insErr } = await db
    .from("members")
    .insert({ tree_id: tree.id, phone });
  if (insErr?.code === "23505") {
    // already a member -> "switch" by bumping joined_at
    await db.from("members")
      .update({ joined_at: new Date().toISOString() })
      .eq("tree_id", tree.id)
      .eq("phone", phone);
  } else if (insErr) {
    throw insErr;
  }

  return tree;
}

export async function latestTreeFor(phone) {
  const { data, error } = await db
    .from("members")
    .select("tree_id, joined_at, trees!inner(id,name,join_code,created_at)")
    .eq("phone", phone)
    .order("joined_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.trees || null;
}

/* --------------------------- people helpers -------------------------- */

/** Find a person by partial name in a tree. */
export async function findPersonByName(phone, name) {
  const tree = await latestTreeFor(phone);
  if (!tree) return null;

  const { data, error } = await db
    .from("persons")
    .select("*")
    .eq("tree_id", tree.id)
    .ilike("primary_name", `%${name}%`)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

/** List all people in the user’s latest tree. */
export async function listPersonsForTree(phone) {
  const tree = await latestTreeFor(phone);
  if (!tree) return null;

  const { data, error } = await db
    .from("persons")
    .select("id,primary_name,dob_dmy")
    .eq("tree_id", tree.id)
    .order("primary_name", { ascending: true });
  if (error) throw error;
  return { tree, people: data };
}

/** Strict find by normalized name; otherwise create. */
export async function upsertPersonByName(treeId, name) {
  const norm = normalizeName(name);
  if (!norm) throw new Error("Name required");

  // try exact normalized match
  const { data: existing, error: qErr } = await db
    .from("persons")
    .select("*")
    .eq("tree_id", treeId)
    .ilike("primary_name", name.trim())
    .limit(1);
  if (qErr) throw qErr;
  if (existing?.[0]) return existing[0];

  // fall back: simple prefix match on normalized form
  const { data: all, error: allErr } = await db
    .from("persons")
    .select("*")
    .eq("tree_id", treeId);
  if (allErr) throw allErr;

  const maybe = all?.find(p => normalizeName(p.primary_name) === norm);
  if (maybe) return maybe;

  // create new
  const { data: created, error: insErr } = await db
    .from("persons")
    .insert({ tree_id: treeId, primary_name: name.trim() })
    .select()
    .single();
  if (insErr) throw insErr;
  return created;
}

/** Merge B into A (keepId <- dupId): move relationships & delete dup. */
export async function mergePersons(treeId, keepId, dupId) {
  if (keepId === dupId) return { merged: false };

  // re-point relationships
  await db.from("relationships").update({ a: keepId }).eq("tree_id", treeId).eq("a", dupId);
  await db.from("relationships").update({ b: keepId }).eq("tree_id", treeId).eq("b", dupId);

  // delete duplicate
  await db.from("persons").delete().eq("tree_id", treeId).eq("id", dupId);
  return { merged: true };
}

/** Simple edit: rename and/or set dob_dmy */
export async function editPerson(treeId, personId, { newName, dob_dmy }) {
  const patch = {};
  if (newName) patch.primary_name = newName.trim();
  if (dob_dmy !== undefined) patch.dob_dmy = dob_dmy;
  if (!Object.keys(patch).length) return { ok: true };

  const { error } = await db.from("persons").update(patch).eq("tree_id", treeId).eq("id", personId);
  if (error) throw error;
  return { ok: true };
}

/* ------------------------- relationship helpers ------------------------ */

export async function addRelationship(treeId, aId, kind, bId) {
  // Prevent exact duplicate
  const { data: existing } = await db
    .from("relationships")
    .select("id")
    .eq("tree_id", treeId)
    .eq("a", aId)
    .eq("b", bId)
    .eq("kind", kind)
    .limit(1);
  if (!existing?.[0]) {
    await db.from("relationships").insert({ tree_id: treeId, a: aId, b: bId, kind });
  }
  // Add reverse for symmetric kinds
  if (kind === "spouse_of" || kind === "partner_of") {
    const { data: back } = await db
      .from("relationships")
      .select("id")
      .eq("tree_id", treeId)
      .eq("a", bId)
      .eq("b", aId)
      .eq("kind", kind)
      .limit(1);
    if (!back?.[0]) {
      await db.from("relationships").insert({ tree_id: treeId, a: bId, b: aId, kind });
    }
  }
  return { ok: true };
}

/** Mini summary for a person. */
export async function personSummary(treeId, personId) {
  const spouseKinds = ["spouse_of", "partner_of"];

  const { data: spouses } = await db
    .from("relationships")
    .select("a,b,kind, persons: b (primary_name)")
    .eq("tree_id", treeId)
    .eq("a", personId)
    .in("kind", spouseKinds);

  const { data: parents } = await db
    .from("relationships")
    .select("a,b, persons: a (primary_name)")
    .eq("tree_id", treeId)
    .eq("b", personId)
    .eq("kind", "parent_of");

  const { data: children } = await db
    .from("relationships")
    .select("a,b, persons: b (primary_name)")
    .eq("tree_id", treeId)
    .eq("a", personId)
    .eq("kind", "parent_of");

  return {
    spouses: spouses?.map(r => r.persons?.primary_name).filter(Boolean) || [],
    parents: parents?.map(r => r.persons?.primary_name).filter(Boolean) || [],
    children: children?.map(r => r.persons?.primary_name).filter(Boolean) || [],
  };
}

/* --------------------------- membership mgmt --------------------------- */

export async function leaveCurrentTree(phone) {
  const tree = await latestTreeFor(phone);
  if (!tree) return { left: false };
  const { error } = await db.from("members").delete().eq("tree_id", tree.id).eq("phone", phone);
  if (error) throw error;
  return { left: true, tree };
}
