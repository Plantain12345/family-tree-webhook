// ===== tree-data.js =====
// Map DB rows -> family-chart input shape
// Adjust keys to the exact API your family-chart build expects.

function mapGender(g) {
  if (!g) return "";
  const s = String(g).toUpperCase();
  if (s === "M") return "male";
  if (s === "F") return "female";
  return "";
}

export function toFamilyChartData({ members, parentChild, spousal }) {
  const persons = members.map((m) => ({
    id: m.id,
    firstName: m.first_name || "",
    lastName: m.last_name || "",
    gender: mapGender(m.gender),
    birthday: m.birthday ?? null,
    death: m.death ?? null,
    // You can carry any metadata you like; the lib ignores unknown fields
    isMain: !!m.is_main,
  }));

  const relationships = [];

  // Parent-child (directed)
  for (const r of parentChild) {
    relationships.push({
      type: "parentChild",
      parentId: r.parent_id,
      childId: r.child_id,
    });
  }

  // Spousal/partner links (undirected)
  for (const r of spousal) {
    relationships.push({
      type: "spouse",
      partnerOneId: r.person1_id,
      partnerTwoId: r.person2_id,
      status: r.relationship_type, // 'married' | 'divorced' | 'partner' | 'separated'
    });
  }

  return { persons, relationships };
}
