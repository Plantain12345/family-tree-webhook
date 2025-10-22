// api/person.js
// CRUD operations for persons in a tree

import {
  getTreeByCode,
  listPersons,
  getPersonById,
  createPerson,
  updatePerson,
  deletePerson
} from "./_db.js";
import { isJoinCode, isUUID, validatePersonData } from "./_models.js";

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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
      case "PUT":
        return await handlePut(req, res, tree);
      case "DELETE":
        return await handleDelete(req, res, tree);
      default:
        return res.status(405).json({ error: "Method not allowed" });
    }
  } catch (error) {
    console.error("API /person error:", error);
    return res.status(500).json({ 
      error: "Internal server error",
      message: error.message 
    });
  }
}

/**
 * GET /api/person?code=ABC123&id=uuid
 * Get single person or list all persons in tree
 */
async function handleGet(req, res, tree) {
  const personId = req.query.id;

  // If ID provided, get single person
  if (personId) {
    if (!isUUID(personId)) {
      return res.status(400).json({ error: "Invalid person ID" });
    }

    const person = await getPersonById(personId);
    
    if (!person) {
      return res.status(404).json({ error: "Person not found" });
    }

    // Verify person belongs to this tree
    if (person.tree_id !== tree.id) {
      return res.status(403).json({ error: "Person does not belong to this tree" });
    }

    return res.status(200).json({ person });
  }

  // Otherwise, list all persons in tree
  const persons = await listPersons(tree.id);
  return res.status(200).json({ persons });
}

/**
 * POST /api/person?code=ABC123
 * Create new person
 * Body: { first_name, last_name?, gender?, birthday? }
 */
async function handlePost(req, res, tree) {
  const personData = req.body;

  if (!personData || typeof personData !== 'object') {
    return res.status(400).json({ error: "Request body must be an object" });
  }

  // Validate person data
  const validation = validatePersonData(personData);
  if (!validation.valid) {
    return res.status(400).json({ 
      error: "Invalid person data",
      details: validation.errors 
    });
  }

  // Create person
  const person = await createPerson(tree.id, personData);

  return res.status(201).json({ 
    person,
    message: "Person created successfully" 
  });
}

/**
 * PUT /api/person?code=ABC123&id=uuid
 * Update existing person
 * Body: { first_name?, last_name?, gender?, birthday?, deathday? }
 */
async function handlePut(req, res, tree) {
  const personId = req.query.id;

  if (!personId || !isUUID(personId)) {
    return res.status(400).json({ error: "Valid person ID is required" });
  }

  // Verify person exists and belongs to tree
  const existing = await getPersonById(personId);
  
  if (!existing) {
    return res.status(404).json({ error: "Person not found" });
  }

  if (existing.tree_id !== tree.id) {
    return res.status(403).json({ error: "Person does not belong to this tree" });
  }

  const updates = req.body;

  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: "Request body must be an object" });
  }

  // Update person
  const person = await updatePerson(personId, updates);

  return res.status(200).json({ 
    person,
    message: "Person updated successfully" 
  });
}

/**
 * DELETE /api/person?code=ABC123&id=uuid
 * Delete person and all their relationships
 */
async function handleDelete(req, res, tree) {
  const personId = req.query.id;

  if (!personId || !isUUID(personId)) {
    return res.status(400).json({ error: "Valid person ID is required" });
  }

  // Verify person exists and belongs to tree
  const existing = await getPersonById(personId);
  
  if (!existing) {
    return res.status(404).json({ error: "Person not found" });
  }

  if (existing.tree_id !== tree.id) {
    return res.status(403).json({ error: "Person does not belong to this tree" });
  }

  // Delete person (CASCADE will remove relationships)
  await deletePerson(personId);

  return res.status(200).json({ 
    message: "Person deleted successfully" 
  });
}
