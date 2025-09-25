// api/_db.js
// Requires Vercel env vars: SUPABASE_URL, SUPABASE_ANON_KEY
import { createClient } from "@supabase/supabase-js";

export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

/** Generate a simple 6-char join code. */
export function makeJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/** Create a tree and add creator as member. */
export async function createTree(name, ownerPhone) {
  const code = makeJoinCode();
  const { data: tree, error } = await db
    .from("trees")
    .insert({ name, join_code: code })
    .select()
    .single();
  if (error) throw error;

  const { error: mErr } = await db.from("members").insert({ tree_id: tree.id, phone: ownerPhone });
  if (mErr) throw mErr;

  return tree;
}

/** Join a tree by code (idempotent). */
export async function joinTreeByCode(code, phone) {
  const { data: tree, error } = await db
    .from("trees")
    .select("*")
    .eq("join_code", code.toUpperCase())
    .single();

  if (error) {
    // If not found, return null; other errors bubble up.
    if (error.code === "PGRST116") return null;
    throw error;
  }
  if (!tree) return null;

  const { error: mErr } = await db
    .from("members")
    .insert({ tree_id: tree.id, phone })
    .onConflict("tree_id,phone")
    .ignore();
  if (mErr) throw mErr;

  return tree;
}

/** Most recently joined/created tree for this phone. */
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

/** Find a person by (partial) name in the user’s latest tree. */
export async function findPersonByName(phone, name) {
  const tree = await latestTreeFor(phone);
  if (!tree) return null;

  const { data, error } = await db
    .from("persons")
    .select("*")
    .ilike("primary_name", `%${name}%`)
    .eq("tree_id", tree.id)
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
    .select("primary_name,dob_dmy")
    .eq("tree_id", tree.id)
    .order("primary_name", { ascending: true });
  if (error) throw error;

  return { tree, people: data };
}

// --- Relationship helpers ---

/** Get or create a person by name in the given tree (case-insensitive). */
export async function upsertPersonByName(treeId, name) {
  const trimmed = name.trim();
  const { data: found, error: selErr } = await db
    .from("persons")
    .select("*")
    .eq("tree_id", treeId)
    .ilike("primary_name", trimmed)
    .limit(1);
  if (selErr) throw selErr;
  if (found?.[0]) return found[0];

  const { data: created, error: insErr } = await db
    .from("persons")
    .insert({ tree_id: treeId, primary_name: trimmed })
    .select()
    .single();
  if (insErr) throw insErr;
  return created;
}

/** Create a relationship; ignores exact duplicates. */
export async function addRelationship(treeId, aId, kind, bId) {
  // prevent dupes (very simple)
  const { data: existing, error: qErr } = await db
    .from("relationships")
    .select("id")
    .eq("tree_id", treeId)
    .eq("a", aId)
    .eq("b", bId)
    .eq("kind", kind)
    .limit(1);
  if (qErr) throw qErr;
  if (existing?.[0]) return existing[0];

  const { data, error } = await db
    .from("relationships")
    .insert({ tree_id: treeId, a: aId, b: bId, kind })
    .select()
    .single();
  if (error) throw error;

  // For symmetric spouse/partner, also add reverse if missing
  if (kind === "spouse_of" || kind === "partner_of") {
    const { data: back, error: backErr } = await db
      .from("relationships")
      .select("id")
      .eq("tree_id", treeId)
      .eq("a", bId)
      .eq("b", aId)
      .eq("kind", kind)
      .limit(1);
    if (backErr) throw backErr;
    if (!back?.[0]) {
      await db.from("relationships").insert({ tree_id: treeId, a: bId, b: aId, kind });
    }
  }
  return data;
}

/** Build a simple summary: spouses, parents, children. */
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

