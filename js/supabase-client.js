// ===== supabase-client.js =====
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, APP } from "./config.js";

export const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- helpers ----
function coerceTreeCode(payload) {
  if (!payload && payload !== 0) throw new Error("No tree code payload");
  if (typeof payload === "string") return payload;
  // Handle common wrapped shapes
  return (
    payload?.tree_code ??
    payload?.code ??
    payload?.generate_tree_code ??
    (() => {
      throw new Error("Invalid tree code payload");
    })()
  );
}

function normalizeCode(maybeCode) {
  const code = String(maybeCode || "").trim().toUpperCase();
  if (code.length !== APP.codeLength) {
    throw new Error(`Invalid tree code: "${maybeCode}"`);
  }
  return code;
}

// ---- RPCs / CRUD ----
export async function generateTreeCode() {
  const { data, error } = await supabaseClient.rpc("generate_tree_code");
  if (error) throw error;
  return coerceTreeCode(data);
}

export async function createFamilyTree({ treeName, firstName, lastName, birthday, death, gender = "U" }) {
  const code = await generateTreeCode();

  const { data: tree, error: treeErr } = await supabaseClient
    .from("family_trees")
    .insert({ tree_code: code, tree_name: treeName })
    .select("*")
    .single();
  if (treeErr) throw treeErr;

  // Starter member (like the demo)
  const starter = {
    tree_id: tree.id,
    first_name: firstName || "Name",
    last_name: lastName || null,
    birthday: birthday ?? null,
    death: death ?? null,
    gender: gender ?? "U",
    is_main: true,
  };
  const { error: memberErr } = await supabaseClient.from("family_members").insert(starter);
  if (memberErr) throw memberErr;

  return { treeId: tree.id, treeCode: code };
}

export async function getFamilyTreeByCode(treeCode) {
  const code = normalizeCode(treeCode);
  const { data, error } = await supabaseClient
    .from("family_trees")
    .select("*")
    .eq("tree_code", code)
    .single();
  if (error) throw error;
  return data;
}

export async function getFamilyMembers(treeId) {
  const { data, error } = await supabaseClient
    .from("family_members")
    .select("*")
    .eq("tree_id", treeId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getParentChildRelationships(treeId) {
  const { data, error } = await supabaseClient
    .from("parent_child_relationships")
    .select("*")
    .eq("tree_id", treeId);
  if (error) throw error;
  return data || [];
}

export async function getSpousalRelationships(treeId) {
  const { data, error } = await supabaseClient
    .from("spousal_relationships")
    .select("*")
    .eq("tree_id", treeId);
  if (error) throw error;
  return data || [];
}

// Inserts for edits (you can expand as needed)
export async function addMember(treeId, payload) {
  const row = { tree_id: treeId, ...payload };
  const { data, error } = await supabaseClient.from("family_members").insert(row).select("*").single();
  if (error) throw error;
  return data;
}

export async function addParentChild(treeId, parentId, childId) {
  const { data, error } = await supabaseClient
    .from("parent_child_relationships")
    .insert({ tree_id: treeId, parent_id: parentId, child_id: childId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function addSpousal(treeId, person1Id, person2Id, relationshipType) {
  const { data, error } = await supabaseClient
    .from("spousal_relationships")
    .insert({ tree_id: treeId, person1_id: person1Id, person2_id: person2Id, relationship_type: relationshipType })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}
