// api/_nlp.js
//
// Parses plain English WhatsApp messages into structured actions.
// Output examples:
//   { action: "create_tree", name: "The De Conincks" }
//   { action: "add_person", first_name: "John", last_name: "", gender: "U", birthday: "1980" }
//   { action: "add_relationship", kind: "parent_of", a_name: "John", b_name: "Mary" }

export function parseOps(text) {
  if (!text) return { action: "unknown" };
  const msg = text.trim().toLowerCase();

  // --- 1️⃣ Create Tree ---
  const mCreate = msg.match(/create( a)? tree( called| named)? (.+)/i);
  if (mCreate) {
    const name = titleCase(mCreate[3]);
    return { action: "create_tree", name };
  }

  // --- 2️⃣ Add Person ---
  const mAdd = msg.match(/^add\s+([a-z\s']+?)(?:,?\s*born\s+([\w\s-]+))?$/i);
  if (mAdd) {
    const full = mAdd[1].trim();
    const { first, last } = splitName(full);
    const birthday = normalizeBirthday(mAdd[2]);
    return {
      action: "add_person",
      first_name: first,
      last_name: last,
      gender: "U",
      birthday,
    };
  }

  // --- 3️⃣ Set Gender ---
  const mGender = msg.match(/^set\s+([a-z\s']+)\s+(?:as\s+)?(male|female|boy|girl)/i);
  if (mGender) {
    const { first } = splitName(mGender[1]);
    const g = mGender[2].startsWith("m") || mGender[2].startsWith("b") ? "M" : "F";
    return { action: "set_gender", first_name: titleCase(first), gender: g };
  }

  // --- 4️⃣ Relationship: A is B's father/mother/son/daughter/spouse/partner ---
  const mRel = msg.match(/^([a-z\s']+)\s+is\s+([a-z\s']+)'?s\s+(\w+)/i);
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
      kid: "child_of",
      wife: "spouse_of",
      husband: "spouse_of",
      spouse: "spouse_of",
      partner: "partner_of",
    };

    const kind = map[relWord] || "related_to";
    let flipped = false;
    if (["child_of"].includes(kind)) {
      // invert direction (child -> parent becomes parent -> child)
      flipped = true;
    }

    return {
      action: "add_relationship",
      kind: kind === "child_of" ? "parent_of" : kind,
      a_name: flipped ? bName : aName,
      b_name: flipped ? aName : bName,
      direction_flipped: flipped,
    };
  }

  // --- 5️⃣ Link A and B as spouses/partners/etc ---
  const mLink = msg.match(/^link\s+([a-z\s']+)\s+(?:and|to|with)\s+([a-z\s']+)(?:\s+as\s+(\w+))?/i);
  if (mLink) {
    const aName = titleCase(mLink[1].trim());
    const bName = titleCase(mLink[2].trim());
    const relType = mLink[3] ? mLink[3].toLowerCase() : "spouse";
    
    let kind = "spouse_of";
    if (relType.includes("partner")) kind = "partner_of";
    
    return {
      action: "add_relationship",
      kind,
      a_name: aName,
      b_name: bName,
    };
  }

  // --- 6️⃣ Help ---
  if (msg.match(/^(help|menu|what can you do|commands)/i)) {
    return { action: "help" };
  }

  return { action: "unknown" };
}

// -----------------------------------------------------------------------------
// Helper utilities
// -----------------------------------------------------------------------------
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

function normalizeBirthday(raw) {
  if (!raw) return "";
  raw = raw.trim();
  // Extract just year or normalize known formats
  const y = raw.match(/\b(\d{4})\b/);
  if (y) return y[1];
  const alt = raw.match(/(\d{1,2})\s*(?:th|st|nd|rd)?\s*(\w+)\s*(\d{4})/);
  if (alt) return `${alt[3]}-${monthNum(alt[2])}-${alt[1].padStart(2, "0")}`;
  return raw;
}

function monthNum(str) {
  const months = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  return months[str.slice(0, 3).toLowerCase()] || "00";
}
