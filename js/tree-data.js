/**
 * Transform database data to family-chart format
 * family-chart expects data in this format:
 * [
 *   {
 *     id: "unique_id",
 *     data: {
 *       "first name": "John",
 *       "last name": "Doe",
 *       "birthday": "1990",
 *       "death": "2020",
 *       "gender": "M"
 *     },
 *     rels: {
 *       father: "father_id",
 *       mother: "mother_id",
 *       children: ["child1_id", "child2_id"],
 *       spouses: ["spouse_id"]
 *     }
 *   }
 * ]
 */

export function transformDatabaseToFamilyChart(members, parentChildRels, spousalRels) {
  const familyChartData = []
  
  // Create a map for quick lookups
  const memberMap = new Map()
  members.forEach(member => {
    memberMap.set(member.id, {
      id: member.id,
      data: {
        "first name": member.first_name || '',
        "last name": member.last_name || '',
        "birthday": member.birthday ? member.birthday.toString() : '',
        "death": member.death ? member.death.toString() : '',
        "gender": member.gender || ''
      },
      rels: {
        children: [],
        spouses: []
      }
    })
  })
  
  // Process parent-child relationships
  parentChildRels.forEach(rel => {
    const child = memberMap.get(rel.child_id)
    const parent = memberMap.get(rel.parent_id)
    
    if (child && parent) {
      const parentGender = parent.data.gender
      
      // Set father or mother
      if (parentGender === 'M') {
        child.rels.father = rel.parent_id
      } else if (parentGender === 'F') {
        child.rels.mother = rel.parent_id
      }
      
      // Add to parent's children list if not already there
      if (!parent.rels.children.includes(rel.child_id)) {
        parent.rels.children.push(rel.child_id)
      }
    }
  })
  
  // Process spousal relationships
  spousalRels.forEach(rel => {
    const person1 = memberMap.get(rel.person1_id)
    const person2 = memberMap.get(rel.person2_id)
    
    if (person1 && person2) {
      // Add spouse to both persons if not already there
      if (!person1.rels.spouses.includes(rel.person2_id)) {
        person1.rels.spouses.push(rel.person2_id)
      }
      if (!person2.rels.spouses.includes(rel.person1_id)) {
        person2.rels.spouses.push(rel.person1_id)
      }
      
      // Store relationship type for link styling
      // We'll use this in the rendering
      if (!person1.data.spouse_rels) person1.data.spouse_rels = {}
      if (!person2.data.spouse_rels) person2.data.spouse_rels = {}
      
      person1.data.spouse_rels[rel.person2_id] = rel.relationship_type
      person2.data.spouse_rels[rel.person1_id] = rel.relationship_type
    }
  })
  
  // Convert map to array
  memberMap.forEach(member => {
    familyChartData.push(member)
  })
  
  return familyChartData
}

/**
 * Find the main person (is_main = true) or first person
 */
export function findMainPersonId(members) {
  const mainPerson = members.find(m => m.is_main)
  if (mainPerson) return mainPerson.id
  
  // If no main person, return first person
  return members.length > 0 ? members[0].id : null
}

/**
 * Create a new member object for database
 */
export function createMemberData(treeId, formData) {
  return {
    tree_id: treeId,
    first_name: formData['first name'] || '',
    last_name: formData['last name'] || '',
    birthday: formData['birthday'] ? parseInt(formData['birthday']) : null,
    death: formData['death'] ? parseInt(formData['death']) : null,
    gender: formData['gender'] || null,
    is_main: false
  }
}

/**
 * Extract relationship data from family-chart datum
 */
export function extractRelationshipData(datum) {
  return {
    id: datum.id,
    father: datum.rels?.father,
    mother: datum.rels?.mother,
    children: datum.rels?.children || [],
    spouses: datum.rels?.spouses || []
  }
}

/**
 * Determine relationship type between two people
 */
export function getRelationshipType(person1, person2, spousalRels) {
  const rel = spousalRels.find(r => 
    (r.person1_id === person1.id && r.person2_id === person2.id) ||
    (r.person1_id === person2.id && r.person2_id === person1.id)
  )
  
  return rel ? rel.relationship_type : 'married' // default to married
}

/**
 * Clean empty relationship fields
 */
export function cleanRelationships(rels) {
  const cleaned = {}
  
  if (rels.father) cleaned.father = rels.father
  if (rels.mother) cleaned.mother = rels.mother
  if (rels.children && rels.children.length > 0) cleaned.children = rels.children
  if (rels.spouses && rels.spouses.length > 0) cleaned.spouses = rels.spouses
  
  return cleaned
}
