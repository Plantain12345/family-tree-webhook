// api/_nlp.js
import OpenAI from "openai";

/**
 * Client is optional so local dev can run without a key.
 */
const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * Tool schema the webhook expects (single tool call with a list of primitive ops).
 * We've extended the enum to include separation, divorce, and affair,
 * and added death date support (dod / set_dod).
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
                    "menu",
                    "new_tree",
                    "join_tree",
                    "add_person",
                    "link",
                    "add_child",
                    "rename",
                    "set_dob",
                    "set_dod",
                    "set_gender",
                    "divorce",
                    "separate",
                    "affair",
                    "view_tree",
                    "view_person",
                    "leave",
                  ],
                },
                // common fields used by ops
                name: { type: "string" }, // new_tree / view_person / add_person / set_dob / set_dod / set_gender / rename.from/.to
                code: { type: "string" }, // join_tree
                a: { type: "string" },
                b: { type: "string" },
                kind: {
                  type: "string",
                  enum: [
                    "spouse_of",
                    "partner_of",
                    "parent_of",
                    "divorced_from",
                    "separated_from",
                    "affair_with",
                  ],
                },
                child: { type: "string" },
                parentA: { type: "string" },
                parentB: { type: "string", nullable: true },
                dob: { type: "string", nullable: true },
                dod: { type: "string", nullable: true },
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
You turn family-related natural language into a short list of primitive operations.

PRIMITIVE EDGES ONLY:
- spouse_of (undirected, normalized a<b)
- partner_of (undirected, normalized a<b)
- divorced_from (undirected, normalized a<b)
- separated_from (undirected, normalized a<b)
- affair_with (undirected, normalized a<b)
- parent_of (directed A -> B)

All other kinship (grandparent, sibling, cousin, etc.) is derived later.

You receive CONTEXT with:
- active_tree_name (string|null)
- last_person_name (string|null)
- people[] (known names in the active tree)
- relationships[] (possibly partial list of {a,b,kind})

RULES
- Output exactly one tool call (set_ops) with fully resolved names (no pronouns like his/her/their/my/our/I).
- If a pronoun is used and the subject is not otherwise explicit, default to last_person_name.
- Prefer capitalization from people[] when resolving existing names (case-insensitive match).
- Never invent dates. If a birth or death date is missing, omit it.
- For gender, use normalized values male, female, nonbinary, or unknown unless user specifies a different explicit term.
- You may output op:"menu" when the user explicitly requests the menu or similar shortcuts.

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
- "X and Y separated"
  -> [{op:"separate", a:"X", b:"Y"}]
- "X and Y divorced"
  -> [{op:"divorce", a:"X", b:"Y"}]
- "X had an affair with Y" / "X and Y had a secret relationship"
  -> [{op:"affair", a:"X", b:"Y"}]
- "X was previously married to Y, but they divorced"
  -> [{op:"link", a:"X", kind:"spouse_of", b:"Y"}, {op:"divorce", a:"X", b:"Y"}]

Parent/Child:
- "X is Y's father/mother/parent"
  -> [{op:"link", a:"X", kind:"parent_of", b:"Y"}]
- "Add Y, child of X and Z" / "X and Z's daughter/son is Y"
  -> [{op:"add_child", child:"Y", parentA:"X", parentB:"Z"}]
- "Add his/her/their son Y (born 1983)" defaults parentA to last_person_name.

Rename, DOB, DOD, Gender:
- "Rename A to B" / "Change A to B" -> [{op:"rename", from:"A", to:"B"}]
- "Set A's birth year to 1950" -> [{op:"set_dob", name:"A", dob:"1950"}]
- "Add Alice born 1950" -> [{op:"add_person", name:"Alice", dob:"1950"}]
- "Alice died in 2003" -> [{op:"set_dod", name:"Alice", dod:"2003"}]
- "A is female" / "Make A male" -> [{op:"set_gender", name:"A", gender:"female"|"male"}]

If pronouns are used and last_person_name is null and subject is unclear, return [{op:"help"}].
`;

/* -------------------------------- helpers ------------------------------- */

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
  ["woman*", "female"], // tolerant
  ["male*", "male"],
  ["female*", "female"],
]);

function canonicalGender(raw) {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase();
  if (!norm) return null;
  return FALLBACK_GENDER_MAP.get(norm) || null;
}

function pickPartnerKind(text) {
  if (/partner/i.test(text)) return "partner_of";
  return "spouse_of";
}

function cleanupName(value, people) {
  return titleCaseFromKnown(value?.trim(), people);
}

function pushUnique(ops, op) {
  if (!op) return;
  ops.push(op);
}

function hasRelationWord(str, words) {
  return new RegExp(`\\b(${words})\\b`, "i").test(str);
}

const PARENT_WORDS = "mother|father|mom|mum|dad|parent|parents";
const CHILD_WORDS = "son|daughter|child";
const SPOUSE_WORDS = "husband|wife|spouse|married|wed|weds|marriage";
const PARTNER_WORDS = "partner";
const DIVORCE_WORDS = "divorce|divorced|split up|ended the marriage|dissolved";
const SEPARATION_WORDS = "separate|separated|separation";
const AFFAIR_WORDS = "affair|mistress|lover|secret relationship|cheated with";

/**
 * Regex fallback for when OPENAI_API_KEY is missing or API errors out.
 * We err on the side of producing the right edge kinds (including divorce/separation/affair).
 */
function fallback(text, ctx) {
  const ops = [];
  const t = (text || "").trim();
  if (!t) return null;

  const people = ctx?.people || [];
  const lastPerson = ctx?.last_person_name || null;

  if (/^help$/i.test(t)) pushUnique(ops, { op: "help" });
  if (/^menu$/i.test(t)) pushUnique(ops, { op: "menu" });

  const mNew = t.match(/^(?:new|create)(?:\s+(?:a\s+)?(?:family\s+)?tree)?\s+(?:called\s+)?(.+)$/i);
  if (mNew) pushUnique(ops, { op: "new_tree", name: mNew[1].trim() });

  const mJoin = t.match(/^join\s+([A-Z0-9]{6})$/i);
  if (mJoin) pushUnique(ops, { op: "join_tree", code: mJoin[1].toUpperCase() });

  if (/^show\s+the\s+tree$/i.test(t)) pushUnique(ops, { op: "view_tree" });

  const mView = t.match(/^show\s+(.+)$/i);
  if (mView && !/tree$/i.test(mView[1]))
    pushUnique(ops, { op: "view_person", name: cleanupName(mView[1], people) });

  if (/^leave(?:\s+tree)?$/i.test(t)) pushUnique(ops, { op: "leave" });

  // Add child with explicit parents
  const mChildOf = t.match(/^add\s+(.+?)\s*,?\s*(?:child|son|daughter)\s+of\s+(.+?)(?:\s+and\s+(.+))?$/i);
  if (mChildOf) {
    pushUnique(ops, {
      op: "add_child",
      child: cleanupName(mChildOf[1], people),
      parentA: cleanupName(mChildOf[2], people),
      parentB: mChildOf[3] ? cleanupName(mChildOf[3], people) : undefined,
    });
  }

  // Pronoun child
  const mPronChild = t.match(/^add\s+(?:his|her|their)\s+(son|daughter|child)\s+([^,]+?)(?:[,]?\s*(?:born|b\.)\s+(.+))?$/i);
  if (mPronChild && lastPerson) {
    pushUnique(ops, {
      op: "add_child",
      child: cleanupName(mPronChild[2], people),
      dob: mPronChild[3] ? mPronChild[3].trim() : null,
      parentA: cleanupName(lastPerson, people),
    });
  }

  // Parent link explicit
  const mAddParentTo = t.match(/^add\s+(.+?)\s+(?:as\s+)?(?:mother|father|mom|mum|dad|parent)\s+(?:of|to)\s+(.+)$/i);
  if (mAddParentTo) {
    pushUnique(ops, {
      op: "link",
      a: cleanupName(mAddParentTo[1], people),
      kind: "parent_of",
      b: cleanupName(mAddParentTo[2], people),
    });
  }

  // Add child relationship explicit
  const mAddChildTo = t.match(/^add\s+(.+?)\s+(?:as\s+)?(?:son|daughter|child)\s+(?:of|to)\s+(.+)$/i);
  if (mAddChildTo) {
    pushUnique(ops, {
      op: "add_child",
      child: cleanupName(mAddChildTo[1], people),
      parentA: cleanupName(mAddChildTo[2], people),
    });
  }

  // Add person with DOB or DOD
  const mAddBorn = t.match(/^add\s+([^,]+?)[,]?\s+(?:born|b\.)\s+(.+)$/i);
  if (mAddBorn) {
    pushUnique(ops, { op: "add_person", name: cleanupName(mAddBorn[1], people), dob: mAddBorn[2].trim() });
  }
  const mAddDied = t.match(/^add\s+([^,]+?)[,]?\s+(?:died|d\.)\s+(.+)$/i);
  if (mAddDied) {
    pushUnique(ops, { op: "add_person", name: cleanupName(mAddDied[1], people), dod: mAddDied[2].trim() });
  }

  // Simple add person
  const mAddSimple = t.match(/^add\s+(?:person\s+)?(.+)$/i);
  if (
    mAddSimple &&
    !/^(?:his|her|their)\b/i.test(mAddSimple[1]) &&
    !hasRelationWord(mAddSimple[1], `${PARENT_WORDS}|${CHILD_WORDS}|${SPOUSE_WORDS}|${PARTNER_WORDS}`)
  ) {
    pushUnique(ops, { op: "add_person", name: cleanupName(mAddSimple[1], people) });
  }

  // Possessive statements
  const possessive = t.match(/^(.+?)\s+is\s+(.+?)['’]s\s+(.+)$/i);
  if (possessive) {
    const left = cleanupName(possessive[1], people);
    const right = cleanupName(possessive[2], people);
    const relation = possessive[3].toLowerCase();
    if (hasRelationWord(relation, PARENT_WORDS)) {
      pushUnique(ops, { op: "link", a: left, kind: "parent_of", b: right });
    } else if (hasRelationWord(relation, CHILD_WORDS)) {
      pushUnique(ops, { op: "link", a: right, kind: "parent_of", b: left });
    } else if (hasRelationWord(relation, SPOUSE_WORDS)) {
      pushUnique(ops, { op: "link", a: left, kind: "spouse_of", b: right });
    } else if (hasRelationWord(relation, PARTNER_WORDS)) {
      pushUnique(ops, { op: "link", a: left, kind: "partner_of", b: right });
    }
  }

  // Divorce / separation / affair
  const mDiv1 = t.match(/^(.+?)\s+and\s+(.+?)\s+(?:have\s+)?(?:divorced|split\s+up|ended\s+the\s+marriage)$/i);
  if (mDiv1) pushUnique(ops, { op: "divorce", a: cleanupName(mDiv1[1], people), b: cleanupName(mDiv1[2], people) });

  const mDiv2 = t.match(/^(.+?)\s+was\s+previously\s+married\s+to\s+(.+?),?\s+but\s+they\s+divorced$/i);
  if (mDiv2) {
    const A = cleanupName(mDiv2[1], people), B = cleanupName(mDiv2[2], people);
    pushUnique(ops, { op: "link", a: A, kind: "spouse_of", b: B });
    pushUnique(ops, { op: "divorce", a: A, b: B });
  }

  const mSep = t.match(/^(.+?)\s+and\s+(.+?)\s+(?:have\s+)?separated$/i);
  if (mSep) pushUnique(ops, { op: "separate", a: cleanupName(mSep[1], people), b: cleanupName(mSep[2], people) });

  const mAffair = t.match(/^(.+?)\s+(?:had\s+an\s+)?(?:affair|secret\s+relationship|cheated\s+with)\s+(.+?)$/i);
  if (mAffair) pushUnique(ops, { op: "affair", a: cleanupName(mAffair[1], people), b: cleanupName(mAffair[2], people) });

  // Direct link commands
  const mLink = t.match(/^(?:link|connect|marry)\s+(.+?)\s+(?:and|with|to)\s+(.+)$/i);
  if (mLink) {
    pushUnique(ops, { op: "link", a: cleanupName(mLink[1], people), b: cleanupName(mLink[2], people) });
  }

  // Set DOB / DOD
  const mDob = t.match(/^set\s+(.+?)['’]s\s+(?:birth(?:\s+year)?)\s+to\s+(.+)$/i);
  if (mDob) pushUnique(ops, { op: "set_dob", name: cleanupName(mDob[1], people), dob: mDob[2].trim() });

  const mDied = t.match(/^set\s+(.+?)['’]s\s+(?:death(?:\s+year)?)\s+to\s+(.+)$/i);
  if (mDied) pushUnique(ops, { op: "set_dod", name: cleanupName(mDied[1], people), dod: mDied[2].trim() });

  // Gender
  const genderLexeme =
    "male|female|man|woman|boy|girl|non[-\\s]?binary|nb|enby|m|f|unknown|unspecified|other";

  let m = t.match(new RegExp(`^set\\s+(.+?)['’]s\\s+gender\\s+to\\s+(${genderLexeme})$`, "i"));
  if (m) {
    const gender = canonicalGender(m[2]);
    if (gender) pushUnique(ops, { op: "set_gender", name: cleanupName(m[1], people), gender });
  }
  m = t.match(new RegExp(`^(.+?)\\s+(?:is|was)\\s+(?:a\\s+)?(${genderLexeme})$`, "i"));
  if (m) {
    const gender = canonicalGender(m[2]);
    if (gender) pushUnique(ops, { op: "set_gender", name: cleanupName(m[1], people), gender });
  }
  m = t.match(new RegExp(`^make\\s+(.+?)\\s+(?:a\\s+)?(${genderLexeme})$`, "i"));
  if (m) {
    const gender = canonicalGender(m[2]);
    if (gender) pushUnique(ops, { op: "set_gender", name: cleanupName(m[1], people), gender });
  }

  const mRename = t.match(/^(?:rename|change)\s+(.+?)\s+to\s+(.+)$/i);
  if (mRename)
    pushUnique(ops, { op: "rename", from: cleanupName(mRename[1], people), to: cleanupName(mRename[2], people) });

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
        { role: "user", content: JSON.stringify({ text, context: ctx }) },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "set_ops" } },
      temperature: 0.1,
    });

    const choice = resp.choices?.[0];
    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall) return fallback(text, ctx);

    const parsed = JSON.parse(toolCall.function.arguments || "{}");
    let ops = parsed.ops || [];

    // Normalize unknown/omitted link kinds from the LLM
    ops = ops.map((op) => {
      if (op?.op === "link") {
        const k = (op.kind || "").toLowerCase();
        if (!["spouse_of", "partner_of", "parent_of"].includes(k)) {
          if (/(married|husband|wife|spouse)/i.test(text)) op.kind = "spouse_of";
          else if (/partner/i.test(text)) op.kind = "partner_of";
          else if (/(father|mother|parent|son|daughter|child)/i.test(text)) op.kind = "parent_of";
          else op.kind = "spouse_of";
        }
      }
      return op;
    });

    // Correct capitalization using known people[]
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

    // Canonicalize gender names if present
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
    return fallback(text, ctx);
  }
}
