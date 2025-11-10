function mapGender(value) {
  const gender = String(value ?? "").trim().toUpperCase();
  if (gender === "M") return "male";
  if (gender === "F") return "female";
  return "";
}

export function buildFamilyChartPayload({ members, parentChild, spousal }) {
  const persons = members.map((member) => ({
    id: member.id,
    firstName: member.first_name ?? "",
    lastName: member.last_name ?? "",
    gender: mapGender(member.gender),
    birthday: member.birthday ?? null,
    death: member.death ?? null,
    isMain: Boolean(member.is_main),
  }));

  const relationships = [
    ...parentChild.map((row) => ({
      type: "parentChild",
      parentId: row.parent_id,
      childId: row.child_id,
    })),
    ...spousal.map((row) => ({
      type: "spouse",
      partnerOneId: row.person1_id,
      partnerTwoId: row.person2_id,
      status: row.relationship_type,
    })),
  ];

  return { persons, relationships };
}
