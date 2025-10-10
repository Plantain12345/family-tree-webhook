// api/_nlp.js
// Uses OpenAI to parse free text into structured actions for the webhook.
// Falls back to a conservative regex parser if the API is unavailable.

import OpenAI from "openai";

const OPENAI_ENABLED = !!process.env.OPENAI_API_KEY;
const client = OPENAI_ENABLED ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ---- Supported actions returned by parseOps(text):
// { action: "help" }
// { action: "create_tree", name }
// { action: "join_tree", code }
// { action: "add_person", firstName, lastName?, gender?, birthday? }
// { action: "set_gender", name, gender } // gender in: "male"|"female"
// { action: "relate", kind, nameA, nameB } // kind in: "father"|"mother"|"parent"|"spouse"|"child"|"daughter"|"son"
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
          properties: {
            action: {
              type: "string",
              description: "The primary action the user wants to take.",
              enum: [
                "help",
                "create_tree",
                "add_person",
                "set_gender",
                "relate",
                "unknown",
              ],
            },
            treeName: {
              type: "string",
              description: "The name for a new family tree. e.g., 'The Smith Family'",
            },
            firstName: {
              type: "string",
              description: "The first name of a person.",
            },
            lastName: {
              type: "string",
              description: "The last name of a person.",
            },
            birthday: {
              type: "string",
              description: "The birth date or year of a person, formatted as YYYY-MM-DD or YYYY.",
            },
            gender: {
              type: "string",
              description: "The gender of the person.",
              enum: ["M", "F"],
            },
            kind: {
              type: "string",
              description: "The type of relationship between two people.",
              enum: ["father", "mother", "parent", "spouse", "child", "son", "daughter"],
            },
            nameA: {
              type: "string",
              description: "The name of the first person in a relationship.",
            },
            nameB: {
              type: "string",
              description: "The name of the second person in a relationship.",
            },
          },
          required: ["action"],
        },
        strict: true,
      };

      const sys = [
        "You are a parser for a WhatsApp family-tree bot.",
        "Return STRICT JSON ONLY that matches the JSON schema.",
        "Analyze the user's message to extract entities for the family tree.",
        "If a field is not present, omit it. Do not invent data.",
        "For 'add_person', extract first_name, last_name, gender, and birthday if available.",
        "For 'relate', `nameA` is the subject and `nameB` is the object. E.g., for 'John is Mary's father', nameA is 'John' and nameB is 'Mary'.",
        "Normalize names to Title Case.",
        "If the user says 'John and Mary are married', the action is 'relate', kind is 'spouse', nameA is 'John', nameB is 'Mary'."
      ].join(" ");

      const user = `Parse this message: "${raw}"`;

      const resp = await client.responses.create({
        model: "gpt-4o-mini",
        temperature: 0,
        // ⬇️ FIXED: Added 'name' and passed 'schema.schema' to the 'json_schema' property.
        text: {
          format: {
            type: "json_schema",
            name: schemaDefinition.name,
            json_schema: schemaDefinition.schema,
          },
        },
        input: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      });
      
      const parsed = resp.output_parsed ?? (resp.output_text ? JSON.parse(resp.output_text) : null);

      if (!parsed || typeof parsed !== "object" || !parsed.action) {
        console.warn("OpenAI parsing failed or returned invalid structure, falling back to regex.");
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

// A simple regex fallback for when the OpenAI API is not available or fails.
function regexFallback(text) {
  const msg = text.trim().toLowerCase();

  if (/^(help|menu|commands)/i.test(msg)) return { action: "help" };

  let m = msg.match(/^create tree called (.+)$/i);
  if (m) return { action: "create_tree", treeName: titleCase(m[1]) };

  m = msg.match(/^add ([a-z\s.'-]+?)(?: born (\d{4}))?$/i);
  if (m) {
    const names = titleCase(m[1]).split(" ");
    const firstName = names.shift();
    const lastName = names.join(" ");
    return {
      action: "add_person",
      firstName: firstName,
      lastName: lastName || null,
      birthday: m[2] || null,
    };
  }

  m = msg.match(/^(.+?)\s+is\s+(.+?)'s\s+(father|mother|son|daughter|child)$/i);
  if (m) {
    return {
      action: "relate",
      kind: m[3].toLowerCase(),
      nameA: titleCase(m[1]),
      nameB: titleCase(m[2]),
    };
  }

  m = msg.match(/^(.+?)\s+and\s+(.+?)\s+are\s+(?:married|spouses)$/i);
  if (m) {
    return {
      action: "relate",
      kind: "spouse",
      nameA: titleCase(m[1]),
      nameB: titleCase(m[2]),
    };
  }

  return { action: "unknown" };
}

function titleCase(s) {
  return s
    .split(/\s+/)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
    .join(" ");
}
