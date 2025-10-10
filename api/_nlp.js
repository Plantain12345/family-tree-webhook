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
// { action: "add_person", full_name, birth_year? }
// { action: "set_gender", full_name, gender } // gender in: "male"|"female"|"unknown"
// { action: "relate", kind, nameA, nameB }    // kind in: "father"|"mother"|"parent"|"spouse"|"child"
// { action: "unknown" }

export async function parseOps(text) {
  const raw = (text ?? "").trim();
  if (!raw) return { action: "unknown" };

  // Try LLM first if available
  if (OPENAI_ENABLED) {
    try {
      const schema = {
        name: "TreeBotCommand",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              enum: [
                "help",
                "create_tree",
                "join_tree",
                "add_person",
                "set_gender",
                "relate",
                "unknown"
              ]
            },
            name: { type: "string" },         // for create_tree
            code: { type: "string" },         // for join_tree
            full_name: { type: "string" },    // for add_person/set_gender
            birth_year: { type: ["integer", "null"] },
            gender: { type: "string", enum: ["male", "female", "unknown"] },
            kind: { type: "string", enum: ["father", "mother", "parent", "spouse", "child"] },
            nameA: { type: "string" },        // for relate
            nameB: { type: "string" }
          },
          required: ["action"]
        },
        strict: true
      };

      const sys = [
        "You are a parser for a WhatsApp family-tree bot.",
        "Return STRICT JSON ONLY that matches the JSON schema.",
        "If a field is not present, omit it—do not invent.",
        "Infer gender only if explicitly stated.",
        "Valid examples:",
        '{"action":"create_tree","name":"Changolis"}',
        '{"action":"add_person","full_name":"Mary Nankya","birth_year":1980}',
        '{"action":"relate","kind":"mother","nameA":"Mary Nankya","nameB":"John Nankya"}',
        '{"action":"help"}'
      ].join(" ");

      const user = [
        "Message:", raw,
        "Normalize names to title case. For ambiguous years like 'born in the 80s', return null."
      ].join("\n");

      const resp = await client.responses.create({
        model: "gpt-4o-mini",
        temperature: 0,
        // ⬇️ New location for JSON schema formatting (Responses API):
        text: { format: { type: "json_schema", json_schema: schema } },
        input: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      });

      // Prefer parsed output when the SDK provides it; otherwise fall back to text/chunks.
      let parsed =
        resp.output_parsed
        ?? (resp.output_text ? JSON.parse(resp.output_text) : null);

      if (!parsed && resp.output && Array.isArray(resp.output)) {
        try {
          const chunk = resp.output[0]?.content?.find?.(c => c.type === "output_text");
          if (chunk?.text) parsed = JSON.parse(chunk.text);
        } catch {
          // ignore JSON errors; we'll fall back to regex below
        }
      }

      // Minimal sanity: if action missing, fall back
      if (!parsed || typeof parsed !== "object" || !parsed.action) {
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

// ------------------- Conservative regex fallback (previous behaviour-ish) -------------------

function regexFallback(text) {
  const msg = text.trim().toLowerCase();

  // help/menu
  if (/^(help|menu|what can you do|commands)/i.test(msg)) return { action: "help" };

  // create tree
  let m = msg.match(/^create\s+(?:a\s+)?tree\s+(?:called|named)\s+(.+)$/i);
  if (m) return { action: "create_tree", name: titleCase(m[1]) };

  // join tree
  m = msg.match(/^(?:join|switch|use)\s+(?:code\s+)?([A-Z0-9]{4,10})$/i);
  if (m) return { action: "join_tree", code: m[1].toUpperCase() };

  // add person (optional birth year)
  m = msg.match(/^(?:add|create)\s+([a-z\s.'-]+?)(?:,\s*born\s+(\d{4}))?$/i);
  if (m) {
    const full = titleCase(m[1]);
    const yr = m[2] ? parseInt(m[2], 10) : null;
    return { action: "add_person", full_name: full, birth_year: yr || null };
  }

  // set gender
  m = msg.match(/^set\s+gender\s+of\s+([a-z\s.'-]+)\s+to\s+(male|female)$/i);
  if (m) return { action: "set_gender", full_name: titleCase(m[1]), gender: m[2] };

  // relationships (X is Y's father/mother/parent/child) OR "make X the wife/husband/spouse of Y"
  m = msg.match(/^(.+?)\s+is\s+(.+?)'s\s+(father|mother|parent|child)$/i);
  if (m) {
    return { action: "relate", kind: m[3].toLowerCase(), nameA: titleCase(m[1]), nameB: titleCase(m[2]) };
  }
  m = msg.match(/^(?:make|set)\s+(.+?)\s+(?:the\s+)?(?:husband|wife|spouse)\s+of\s+(.+?)$/i);
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
