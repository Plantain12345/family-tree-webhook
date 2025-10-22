// api/relationship.js
// CRUD operations for relationships

import {
  getTreeByCode,
  listRelationships,
  createRelationship,
  deleteRelationship,
  RELATIONSHIP_KIND
} from "./_db.js";
import { isJoinCode, isUUID, isValidRelationshipKind } from "./_models.js";

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    // All operations require tree code
    const code = (req.query.code || "").trim().toUpperCase();
    
    if (!code || !isJoinCode(code)) {
      return res.status(400).json({ error: "Valid tree code is required" });
    }

    const tree = await getTreeByCode(code);
    if (!tree) {
      return res.status(404).json({ error: "Tree not found" });
    }

    // Route based on HTTP method
    switch (req.method) {
      case "GET":
        return await handleGet(req, res, tree);
      case "POST":
        return await handlePost(req, res, tree);
      case "DELETE":
        return await handleDelete(req, res, tree);
      default:
        return res.status(405).json({ error: "Method not allowed" });
    }
  } catch (error) {
    console.error("API /relationship error:", error);
    return res.status(500).json({ 
      error: "Internal server error",
      message: error.message 
    });
  }
}

/**
 * GET /api/relationship?code=ABC123
 * List all relationships in tree
 */
async function handleGet(req, res, tree) {
  const relationships = await listRelationships(tree.id);
  return res.status(200).json({ relationships });
}

/**
 * POST /api/relationship?code=ABC123
 * Create new relationship
 * Body: { kind, person_a_id, person_b_id }
 */
async function handlePost(req, res, tree) {
  const { kind, person_a_id, person_b_id } = req.body;

  // Validate required fields
  if (!kind || !person_a_id || !person_b_id) {
    return res.status(400).json({ 
      error: "Missing required fields: kind, person_a_id, person_b_id" 
    });
  }

  // Validate relationship kind
  if (!isValidRelationshipKind(kind)) {
    return res.status(400).json({ 
      error: `Invalid relationship kind. Must be one of: ${Object.values(RELATIONSHIP_KIND).join(', ')}` 
    });
  }

  // Validate UUIDs
  if (!isUUID(person_a_id)) {
    return res.status(400).json({ error: "Invalid person_a_id" });
  }

  if (!isUUID(person_b_id)) {
    return res.status(400).json({ error: "Invalid person_b_id" });
  }

  // Create relationship
  try {
    const relationship = await createRelationship(tree.id, kind, person_a_id, person_b_id);

    return res.status(201).json({ 
      relationship,
      message: "Relationship created successfully" 
    });
  } catch (error) {
    // Handle specific errors
    if (error.message.includes("already exists")) {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
}

/**
 * DELETE /api/relationship?code=ABC123&id=uuid
 * Delete relationship
 */
async function handleDelete(req, res, tree) {
  const relationshipId = req.query.id;

  if (!relationshipId || !isUUID(relationshipId)) {
    return res.status(400).json({ error: "Valid relationship ID is required" });
  }

  // Delete relationship
  await deleteRelationship(relationshipId);

  return res.status(200).json({ 
    message: "Relationship deleted successfully" 
  });
}
