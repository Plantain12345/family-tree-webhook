// api/_nlp.js
// Enhanced NLP parser for natural language family tree commands

export function parseOps(text) {
  if (!text) return { action: "unknown" };
  const msg = text.trim().toLowerCase();

  // --- HELP/MENU ---
  if (msg.match(/^(help|menu|what can you do|commands)/i)) {
    return { action: "help" };
  }

  // --- CREATE TREE ---
  // Must be explicit to avoid false matches
  const mCreate = msg.match(/^create\s+(?:a\s+)?tree\s+(?:called|named)\s+(.+)$/i);
  if (mCreate) {
    const name = titleCase(mCreate[1]);
    return { action: "create_tree", name };
  }

  // --- ADD PERSON (various formats) ---
  // "Add John born 1980"
  const mAdd1 = msg.match(/^add\s+([a-z\s']+?)(?:,?\s+born\s+(?:in\s+)?(\d{4}))?$/i);
  if (mAdd1) {
    const full = mAdd1[1].trim();
    const { first, last } = splitName(full);
    const birthday = mAdd1[2] || "";
    return {
      action: "add_person",
      first_name: first,
      last_name: last,
      gender: "U",
      birthday,
    };
  }

  // --- LINK/MARRIAGE (various formats) ---
  // "Link John and Mary as spouses"
  // "John and Mary are married"
  // "Grace is John's wife/husband"
  
  // Pattern 1: "X and Y are married/spouses"
  const mMarried = msg.match(/^([a-z\s']+)\s+and\s+([a-z\s']+)\s+are\s+(married|spouses?|partners?)$/i);
  if (mMarried) {
    return {
      action: "add_relationship",
      kind: "spouse_of",
      a_name: titleCase(mMarried[1].trim()),
      b_name: titleCase(mMarried[2].trim()),
    };
  }

  // Pattern 2: "Link X and Y" or "Link X and Y as spouses"
  const mLink = msg.match(/^link\s+([a-z\s']+)\s+(?:and|to|with)\s+([a-z\s']+)(?:\s+as\s+(\w+))?$/i);
  if (mLink) {
    const relType = mLink[3] ? mLink[3].toLowerCase() : "spouse";
    let kind = "spouse_of";
    if (relType.includes("partner")) kind = "partner_of";
    
    return {
      action: "add_relationship",
      kind,
      a_name: titleCase(mLink[1].trim()),
      b_name: titleCase(mLink[2].trim()),
    };
  }

  // Pattern 3: "X is Y's wife/husband/spouse"
  const mSpouse = msg.match(/^([a-z\s']+)\s+is\s+([a-z\s']+)'?s\s+(wife|husband|spouse|partner)$/i);
  if (mSpouse) {
    return {
      action: "add_relationship",
      kind: "spouse_of",
      a_name: titleCase(mSpouse[1].trim()),
      b_name: titleCase(mSpouse[2].trim()),
    };
  }

  // --- PARENT/CHILD RELATIONSHIPS ---
  // "X is Y's father/mother/son/daughter"
  const mRel = msg.match(/^([a-z\s']+)\s+is\s+([a-z\s']+)'?s\s+(father|mother|dad|mom|parent|son|daughter|child)$/i);
  if (mRel) {
    const aName = titleCase(mRel[1].trim());
    const bName = titleCase(mRel[2].trim());
    const relWord = mRel[3].toLowerCase();

    const map = {
      father: "parent_of",
      mother: "parent_of",
      dad: "parent_of",
      mom: "parent_of",
      parent: "parent_of",
      son: "child_of",
      daughter: "child_of",
      child: "child_of",
    };

    const kind = map[relWord] || "parent_of";
    const flipped = ["son", "daughter", "child"].includes(relWord);

    return {
      action: "add_relationship",
      kind: flipped ? "parent_of" : kind,
      a_name: flipped ? bName : aName,
      b_name: flipped ? aName : bName,
    };
  }

  // --- SET GENDER ---
  const mGender = msg.match(/^set\s+([a-z\s']+)\s+(?:as\s+)?(male|female|boy|girl)$/i);
  if (mGender) {
    const { first } = splitName(mGender[1]);
    const g = mGender[2].startsWith("m") || mGender[2].startsWith("b") ? "M" : "F";
    return { action: "set_gender", first_name: titleCase(first), gender: g };
  }

  // If nothing matched, return unknown
  return { action: "unknown" };
}

// Helper utilities
function titleCase(str) {
  if (!str) return "";
  return str
    .split(/\s+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
}

function splitName(full) {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: titleCase(parts[0]), last: "" };
  return {
    first: titleCase(parts.slice(0, -1).join(" ")),
    last: titleCase(parts[parts.length - 1]),
  };
}
