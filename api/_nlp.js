// api/_nlp.js
// Plain-English → structured intents.
// 1) Strong rule-based patterns for common phrases (no cost, no latency)
// 2) Optional OpenAI tool-calling fallback if OPENAI_API_KEY is present

import OpenAI from "openai";

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const tools = [
  {
    type: "function",
    function: {
      name: "set_intent",
      description: "Select the user intent and fill structured fields",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "HELP",
              "LEAVE",
              "NEW_TREE",
              "JOIN_TREE",
              "ADD_PERSON",
              "LINK_REL",
              "EDIT_PERSON",
              "VIEW_TREE",
              "VIEW_PERSON"
            ]
          },
          data: {
            type: "object",
            properties: {
              // NEW_TREE
              name: { type: "string" },

              // JOIN_TREE
              code: { type: "string" },

              // ADD_PERSON
              person_name: { type: "string" },
              dob: { type: "string", nullable: true },

              // LINK_REL
              a: { type: "string" },
              kind: { type: "string", enum: ["spouse_of", "partner_of", "parent_of"] },
              b: { type: "string" },

              // EDIT_PERSON
              target_name: { type: "string" },
              new_name: { type: "string", nullable: true },
              new_dob: { type: "string", nullable: true },

              // VIEW_PERSON
              view_name: { type: "string" }
            },
            additionalProperties: false
          }
        },
        required: ["type", "data"],
        additionalProperties: false
      }
    }
  }
];

function norm(s) {
  return (s || "").trim().replace(/\s+/g, " ");
}

function matchJoinCode(s) {
  // “join ABC123”, “join code ABC123”, “my code is ABC123”
  let m = s.match(/(?:^|\b)join(?:\s+code)?\s+([A-Z0-9]{6})(?:\b|$)/i);
  if (m) return m[1].toUpperCase();
  m = s.match(/(?:^|\b)code\s+is\s+([A-Z0-9]{6})(?:\b|$)/i);
  if (m) return m[1].toUpperCase();
  return null;
}

function matchNewTree(s) {
  // “start a new tree called Kintu Family”
  // “create a tree named Kintu Family”
  // “start new tree Kintu Family”
  const patterns = [
    /start(?:\s+a)?\s+new\s+tree\s+(?:called|named)\s+(.+)$/i,
    /create(?:\s+a)?\s+new?\s*tree\s+(?:called|named)\s+(.+)$/i,
    /start(?:\s+a)?\s+new\s+tree\s+(.+)$/i,
    /create(?:\s+a)?\s+tree\s+(.+)$/i,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1].trim().slice(0, 80);
  }
  return null;
}

function matchViewTree(s) {
  // “show the tree”, “view tree”, “show my family tree”
  return /(show|view)\s+(the\s+)?(family\s+)?tree\b/i.test(s);
}

function matchViewPerson(s) {
  // “show alice”, “view john kintu”
  const m = s.match(/(?:^|\b)(show|view)\s+(.+)$/i);
  if (m) {
    const name = m[2].trim();
    if (!/tree\b/i.test(name)) return name; // avoid catching "show the tree"
  }
  return null;
}

function normalizeRelWord(w) {
  if (!w) return null;
  const a = w.toLowerCase();
  if (a.includes("married")) return "spouse_of";
  if (a.includes("spouse")) return "spouse_of";
  if (a.includes("partner")) return "partner_of";
  if (a.includes("parent")) return "parent_of";
  return null;
}

function matchLink(s) {
  // “link alice spouse bob”, “link alice married to bob”, “link jane parent of john”
  let m = s.match(/^link:\s*(.+)$/i);
  if (m) s = m[1]; // allow optional "link:" prefix for compatibility

  // capture: A <relword> B
  // where relword can be “spouse”, “partner”, “married to”, “parent of / parent_of”
  const rel = s.match(/^(.+?)\s+(spouse|partner|married to|parent(?:[_\s]+of))\s+(.+)$/i);
  if (!rel) return null;

  const a = rel[1].trim();
  const relWord = normalizeRelWord(rel[2]);
  const b = rel[3].trim();
  if (!relWord) return null;
  return { a, kind: relWord, b };
}

function matchAddPerson(s) {
  // “add alice born 1950”, “add my grandma alice born in 1950”, “please add alice (1950)”
  // Also accept “add: alice, b. 1950”
  let m = s.match(/^add:\s*(.+)$/i);
  if (m) {
    const rest = m[1].trim();
    const [namePart, maybeDob] = rest.split(",").map(t => t.trim());
    return { person_name: namePart, dob: maybeDob?.replace(/^b\.\s*/i, "") || null };
  }
  m = s.match(/(?:^|\b)add(?:\s+(?:my|our|a|the))?\s+(.+?)\s+(?:born\s+(?:in\s+)?)?(\d{3,4}|\d{1,2}\s+\w+\s+\d{4})$/i);
  if (m) return { person_name: m[1].trim(), dob: m[2].trim() };
  m = s.match(/(?:^|\b)add\s+(.+)$/i);
  if (m) return { person_name: m[1].trim(), dob: null };
  return null;
}

function matchEdit(s) {
  // “change alice to alice n.”, “rename alice to alice namutebi”
  let m = s.match(/(?:^|\b)(change|rename)\s+(.+?)\s+to\s+(.+)$/i);
  if (m) return { target_name: m[2].trim(), new_name: m[3].trim(), new_dob: null };

  // “set alice birth year to 1950”, “update alice b. 1950”
  m = s.match(/(?:^|\b)(set|update)\s+(.+?)\s+(?:birth\s+(?:year|date)|b\.)\s+(?:to\s+)?(.+)$/i);
  if (m) return { target_name: m[2].trim(), new_name: null, new_dob: m[3].trim() };

  // compat: “EDIT: Alice, b. 1950”
  m = s.match(/^edit:\s*(.+?),\s*b\.\s*(.+)$/i);
  if (m) return { target_name: m[1].trim(), new_name: null, new_dob: m[2].trim() };

  // compat: “EDIT: Old -> New”
  m = s.match(/^edit:\s*(.+?)\s*->\s*(.+)$/i);
  if (m) return { target_name: m[1].trim(), new_name: m[2].trim(), new_dob: null };

  return null;
}

export async function parseIntent(input) {
  const s = norm(input);
  if (!s) return null;

  // Zero-cost routes first
  if (/^help$/i.test(s)) return { type: "HELP", data: {} };
  if (/^leave$/i.test(s) || /leave\s+tree/i.test(s)) return { type: "LEAVE", data: {} };

  const code = matchJoinCode(s);
  if (code) return { type: "JOIN_TREE", data: { code } };

  const newName = matchNewTree(s);
  if (newName) return { type: "NEW_TREE", data: { name: newName } };

  if (matchViewTree(s)) return { type: "VIEW_TREE", data: {} };

  const viewName = matchViewPerson(s);
  if (viewName) return { type: "VIEW_PERSON", data: { view_name: viewName } };

  const link = matchLink(s);
  if (link) return { type: "LINK_REL", data: link };

  const add = matchAddPerson(s);
  if (add) return { type: "ADD_PERSON", data: add };

  const edit = matchEdit(s);
  if (edit) return { type: "EDIT_PERSON", data: edit };

  // If no rule matched and no key -> give up
  if (!client) return null;

  // OpenAI fallback
  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Extract ONE intent from the message and call set_intent. " +
            "Normalize relationships: 'married to' -> spouse_of; 'partner' -> partner_of; 'parent of' -> parent_of."
        },
        { role: "user", content: s }
      ],
      tools,
      tool_choice: { type: "function", function: { name: "set_intent" } }
    });

    const call = resp.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return null;
    const args = JSON.parse(call.function.arguments || "{}");
    if (!args?.type || !args?.data) return null;

    // Basic sanity checks
    if (args.type === "JOIN_TREE" && !/^[A-Z0-9]{6}$/i.test(args.data.code || "")) return null;
    if (args.type === "VIEW_PERSON" && !args.data.view_name) return null;
    if (args.type === "ADD_PERSON" && !args.data.person_name) return null;

    return args;
  } catch (e) {
    console.error("parseIntent error:", e);
    return null;
  }
}
