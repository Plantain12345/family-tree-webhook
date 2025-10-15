// api/_db.js
// Database operations for family tree bot

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const db = createClient(supabaseUrl, supabaseKey);

// Constants
export const RELATIONSHIP_TYPES = {
  PARENT: 'parent',
  CHILD: 'child',
  SPOUSE: 'spouse',
  DIVORCED: 'divorced',
  SEPARATED: 'separated'
};

export const GENDER_TYPES = {
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

  // Auto-add creator as member
  await addMember(data.id, phoneNumber);

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
// MEMBER MANAGEMENT
// ============================================================================

export async function addMember(treeId, phoneNumber) {
  const { data, error } = await db
    .from("members")
    .insert({ tree_id: treeId, phone: phoneNumber })
    .select("*")
    .single();

  if (error && error.code !== '23505') { // Ignore duplicate key errors
    throw error;
  }
  return data;
}

export async function isMember(treeId, phoneNumber) {
  const { data, error } = await db
    .from("members")
    .select("id")
    .eq("tree_id", treeId)
    .eq("phone", phoneNumber)
    .single();

  return !!data;
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

export async function getPersonById(personId) {
  const { data, error } = await db
    .from("persons")
    .select("*")
    .eq("id", personId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
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

export async function findSimilarPersons(treeId, firstName, lastName, birthday) {
  const persons = await listPersons(treeId);
  const searchFirst = (firstName || '').toLowerCase().trim();
  const searchLast = (lastName || '').toLowerCase().trim();
  const searchYear = extractYear(birthday);

  return persons.filter(person => {
    const pFirst = (person.data.first_name || '').toLowerCase().trim();
    const pLast = (person.data.last_name || '').toLowerCase().trim();
    const pYear = extractYear(person.data.birthday);

    // Match if first name is similar and either:
    // 1. Last names match, or
    // 2. Birth years are within 2 years, or
    // 3. Both last name and birth year are missing
    const firstMatch = similarity(searchFirst, pFirst) > 0.8;
    const lastMatch = searchLast && pLast && similarity(searchLast, pLast) > 0.8;
    const yearMatch = searchYear && pYear && Math.abs(parseInt(searchYear) - parseInt(pYear)) <= 2;
    
    return firstMatch && (lastMatch || yearMatch || (!searchLast && !searchYear));
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

export async function updatePerson(personId, updates) {
  const person = await getPersonById(personId);
  if (!person) throw new Error("Person not found");

  const updatedData = {
    ...person.data,
    ...updates
  };

  const { data, error } = await db
    .from("persons")
    .update({ 
      data: updatedData,
      updated_at: new Date().toISOString()
    })
    .eq("id", personId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function updatePersonGender(personId, gender) {
  return updatePerson(personId, { gender: normalizeGender(gender) });
}

// ============================================================================
// RELATIONSHIP MANAGEMENT
// ============================================================================

export async function listRelationships(treeId) {
  const { data, error } = await db
    .from("relationships")
    .select("*")
    .eq("tree_id", treeId);

  if (error) throw error;
  return data || [];
}

export async function relationshipExists(treeId, kind, personAId, personBId) {
  const { data, error } = await db
    .from("relationships")
    .select("id")
    .eq("tree_id", treeId)
    .eq("kind", kind)
    .eq("person_a_id", personAId)
    .eq("person_b_id", personBId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error("Error checking relationship:", error);
  }

  // For symmetric relationships (spouse, divorced, separated), check reverse too
  if ([RELATIONSHIP_TYPES.SPOUSE, RELATIONSHIP_TYPES.DIVORCED, RELATIONSHIP_TYPES.SEPARATED].includes(kind)) {
    const { data: reverseData } = await db
      .from("relationships")
      .select("id")
      .eq("tree_id", treeId)
      .eq("kind", kind)
      .eq("person_a_id", personBId)
      .eq("person_b_id", personAId)
      .single();
    
    return !!(data || reverseData);
  }

  return !!data;
}

export async function addRelationship(treeId, kind, personAId, personBId) {
  // Validate kind
  const validKinds = Object.values(RELATIONSHIP_TYPES);
  if (!validKinds.includes(kind)) {
    throw new Error(`Invalid relationship kind: ${kind}. Must be one of: ${validKinds.join(', ')}`);
  }

  // Check for duplicates
  const exists = await relationshipExists(treeId, kind, personAId, personBId);
  if (exists) {
    return { duplicate: true };
  }

  // Validate logical consistency
  const validation = await validateRelationship(treeId, kind, personAId, personBId);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  
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

export async function validateRelationship(treeId, kind, personAId, personBId) {
  // Prevent self-relationships
  if (personAId === personBId) {
    return { valid: false, error: "A person cannot have a relationship with themselves." };
  }

  // Get both persons
  const [personA, personB] = await Promise.all([
    getPersonById(personAId),
    getPersonById(personBId)
  ]);

  // Check birth years for parent-child relationships
  if (kind === RELATIONSHIP_TYPES.PARENT) {
    const yearA = extractYear(personA.data.birthday);
    const yearB = extractYear(personB.data.birthday);

    if (yearA && yearB && parseInt(yearB) <= parseInt(yearA)) {
      return { 
        valid: false, 
        error: `${personA.data.first_name} cannot be the parent of ${personB.data.first_name} because they were born in the same year or later.` 
      };
    }
  }

  return { valid: true };
}

// ============================================================================
// PENDING ACTIONS (For inference mode)
// ============================================================================

export async function savePendingAction(phoneNumber, treeId, action) {
  const { data, error } = await db
    .from("pending_actions")
    .insert({
      phone: phoneNumber,
      tree_id: treeId,
      action: action
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function getPendingAction(phoneNumber) {
  const { data, error } = await db
    .from("pending_actions")
    .select("*")
    .eq("phone", phoneNumber)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error("Error fetching pending action:", error);
  }

  return data || null;
}

export async function clearPendingAction(phoneNumber) {
  const { error } = await db
    .from("pending_actions")
    .delete()
    .eq("phone", phoneNumber);

  if (error) {
    console.error("Error clearing pending action:", error);
  }
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
  
  // Extract year from various formats
  const cleaned = String(input).trim();
  
  // Match full date formats (YYYY-MM-DD, DD/MM/YYYY, etc.)
  const fullDateMatch = cleaned.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (fullDateMatch) {
    return fullDateMatch[1]; // Return only year
  }
  
  const slashDateMatch = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slashDateMatch) {
    let year = slashDateMatch[3];
    // Convert 2-digit to 4-digit year
    if (year.length === 2) {
      year = parseInt(year) > 30 ? `19${year}` : `20${year}`;
    }
    return year;
  }
  
  // Match 4-digit year
  const yearMatch = cleaned.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    return yearMatch[0];
  }
  
  // Match decade (e.g., "1940s" -> "1940")
  const decadeMatch = cleaned.match(/\b(19|20)(\d)0s?\b/);
  if (decadeMatch) {
    return `${decadeMatch[1]}${decadeMatch[2]}0`;
  }
  
  return null;
}

export function extractYear(dateString) {
  if (!dateString) return null;
  const match = String(dateString).match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

function generateJoinCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 6 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join("");
}

// Simple string similarity (Levenshtein distance based)
function similarity(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(null));
  
  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  
  const distance = matrix[len1][len2];
  const maxLen = Math.max(len1, len2);
  return 1 - distance / maxLen;
}
