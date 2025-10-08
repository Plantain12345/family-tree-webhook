// api/_db.js
import { createClient } from "@supabase/supabase-js";

// ---------- Setup ----------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const db = createClient(supabaseUrl, supabaseKey);

// ---------- User State Management ----------
export async function getUserState(phone) {
  const { data, error } = await db
    .from("user_states")
    .select("*")
    .eq("phone", phone)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error("Error fetching user state:", error);
  }
  
  return data || null;
}

export async function setUserState(phone, tree_id, last_person_id, last_person_name) {
  const { data, error } = await db
    .from("user_states")
    .upsert(
      {
        phone,
        tree_id,
        last_person_id,
        last_person_name,
        updated_at: new Date().toISOString()
      },
      { onConflict: "phone" }
    )
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ---------- Tree Management ----------
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

export async function getTreeByCode(code, tree_id = null) {
  let query = db.from("trees").select("*");
  
  if (tree_id) {
    query = query.eq("id", tree_id);
  } else if (code) {
    query = query.eq("join_code", code.toUpperCase());
  } else {
    return null;
  }

  const { data, error } = await query.single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    throw error;
  }
  return data;
}

// ---------- Person Management ----------
export async function listPersons(tree_id) {
  const { data, error } = await db
    .from("persons")
    .select("id, data")
    .eq("tree_id", tree_id);

  if (error) throw error;
  return data || [];
}

export async function findPersonByName(tree_id, name) {
  const persons = await listPersons(tree_id);
  const searchName = name.toLowerCase().trim();
  
  return persons.filter(p => {
    const fullName = `${p.data.first_name || ''} ${p.data.last_name || ''}`.toLowerCase().trim();
    const firstName = (p.data.first_name || '').toLowerCase().trim();
    
    return fullName.includes(searchName) || 
           firstName === searchName ||
           fullName === searchName;
  });
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
  // First fetch the current person
  const { data: person, error: fetchError } = await db
    .from("persons")
    .select("data")
    .eq("id", person_id)
    .single();

  if (fetchError) throw fetchError;

  // Update the gender in the data object
  const updatedData = {
    ...person.data,
    gender: normalizeGender(gender)
  };

  // Update the person
  const { data, error } = await db
    .from("persons")
    .update({ data: updatedData })
    .eq("id", person_id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ---------- Relationship Management ----------
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
  if (g.startsWith("m") || g === "boy") return "M";
  if (g.startsWith("f") || g === "girl") return "F";
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
