// api/_db.js
import { createClient } from "@supabase/supabase-js";

export const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/* ------------------------------ utils ------------------------------ */

export function makeJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export function normalizeName(s) {
  return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Used in tips we send back to WhatsApp users
const BASE_URL = "https://family-tree-webhook.vercel.app";

/* --------------------------- activation flow ------------------------ */
/**
 * Insert a fresh membership row to mark a tree as the *active* one.
 * We also upsert the (tree_id, phone) pair so the membership exists.
 * Assumes members.joined_at defaults to now().
 */
// api/_db.js
export async function activateTree(phone, treeId) {
  const nowIso = new Date().toISOString();
  const up = await db
    .from("members")
    .upsert(
      { tree_id: treeId, phone, joined_at: nowIso },      // update the timestamp on conflict
      { onConflict: "tree_id,phone" }
    )
    .select()
    .maybeSingle();

  if (up.error) {
    console.error("activateTree upsert error:", up.error);
    throw up.error;
  }
}


/**
 * Create a tree, make creator active, return a helpful tip.
 * @returns {Promise<{tree: any, tip: string}>}
 */
export async function createTree(name, ownerPhone) {
  // up to 8 attempts to avoid rare join_code collisions
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = makeJoinCode();
    const ins = await db
      .from("trees")
      .insert({ name, join_code: code })
      .select()
      .maybeSingle();

    if (!ins.error && ins.data) {
      const tree = ins.data;
      await activateTree(ownerPhone, tree.id);
      const tip =
        `You’re now active in “${tree.name}”. ` +
        `Try: Add Alice born 1950\n` +
        `Live tree: https://family-tree-webhook.vercel.app/tree.html?code=${tree.join_code}`;
      return { tree, tip };
    }

    // If it wasn't a unique-code collision, bubble the error immediately
    if (ins.error?.code !== "23505") {
      console.error("createTree insert error:", ins.error);
      throw ins.error;
    }
    // else: loop and try a new code
  }

  // If we somehow failed all attempts
  throw new Error("join_code generation collided repeatedly");
}


/**
 * Join by code, make that tree active, return a helpful tip.
 * @returns {Promise<{tree: any|null, tip?: string}>}
 */
export async function joinTreeByCode(code, phone) {
  const t = await db.from("trees").select("*").eq("join_code", code).maybeSingle();
  if (t.error) {
    console.error("joinTreeByCode lookup error:", t.error);
    return { tree: null };
  }
  const tree = t.data;
  if (!tree) return { tree: null };

  await activateTree(phone, tree.id);

  const tip =
    `You’re now active in “${tree.name}”. ` +
    `Try: Add Alice born 1950\n` +
    `Live tree: ${BASE_URL}/tree.html?code=${tree.join_code}`;
  return { tree, tip };
}

/**
 * Return the *currently active* (most recently “activated”) tree for a phone.
 * Uses members.joined_at (your schema) instead of created_at.
 */
export async function latestTreeFor(phone) {
  const m = await db
    .from("members")
    .select("tree_id, joined_at")
    .eq("phone", phone)
    .order("joined_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (m.error) {
    console.error("latestTreeFor members error:", m.error);
    return null;
  }
  if (!m.data) return null;

  const t = await db
    .from("trees")
    .select("id, name, join_code")
    .eq("id", m.data.tree_id)
    .maybeSingle();

  if (t.error) {
    console.error("latestTreeFor trees error:", t.error);
    return null;
  }
  return t.data || null;
}

/* ------------------------------ listings --------------------------- */

export async function listPersonsForTree(phone) {
  const tree = await latestTreeFor(phone);
  if (!tree) return null;
  const [{ data: people }, { data: rels }] = await Promise.all([
    db.from("persons").select("id, primary_name, dob_dmy").eq("tree_id", tree.id),
    db.from("relationships").select("a, b, kind").eq("tree_id", tree.id),
  ]);
  return { tree, people: people || [], rels: rels || [] };
}

/* ------------------------------ persons ---------------------------- */

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

/* --------------------------- relationships ------------------------- */

function minmax(a, b) {
  return a < b ? [a, b] : [b, a];
}

/**
 * spouse_of / partner_of: single undirected edge (no duplicates).
 * parent_of: directed (a -> b).
 * divorced_from: remove spouse_of between the pair.
 */
export async function addRelationship(treeId, aId, kind, bId) {
  if (kind === "spouse_of" || kind === "partner_of") {
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
  if (Object.keys(patch).length) {
    const r = await db.from("persons").update(patch).eq("id", personId);
    if (r.error) throw r.error;
  }
}

export async function personSummary(treeId, personId) {
  const [{ data: me }, { data: rels }, { data: ppl }] = await Promise.all([
    db.from("persons").select("*").eq("id", personId).maybeSingle(),
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

/* ------------------------------ leaving ----------------------------- */

export async function leaveCurrentTree(phone) {
  const tree = await latestTreeFor(phone);
  if (!tree) return { left: false };
  await db.from("members").delete().match({ tree_id: tree.id, phone });
  return { left: true, tree };
}

/* --------------------------- confirmations -------------------------- */

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
