// api/_db.js
// Supabase client + tiny helpers for trees/members.
// Requires env vars in Vercel: SUPABASE_URL, SUPABASE_ANON_KEY

import { createClient } from "@supabase/supabase-js";

export const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Generate a human-friendly 6-char join code (no confusing chars).
 */
export function makeJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/**
 * Create a tree and add the creator as a member.
 * @param {string} name - Tree display name
 * @param {string} ownerPhone - WhatsApp phone (E.164) of creator
 * @returns {Promise<{id:string,name:string,join_code:string,created_at:string}>}
 */
export async function createTree(name, ownerPhone) {
  const code = makeJoinCode();

  const { data: tree, error } = await db
    .from("trees")
    .insert({ name, join_code: code })
    .select()
    .single();

  if (error) throw error;

  const { error: mErr } = await db
    .from("members")
    .insert({ tree_id: tree.id, phone: ownerPhone });

  if (mErr) throw mErr;

  return tree;
}

/**
 * Join a tree by 6-char code (idempotent).
 * @param {string} code - Join code (case-insensitive)
 * @param {string} phone - Member’s WhatsApp phone
 * @returns {Promise<null|{id:string,name:string,join_code:string}>}
 */
export async function joinTreeByCode(code, phone) {
  const { data: tree, error } = await db
    .from("trees")
    .select("*")
    .eq("join_code", code.toUpperCase())
    .single();

  if (error) {
    // If not found, return null; other errors bubble up
    if (error.code === "PGRST116") return null;
    throw error;
  }
  if (!tree) return null;

  // Insert membership; ignore if already a member
  const { error: mErr } = await db
    .from("members")
    .insert({ tree_id: tree.id, phone })
    .onConflict("tree_id,phone")
    .ignore();

  if (mErr) throw mErr;

  return tree;
}

/**
 * Get the most recently joined/created tree for a phone number.
 * @param {string} phone
 * @returns {Promise<null|{id:string,name:string,join_code:string,created_at:string}>}
 */
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

/**
 * Find a person by name (case-insensitive) in the latest tree for this phone.
 */
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

/**
 * Get all people in the latest tree for this phone.
 */
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

