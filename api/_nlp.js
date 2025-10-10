// api/_nlp.js
// Dual-mode NLP: Command mode (direct) vs Inference mode (requires confirmation)

import OpenAI from "openai";

const OPENAI_ENABLED = !!process.env.OPENAI_API_KEY;
const client = OPENAI_ENABLED ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ============================================================================
// PARSE OPERATIONS
// ============================================================================

export async function parseOps(text, treeContext = null) {
  const raw = (text ?? "").trim();
  if (!raw) return { action: "unknown" };

  if (!OPENAI_ENABLED) {
    return { action: "unknown" };
  }

  try {
    // Determine mode based on text characteristics
    const mode = detectMode(raw);
    
    if (mode === 'command') {
      return await parseCommandMode(raw, treeContext);
    } else {
      return await parseInferenceMode(raw, treeContext);
    }
  } catch (err) {
    console.error("OpenAI parse error:", err?.message || err);
    return { action: "unknown" };
  }
}

// ============================================================================
// MODE DETECTION
// ============================================================================

function detectMode(text) {
  const lower = text.toLowerCase();
  
  // Command mode indicators (direct, imperative)
  const commandIndicators = [
    /^(add|create|set|change|update|delete|remove)/i,
    /^(john|mary|mike|grace|alex)\s+(is|was)\s+/i, // "John is Mary's father"
    /\s+(and|&)\s+.+\s+(are|were)\s+(married|divorced)/i // "John and Mary are married"
  ];
  
  for (const indicator of commandIndicators) {
    if (indicator.test(text)) {
      return 'command';
    }
  }
  
  // Inference mode indicators (conversational, past tense, indirect)
  const inferenceIndicators = [
    /they (got|were|had|became)/i,
    /he (married|had|met|knew)/i,
    /she (married|had|met|knew)/i,
    /tied the knot/i,
    /walking down the aisle/i,
    /welcomed.*child/i
  ];
  
  for (const indicator of inferenceIndicators) {
    if (indicator.test(text)) {
      return 'inference';
    }
  }
  
  // Default to command mode
  return 'command';
}

// ============================================================================
// COMMAND MODE PARSER
// ============================================================================

async function parseCommandMode(text, treeContext) {
  const schemaDefinition = {
    name: "TreeBotCommand",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["help", "create_tree", "join_tree", "add_person", "edit_person", "set_gender", "relate", "confirm", "cancel", "unknown"]
        },
        treeName: { type: "string" },
        code: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: ["string", "null"] },
        birthday: { type: ["string", "null"] },
        deathday: { type: ["string", "null"] },
        gender: { type: ["string", "null"], enum: ["M", "F", null] },
        kind: { type: "string", enum: ["father", "mother", "parent", "spouse", "child", "son", "daughter", "divorced", "separated", "brother", "sister"] },
        nameA: { type: "string" },
        nameB: { type: "string" },
        oldName: { type: "string" },
        newName: { type: ["string", "null"] },
        newBirthday: { type: ["string", "null"] },
        newGender: { type: ["string", "null"], enum: ["M", "F", null] }
      },
      required: ["action"]
    },
    strict: true
  };

  const systemPrompt = buildSystemPrompt(treeContext);
  const userPrompt = buildUserPrompt(text);

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaDefinition.name,
        schema: schemaDefinition.schema,
        strict: schemaDefinition.strict
      }
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  const content = resp.choices[0].message.content;
  let parsed = JSON.parse(content);

  if (!parsed || typeof parsed !== "object" || !parsed.action) {
    return { action: "unknown" };
  }

  // Normalize operation
  parsed = normalizeOperation(text, parsed);

  return parsed;
}

// ============================================================================
// INFERENCE MODE PARSER
// ============================================================================

async function parseInferenceMode(text, treeContext) {
  const schemaDefinition = {
    name: "TreeBotInference",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        confidence: { type: "number" },
        interpretation: { type: "string" },
        suggestedActions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              firstName: { type: "string" },
              lastName: { type: ["string", "null"] },
              birthday: { type: ["string", "null"] },
              gender: { type: ["string", "null"], enum: ["M", "F", null] },
              kind: { type: "string" },
              nameA: { type: "string" },
              nameB: { type: "string" }
            },
            required: ["action"]
          }
        },
        requiresConfirmation: { type: "boolean" }
      },
      required: ["confidence", "interpretation", "suggestedActions", "requiresConfirmation"]
    },
    strict: true
  };

  const systemPrompt = `You are an AI that interprets conversational statements about family relationships.
Your job is to extract structured actions from indirect or past-tense statements.

Context: ${treeContext ? JSON.stringify(treeContext) : 'No tree context available'}

Examples:
- "They tied the knot in Palo Alto" → spouse relationship
- "She welcomed three children" → add 3 children
- "He passed away in the 80s" → update deathday

Return confidence (0-1), interpretation, suggested actions, and requiresConfirmation=true.`;

  const userPrompt = `Statement: "${text}"

Extract all implied actions as a structured list.`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaDefinition.name,
        schema: schemaDefinition.schema,
        strict: schemaDefinition.strict
      }
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  const content = resp.choices[0].message.content;
  let parsed = JSON.parse(content);

  // Add mode flag
  parsed.mode = 'inference';
  parsed.requiresConfirmation = true;

  return parsed;
}

// ============================================================================
// SYSTEM PROMPT BUILDER
// ============================================================================

function buildSystemPrompt(treeContext) {
  let prompt = `You are a deterministic parser for a WhatsApp family tree bot. Output STRICT JSON only.

CRITICAL RULES:
1. Never invent data. Omit fields that are not present.
2. Names must be Title Case.
3. For 'add_person': extract firstName, lastName (optional), birthday (YYYY only), gender ('M'|'F') if stated.
4. For 'relate': nameA is SUBJECT, nameB is OBJECT.
   - "John is Mary's father" → kind='father', nameA='John', nameB='Mary'
   - "Alice is Bob's daughter" → kind='daughter', nameA='Alice', nameB='Bob' (will be converted to parent relationship)
5. For 'join_tree': return uppercase 6-character code.
6. Dates: Extract year only (YYYY format). Accept "born in 1952", "1952", "circa 1940s", "Spring 1978".
7. Multiple people: Extract each separately.

RELATIONSHIP MAPPINGS:
- "father", "mother", "parent" → parent relationship (A is parent of B)
- "son", "daughter", "child" → parent relationship reversed (B is parent of A)
- "brother", "sister" → infer same parents
- "spouse", "married" → spouse relationship
- "divorced" → divorced relationship
- "separated" → separated relationship`;

  if (treeContext) {
    prompt += `\n\nCURRENT TREE CONTEXT:\n${JSON.stringify(treeContext, null, 2)}`;
  }

  prompt += `\n\nEXAMPLES:
{"action":"add_person","firstName":"Grace","lastName":null,"birthday":"1952"}
{"action":"add_person","firstName":"John","lastName":"Smith","birthday":"1980","gender":"M"}
{"action":"relate","kind":"spouse","nameA":"John","nameB":"Mary"}
{"action":"relate","kind":"father","nameA":"John","nameB":"Alice"}
{"action":"edit_person","oldName":"John Benedict Kaggwa","newName":"John Baptist Kaggwa"}
{"action":"create_tree","treeName":"The Smith Family"}
{"action":"join_tree","code":"AB12CD"}
{"action":"help"}`;

  return prompt;
}

function buildUserPrompt(text) {
  return `Message: "${text}"

SPECIAL CASES:
- "Add Grace, born in 1952" → {"action":"add_person","firstName":"Grace","lastName":null,"birthday":"1952"}
- "Add Grace born 1952" → same as above
- "Musa had three kids named Henry, James and Roberto, born in 1932, 1933, and 1954" → return FIRST person only: {"action":"add_person","firstName":"Henry","lastName":null,"birthday":"1932"}
- Natural language dates: "fourteenth of January nineteen forty" → "1940"
- Decades: "1940s", "circa 1940s", "the forties" → "1940"

Parse this message and return valid JSON matching the schema.`;
}

// ============================================================================
// NORMALIZATION
// ============================================================================

function normalizeOperation(raw, op) {
  const out = { ...op };

  // Normalize action casing
  if (typeof out.action === 'string') {
    out.action = out.action.toLowerCase();
  }

  // Join code to uppercase
  if (out.action === 'join_tree' && out.code) {
    out.code = String(out.code).toUpperCase().trim();
  }

  // Handle add_person
  if (out.action === 'add_person') {
    // If model gave us a single 'name', split it
    if (!out.firstName && out.name) {
      const full = titleCase(String(out.name));
      const parts = full.split(/\s+/);
      out.firstName = parts.shift();
      out.lastName = parts.length ? parts.join(' ') : null;
      delete out.name;
    }

    // Swap if firstName missing but lastName present
    if (!out.firstName && out.lastName) {
      const parts = String(out.lastName).split(/\s+/);
      out.firstName = titleCase(parts.shift());
      out.lastName = parts.length ? titleCase(parts.join(' ')) : null;
    }

    // Extract birthday from raw text if not parsed
    if (!out.birthday) {
      out.birthday = extractBirthdayFromText(raw);
    }

    // Normalize gender
    if (out.gender) {
      const g = String(out.gender).trim().toLowerCase();
      out.gender = g.startsWith('m') ? 'M' : g.startsWith('f') ? 'F' : null;
    }

    // Title case names
    if (out.firstName) out.firstName = titleCase(out.firstName);
    if (out.lastName) out.lastName = titleCase(out.lastName);
  }

  // Handle relate
  if (out.action === 'relate') {
    if (out.nameA) out.nameA = titleCase(out.nameA);
    if (out.nameB) out.nameB = titleCase(out.nameB);
    if (out.kind) out.kind = out.kind.toLowerCase();
  }

  // Handle edit_person
  if (out.action === 'edit_person') {
    if (out.oldName) out.oldName = titleCase(out.oldName);
    if (out.newName) out.newName = titleCase(out.newName);
    if (out.newGender) {
      const g = String(out.newGender).trim().toLowerCase();
      out.newGender = g.startsWith('m') ? 'M' : g.startsWith('f') ? 'F' : null;
    }
  }

  return out;
}

// ============================================================================
// DATE EXTRACTION
// ============================================================================

function extractBirthdayFromText(text) {
  const lower = text.toLowerCase();
  
  // Match "born in YYYY" or "born YYYY"
  const bornMatch = lower.match(/born\s+(?:in\s+)?(\d{4})/);
  if (bornMatch) return bornMatch[1];
  
  // Match standalone 4-digit year
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) return yearMatch[0];
  
  // Match decade: "1940s", "the forties"
  const decadeMatch = lower.match(/\b(19|20)(\d)0s?\b|the\s+(nineteen|twenty)\s*(ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)/);
  if (decadeMatch) {
    if (decadeMatch[1]) {
      return `${decadeMatch[1]}${decadeMatch[2]}0`;
    } else {
      const decadeWords = {
        'ten': '10', 'twenty': '20', 'thirty': '30', 'forty': '40',
        'fifty': '50', 'sixty': '60', 'seventy': '70', 'eighty': '80', 'ninety': '90'
      };
      const century = decadeMatch[3] === 'nineteen' ? '19' : '20';
      return `${century}${decadeWords[decadeMatch[4]]}`;
    }
  }
  
  // Match full dates and extract year
  const fullDateMatch = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (fullDateMatch) {
    let year = fullDateMatch[3];
    if (year.length === 2) {
      year = parseInt(year) > 30 ? `19${year}` : `20${year}`;
    }
    return year;
  }
  
  return null;
}

// ============================================================================
// UTILITIES
// ============================================================================

function titleCase(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// ============================================================================
// TREE CONTEXT FETCHER (called by webhook)
// ============================================================================

export async function getTreeContext(treeId, db) {
  if (!treeId) return null;
  
  try {
    const [tree, persons, relationships] = await Promise.all([
      db.getTreeById(treeId),
      db.listPersons(treeId),
      db.listRelationships(treeId)
    ]);

    return {
      tree_name: tree?.name,
      person_count: persons.length,
      persons: persons.map(p => ({
        id: p.id,
        name: `${p.data.first_name} ${p.data.last_name || ''}`.trim(),
        birthday: p.data.birthday,
        gender: p.data.gender
      })),
      relationship_count: relationships.length
    };
  } catch (err) {
    console.error('Error fetching tree context:', err);
    return null;
  }
}
