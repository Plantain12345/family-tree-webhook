// api/_db.js
import { createClient } from "@supabase/supabase-js";

export const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/* ------------------------------ utils ------------------------------ */

// Minimal replacement for the deleted date-utils.js
function normalizeDobInput(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  // Accept YYYY / YYYY-MM / YYYY-MM-DD as-is; anything else, store the trimmed string
  if (/^\d{4}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

export function makeJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export function normalizeName(s) {
  return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function joinCodeExists(code) {
  const { data, error } = await db
    .from("trees")
    .select("id")
    .eq("join_code", code)
    .maybeSingle();
  if (error) {
    console.error("joinCodeExists error:", error);
    return false;
  }
  return Boolean(data);
}

async function generateJoinCode() {
  for (let i = 0; i < 10; i += 1) {
    const code = makeJoinCode();
    if (!(await joinCodeExists(code))) return code;
  }
  throw new Error("Failed to generate unique join code");
}

/* ------------------------------- trees ------------------------------ */

export async function createTree(phone, name) {
  if (!phone) throw new Error("Phone number is required to create a tree");
  const joinCode = await generateJoinCode();
  const payload = { join_code: joinCode };
  const trimmed = (name || "").trim();
  if (trimmed) payload.name = trimmed;

  const { data: tree, error } = await db
    .from("trees")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;

  const { error: memberError } = await db
    .from("members")
    .upsert(
      {
        tree_id: tree.id,
        phone,
        joined_at: new Date().toISOString(),
      },
      { onConflict: "tree_id,phone" }
    );

  if (memberError) throw memberError;

  return tree;
}

export async function joinTreeByCode(phone, rawCode) {
  if (!phone) throw new Error("Phone number is required to join a tree");
  const code = (rawCode || "").toString().trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return { joined: false, reason: "invalid_code", tree: null };
  }

  const { data: tree, error } = await db
    .from("trees")
    .select("*")
    .eq("join_code", code)
    .maybeSingle();

  if (error) {
    console.error("joinTreeByCode error:", error);
    return { joined: false, reason: "error", tree: null };
  }

  if (!tree) {
    return { joined: false, reason: "not_found", tree: null };
  }

  const { error: memberError } = await db
    .from("members")
    .upsert(
      {
        tree_id: tree.id,
        phone,
        joined_at: new Date().toISOString(),
      },
      { onConflict: "tree_id,phone" }
    );

  if (memberError) throw memberError;

  return { joined: true, reason: null, tree };
}

export async function latestTreeFor(phone) {
  if (!phone) return null;
  const { data: membership, error } = await db
    .from("members")
    .select("tree_id")
    .eq("phone", phone)
    .order("joined_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("latestTreeFor error:", error);
    return null;
  }

  const treeId = membership?.tree_id;
  if (!treeId) return null;

  const { data: tree, error: treeErr } = await db
    .from("trees")
    .select("*")
    .eq("id", treeId)
    .maybeSingle();

  if (treeErr) {
    console.error("latestTreeFor tree fetch error:", treeErr);
    return null;
  }

  return tree || null;
}

export async function listPersonsForTree(phone) {
  const tree = await latestTreeFor(phone);
  if (!tree) return { tree: null, people: [], rels: [] };

  const [{ data: people, error: peopleError }, { data: rels, error: relsError }] =
    await Promise.all([
      db
        .from("persons")
        .select("id, primary_name, dob_dmy, gender")
        .eq("tree_id", tree.id)
        .order("primary_name", { ascending: true }),
      db
        .from("relationships")
        .select("a, b, kind")
        .eq("tree_id", tree.id),
    ]);

  if (peopleError) console.error("listPersonsForTree people error:", peopleError);
  if (relsError) console.error("listPersonsForTree rels error:", relsError);

  return {
    tree,
    people: people || [],
    rels: rels || [],
  };
}

/* --------------------------- activation flow ------------------------ */

export async function findInTreeByName(treeId, q) {
  const norm = normalizeName(q);
  const { data: ppl } = await db.from("persons").select("*").eq("tree_id", treeId);
  return ppl?.find((p) => normalizeName(p.primary_name) === norm) || null;
}

export async function listPersonsByExactName(treeId, q) {
  const norm = normalizeName(q);
  const { data, error } = await db
    .from("persons")
    .select("id, primary_name, dob_dmy")
    .eq("tree_id", treeId);

  if (error) {
    console.error("listPersonsByExactName error:", error);
    return [];
  }

  return (data || []).filter((p) => normalizeName(p.primary_name) === norm);
}

export async function upsertPersonByName(treeId, name, dob = null) {
  const norm = normalizeName(name);
  const { data: all } = await db.from("persons").select("*").eq("tree_id", treeId);
  let person = all?.find((p) => normalizeName(p.primary_name) === norm);
  if (person) {
    if (dob !== undefined) {
      const nextDob = normalizeDobInput(dob);
      if (nextDob !== person.dob_dmy) {
        await db.from("persons").update({ dob_dmy: nextDob }).eq("id", person.id);
        person.dob_dmy = nextDob;
      }
    }
    return person;
  }
  const payload = {
    tree_id: treeId,
    primary_name: name.trim(),
  };
  const normalizedDob = normalizeDobInput(dob);
  if (normalizedDob) payload.dob_dmy = normalizedDob;
  const { data: created, error } = await db
    .from("persons")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return created;
}

/* --------------------------- relationships ------------------------- */

function minmax(a, b) {
  return a < b ? [a, b] : [b, a];
}

export async function addRelationship(treeId, aId, kind, bId) {
  // undirected kinds (normalize a<b)
  if (["spouse_of", "partner_of", "divorced_from", "separated_from", "affair_with"].includes(kind)) {
    const [x, y] = minmax(aId, bId);
    const { error } = await db
      .from("relationships")
      .upsert({ tree_id: treeId, a: x, b: y, kind }, { onConflict: "tree_id,a,b,kind" });
    if (error && error.code !== "23505") throw error;
    return;
  }
  if (kind === "parent_of") {
    const { error } = await db
      .from("relationships")
      .upsert({ tree_id: treeId, a: aId, b: bId, kind }, { onConflict: "tree_id,a,b,kind" });
    if (error && error.code !== "23505") throw error;
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

export async function editPerson(treeId, personId, { newName, dob_dmy, dod_dmy, gender }) {
  const patch = {};
  if (newName !== undefined && newName !== null) {
    const trimmed = newName.trim();
    if (trimmed) patch.primary_name = trimmed;
  }
  if (dob_dmy !== undefined) {
    const normalized = normalizeDobInput(dob_dmy);
    patch.dob_dmy = normalized || null;
  }
  if (dod_dmy !== undefined) {
    const normalized = normalizeDobInput(dod_dmy);
    patch.dod_dmy = normalized || null;
  }
  if (gender !== undefined) patch.gender = gender;
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

/* --------------------------- user state management ------------------ */

export async function getUserState(phone) {
  const { data, error } = await db
    .from("user_states")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();

  if (error) {
    console.error("getUserState error:", error);
    return null;
  }
  return data;
}

export async function setLastPerson(phone, treeId, personId, personName) {
  const { error } = await db
    .from("user_states")
    .upsert(
      {
        phone,
        tree_id: treeId,
        last_person_id: personId,
        last_person_name: personName,
        updated_at: new Date().toISOString()
      },
      { onConflict: "phone" }
    );

  if (error) {
    console.error("setLastPerson error:", error);
  }
}

export async function setActiveTreeState(phone, treeId) {
  const { error } = await db
    .from("user_states")
    .upsert(
      {
        phone,
        tree_id: treeId,
        updated_at: new Date().toISOString()
      },
      { onConflict: "phone" }
    );

  if (error) {
    console.error("setActiveTreeState error:", error);
  }
}

