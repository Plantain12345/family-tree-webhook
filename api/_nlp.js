// api/_nlp.js
import OpenAI from "openai";
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

/**
 * Tool schema your webhook expects
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
                  "add_child","rename","set_dob","divorce",
                  "view_tree","view_person","leave"
                ]},
                name: { type: "string" },                   // new_tree / view_person
                code: { type: "string" },                   // join_tree
                a: { type: "string" }, b: { type: "string" }, // link/divorce
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
You are a controller that compiles natural-language family statements into *primitive graph ops*.

PRIMITIVE EDGES (the only stored relationships):
- spouse_of  (undirected; we store one normalized edge)
- parent_of  (directed A -> B)

Everything else (grandparent, sibling, cousin, in-law, etc.) is *derived* from those primitives at query time.
Do NOT emit other edge kinds. Convert language into these primitives or ask for missing names.

You are given CONTEXT:
- active_tree_name: string | null
- last_person_name: string | null    // last focused person in chat
- people: string[]                   // known names in active tree
- relationships: {a:string,b:string,kind:string}[] // may be partial

CRITICAL:
- Output exactly one tool call to set_ops with concrete names (no pronouns like "his/her/their/my/our/I").
- If the user uses a pronoun and a subject isn’t obvious, default to last_person_name.
- Prefer existing names from people[] when resolving (case-insensitive match).
- Never invent birthdates. Include dob only if provided by the user.

MAPPINGS (examples -> ops):
- "Create a family tree called Kintu" -> [{op:"new_tree", name:"Kintu"}]
- "Join code ABC123" -> [{op:"join_tree", code:"ABC123"}]
- "Show the tree" -> [{op:"view_tree"}]
- "Show Alice" -> [{op:"view_person", name:"Alice"}]
- "Leave tree" -> [{op:"leave"}]

Marriage / partnership:
- "X is married to Y", "Link X and Y", "Make X Y's wife/husband", "X is Y's spouse"
  -> [{op:"link", a:"X", kind:"spouse_of", b:"Y"}]
- "X is Y's partner"
  -> [{op:"link", a:"X", kind:"partner_of", b:"Y"}]

Parent/child (single edge):
- "X is Y's father/mother/parent"
  -> [{op:"link", a:"X", kind:"parent_of", b:"Y"}]
- "Add Y, child of X", "Add Y who is X's daughter/son"
  -> produce add_child with parentA:X if a second parent is not named:
     [{op:"add_child", child:"Y", parentA:"X"}]

Two-parent child:
- "X and Y's daughter/son is Z", "Add Z, child of X and Y", "Add their son Z" (pronoun resolves to last_person_name if needed)
  -> [{op:"add_child", child:"Z", parentA:"X", parentB:"Y"}]

Grandparent language:
- "X is Y's grandmother/grandfather/grandparent"
  -> You may need the middle parent name. If it's not provided and cannot be safely inferred, return [{op:"help"}].

Cousins / aunts / uncles / siblings:
- Do NOT output a custom relation. Either:
  1) Ask for missing parent names via [{op:"help"}], or
  2) If the message *already* gives parents, compile those parents to parent_of edges via add_child/link.
  Example: "Z is John's cousin; Z's parents are A and B; John's parents are C and D"
   -> parent_of edges via add_child for Z (A,B) and John (C,D). No cousin edge.

Renames & DOB:
- "Rename A to B" / "Change A to B" -> [{op:"rename", from:"A", to:"B"}]
- "Set A's birth year to 1950" / "A born 1950" / "Add A born 1950" 
   -> If adding: [{op:"add_person", name:"A", dob:"1950"}]
   -> If setting: [{op:"set_dob", name:"A", dob:"1950"}]

Pronouns:
- If a message says "Add his daughter Z born 1983" and last_person_name = "John"
  -> [{op:"add_child", child:"Z", dob:"1983", parentA:"John"}]
- If last_person_name is null and the subject is ambiguous, return [{op:"help"}].

Validation:
- Always return a concise set of ops. Never include pronouns in any name fields. Use people[] to resolve capitalization.
`;

function titleCaseFromKnown(name, people) {
  if (!name) return name;
  const n = name.trim().toLowerCase();
  const hit = (people||[]).find(p => p.trim().toLowerCase() === n);
  return hit || name.trim();
}

function fallback(text, ctx) {
  // A pragmatic regex fallback that covers the common stuff if the API key is missing.
  const ops = [];
  const t = text.trim();

  // new/join/view/help basics
  const mNew = t.match(/^(?:new|create)(?:\s+(?:a\s+)?(?:family\s+)?tree)?\s+(?:called\s+)?(.+)$/i);
  if (/^help$/i.test(t)) ops.push({ op: "help" });
  if (mNew) ops.push({ op: "new_tree", name: mNew[1].trim() });
  const mJoin = t.match(/^join\s+([A-Z0-9]{6})$/i);
  if (mJoin) ops.push({ op: "join_tree", code: mJoin[1].toUpperCase() });
  if (/^show\s+the\s+tree$/i.test(t)) ops.push({ op: "view_tree" });
  const mView = t.match(/^show\s+(.+)$/i);
  if (mView && !/tree$/i.test(mView[1])) ops.push({ op: "view_person", name: mView[1].trim() });
  if (/^leave(?:\s+tree)?$/i.test(t)) ops.push({ op: "leave" });

  // add person with dob
  const mAddBorn = t.match(/^add\s+([^,]+?)[,]?\s+(?:born|b\.)\s+([0-9]{3,4}|[0-9]{1,2}\s+\w+\s+\d{4})$/i);
  if (mAddBorn) ops.push({ op: "add_person", name: mAddBorn[1].trim(), dob: mAddBorn[2].trim() });

  // married / spouse / link A and B
  const mMarried = t.match(/^(.+?)\s+is\s+married\s+to\s+(.+)$/i);
  if (mMarried) ops.push({ op: "link", a: mMarried[1].trim(), kind: "spouse_of", b: mMarried[2].trim() });
  const mLinkAnd = t.match(/^link\s+(.+?)\s+and\s+(.+)$/i);
  if (mLinkAnd) ops.push({ op: "link", a: mLinkAnd[1].trim(), kind: "spouse_of", b: mLinkAnd[2].trim() });

  // parent_of: "X is Y's father/mother/parent"
  const mParent = t.match(/^(.+?)\s+is\s+(.+?)['’]s\s+(father|mother|parent)$/i);
  if (mParent) ops.push({ op: "link", a: mParent[1].trim(), kind: "parent_of", b: mParent[2].trim() });

  // add_child: "X and Y's daughter/son is Z"
  const mChildOfTwo = t.match(/^(.+?)\s+and\s+(.+?)['’]s\s+(daughter|son|child)\s+(?:is\s+)?(.+)$/i);
  if (mChildOfTwo) {
    const child = mChildOfTwo[4].trim();
    ops.push({ op: "add_child", child, parentA: mChildOfTwo[1].trim(), parentB: mChildOfTwo[2].trim() });
  }

  // add_child with pronoun: "Add his/her/their son/daughter Z born 1983"
  const mPronChild = t.match(/^add\s+(?:his|her|their)\s+(son|daughter|child)\s+([^,]+?)(?:[,]\s*(?:born|b\.)\s+(.+))?$/i);
  if (mPronChild && ctx?.last_person_name) {
    const child = mPronChild[2].trim();
    const dob = (mPronChild[3] || "").trim() || null;
    ops.push({ op: "add_child", child, dob: dob || null, parentA: ctx.last_person_name });
  }

  // set dob: "Set Alice's birth year to 1950"
  const mDob = t.match(/^set\s+(.+?)['’]s\s+(?:birth(?:\s+year)?)\s+to\s+(.+)$/i);
  if (mDob) ops.push({ op: "set_dob", name: mDob[1].trim(), dob: mDob[2].trim() });

  // rename
  const mRename = t.match(/^(?:rename|change)\s+(.+?)\s+to\s+(.+)$/i);
  if (mRename) ops.push({ op: "rename", from: mRename[1].trim(), to: mRename[2].trim() });

  return ops.length ? ops : null;
}

/**
 * parseOps(text, ctx)
 * ctx = { active_tree_name, last_person_name, people, relationships }
 */
export async function parseOps(input, ctx = {}) {
  const text = (input || "").trim();
  if (!text) return null;

  if (!client) return fallback(text, ctx);

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
    let ops = Array.isArray(args.ops) ? args.ops : [];

    // Normalize capitalization against known people (helps “john” -> “John”)
    if (ctx?.people?.length) {
      ops = ops.map(op => {
        if (op.name) op.name = titleCaseFromKnown(op.name, ctx.people);
        if (op.a)    op.a    = titleCaseFromKnown(op.a, ctx.people);
        if (op.b)    op.b    = titleCaseFromKnown(op.b, ctx.people);
        if (op.child) op.child = titleCaseFromKnown(op.child, ctx.people);
        if (op.from) op.from = titleCaseFromKnown(op.from, ctx.people);
        if (op.to)   op.to   = titleCaseFromKnown(op.to, ctx.people);
        if (op.parentA) op.parentA = titleCaseFromKnown(op.parentA, ctx.people);
        if (op.parentB) op.parentB = titleCaseFromKnown(op.parentB, ctx.people);
        return op;
      });
    }
    return ops;
  } catch (e) {
    console.error("parseOps error:", e);
    return fallback(text, ctx); // graceful degradation
  }
}
