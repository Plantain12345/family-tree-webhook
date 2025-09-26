// api/_nlp.js
// Turns plain English into a structured "intent" for your bot.
// Uses OpenAI function (tool) calling. Falls back to null if no API key.

import OpenAI from "openai";

// Single client reused by serverless runtime
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
console.log("OPENAI key present?", !!process.env.OPENAI_API_KEY);

// Define ONE tool the model can "call" with a strict schema
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
            description: "One of the supported intents",
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
            description: "Intent-specific fields",
            properties: {
              // NEW_TREE
              name: { type: "string", description: "Tree name" },

              // JOIN_TREE
              code: { type: "string", description: "6-char join code" },

              // ADD_PERSON
              person_name: { type: "string" },
              dob: { type: "string", description: "DOB/DOB year e.g. '1950' or '3 Mar 1950'", nullable: true },

              // LINK_REL
              a: { type: "string", description: "Left person" },
              kind: {
                type: "string",
                enum: ["spouse_of", "partner_of", "parent_of"],
                description: "Relationship kind"
              },
              b: { type: "string", description: "Right person" },

              // EDIT_PERSON
              target_name: { type: "string", description: "Person to edit" },
              new_name: { type: "string", nullable: true },
              new_dob: { type: "string", nullable: true },

              // VIEW_PERSON
              view_name: { type: "string", description: "Name to view" }
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

/**
 * parseIntent("please add my grandma Alice born 1950")
 *  -> { type: "ADD_PERSON", data: { person_name: "Alice", dob: "1950" } }
 * Returns null if low confidence or no match.
 */
export async function parseIntent(input) {
  const text = (input || "").trim();
  if (!text) return null;

  // Fast path: simple rules (no LLM call cost)
  if (/^help$/i.test(text)) return { type: "HELP", data: {} };
  if (/^leave$/i.test(text)) return { type: "LEAVE", data: {} };
  const mJoin = text.match(/^join\s+([A-Z0-9]{6})$/i);
  if (mJoin) return { type: "JOIN_TREE", data: { code: mJoin[1].toUpperCase() } };
  const mNew = text.match(/^new\s+(.+)$/i);
  if (mNew) return { type: "NEW_TREE", data: { name: mNew[1].trim().slice(0, 80) } };

  // If there is no OpenAI key, skip gracefully
  if (!client) return null;

  // Call the model with tool-calling
  // Model choice: gpt-4o-mini (fast & low-cost, supports tool calling). :contentReference[oaicite:1]{index=1}
  const messages = [
    {
      role: "system",
      content:
        "You are a parser. Extract ONE intent from the user message and call set_intent with fields. " +
        "Normalize relationship words: 'married to' -> spouse_of, 'partner' -> partner_of, 'parent of' -> parent_of. " +
        "If the user wants to view a name like 'show Alice', use VIEW_PERSON with view_name='Alice'. " +
        "If unsure, do not guess—still call set_intent with the closest intent and as many fields as possible."
    },
    { role: "user", content: text }
  ];

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
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

    return args; // {type, data:{…}}
  } catch (e) {
    console.error("parseIntent error:", e);
    return null;
  }
}
