// api/_nlp.js
import OpenAI from "openai";

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * Tool schema (webhook expects this dialect)
 */
const tools = [
  {
    type: "function",
    function: {
      name: "set_ops",
      description:
        "Return a list of normalized operations extracted from the user's message. Names must be concrete (no pronouns).",
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
                    "help",
                    "new_tree",
                    "join_tree",
                    "add_person",
                    "link",
                    "add_child",
                    "rename",
                    "set_dob",
                    "divorce",
                    "view_tree",
                    "view_person",
                    "leave"
                  ]
                },
                name: { type: "string" }, // new_tree / view_person / add_person / set_dob
                code: { type: "string" }, // join_tree
                a: { type: "string" }, b: { type: "string" }, // link/divorce
                kind: {
                  type: "string",
                  enum: ["spouse_of", "partner_of", "parent_of"]
                },
                child: { type: "string" },
                parentA: { type: "string" },
                parentB: { type: "string", nullable: true },
                dob: { type: "string", nullable: true },
                from: { type: "string" },
                to: { type: "string" }
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
You are a controller that turns natural-language messages about a family tree into a SHORT list of operations.

You are given a JSON object as the user's message content with:
- "message": the user's text
- "context": {
    "active_tree_name": string|null,
    "last_person_name": string|null,
    "people": string[],            // known person names in active tree
    "relationships": {a:string,b:string,kind:string}[]
  }

CRITICAL RULES
- Output MUST be a single tool call to set_ops. Do not reply with text.
- In every op, all names must be CONCRETE and fully resolved. NEVER pass pronouns ("his", "her", "their", "my", "our", "me", "I") as names.
- If the user uses pronouns, default to context.last_person_name unless the message explicitly names a different subject.
- Prefer exact matches from context.people when referring to existing people.
- Do NOT invent DOBs or names not present in the user message (except resolving pronouns).
- Use the smallest number of ops that correctly capture the user's intent.

MAPPING
- "create a new tree NAME" or "Start a tree called NAME" -> {op:"new_tree", name:NAME}
- "join code ABC123" -> {op:"join_tree", code:"ABC123"}
- "show the tree" -> {op:"view_tree"}
- "show Alice" -> {op:"view_person", name:"Alice"}
- "add Alice (born|b.|born in) 1950" -> {op:"add_person", name:"Alice", dob:"1950"}
- "set Alice's birth (year) to 1950" -> {op:"set_dob", name:"Alice", dob:"1950"}
- "link A married to B" -> {op:"link", a:"A", kind:"spouse_of", b:"B"}
- "A is partner of B" -> {op:"link", a:"A", kind:"partner_of", b:"B"}
- "A is parent of B" -> {op:"link", a:"A", kind:"parent_of", b:"B"}
- "Add (his|her|their) son/daughter Z born 1983" -> {op:"add_child", child:"Z", dob:"1983", parentA: <resolved pronoun>, parentB:null}
- "X and Y's daughter/son Z (born 2010?)" -> {op:"add_child", child:"Z", dob:"2010?", parentA:"X", parentB:"Y"}
- "rename A to B" or "change A to B" -> {op:"rename", from:"A", to:"B"}
- "divorce A and B" / "separate A and B" -> {op:"divorce", a:"A", b:"B"}
- "leave tree" -> {op:"leave"}

AMBIGUITY
- If pronouns are used but context.last_person_name is null and subject cannot be inferred, return [{op:"help"}].
`;

function basicFallback(text, ctx) {
  // Minimal regex fallback when OPENAI_API_KEY is missing
  const ops = [];
  if (/^help$/i.test(text)) ops.push({ op: "help" });

  // new tree
  const mNew =
    text.match(/^(?:new|create)(?:\s+(?:a\s+)?(?:family\s+)?tree)?\s+called\s+(.+)$/i) ||
    text.match(/^start(?:\s+(?:a\s+)?(?:family\s+)?tree)?\s+called\s+(.+)$/i);
  if (mNew) ops.push({ op: "new_tree", name: mNew[1].trim() });

  // join
  const mJoin = text.match(/join\s+([A-Z0-9]{6})/i);
  if (mJoin) ops.push({ op: "join_tree", code: mJoin[1].toUpperCase() });

  // view
  const mViewP = text.match(/^(?:show|view)\s+(.+)$/i);
  if (mViewP && !/tree$/i.test(mViewP[1])) ops.push({ op: "view_person", name: mViewP[1].trim() });
  if (/^(?:show|view)\s+the\s+tree$/i.test(text)) ops.push({ op: "view_tree" });

  // simple "add X born 1950"
  const mAdd = text.match(/^add\s+(.+?)\s+(?:born\s+|b\.\s*)(\d{3,4})$/i);
  if (mAdd) ops.push({ op: "add_person", name: mAdd[1].trim(), dob: mAdd[2] });

  // Add his/her/their son|daughter Z born YYYY
  const mChildPron = text.match(/^add\s+(?:his|her|their)\s+(son|daughter)\s+(.+?)(?:\s+(?:born\s+|b\.\s*)(\d{3,4}))?$/i);
  if (mChildPron && ctx?.last_person_name) {
    ops.push({
      op: "add_child",
      child: mChildPron[2].trim(),
      dob: mChildPron[3] || null,
      parentA: ctx.last_person_name,
      parentB: null
    });
  }

  return ops.length ? ops : null;
}

/**
 * parseOps(text, ctx)
 * ctx = { active_tree_name, last_person_name, people, relationships }
 */
export async function parseOps(input, ctx = {}) {
  const text = (input || "").trim();
  if (!text) return null;

  if (!client) return basicFallback(text, ctx);

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
