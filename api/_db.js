// api/_db.js
// STANDARDIZED: Consistent naming, clear function signatures

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const db = createClient(supabaseUrl, supabaseKey);

// Constants
const RELATIONSHIP_TYPES = {
  PARENT: 'parent',
  CHILD: 'child',
  SPOUSE: 'spouse'
};

const GENDER_TYPES = {
  MALE: 'M',
  FEMALE: 'F',
  UNKNOWN: 'U'
};

// ============================================================================
// USER STATE MANAGEMENT
// ============================================================================

export async function getUserState(phoneNumber) {
  const { data, error } = await db
    .from("user_states")
    .select("*")
    .eq("phone", phoneNumber)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error("Error fetching user state:", error);
  }
  
  return data || null;
}

export async function setUserState(phoneNumber, treeId, lastPersonId, lastPersonName) {
  const { data, error } = await db
    .from("user_states")
    .upsert(
      {
        phone: phoneNumber,
        tree_id: treeId,
        last_person_id: lastPersonId,
        last_person_name: lastPersonName,
        updated_at: new Date().toISOString()
      },
      { onConflict: "phone" }
    )
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ============================================================================
// TREE MANAGEMENT
// ============================================================================

export async function createTree(phoneNumber, treeName) {
  const joinCode = generateJoinCode();
  const { data, error } = await db
    .from("trees")
    .insert({ 
      name: treeName, 
      join_code: joinCode 
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function getTreeByCode(joinCode) {
  if (!joinCode) return null;
  
  const { data, error } = await db
    .from("trees")
    .select("*")
    .eq("join_code", joinCode.toUpperCase())
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
}

export async function getTreeById(treeId) {
  if (!treeId) return null;
  
  const { data, error } = await db
    .from("trees")
    .select("*")
    .eq("id", treeId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
}

// ============================================================================
// PERSON MANAGEMENT
// ============================================================================

export async function listPersons(treeId) {
  const { data, error } = await db
    .from("persons")
    .select("id, tree_id, data, created_at, updated_at")
    .eq("tree_id", treeId);

  if (error) throw error;
  return data || [];
}

export async function findPersonByName(treeId, name) {
  const persons = await listPersons(treeId);
  const searchName = name.toLowerCase().trim();
  
  return persons.filter(person => {
    const fullName = `${person.data.first_name || ''} ${person.data.last_name || ''}`.toLowerCase().trim();
    const firstName = (person.data.first_name || '').toLowerCase().trim();
    
    return fullName.includes(searchName) || 
           firstName === searchName ||
           fullName === searchName;
  });
}

export async function insertPerson(treeId, firstName, lastName, gender, birthday) {
  const { data, error } = await db
    .from("persons")
    .insert({
      tree_id: treeId,
      data: {
        first_name: firstName,
        last_name: lastName,
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

export async function updatePersonGender(personId, gender) {
  const { data: person, error: fetchError } = await db
    .from("persons")
    .select("data")
    .eq("id", personId)
    .single();

  if (fetchError) throw fetchError;

  const updatedData = {
    ...person.data,
    gender: normalizeGender(gender)
  };

  const { data, error } = await db
    .from("persons")
    .update({ data: updatedData })
    .eq("id", personId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

// ============================================================================
// RELATIONSHIP MANAGEMENT
// ============================================================================

export async function addRelationship(treeId, kind, personAId, personBId) {
  // Validate kind is one of the allowed values
  const validKinds = Object.values(RELATIONSHIP_TYPES);
  if (!validKinds.includes(kind)) {
    throw new Error(`Invalid relationship kind: ${kind}. Must be one of: ${validKinds.join(', ')}`);
  }
  
  console.log("Adding relationship:", { treeId, kind, personAId, personBId });
  
  const { data, error } = await db
    .from("relationships")
    .insert({ 
      tree_id: treeId, 
      kind: kind,
      person_a_id: personAId,
      person_b_id: personBId
    })
    .select("*")
    .single();

  if (error) {
    console.error("Relationship insert error:", error);
    throw error;
  }
  return data;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export function normalizeGender(input) {
  if (!input) return GENDER_TYPES.UNKNOWN;
  
  const normalized = String(input).trim().toLowerCase();
  
  if (normalized.startsWith("m") || normalized === "boy" || normalized === "male") {
    return GENDER_TYPES.MALE;
  }
  if (normalized.startsWith("f") || normalized === "girl" || normalized === "female") {
    return GENDER_TYPES.FEMALE;
  }
  
  return GENDER_TYPES.UNKNOWN;
}

export function normalizeDate(input) {
  if (!input) return null;
  
  const cleaned = String(input)
    .replace(/[^\d-]/g, "")
    .replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  
  return cleaned.length >= 4 ? cleaned : null;
}

function generateJoinCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 6 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join("");
}
