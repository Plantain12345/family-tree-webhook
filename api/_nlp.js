// api/_nlp.js
import OpenAI from "openai";

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

/**
 * We want the model to return a batch of operations:
 * ops: [
 *   { op: "new_tree", name },
 *   { op: "join_tree", code },
 *   { op: "add_person", name, dob },                 // "Add Alice born 1950"
 *   { op: "link", a, kind, b },                      // kind: spouse_of|partner_of|parent_of
 *   { op: "add_child", child, dob, parentA, parentB },
 *   { op: "rename", from, to },                      // risky -> confirm
 *   { op: "set_dob", name, dob },
 *   { op: "divorce", a, b }                          // risky -> confirm
 * ]
 */
const tools = [
  {
    type: "function",
    function: {
      name: "set_ops",
      description: "Return a list of normalized operations extracted from the user's message.",
      parameters: {
        type: "object",
        properties: {
          ops: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: {
                  type: "string",
                  enum: [
                    "help","new_tree","join_tree","add_person","link","add_child","rename","set_dob","divorce","view_tree","view_person","leave"
                  ]
                },
                name: { type: "string" },           // for new_tree / view_person
                code: { type: "string" },           // for join_tree
                a: { type: "string" }, b: { type: "string" }, // for link/divorce
                kind: { type: "string", enum: ["spouse_of","partner_of","parent_of"] },
                child: { type: "string" },
                parentA: { type: "string" }, parentB: { type: "string", nullable: true },
                dob: { type: "string", nullable: true },
                from: { type: "string" }, to: { type: "string" }
              },
              required: ["op"],
              additionalProperties: false
            }
          }
        },
        required: ["ops"],
        additionalProperties: false
      }
    }
  }
];

const SYSTEM = `
You convert natural-language requests about a family tree into a short list of operations.

Guidelines:
- Normalize relationships:
  - "married to" -> spouse_of, "husband/wife/partner" -> spouse_of or partner_of,
  - "X and Y's daughter/son Z" -> add_child { child: Z, parentA: X, parentB: Y }
- If the user says "rename A to B" -> { op: "rename", from: A, to: B }
- "change A to B" is also rename.
- "set A's birth year to 1950" -> { op: "set_dob", name: A, dob: "1950" }
- If user requests a divorce/separation, return { op: "divorce", a, b }.
- "create a new tree NAME" -> { op: "new_tree", name: NAME }
- "join code ABC123" -> { op: "join_tree", code: "ABC123" }
- "leave tree" -> { op: "leave" }
- "show the tree" -> { op: "view_tree" }
- "show Alice" -> { op: "view_person", name: "Alice" }
- Prefer concrete names. Never invent DOBs. If info is missing, still return the op with fields you do have.
- Never treat leading verbs ("link", "rename", "create", "join", "change") as part of a person's name.
Return only a concise set of ops in tool calls.
`;

export async function parseOps(input) {
  const text = (input || "").trim();
  if (!text) return null;

  // fast path for no-key environment
  if (!client) {
    const ops = [];
    if (/^help$/i.test(text)) ops.push({ op: "help" });
    const mNew = text.match(/^new\s+(.+)$/i);
    if (mNew) ops.push({ op: "new_tree", name: mNew[1].trim() });
    const mJoin = text.match(/^join\s+([A-Z0-9]{6})$/i);
    if (mJoin) ops.push({ op: "join_tree", code: mJoin[1].toUpperCase() });
    const mViewP = text.match(/^view\s+(.+)$/i);
    if (mViewP && !/tree$/i.test(mViewP[1])) ops.push({ op: "view_person", name: mViewP[1].trim() });
    if (/^view\s+tree$/i.test(text)) ops.push({ op: "view_tree" });
    return ops.length ? ops : null;
  }

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }],
      tools,
      tool_choice: { type: "function", function: { name: "set_ops" } }
    });

    const call = resp.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return null;
    const args = JSON.parse(call.function.arguments || "{}");
    const ops = Array.isArray(args.ops) ? args.ops : [];
    return ops;
  } catch (e) {
    console.error("parseOps error:", e);
    return null;
  }
}
