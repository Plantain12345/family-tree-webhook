// api/_db.js
import { createClient } from "@supabase/supabase-js";

// ---------- Setup ----------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const db = createClient(supabaseUrl, supabaseKey);

// ---------- Relationship Kind Mapping ----------
// EXACT values from your Supabase constraint: 'parent', 'child', 'spouse'
const RELATIONSHIP_KINDS = {
  SPOUSE: "spouse",
  PARENT: "parent",
  CHILD: "child"
};

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
    if (error.code === 'PGRST116') return null;
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
  const { data: person, error: fetchError } = await db
    .from("persons")
    .select("data")
    .eq("id", person_id)
    .single();

  if (fetchError) throw fetchError;

  const updatedData = {
    ...person.data,
    gender: normalizeGender(gender)
  };

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
export async function addRelationship(tree_id, kind, person_a_id, person_b_id) {
  // Normalize the kind to match database constraint
  const normalizedKind = normalizeRelationshipKind(kind);
  
  console.log("Adding relationship:", { tree_id, kind: normalizedKind, person_a_id, person_b_id });
  
  const { data, error } = await db
    .from("relationships")
    .insert({ 
      tree_id, 
      kind: normalizedKind,
      person_a_id,
      person_b_id
    })
    .select("*")
    .single();

  if (error) {
    console.error("Relationship insert error:", error);
    throw error;
  }
  return data;
}

// ---------- Utilities ----------
function normalizeRelationshipKind(kind) {
  // Map common relationship terms to database values
  const mapping = {
    "spouse_of": RELATIONSHIP_KINDS.SPOUSE,
    "spouse": RELATIONSHIP_KINDS.SPOUSE,
    "married": RELATIONSHIP_KINDS.SPOUSE,
    "partner_of": RELATIONSHIP_KINDS.PARTNER,
    "partner": RELATIONSHIP_KINDS.PARTNER,
    "parent_of": RELATIONSHIP_KINDS.PARENT,
    "parent": RELATIONSHIP_KINDS.PARENT,
    "child_of": RELATIONSHIP_KINDS.CHILD,
    "child": RELATIONSHIP_KINDS.CHILD,
    "sibling_of": RELATIONSHIP_KINDS.SIBLING,
    "sibling": RELATIONSHIP_KINDS.SIBLING,
    "divorced_from": RELATIONSHIP_KINDS.DIVORCED,
    "divorced": RELATIONSHIP_KINDS.DIVORCED
  };
  
  return mapping[kind.toLowerCase()] || kind.toUpperCase();
}

function normalizeGender(g) {
  if (!g) return "U";
  g = String(g).trim().toLowerCase();
  if (g.startsWith("m") || g === "boy" || g === "male") return "M";
  if (g.startsWith("f") || g === "girl" || g === "female") return "F";
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
