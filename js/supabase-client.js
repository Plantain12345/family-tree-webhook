import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, APP } from "./config.js";

export const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CODE_FIELDS = ["tree_code", "code", "generate_tree_code"];

function extractTreeCode(payload) {
  if (!payload && payload !== 0) throw new Error("Missing tree code payload");
  if (typeof payload === "string") return payload;
  for (const key of CODE_FIELDS) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  throw new Error("Unable to resolve tree code from RPC response");
}

function normalizeCode(maybeCode) {
  const code = String(maybeCode ?? "").trim().toUpperCase();
  if (code.length !== APP.codeLength || !/^[A-Z0-9]+$/.test(code)) {
    throw new Error(`Invalid tree code: ${maybeCode}`);
  }
  return code;
}

export async function generateTreeCode() {
  const { data, error } = await supabaseClient.rpc("generate_tree_code");
  if (error) throw error;
  return normalizeCode(extractTreeCode(data));
}

export async function createFamilyTree({ treeName, firstName, lastName, birthday, death, gender = "U" }) {
  const code = await generateTreeCode();

  const { data: tree, error: insertError } = await supabaseClient
    .from("family_trees")
    .insert({ tree_code: code, tree_name: treeName })
    .select("*")
    .single();
  if (insertError) throw insertError;

  const starter = {
    tree_id: tree.id,
    first_name: firstName || "Name",
    last_name: lastName || null,
    birthday: birthday ?? null,
    death: death ?? null,
    gender: gender || "U",
    is_main: true,
  };

  const { error: memberError } = await supabaseClient.from("family_members").insert(starter);
  if (memberError) throw memberError;

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
  return data ?? [];
}

export async function getParentChildRelationships(treeId) {
  const { data, error } = await supabaseClient
    .from("parent_child_relationships")
    .select("*")
    .eq("tree_id", treeId);
  if (error) throw error;
  return data ?? [];
}

export async function getSpousalRelationships(treeId) {
  const { data, error } = await supabaseClient
    .from("spousal_relationships")
    .select("*")
    .eq("tree_id", treeId);
  if (error) throw error;
  return data ?? [];
}
