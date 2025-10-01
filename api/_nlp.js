// api/_nlp.js
import OpenAI from "openai";

// Create client only if a key exists (lets you run locally without one)
const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * Tool schema the webhook expects.
 * We keep the set of primitive ops small and stable.
 */
const tools = [
  {
    type: "function",
    function: {
      name: "set_ops",
      description:
        "Return a list of normalized operations extracted from the user's message.",
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
                    "set_gender",
                    "divorce",
                    "view_tree",
                    "view_person",
                    "leave",
                  ],
                },
                // fields used by the ops
                name: { type: "string" }, // new_tree / view_person / add_person / set_dob / rename.from/.to
                code: { type: "string" }, // join_tree
                a: { type: "string" },
                b: { type: "string" },
                kind: {
                  type: "string",
                  enum: ["spouse_of", "partner_of", "parent_of"],
                },
                child: { type: "string" },
                parentA: { type: "string" },
                parentB: { type: "string", nullable: true },
                dob: { type: "string", nullable: true },
                from: { type: "string" },
                to: { type: "string" },
                gender: { type: "string" },
              },
              required: ["op"],
              additionalProperties: false,
            },
          },
        },
        required: ["ops"],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM = `
You are a controller that turns family-related natural language into a short list of primitive operations.

PRIMITIVE EDGES ONLY:
- spouse_of (undirected, normalized a<b)
- parent_of (directed A -> B)

All other kinship (grandparent, sibling, cousin, etc.) is *derived* later. Do not emit new edge kinds.

You receive CONTEXT with:
- active_tree_name (string|null)
- last_person_name (string|null)
- people[] (known names in the active tree)
- relationships[] (possibly partial list of {a,b,kind})

RULES
- Output exactly one tool call (set_ops) with fully resolved names (no pronouns like his/her/their/my/our/I).
- If a pronoun is used and the subject is not otherwise explicit, default to last_person_name.
- Prefer capitalization from people[] when resolving existing names (case-insensitive match).
- Never invent dates. If a dob is missing, omit it.
- For gender, use the normalized values male, female, nonbinary, or unknown unless the user specifies another explicit term.

MAPPING EXAMPLES (non-exhaustive)
- "Create a family tree called Kintu" -> [{op:"new_tree", name:"Kintu"}]
- "Join code ABC123" -> [{op:"join_tree", code:"ABC123"}]
- "Show the tree" -> [{op:"view_tree"}]
- "Show Alice" -> [{op:"view_person", name:"Alice"}]
- "Leave tree" -> [{op:"leave"}]

Marriage/Partnership:
- "X is married to Y", "Link X and Y", "Make X Y's husband/wife", "X is Y's spouse"
  -> [{op:"link", a:"X", kind:"spouse_of", b:"Y"}]
- "X is Y's partner"
  -> [{op:"link", a:"X", kind:"partner_of", b:"Y"}]

Parent/Child:
- "X is Y's father/mother/parent"
  -> [{op:"link", a:"X", kind:"parent_of", b:"Y"}]
- "Add Y, child of X and Z" / "X and Z's daughter/son is Y"
  -> [{op:"add_child", child:"Y", parentA:"X", parentB:"Z"}]
- "Add his/her/their son Y (born 1983)" defaults parentA to last_person_name.

Rename & DOB:
- "Rename A to B" / "Change A to B" -> [{op:"rename", from:"A", to:"B"}]
- "Set A's birth year to 1950" -> [{op:"set_dob", name:"A", dob:"1950"}]
- "Add Alice born 1950" -> [{op:"add_person", name:"Alice", dob:"1950"}]

Gender:
- "A is female" -> [{op:"set_gender", name:"A", gender:"female"}]
- "Make A male" -> [{op:"set_gender", name:"A", gender:"male"}]

If pronouns are used and last_person_name is null and subject is unclear, return [{op:"help"}].
`;

/* ------------------------------- helpers ------------------------------- */

function titleCaseFromKnown(name, people) {
  if (!name) return name;
  const n = name.trim().toLowerCase();
  const hit = (people || []).find((p) => p.trim().toLowerCase() === n);
  return hit || name.trim();
}

const FALLBACK_GENDER_MAP = new Map([
  ["m", "male"],
  ["male", "male"],
  ["man", "male"],
  ["boy", "male"],
  ["f", "female"],
  ["female", "female"],
  ["woman", "female"],
  ["girl", "female"],
  ["nonbinary", "nonbinary"],
  ["non-binary", "nonbinary"],
  ["non binary", "nonbinary"],
  ["nb", "nonbinary"],
  ["enby", "nonbinary"],
  ["unknown", "unknown"],
  ["unspecified", "unknown"],
  ["other", "other"],
]);

function canonicalGender(raw) {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase();
  if (!norm) return null;
  return FALLBACK_GENDER_MAP.get(norm) || null;
}

// Regex fallback for when OPENAI_API_KEY is missing or API errors out
function fallback(text, ctx) {
  const ops = [];
  const t = text.trim();

  // basics
  if (/^help$/i.test(t)) ops.push({ op: "help" });
  const mNew = t.match(
    /^(?:new|create)(?:\s+(?:a\s+)?(?:family\s+)?tree)?\s+(?:called\s+)?(.+)$/i
  );
  if (mNew) ops.push({ op: "new_tree", name: mNew[1].trim() });
  const mJoin = t.match(/^join\s+([A-Z0-9]{6})$/i);
  if (mJoin) ops.push({ op: "join_tree", code: mJoin[1].toUpperCase() });
  if (/^show\s+the\s+tree$/i.test(t)) ops.push({ op: "view_tree" });
  const mView = t.match(/^show\s+(.+)$/i);
  if (mView && !/tree$/i.test(mView[1]))
    ops.push({ op: "view_person", name: mView[1].trim() });
  if (/^leave(?:\s+tree)?$/i.test(t)) ops.push({ op: "leave" });

  // add person with dob
  const mAddBorn = t.match(
    /^add\s+([^,]+?)[,]?\s+(?:born|b\.)\s+([0-9]{3,4}|[0-9]{1,2}\s+\w+\s+\d{4})$/i
  );
  if (mAddBorn)
    ops.push({
@@ -196,51 +229,109 @@ function fallback(text, ctx) {
      op: "add_child",
      child,
      parentA: mChildOfTwo[1].trim(),
      parentB: mChildOfTwo[2].trim(),
    });
  }

  // pronoun child: "Add his/her/their son Y born 1983"
  const mPronChild = t.match(
    /^add\s+(?:his|her|their)\s+(son|daughter|child)\s+([^,]+?)(?:[,]\s*(?:born|b\.)\s+(.+))?$/i
  );
  if (mPronChild && ctx?.last_person_name) {
    const child = mPronChild[2].trim();
    const dob = (mPronChild[3] || "").trim() || null;
    ops.push({
      op: "add_child",
      child,
      dob: dob || null,
      parentA: ctx.last_person_name,
    });
  }

  // set dob
  const mDob = t.match(/^set\s+(.+?)['’]s\s+(?:birth(?:\s+year)?)\s+to\s+(.+)$/i);
  if (mDob)
    ops.push({
      op: "set_dob",
      name: titleCaseFromKnown(mDob[1].trim(), ctx?.people),
      dob: mDob[2].trim(),
    });

  const genderLexeme =
    "male|female|man|woman|boy|girl|non[-\\s]?binary|nb|enby|m|f|unknown|unspecified|other";

  const mGenderSet = t.match(
    new RegExp(
      `^set\\s+(.+?)['’]s\\s+gender\\s+to\\s+(${genderLexeme})$`,
      "i"
    )
  );
  if (mGenderSet) {
    const gender = canonicalGender(mGenderSet[2]);
    if (gender) {
      ops.push({
        op: "set_gender",
        name: titleCaseFromKnown(mGenderSet[1].trim(), ctx?.people),
        gender,
      });
    }
  }

  const mGenderIs = t.match(
    new RegExp(
      `^(.+?)\\s+(?:is|was)\\s+(?:a\\s+)?(${genderLexeme})$`,
      "i"
    )
  );
  if (mGenderIs) {
    const gender = canonicalGender(mGenderIs[2]);
    if (gender) {
      ops.push({
        op: "set_gender",
        name: titleCaseFromKnown(mGenderIs[1].trim(), ctx?.people),
        gender,
      });
    }
  }

  const mGenderMake = t.match(
    new RegExp(
      `^make\\s+(.+?)\\s+(?:a\\s+)?(${genderLexeme})$`,
      "i"
    )
  );
  if (mGenderMake) {
    const gender = canonicalGender(mGenderMake[2]);
    if (gender) {
      ops.push({
        op: "set_gender",
        name: titleCaseFromKnown(mGenderMake[1].trim(), ctx?.people),
        gender,
      });
    }
  }

  // rename
  const mRename = t.match(/^(?:rename|change)\s+(.+?)\s+to\s+(.+)$/i);
  if (mRename)
    ops.push({ op: "rename", from: mRename[1].trim(), to: mRename[2].trim() });

  return ops.length ? ops : null;
}

/**
 * parseOps(text, ctx)
 * ctx = { active_tree_name, last_person_name, people, relationships }
 */
export async function parseOps(input, ctx = {}) {
  const text = (input || "").trim();
  if (!text) return null;

  // If no OpenAI key, use fallback regex
  if (!client) return fallback(text, ctx);

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM },
@@ -271,32 +362,40 @@ export async function parseOps(input, ctx = {}) {
          } else {
            // Safe default for ambiguous "link A and B"
            k = "spouse_of";
          }
        }
        op.kind = k;
      }
      return op;
    });

    // --- Correct capitalization using known people[] (title-case match) ---
    if (ctx?.people?.length) {
      ops = ops.map((op) => {
        if (op.name) op.name = titleCaseFromKnown(op.name, ctx.people);
        if (op.a) op.a = titleCaseFromKnown(op.a, ctx.people);
        if (op.b) op.b = titleCaseFromKnown(op.b, ctx.people);
        if (op.child) op.child = titleCaseFromKnown(op.child, ctx.people);
        if (op.from) op.from = titleCaseFromKnown(op.from, ctx.people);
        if (op.to) op.to = titleCaseFromKnown(op.to, ctx.people);
        if (op.parentA) op.parentA = titleCaseFromKnown(op.parentA, ctx.people);
        if (op.parentB) op.parentB = titleCaseFromKnown(op.parentB, ctx.people);
        return op;
      });
    }

    ops = ops.map((op) => {
      if (op?.op === "set_gender" && op.gender) {
        const canon = canonicalGender(op.gender) || op.gender.trim().toLowerCase();
        if (canon) op.gender = canon;
      }
      return op;
    });

    return ops;
  } catch (e) {
    console.error("parseOps error:", e);
    // Graceful degradation so the app still works if the API hiccups
    return fallback(text, ctx);
  }
}
