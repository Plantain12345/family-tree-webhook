import { createClient } from "@supabase/supabase-js";
export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export function makeJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export async function createTree(name, ownerPhone) {
  const code = makeJoinCode();
  const { data: tree, error } = await db.from("trees").insert({ name, join_code: code }).select().single();
  if (error) throw error;
  await db.from("members").insert({ tree_id: tree.id, phone: ownerPhone });
  return tree;
}

export async function joinTreeByCode(code, phone) {
  const { data: tree } = await db.from("trees").select("*").eq("join_code", code).single();
  if (!tree) return null;
  await db.from("members").insert({ tree_id: tree.id, phone }).onConflict("tree_id,phone").ignore();
  return tree;
}
