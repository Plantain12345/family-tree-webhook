// api/_db.js
// Minimal DB helpers used by the Flows-only webhook

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

export const db = createClient(supabaseUrl, supabaseKey);

// ---- enums / helpers ----
export const GENDER_TYPES = {
  MALE: "M",
  FEMALE: "F",
  UNKNOWN: "U"
};

export function normalizeGender(input) {
  if (!input) return GENDER_TYPES.UNKNOWN;
  const s = String(input).toLowerCase();
  if (s.startsWith("m")) return GENDER_TYPES.MALE;
  if (s.startsWith("f")) return GENDER_TYPES.FEMALE;
  return GENDER_TYPES.UNKNOWN;
}

// "1984" -> "1984-01-01", or null
export function normalizeYear(year) {
  if (!year) return null;
  const s = String(year).trim();
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  return null;
}

// ---- trees / members / user state ----
export async function getTreeByCode(code) {
  const { data, error } = await db
    .from("trees")
    .select("id, name, join_code")
    .eq("join_code", code)
    .single();
  if (error) return null;
  return data;
}

export async function isMember(treeId, phone) {
  const { data, error } = await db
    .from("members")
    .select("id")
    .eq("tree_id", treeId)
    .eq("phone", phone)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

export async function addMember(treeId, phone) {
  const { error } = await db
    .from("members")
    .upsert({ tree_id: treeId, phone });
  if (error) throw error;
}

export async function getUserState(phone) {
  const { data, error } = await db
    .from("user_states")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

export async function setUserState(phone, treeId, lastPersonId = null, lastPersonName = null) {
  const { error } = await db
    .from("user_states")
    .upsert({
      phone,
      tree_id: treeId || null,
      last_person_id: lastPersonId || null,
      last_person_name: lastPersonName || null,
      updated_at: new Date().toISOString()
    });
  if (error) throw error;
}

// ---- persons ----
export async function insertPerson(treeId, firstName, lastName, gender, birthYear, deathYear = null) {
  const rec = {
    tree_id: treeId,
    data: {
      first_name: firstName,
      last_name: lastName || null,
      gender: normalizeGender(gender),
      birthday: normalizeYear(birthYear),
      deathday: normalizeYear(deathYear)
    }
  };
  const { data, error } = await db.from("persons").insert(rec).select("id, data").single();
  if (error) throw error;
  return data;
}

// ---- querying for tree render ----
export async function getTreeDataByJoinCode(code) {
  const { data: tree, error: tErr } = await db
    .from("trees")
    .select("id, name, join_code")
    .eq("join_code", code)
    .single();
  if (tErr || !tree) return { tree: null, persons: [], relationships: [] };

  const [{ data: persons }, { data: relationships }] = await Promise.all([
    db.from("persons").select("id, data").eq("tree_id", tree.id),
    db.from("relationships").select("*").eq("tree_id", tree.id)
  ]);

  return { tree, persons: persons || [], relationships: relationships || [] };
}
