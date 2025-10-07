// api/_db.js
import { createClient } from "@supabase/supabase-js";

// ---------- Setup ----------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const db = createClient(supabaseUrl, supabaseKey);

// ---------- Helper functions ----------
export async function createTree(from, name) {
  const join_code = generateJoinCode();
  const { data, error } = await db
    .from("trees")
    .insert({ name, join_code })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function getTreeByCode(code) {
  const { data, error } = await db
    .from("trees")
    .select("*")
    .eq("join_code", code)
    .single();

  if (error) throw error;
  return data;
}

export async function listPersons(tree_id) {
  const { data, error } = await db
    .from("persons")
    .select("id, data")
    .eq("tree_id", tree_id);

  if (error) throw error;
  return data || [];
}

export async function insertPerson(tree_id, first_name, last_name, gender, birthday) {
  const { data, error } = await db
    .from("persons")
    .insert({
      tree_id,
      data: {
        first_name,
        last_name,
        gender: normalizeGender(gender),
        birthday: normalizeDate(birthday),
        deathday: null
      }
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function updatePersonGender(person_id, gender) {
  const { data, error } = await db
    .from("persons")
    .update({
      data: db.rpc("jsonb_set", {
        target: "data",
        path: "{gender}",
        value: normalizeGender(gender)
      })
    })
    .eq("id", person_id)
    .select("*");

  if (error) throw error;
  return data;
}

export async function addRelationship(tree_id, kind, a, b) {
  const { data, error } = await db
    .from("relationships")
    .insert({ tree_id, kind, a, b })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ---------- Utilities ----------
function normalizeGender(g) {
  if (!g) return "U";
  g = String(g).trim().toLowerCase();
  if (g.startsWith("m")) return "M";
  if (g.startsWith("f")) return "F";
  return "U";
}

function normalizeDate(str) {
  if (!str) return null;
  const clean = String(str)
    .replace(/[^\d-]/g, "")
    .replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  return clean.length >= 4 ? clean : null;
}

function generateJoinCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 6 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join("");
}
