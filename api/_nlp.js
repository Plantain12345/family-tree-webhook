// api/_nlp.js
import OpenAI from "openai";
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

/**
 * Tool schema unchanged (your webhook already speaks this dialect)
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
                op: { type: "string", enum: [
                  "help","new_tree","join_tree","add_person","link",
                  "add_child","rename","set_dob","divorce","view_tree","view_person","leave"
                ]},
                name: { type: "string" },                    // for new_tree / view_person
                code: { type: "string" },                    // for join_tree
                a: { type: "string" }, b: { type: "string" },// for link/divorce
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
You are a *controller* that converts natural-language messages about a family tree into a small list of operations.

You receive CONTEXT with:
- active_tree_name (string or null)
- last_person_name (string or null) — the last person the user mentioned/asked about
- people[] — list of known person names in the active tree (strings)
- relationships[] — list of {a, b, kind} edges for the active tree

CRITICAL RULES
- Your output must be a single tool call to set_ops with concrete, fully-resolved names. 
  NEVER leave pronouns ("his", "her", "their", "my", "our", "me", "I", etc.) in any name field.
- If the user uses pronouns like "his/her/their", default to last_person_name unless the message clearly names a different subject.
- Prefer existing names from people[]; if a new person is introduced, use exactly the name from the message.
- Never invent DOBs. If a year/date is not given, omit dob.

MAPPING
- "married to" / wife / husband / spouse -> link { kind: "spouse_of" }
- "partner" -> link { kind: "partner_of" }
- "X and Y's daughter/son Z" -> add_child { child: Z, parentA: X, parentB: Y }
- "Add his/her/their son/daughter Z born 1983" -> add_child with parentA resolved to last_person_name
- "rename A to B" or "change A to B" -> rename
- "set A's birth year to 1950" -> set_dob { name: A, dob: "1950" }
- "create a new tree NAME" -> new_tree
- "join code ABC123" -> join_tree
- "leave tree" -> leave
- "show the tree" -> view_tree
- "show Alice" -> view_person { name: "Alice" }

AMBIGUITY
- If pronouns are used but last_person_name is null and no subject is otherwise obvious, prefer returning a single help op:
  [{ "op": "help" }]  (the app will respond with guidance).
- Otherwise, resolve to concrete names using the best available context.
`;

function basicFallback(text) {
  // Minimal regex fallback when OPENAI_API_KEY is missing
  const ops = [];
  if (/^help$/i.test(text)) ops.push({ op: "help" });
  const mNew = text.match(/^(?:new|create)(?:\s+(?:a\s+)?(?:family\s+)?tree)?\s+called\s+(.+)$/i);
  if (mNew) ops.push({ op: "new_tree", name: mNew[1].trim() });
  const mJoin = text.match(/^join\s+([A-Z0-9]{6})$/i);
  if (mJoin) ops.push({ op: "join_tree", code: mJoin[1].toUpperCase() });
  const mViewP = text.match(/^show\s+(.+)$/i);
  if (mViewP && !/tree$/i.test(mViewP[1])) ops.push({ op: "view_person", name: mViewP[1].trim() });
  if (/^show\s+the\s+tree$/i.test(text)) ops.push({ op: "view_tree" });
  return ops.length ? ops : null;
}

/**
 * parseOps(text, ctx)
 * ctx = { active_tree_name, last_person_name, people, relationships }
 */
export async function parseOps(input, ctx = {}) {
  const text = (input || "").trim();
  if (!text) return null;

  if (!client) return basicFallback(text);

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify({ message: text, context: ctx }) }
      ],
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
