// api/_db.js
// Database operations for family tree webapp
// ALL IDs ARE STRING UUIDs | Gender: Male/Female/Undefined | Dates: YYYY only

import { createClient } from "@supabase/supabase-js";
import {
  GENDER,
  RELATIONSHIP_KIND,
  normalizePersonData,
  normalizeGender,
  normalizeYear,
  validatePersonData,
  isValidRelationshipKind,
  generateJoinCode,
  isUUID,
  ensureUUIDString
} from "./_models.js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase credentials in environment variables");
}

export const db = createClient(supabaseUrl, supabaseKey);

// ============================================================================
// TREE OPERATIONS
// ============================================================================

/**
 * Create a new tree
 * @param {string} name - Tree name
 * @returns {Promise<Object>} Created tree with UUID strings
 */
export async function createTree(name) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error("Tree name is required");
  }

  const joinCode = generateJoinCode();
  
  const { data, error } = await db
    .from("trees")
    .insert({ 
      name: name.trim(), 
      join_code: joinCode 
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to create tree: ${error.message}`);
  
  // Ensure ID is string
  return {
    ...data,
    id: String(data.id)
  };
}

/**
 * Get tree by ID
 * @param {string} treeId - Tree UUID string
 * @returns {Promise<Object|null>} Tree or null if not found
 */
export async function getTreeById(treeId) {
  if (!treeId || !isUUID(treeId)) {
    return null;
  }
  
  const { data, error } = await db
    .from("trees")
    .select("*")
    .eq("id", treeId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    throw new Error(`Failed to get tree: ${error.message}`);
  }
  
  return data ? { ...data, id: String(data.id) } : null;
}

/**
 * Get tree by join code
 * @param {string} joinCode - 6-character join code
 * @returns {Promise<Object|null>} Tree or null if not found
 */
export async function getTreeByCode(joinCode) {
  if (!joinCode || typeof joinCode !== 'string') {
    return null;
  }
  
  const code = joinCode.toUpperCase().trim();
  
  const { data, error } = await db
    .from("trees")
    .select("*")
    .eq("join_code", code)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    throw new Error(`Failed to get tree: ${error.message}`);
  }
  
  return data ? { ...data, id: String(data.id) } : null;
}

/**
 * Update tree name
 * @param {string} treeId - Tree UUID string
 * @param {string} name - New tree name
 * @returns {Promise<Object>} Updated tree
 */
export async function updateTreeName(treeId, name) {
  if (!treeId || !isUUID(treeId)) {
    throw new Error("Invalid tree ID");
  }
  
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error("Tree name is required");
  }

  const { data, error } = await db
    .from("trees")
    .update({ name: name.trim() })
    .eq("id", treeId)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to update tree: ${error.message}`);
  return { ...data, id: String(data.id) };
}

/**
 * Delete tree and all associated data (CASCADE handles persons/relationships)
 * @param {string} treeId - Tree UUID string
 * @returns {Promise<void>}
 */
export async function deleteTree(treeId) {
  if (!treeId || !isUUID(treeId)) {
    throw new Error("Invalid tree ID");
  }

  const { error } = await db
    .from("trees")
    .delete()
    .eq("id", treeId);

  if (error) throw new Error(`Failed to delete tree: ${error.message}`);
}

// ============================================================================
// PERSON OPERATIONS (all IDs are string UUIDs)
// ============================================================================

/**
 * List all persons in a tree
 * @param {string} treeId - Tree UUID string
 * @returns {Promise<Array>} Array of persons with string UUIDs
 */
export async function listPersons(treeId) {
  if (!treeId || !isUUID(treeId)) {
    throw new Error("Invalid tree ID");
  }

  const { data, error } = await db
    .from("persons")
    .select("*")
    .eq("tree_id", treeId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to list persons: ${error.message}`);
  
  // Ensure all IDs are strings
  return (data || []).map(person => ({
    ...person,
    id: String(person.id),
    tree_id: String(person.tree_id)
  }));
}

/**
 * Get person by ID
 * @param {string} personId - Person UUID string
 * @returns {Promise<Object|null>} Person or null if not found
 */
export async function getPersonById(personId) {
  if (!personId || !isUUID(personId)) {
    return null;
  }

  const { data, error } = await db
    .from("persons")
    .select("*")
    .eq("id", personId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get person: ${error.message}`);
  }
  
  return data ? {
    ...data,
    id: String(data.id),
    tree_id: String(data.tree_id)
  } : null;
}

/**
 * Create a new person
 * Gender: Male/Female/Undefined | Birthday: YYYY only
 * @param {string} treeId - Tree UUID string
 * @param {Object} personData - Person data
 * @returns {Promise<Object>} Created person with string UUID
 */
export async function createPerson(treeId, personData) {
  if (!treeId || !isUUID(treeId)) {
    throw new Error("Invalid tree ID");
  }

  // Validate person data
  const validation = validatePersonData(personData);
  if (!validation.valid) {
    throw new Error(`Invalid person data: ${validation.errors.join(', ')}`);
  }

  const normalized = normalizePersonData(personData);

  const { data, error } = await db
    .from("persons")
    .insert({
      tree_id: treeId,
      data: normalized
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to create person: ${error.message}`);
  
  return {
    ...data,
    id: String(data.id),
    tree_id: String(data.tree_id)
  };
}

/**
 * Update person data
 * @param {string} personId - Person UUID string
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated person
 */
export async function updatePerson(personId, updates) {
  if (!personId || !isUUID(personId)) {
    throw new Error("Invalid person ID");
  }

  const person = await getPersonById(personId);
  if (!person) {
    throw new Error("Person not found");
  }

  // Merge updates with existing data
  const updatedData = {
    ...person.data,
    ...updates
  };

  // Validate merged data
  const validation = validatePersonData(updatedData);
  if (!validation.valid) {
    throw new Error(`Invalid person data: ${validation.errors.join(', ')}`);
  }

  const normalized = normalizePersonData(updatedData);

  const { data, error } = await db
    .from("persons")
    .update({ 
      data: normalized,
      updated_at: new Date().toISOString()
    })
    .eq("id", personId)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to update person: ${error.message}`);
  
  return {
    ...data,
    id: String(data.id),
    tree_id: String(data.tree_id)
  };
}

/**
 * Delete person and all associated relationships (CASCADE handles relationships)
 * @param {string} personId - Person UUID string
 * @returns {Promise<void>}
 */
export async function deletePerson(personId) {
  if (!personId || !isUUID(personId)) {
    throw new Error("Invalid person ID");
  }

  const { error } = await db
    .from("persons")
    .delete()
    .eq("id", personId);

  if (error) throw new Error(`Failed to delete person: ${error.message}`);
}

// ============================================================================
// RELATIONSHIP OPERATIONS (all IDs are string UUIDs)
// ============================================================================

/**
 * List all relationships in a tree
 * @param {string} treeId - Tree UUID string
 * @returns {Promise<Array>} Array of relationships with string UUIDs
 */
export async function listRelationships(treeId) {
  if (!treeId || !isUUID(treeId)) {
    throw new Error("Invalid tree ID");
  }

  const { data, error } = await db
    .from("relationships")
    .select("*")
    .eq("tree_id", treeId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to list relationships: ${error.message}`);
  
  // Ensure all IDs are strings
  return (data || []).map(rel => ({
    ...rel,
    id: String(rel.id),
    tree_id: String(rel.tree_id),
    person_a_id: String(rel.person_a_id),
    person_b_id: String(rel.person_b_id)
  }));
}

/**
 * Check if a relationship exists
 * @param {string} treeId - Tree UUID string
 * @param {string} kind - Relationship kind
 * @param {string} personAId - Person A UUID string
 * @param {string} personBId - Person B UUID string
 * @returns {Promise<boolean>} True if relationship exists
 */
export async function relationshipExists(treeId, kind, personAId, personBId) {
  const { data, error } = await db
    .from("relationships")
    .select("id")
    .eq("tree_id", treeId)
    .eq("kind", kind)
    .eq("person_a_id", personAId)
    .eq("person_b_id", personBId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error("Error checking relationship:", error);
  }

  // For symmetric relationships (spouse, divorced, separated), check reverse too
  if ([RELATIONSHIP_KIND.SPOUSE, RELATIONSHIP_KIND.DIVORCED, RELATIONSHIP_KIND.SEPARATED].includes(kind)) {
    const { data: reverseData } = await db
      .from("relationships")
      .select("id")
      .eq("tree_id", treeId)
      .eq("kind", kind)
      .eq("person_a_id", personBId)
      .eq("person_b_id", personAId)
      .maybeSingle();
    
    return !!(data || reverseData);
  }

  return !!data;
}

/**
 * Create a relationship between two persons
 * @param {string} treeId - Tree UUID string
 * @param {string} kind - Relationship kind (parent/child/spouse/divorced/separated)
 * @param {string} personAId - Person A UUID string
 * @param {string} personBId - Person B UUID string
 * @returns {Promise<Object>} Created relationship with string UUIDs
 */
export async function createRelationship(treeId, kind, personAId, personBId) {
  // Validate inputs
  if (!treeId || !isUUID(treeId)) {
    throw new Error("Invalid tree ID");
  }
  
  if (!isValidRelationshipKind(kind)) {
    throw new Error(`Invalid relationship kind: ${kind}. Must be one of: ${Object.values(RELATIONSHIP_KIND).join(', ')}`);
  }
  
  if (!personAId || !isUUID(personAId)) {
    throw new Error("Invalid person A ID");
  }
  
  if (!personBId || !isUUID(personBId)) {
    throw new Error("Invalid person B ID");
  }
  
  if (personAId === personBId) {
    throw new Error("A person cannot have a relationship with themselves");
  }

  // Check if relationship already exists
  const exists = await relationshipExists(treeId, kind, personAId, personBId);
  if (exists) {
    throw new Error("This relationship already exists");
  }

  // Validate logical consistency
  await validateRelationshipLogic(treeId, kind, personAId, personBId);

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

  if (error) throw new Error(`Failed to create relationship: ${error.message}`);
  
  return {
    ...data,
    id: String(data.id),
    tree_id: String(data.tree_id),
    person_a_id: String(data.person_a_id),
    person_b_id: String(data.person_b_id)
  };
}

/**
 * Delete a relationship
 * @param {string} relationshipId - Relationship UUID string
 * @returns {Promise<void>}
 */
export async function deleteRelationship(relationshipId) {
  if (!relationshipId || !isUUID(relationshipId)) {
    throw new Error("Invalid relationship ID");
  }

  const { error } = await db
    .from("relationships")
    .delete()
    .eq("id", relationshipId);

  if (error) throw new Error(`Failed to delete relationship: ${error.message}`);
}

/**
 * Validate relationship logic (prevent impossible relationships)
 * @param {string} treeId - Tree UUID string
 * @param {string} kind - Relationship kind
 * @param {string} personAId - Person A UUID string
 * @param {string} personBId - Person B UUID string
 * @returns {Promise<void>} Throws error if invalid
 */
async function validateRelationshipLogic(treeId, kind, personAId, personBId) {
  const [personA, personB] = await Promise.all([
    getPersonById(personAId),
    getPersonById(personBId)
  ]);

  if (!personA || !personB) {
    throw new Error("One or both persons not found");
  }

  // Check birth years for parent-child relationships
  if (kind === RELATIONSHIP_KIND.PARENT) {
    const yearA = personA.data.birthday; // Already in YYYY format
    const yearB = personB.data.birthday; // Already in YYYY format

    if (yearA && yearB) {
      const diff = parseInt(yearB) - parseInt(yearA);
      if (diff <= 0) {
        throw new Error(`${personA.data.first_name} cannot be the parent of ${personB.data.first_name} (born in same year or later)`);
      }
      if (diff < 12) {
        throw new Error(`${personA.data.first_name} was too young to be ${personB.data.first_name}'s parent`);
      }
    }
  }
}

// ============================================================================
// MEMBER OPERATIONS (for future collaboration features)
// ============================================================================

/**
 * Add a member to a tree
 * @param {string} treeId - Tree UUID string
 * @param {string} phone - Phone number or user identifier
 * @returns {Promise<Object>} Created member
 */
export async function addMember(treeId, phone) {
  if (!treeId || !isUUID(treeId)) {
    throw new Error("Invalid tree ID");
  }

  if (!phone || typeof phone !== 'string') {
    throw new Error("Phone/identifier is required");
  }

  const { data, error } = await db
    .from("members")
    .insert({ 
      tree_id: treeId, 
      phone: phone.trim() 
    })
    .select("*")
    .single();

  // Ignore duplicate key errors (member already exists)
  if (error && error.code !== '23505') {
    throw new Error(`Failed to add member: ${error.message}`);
  }
  
  return data ? {
    ...data,
    id: String(data.id),
    tree_id: String(data.tree_id)
  } : null;
}

/**
 * Check if a phone/identifier is a member of a tree
 * @param {string} treeId - Tree UUID string
 * @param {string} phone - Phone number or user identifier
 * @returns {Promise<boolean>} True if member exists
 */
export async function isMember(treeId, phone) {
  if (!treeId || !isUUID(treeId)) {
    return false;
  }

  const { data, error } = await db
    .from("members")
    .select("id")
    .eq("tree_id", treeId)
    .eq("phone", phone)
    .maybeSingle();

  return !!data;
}

/**
 * List all members of a tree
 * @param {string} treeId - Tree UUID string
 * @returns {Promise<Array>} Array of members
 */
export async function listMembers(treeId) {
  if (!treeId || !isUUID(treeId)) {
    throw new Error("Invalid tree ID");
  }

  const { data, error } = await db
    .from("members")
    .select("*")
    .eq("tree_id", treeId)
    .order("joined_at", { ascending: true });

  if (error) throw new Error(`Failed to list members: ${error.message}`);
  
  return (data || []).map(member => ({
    ...member,
    id: String(member.id),
    tree_id: String(member.tree_id)
  }));
}

// Export constants for use in other modules
export { GENDER, RELATIONSHIP_KIND }
