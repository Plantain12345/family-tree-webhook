// api/_nlp.js
// STANDARDIZED: Returns DB-ready values with consistent naming

export function parseOps(text) {
  if (!text) return { action: "unknown" };
  const msg = text.trim().toLowerCase();

  // --- HELP/MENU ---
  if (msg.match(/^(help|menu|what can you do|commands)/i)) {
    return { action: "help" };
  }

  // --- CREATE TREE ---
  const mCreate = msg.match(/^create\s+(?:a\s+)?tree\s+(?:called|named)\s+(.+)$/i);
  if (mCreate) {
    return { 
      action: "create_tree", 
      treeName: titleCase(mCreate[1])
    };
  }

  // --- ADD PERSON ---
  const mAdd = msg.match(/^add\s+([a-z\s']+?)(?:,?\s+born\s+(?:in\s+)?(\d{4}))?$/i);
  if (mAdd) {
    const fullName = mAdd[1].trim();
    const { first, last } = splitName(fullName);
    return {
      action: "add_person",
      firstName: first,
      lastName: last,
      gender: "U",
      birthday: mAdd[2] || ""
    };
  }

  // --- SPOUSE RELATIONSHIPS ---
  // "X and Y are married/spouses"
  const mMarried = msg.match(/^([a-z\s']+)\s+and\s+([a-z\s']+)\s+are\s+(married|spouses?|partners?)$/i);
  if (mMarried) {
    return {
      action: "add_relationship",
      kind: "spouse",
      nameA: titleCase(mMarried[1].trim()),
      nameB: titleCase(mMarried[2].trim())
    };
  }

  // "Link X and Y" or "Link X and Y as spouses"
  const mLink = msg.match(/^link\s+([a-z\s']+)\s+(?:and|to|with)\s+([a-z\s']+)(?:\s+as\s+\w+)?$/i);
  if (mLink) {
    return {
      action: "add_relationship",
      kind: "spouse",
      nameA: titleCase(mLink[1].trim()),
      nameB: titleCase(mLink[2].trim())
    };
  }

  // "X is Y's wife/husband/spouse/partner"
  const mSpouse = msg.match(/^([a-z\s']+)\s+is\s+([a-z\s']+)'?s\s+(wife|husband|spouse|partner)$/i);
  if (mSpouse) {
    return {
      action: "add_relationship",
      kind: "spouse",
      nameA: titleCase(mSpouse[1].trim()),
      nameB: titleCase(mSpouse[2].trim())
    };
  }

  // --- PARENT/CHILD RELATIONSHIPS ---
  // "X is Y's father/mother/son/daughter"
  const mParentChild = msg.match(/^([a-z\s']+)\s+is\s+([a-z\s']+)'?s\s+(father|mother|dad|mom|parent|son|daughter|child)$/i);
  if (mParentChild) {
    const nameA = titleCase(mParentChild[1].trim());
    const nameB = titleCase(mParentChild[2].trim());
    const relWord = mParentChild[3].toLowerCase();

    // Determine if this is parent or child relationship
    const isParentWord = ["father", "mother", "dad", "mom", "parent"].includes(relWord);
    
    if (isParentWord) {
      // "John is Mary's father" → John (parent) of Mary (child)
      return {
        action: "add_relationship",
        kind: "parent",
        nameA: nameA,  // parent
        nameB: nameB   // child
      };
    } else {
      // "Mary is John's daughter" → John (parent) of Mary (child)
      return {
        action: "add_relationship",
        kind: "parent",
        nameA: nameB,  // parent (flipped)
        nameB: nameA   // child (flipped)
      };
    }
  }

  // --- SET GENDER ---
  const mGender = msg.match(/^set\s+([a-z\s']+)\s+(?:as\s+)?(male|female|boy|girl)$/i);
  if (mGender) {
    const { first } = splitName(mGender[1]);
    const genderWord = mGender[2].toLowerCase();
    const gender = (genderWord.startsWith("m") || genderWord === "boy") ? "M" : "F";
    return { 
      action: "set_gender", 
      firstName: titleCase(first), 
      gender 
    };
  }

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

function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { first: titleCase(parts[0]), last: "" };
  }
  return {
    first: titleCase(parts.slice(0, -1).join(" ")),
    last: titleCase(parts[parts.length - 1])
  };
}
