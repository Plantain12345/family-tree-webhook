// api/tree.js
// GET endpoint to fetch tree data with persons and relationships
// Returns data formatted for family-chart library

import { 
  getTreeByCode, 
  listPersons, 
  listRelationships,
  RELATIONSHIP_KIND,
  GENDER
} from "./_db.js";
import { 
  isJoinCode, 
  genderToAbbreviation,
  normalizePersonData 
} from "./_models.js";

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Validate join code parameter
    const code = (req.query.code || "").trim().toUpperCase();
    
    if (!code) {
      return res.status(400).json({ 
        error: "Missing code parameter. Usage: /api/tree?code=ABC123" 
      });
    }

    if (!isJoinCode(code)) {
      return res.status(400).json({ 
        error: "Invalid code format. Code must be 6 alphanumeric characters." 
      });
    }

    // Fetch tree
    const tree = await getTreeByCode(code);
    
    if (!tree) {
      return res.status(404).json({ 
        error: "Tree not found. Please check the code and try again." 
      });
    }

    // Fetch persons and relationships in parallel
    const [personRows, relationshipRows] = await Promise.all([
      listPersons(tree.id),
      listRelationships(tree.id)
    ]);

    // Transform persons into family-chart format
    const persons = personRows.map(p => ({
      id: String(p.id), // Ensure string UUID
      data: {
        ...normalizePersonData(p.data),
        // Convert gender to abbreviation for family-chart library
        gender: genderToAbbreviation(p.data.gender)
      },
      rels: {
        father: null,
        mother: null,
        spouses: [],
        children: []
      }
    }));

    // Build person lookup map
    const personMap = new Map(persons.map(p => [p.id, p]));

    // Process relationships and build family tree structure
    for (const rel of relationshipRows) {
      const aId = String(rel.person_a_id);
      const bId = String(rel.person_b_id);
      
      const personA = personMap.get(aId);
      const personB = personMap.get(bId);
      
      // Skip if either person not found
      if (!personA || !personB) {
        console.warn(`Skipping relationship ${rel.id}: person not found`);
        continue;
      }

      // Handle different relationship types
      switch (rel.kind) {
        case RELATIONSHIP_KIND.PARENT:
          // A is parent of B
          handleParentRelationship(personA, personB, aId, bId);
          break;
          
        case RELATIONSHIP_KIND.CHILD:
          // B is parent of A (reverse relationship)
          handleParentRelationship(personB, personA, bId, aId);
          break;
          
        case RELATIONSHIP_KIND.SPOUSE:
        case RELATIONSHIP_KIND.DIVORCED:
        case RELATIONSHIP_KIND.SEPARATED:
          // Bidirectional spouse-type relationships
          handleSpouseRelationship(personA, personB, aId, bId);
          break;
          
        default:
          console.warn(`Unknown relationship kind: ${rel.kind}`);
      }
    }

    // Return formatted response
    return res.status(200).json({
      tree: {
        id: tree.id,
        name: tree.name,
        join_code: tree.join_code,
        created_at: tree.created_at
      },
      persons: persons,
      relationships: relationshipRows
    });

  } catch (error) {
    console.error("API /tree error:", error);
    return res.status(500).json({ 
      error: "Internal server error",
      message: error.message 
    });
  }
}

/**
 * Handle parent-child relationship
 * @param {Object} parent - Parent person object
 * @param {Object} child - Child person object
 * @param {string} parentId - Parent ID
 * @param {string} childId - Child ID
 */
function handleParentRelationship(parent, child, parentId, childId) {
  // Add child to parent's children array (no duplicates)
  if (!parent.rels.children.includes(childId)) {
    parent.rels.children.push(childId);
  }
  
  // Set parent as child's father or mother based on gender
  const parentGender = parent.data.gender;
  
  if (parentGender === 'M' && !child.rels.father) {
    child.rels.father = parentId;
  } else if (parentGender === 'F' && !child.rels.mother) {
    child.rels.mother = parentId;
  } else if (parentGender === 'U') {
    // Unknown gender: assign to whichever slot is empty
    if (!child.rels.father) {
      child.rels.father = parentId;
    } else if (!child.rels.mother) {
      child.rels.mother = parentId;
    }
  }
}

/**
 * Handle spouse-type relationships (bidirectional)
 * @param {Object} personA - Person A object
 * @param {Object} personB - Person B object
 * @param {string} idA - Person A ID
 * @param {string} idB - Person B ID
 */
function handleSpouseRelationship(personA, personB, idA, idB) {
  // Add to each other's spouse arrays (no duplicates)
  if (!personA.rels.spouses.includes(idB)) {
    personA.rels.spouses.push(idB);
  }
  
  if (!personB.rels.spouses.includes(idA)) {
    personB.rels.spouses.push(idA);
  }
}
