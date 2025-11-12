import { SUPABASE_CONFIG } from './config.js'

// Initialize Supabase client
const { createClient } = supabase
export const supabaseClient = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey)

// ==================== FAMILY TREE OPERATIONS ====================

/**
 * Create a new family tree with a unique code
 */
export async function createFamilyTree(treeName) {
  try {
    // Generate unique tree code
    const { data: codeData, error: codeError } = await supabaseClient
      .rpc('generate_tree_code')
    
    if (codeError) throw codeError
    
    const treeCode = codeData
    
    // Insert new tree
    const { data, error } = await supabaseClient
      .from('family_trees')
      .insert([{ tree_code: treeCode, tree_name: treeName }])
      .select()
      .single()
    
    if (error) throw error
    
    return { success: true, data, treeCode }
  } catch (error) {
    console.error('Error creating family tree:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Get family tree by code
 */
export async function getFamilyTreeByCode(treeCode) {
  try {
    const { data, error } = await supabaseClient
      .from('family_trees')
      .select('*')
      .eq('tree_code', treeCode.toUpperCase())
      .single()
    
    if (error) throw error
    if (!data) return { success: false, error: 'Tree not found' }
    
    return { success: true, data }
  } catch (error) {
    console.error('Error fetching family tree:', error)
    return { success: false, error: error.message }
  }
}

// ==================== FAMILY MEMBER OPERATIONS ====================

/**
 * Get all family members for a tree
 */
export async function getFamilyMembers(treeId) {
  try {
    const { data, error } = await supabaseClient
      .from('family_members')
      .select('*')
      .eq('tree_id', treeId)
    
    if (error) throw error
    
    return { success: true, data: data || [] }
  } catch (error) {
    console.error('Error fetching family members:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Create a new family member
 * IMPORTANT: If memberData includes an 'id', it will be used as the database ID
 * This allows us to use the same IDs for chart and database
 */
export async function createFamilyMember(memberData) {
  try {
    const { data, error } = await supabaseClient
      .from('family_members')
      .insert([memberData])
      .select()
      .single()
    
    if (error) throw error
    
    return { success: true, data }
  } catch (error) {
    console.error('Error creating family member:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Update family member
 */
export async function updateFamilyMember(memberId, updates) {
  try {
    const { data, error } = await supabaseClient
      .from('family_members')
      .update(updates)
      .eq('id', memberId)
      .select()
      .single()
    
    if (error) throw error
    
    return { success: true, data }
  } catch (error) {
    console.error('Error updating family member:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Delete family member
 */
export async function deleteFamilyMember(memberId) {
  try {
    const { error } = await supabaseClient
      .from('family_members')
      .delete()
      .eq('id', memberId)
    
    if (error) throw error
    
    return { success: true }
  } catch (error) {
    console.error('Error deleting family member:', error)
    return { success: false, error: error.message }
  }
}

// ==================== RELATIONSHIP OPERATIONS ====================

/**
 * Get all parent-child relationships for a tree
 */
export async function getParentChildRelationships(treeId) {
  try {
    const { data, error } = await supabaseClient
      .from('parent_child_relationships')
      .select('*')
      .eq('tree_id', treeId)
    
    if (error) throw error
    
    return { success: true, data: data || [] }
  } catch (error) {
    console.error('Error fetching parent-child relationships:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Get all spousal relationships for a tree
 */
export async function getSpousalRelationships(treeId) {
  try {
    const { data, error } = await supabaseClient
      .from('spousal_relationships')
      .select('*')
      .eq('tree_id', treeId)
    
    if (error) throw error
    
    return { success: true, data: data || [] }
  } catch (error) {
    console.error('Error fetching spousal relationships:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Create parent-child relationship
 */
export async function createParentChildRelationship(treeId, parentId, childId) {
  try {
    const { data, error } = await supabaseClient
      .from('parent_child_relationships')
      .insert([{ tree_id: treeId, parent_id: parentId, child_id: childId }])
      .select()
      .single()
    
    if (error) {
      // If duplicate, just return success (relationship already exists)
      if (error.code === '23505') {
        console.log('Relationship already exists, skipping...')
        return { success: true, data: null }
      }
      throw error
    }
    
    return { success: true, data }
  } catch (error) {
    console.error('Error creating parent-child relationship:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Create spousal relationship
 */
export async function createSpousalRelationship(treeId, person1Id, person2Id, relationshipType) {
  try {
    const { data, error } = await supabaseClient
      .from('spousal_relationships')
      .insert([{ 
        tree_id: treeId, 
        person1_id: person1Id, 
        person2_id: person2Id,
        relationship_type: relationshipType.toLowerCase()
      }])
      .select()
      .single()
    
    if (error) {
      // If duplicate, just return success (relationship already exists)
      if (error.code === '23505') {
        console.log('Spousal relationship already exists, skipping...')
        return { success: true, data: null }
      }
      throw error
    }
    
    return { success: true, data }
  } catch (error) {
    console.error('Error creating spousal relationship:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Update spousal relationship
 */
export async function updateSpousalRelationship(relationshipId, relationshipType) {
  try {
    const { data, error } = await supabaseClient
      .from('spousal_relationships')
      .update({ relationship_type: relationshipType.toLowerCase() })
      .eq('id', relationshipId)
      .select()
      .single()
    
    if (error) throw error
    
    return { success: true, data }
  } catch (error) {
    console.error('Error updating spousal relationship:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Delete parent-child relationship
 */
export async function deleteParentChildRelationship(parentId, childId) {
  try {
    const { error } = await supabaseClient
      .from('parent_child_relationships')
      .delete()
      .eq('parent_id', parentId)
      .eq('child_id', childId)
    
    if (error) throw error
    
    return { success: true }
  } catch (error) {
    console.error('Error deleting parent-child relationship:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Delete spousal relationship
 */
export async function deleteSpousalRelationship(person1Id, person2Id) {
  try {
    const { error } = await supabaseClient
      .from('spousal_relationships')
      .delete()
      .or(`and(person1_id.eq.${person1Id},person2_id.eq.${person2Id}),and(person1_id.eq.${person2Id},person2_id.eq.${person1Id})`)
    
    if (error) throw error
    
    return { success: true }
  } catch (error) {
    console.error('Error deleting spousal relationship:', error)
    return { success: false, error: error.message }
  }
}

// ==================== REAL-TIME SUBSCRIPTIONS ====================

/**
 * Subscribe to family member changes
 */
export function subscribeFamilyMembers(treeId, callback) {
  return supabaseClient
    .channel(`family_members:${treeId}`)
    .on('postgres_changes', 
      { event: '*', schema: 'public', table: 'family_members', filter: `tree_id=eq.${treeId}` },
      callback
    )
    .subscribe()
}

/**
 * Subscribe to relationship changes
 */
export function subscribeRelationships(treeId, callback) {
  const channel = supabaseClient.channel(`relationships:${treeId}`)
  
  channel
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'parent_child_relationships', filter: `tree_id=eq.${treeId}` },
      callback
    )
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'spousal_relationships', filter: `tree_id=eq.${treeId}` },
      callback
    )
    .subscribe()
  
  return channel
}
