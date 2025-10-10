// api/_nlp.js
// Uses OpenAI to parse free text into structured actions for the webhook.
// Stays on the LLM path but includes light post-processing to handle messy inputs.

import OpenAI from "openai";

const OPENAI_ENABLED = !!process.env.OPENAI_API_KEY;
const client = OPENAI_ENABLED ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ---- Supported actions returned by parseOps(text):
// { action: "help" }
// { action: "create_tree", treeName }
// { action: "join_tree", code }
// { action: "add_person", firstName, lastName?, gender?, birthday? }   // birthday: "YYYY" or "YYYY-MM-DD"
// { action: "set_gender", name, gender }                               // gender: "M" | "F"
// { action: "relate", kind, nameA, nameB }                             // kind: "father"|"mother"|"parent"|"spouse"|"child"|"son"|"daughter"
// { action: "unknown" }

export async function parseOps(text) {
  const raw = (text ?? "").trim();
  if (!raw) return { action: "unknown" };

  if (OPENAI_ENABLED) {
    try {
      // JSON Schema the model must follow
      const schemaDefinition = {
        name: "TreeBotCommand",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              enum: ["help", "create_tree", "join_tree", "add_person", "set_gender", "relate", "unknown"]
            },
            treeName: { type: "string" },
            code: { type: "string" },
            firstName: { type: "string" },
            lastName: { type: ["string", "null"] },
            birthday: { type: ["string", "null"] }, // "YYYY" or "YYYY-MM-DD"
            gender: { type: ["string", "null"], enum: ["M", "F", null] },
            kind: { type: "string", enum: ["father", "mother", "parent", "spouse", "child", "son", "daughter"] },
            nameA: { type: "string" },
            nameB: { type: "string" }
          },
          required: ["action"]
        },
        strict: true
      };

      // System prompt with *concrete* mapping rules + few-shot coverage
      const sys = [
        "You are a deterministic parser for a WhatsApp family-tree bot. Output STRICT JSON only, matching the schema.",
        "Rules:",
        "- Never invent data. Omit fields that are not present.",
        "- Names must be Title Case.",
        "- For 'add_person': extract firstName, lastName (optional), birthday (YYYY or YYYY-MM-DD), gender ('M'|'F') if explicitly stated.",
        "- For 'relate': nameA is the SUBJECT, nameB is the OBJECT. Example: 'John is Mary's father' => kind='father', nameA='John', nameB='Mary'.",
        "- For 'join_tree': return uppercase code.",
        "",
        "Examples (exact JSON):",
        '{"action":"add_person","firstName":"Grace","lastName":null,"birthday":"1952"}',
        '{"action":"add_person","firstName":"John","lastName":"Smith","birthday":"1980"}',
        '{"action":"relate","kind":"spouse","nameA":"John","nameB":"Mary"}',
        '{"action":"create_tree","treeName":"The Smith Family"}',
        '{"action":"join_tree","code":"AB12CD"}',
        '{"action":"set_gender","name":"Mary Nankya","gender":"F"}',
        '{"action":"help"}'
      ].join(" ");

      // User turn includes a nudge that covers "born in 1952" explicitly
      const user = [
        `Message: "${raw}"`,
        "If the user writes 'Add Grace, born in 1952' then parse as:",
        '{"action":"add_person","firstName":"Grace","lastName":null,"birthday":"1952"}',
        "If they write 'Add Grace born 1952' or 'Add Grace (1952)', treat equivalently.",
        "Do not include extra fields not in the schema."
      ].join("\n");

      const resp = await client.responses.create({
        model: "gpt-4o-mini",
        temperature: 0,
        text: {
          format: {
            type: "json_schema",
            name: schemaDefinition.name,
            schema: schemaDefinition.schema,
            strict: schemaDefinition.strict
          }
        },
        input: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      });

      // Prefer parsed; fallback to text parse if needed
      let parsed = resp.output_parsed ?? (resp.output_text ? JSON.parse(resp.output_text) : null);

      // If the model failed or gave action missing, return unknown
      if (!parsed || typeof parsed !== "object" || !parsed.action) {
        return { action: "unknown" };
      }

      // ---------- LIGHT COERCION / NORMALIZATION ----------
      parsed = normalizeOperation(raw, parsed);

      return parsed;

    } catch (err) {
      console.error("OpenAI parse error; using LLM-safe unknown:", err?.message || err);
      // Stay on LLM path: return unknown so your handler can reply helpfully
      return { action: "unknown" };
    }
  }

  // If no key, keep behavior graceful
  return { action: "unknown" };
}

// ---- Post-processing to make the LLM output robust without full regex fallback ----
function normalizeOperation(raw, op) {
  const out = { ...op };

  // Normalize action casing
  if (typeof out.action === "string") {
    out.action = out.action.toLowerCase();
  }

  // Coerce join code to uppercase
  if (out.action === "join_tree" && out.code) {
    out.code = String(out.code).toUpperCase().trim();
  }

  // If model returned a single 'name' somewhere, split it into firstName/lastName when needed
  if (out.action === "add_person") {
    // Ensure firstName/lastName present; if model produced a 'name', split it.
    if (!out.firstName && out.name) {
      const full = titleCase(String(out.name));
      const parts = full.split(/\s+/);
      out.firstName = parts.shift();
      out.lastName = parts.length ? parts.join(" ") : null;
      delete out.name;
    }

    // If still missing firstName but we do have lastName, swap (rare but safer than failing)
    if (!out.firstName && out.lastName) {
      const parts = String(out.lastName).split(/\s+/);
      out.firstName = titleCase(parts.shift());
      out.lastName = parts.length ? titleCase(parts.join(" ")) : null;
    }

    // Birthday coercion: accept 'born in 1952', '1952', '1980-05-20'
    if (!out.birthday) {
      const m = String(raw).match(/\b(born\s+(?:in\s+)?)?(\d{4})(?:-(\d{2})-(\d{2}))?\b/i);
      if (m) {
        out.birthday = m[3] && m[4] ? `${m[2]}-${m[3]}-${m[4]}` : m[2];
      }
    }

    // Gender normalization: accept words and map to 'M'|'F'
    if (out.gender) {
      const g = String(out.gender).trim().toLowerCase();
      out.gender = g.startsWith("m") ? "M" : g.startsWith("f") ? "F" : null;
    }
  }

  // For relationships, be strict about direction (subject/object)
  if (out.action === "relate") {
    if (out.nameA) out.nameA = titleCase(out.nameA);
    if (out.nameB) out.nameB = titleCase(out.nameB);
    if (out.kind) out.kind = out.kind.toLowerCase();
  }

  return out;
}

function titleCase(s) {
  return String(s)
    .trim()
    .split(/\s+/)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
    .join(" ");
}
