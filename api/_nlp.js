// api/_nlp.js
// Uses OpenAI to parse free text into structured actions for the webhook.
// Falls back to a conservative regex parser if the API is unavailable.

import OpenAI from "openai";

const OPENAI_ENABLED = !!process.env.OPENAI_API_KEY;
const client = OPENAI_ENABLED ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ---- Supported actions returned by parseOps(text):
// { action: "help" }
// { action: "create_tree", treeName }
// { action: "join_tree", code }
// { action: "add_person", firstName, lastName?, gender?, birthday? }
// { action: "set_gender", name, gender } // gender: "M" | "F"
// { action: "relate", kind, nameA, nameB } // kind: "father"|"mother"|"parent"|"spouse"|"child"|"daughter"|"son"
// { action: "unknown" }

export async function parseOps(text) {
  const raw = (text ?? "").trim();
  if (!raw) return { action: "unknown" };

  // Try LLM first if available
  if (OPENAI_ENABLED) {
    try {
      const schemaDefinition = {
        name: "TreeBotCommand",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              description: "The primary action the user wants to take.",
              enum: ["help", "create_tree", "join_tree", "add_person", "set_gender", "relate", "unknown"]
            },
            treeName: { type: "string", description: "Name for a new family tree." },
            code: { type: "string", description: "Join/switch code for a tree." },
            firstName: { type: "string" },
            lastName: { type: "string" },
            birthday: {
              type: ["string", "null"],
              description: "YYYY-MM-DD or YYYY."
            },
            gender: {
              type: ["string", "null"],
              enum: ["M", "F", null]
            },
            kind: {
              type: "string",
              enum: ["father", "mother", "parent", "spouse", "child", "son", "daughter"]
            },
            nameA: { type: "string" },
            nameB: { type: "string" }
          },
          required: ["action"]
        },
        strict: true
      };

      const sys = [
        "You are a parser for a WhatsApp family-tree bot.",
        "Return STRICT JSON ONLY that matches the JSON schema.",
        "If a field is not present, omit it. Do not invent data.",
        "Normalize names to Title Case.",
        "For 'add_person', extract firstName, lastName, gender ('M'|'F') and birthday (YYYY-MM-DD or YYYY) when present.",
        "For 'relate', nameA is the subject and nameB is the object, e.g., 'John is Mary's father' => nameA='John', nameB='Mary'.",
        "For 'create_tree', return treeName.",
        "For 'join_tree', return code (uppercase)."
      ].join(" ");

      const user = `Parse this message: "${raw}"`;

      const resp = await client.responses.create({
        model: "gpt-4o-mini",
        temperature: 0,
        text: {
          format: {
            type: "json_schema",
            name: schemaDefinition.name,
            schema: schemaDefinition.schema,   // <-- FIXED: must be `schema`, not `json_schema`
            strict: schemaDefinition.strict
          }
        },
        input: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      });

      // Prefer parsed output when the SDK provides it; otherwise try text.
      let parsed = resp.output_parsed
        ?? (resp.output_text ? JSON.parse(resp.output_text) : null);

      // Minimal sanity: if action missing, fall back
      if (!parsed || typeof parsed !== "object" || !parsed.action) {
        console.warn("OpenAI parsing returned no/invalid JSON; falling back to regex.");
        return regexFallback(raw);
      }
      return parsed;

    } catch (err) {
      console.error("OpenAI parse error; using regex fallback:", err?.message || err);
      return regexFallback(raw);
    }
  }

  // No key? Use fallback.
  return regexFallback(raw);
}

// ------------------- Conservative regex fallback -------------------

function regexFallback(text) {
  const msg = text.trim().toLowerCase();

  // help/menu
  if (/^(help|menu|commands|what can you do)/i.test(msg)) return { action: "help" };

  // create tree
  let m = msg.match(/^create\s+(?:a\s+)?tree\s+(?:called|named)\s+(.+)$/i);
  if (m) return { action: "create_tree", treeName: titleCase(m[1]) };

  // join tree (e.g., "use ABC123" or "join code ABC123")
  m = msg.match(/^(?:join|switch|use)\s+(?:code\s+)?([A-Z0-9]{4,10})$/i);
  if (m) return { action: "join_tree", code: m[1].toUpperCase() };

  // add person (optional birth year)
  m = msg.match(/^(?:add|create)\s+([a-z\s.'-]+?)(?:,\s*born\s+(\d{4}))?$/i);
  if (m) {
    const full = titleCase(m[1]);
    const parts = full.split(/\s+/);
    const firstName = parts.shift();
    const lastName = parts.join(" ") || null;
    return { action: "add_person", firstName, lastName, birthday: m[2] || null };
  }

  // set gender
  m = msg.match(/^set\s+gender\s+of\s+([a-z\s.'-]+)\s+to\s+(male|female)$/i);
  if (m) {
    const g = m[2].toLowerCase().startsWith("m") ? "M" : "F";
    return { action: "set_gender", name: titleCase(m[1]), gender: g };
  }

  // relationships (X is Y's father/mother/son/daughter/child)
  m = msg.match(/^(.+?)\s+is\s+(.+?)'s\s+(father|mother|son|daughter|child)$/i);
  if (m) {
    return { action: "relate", kind: m[3].toLowerCase(), nameA: titleCase(m[1]), nameB: titleCase(m[2]) };
  }

  // marriage
  m = msg.match(/^(.+?)\s+and\s+(.+?)\s+are\s+(?:married|spouses)$/i);
  if (m) {
    return { action: "relate", kind: "spouse", nameA: titleCase(m[1]), nameB: titleCase(m[2]) };
  }

  return { action: "unknown" };
}

function titleCase(s) {
  return s
    .split(/\s+/)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
    .join(" ");
}
