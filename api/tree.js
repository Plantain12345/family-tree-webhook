// api/tree.js
import { db } from "./_db.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

    const code = (req.query.code || "").toString().trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ error: "Bad code" });

    const { data: tree, error: tErr } = await db
      .from("trees")
      .select("id, name, join_code, created_at")
      .eq("join_code", code)
      .single();

    if (tErr || !tree) {
      console.log("API /tree: not found or error for code", code, tErr);
      return res.status(404).json({ error: "Tree not found" });
    }

    const [peopleResult, relsResult] = await Promise.all([
      db
        .from("persons")
        .select("id, primary_name, dob_dmy, gender")
        .eq("tree_id", tree.id),
      db.from("relationships").select("a, b, kind").eq("tree_id", tree.id),
    ]);

    let peopleError = peopleResult.error;
    let peopleList = peopleResult.data || [];

    if (peopleError && /column .*gender/i.test(peopleError.message || "")) {
      const fallback = await db
        .from("persons")
        .select("id, primary_name, dob_dmy")
        .eq("tree_id", tree.id);
      if (!fallback.error) {
        peopleList = fallback.data || [];
        peopleError = null;
      }
    }

    if (peopleError || relsResult.error) {
      console.log("API /tree persons/relationships error", peopleError, relsResult.error);
      return res.status(500).json({ error: "Query error" });
    }

    const rels = relsResult.data || [];

    const personById = new Map(peopleList.map((p) => [p.id, p]));
    const issues = [];

    const duplicateBuckets = new Map();
    for (const person of peopleList) {
      const key = `${normalizeNameKey(person.primary_name)}|${normalizeDobKey(person.dob_dmy)}`;
      if (!duplicateBuckets.has(key)) duplicateBuckets.set(key, []);
      duplicateBuckets.get(key).push(person);
    }

    duplicateBuckets.forEach((bucket) => {
      if (bucket.length <= 1) return;
      const sorted = bucket
        .slice()
        .sort((a, b) => {
          const nameA = (a.primary_name || "").toLowerCase();
          const nameB = (b.primary_name || "").toLowerCase();
          if (nameA !== nameB) return nameA.localeCompare(nameB);
          const dobA = normalizeDob(a.dob_dmy);
          const dobB = normalizeDob(b.dob_dmy);
          if (dobA === dobB) return 0;
          return dobA - dobB;
        });
      issues.push({
        type: "duplicate_person",
        people: sorted.map(formatPersonRef),
      });
    });

    const nodes = peopleList.map((p) => {
      const lines = [p.primary_name || ""];
      if (p.dob_dmy) lines.push(`b. ${p.dob_dmy}`);
      const normalizedGender = normalizeGender(p.gender);
      return {
        data: {
          id: p.id,
          label: lines.join("\n"),
          gender: normalizedGender,
          dob: p.dob_dmy || null,
        },
      };
    });

    const edges = (rels || []).map((r) => ({
      data: { id: `${r.a}_${r.kind}_${r.b}`, source: r.a, target: r.b, kind: r.kind },
    }));

    const spouseKinds = new Set(["spouse_of", "partner_of"]);
    const divorceKinds = new Set(["divorced_from", "separated_from"]);
    const familiesMap = new Map();
    const parentsByChild = new Map();
    const parentChildPairs = [];

    for (const rel of rels) {
      if (spouseKinds.has(rel.kind) || divorceKinds.has(rel.kind)) {
        const pair = [rel.a, rel.b].sort();
        const key = pair.join("_");
        if (!familiesMap.has(key)) {
          familiesMap.set(key, {
            id: `fam_${key}`,
            spouses: pair,
            parents: pair.slice(),
            children: [],
            status: null,
          });
        }
        if (divorceKinds.has(rel.kind)) {
          const family = familiesMap.get(key);
          family.status = rel.kind;
        }
      }

      if (rel.kind === "parent_of" || rel.kind === "child_of") {
        const parent = rel.kind === "parent_of" ? rel.a : rel.b;
        const child = rel.kind === "parent_of" ? rel.b : rel.a;
        parentChildPairs.push({ parent, child });
        if (!parentsByChild.has(child)) parentsByChild.set(child, new Set());
        parentsByChild.get(child).add(parent);
      }
    }

    for (const [child, parentSet] of parentsByChild.entries()) {
      const parents = Array.from(parentSet).sort();
      if (parents.length === 0) continue;
      const key = parents.join("_");
      if (!familiesMap.has(key)) {
        familiesMap.set(key, {
          id: `fam_${key}`,
          spouses: parents,
          parents: parents.slice(),
          children: [],
          status: null,
        });
      }
      const family = familiesMap.get(key);
      if (!family.children.includes(child)) family.children.push(child);
    }

    const labelByPerson = new Map(peopleList.map((p) => [p.id, p.primary_name || ""]));

    const birthOrder = new Map(
      peopleList.map((p) => {
        const dobValue = normalizeDob(p.dob_dmy);
        return [p.id, dobValue];
      })
    );

    const flaggedParentAge = new Set();

    parentChildPairs.forEach(({ parent, child }) => {
      const parentDob = birthOrder.get(parent);
      const childDob = birthOrder.get(child);
      if (parentDob === undefined || childDob === undefined) return;
      if (!Number.isFinite(parentDob) || !Number.isFinite(childDob)) return;
      if (parentDob > childDob) {
        const key = `${parent}->${child}`;
        if (flaggedParentAge.has(key)) return;
        const parentPerson = personById.get(parent);
        const childPerson = personById.get(child);
        issues.push({
          type: "parent_age_anomaly",
          parent: formatPersonRef(parentPerson),
          child: formatPersonRef(childPerson),
        });
        flaggedParentAge.add(key);
      }
    });

    const families = Array.from(familiesMap.values())
      .map((family) => {
        if (!Array.isArray(family.parents)) {
          family.parents = Array.isArray(family.spouses)
            ? family.spouses.slice()
            : [];
        }
        const seen = new Set();
        const orderedChildren = [];
        for (const childId of family.children) {
          if (!seen.has(childId)) {
            seen.add(childId);
            orderedChildren.push(childId);
          }
        }
        orderedChildren.sort((a, b) => {
          const aVal = birthOrder.get(a) ?? Number.POSITIVE_INFINITY;
          const bVal = birthOrder.get(b) ?? Number.POSITIVE_INFINITY;
          if (aVal !== bVal) return aVal - bVal;
          const aLabel = labelByPerson.get(a) || "";
          const bLabel = labelByPerson.get(b) || "";
          return aLabel.localeCompare(bLabel);
        });
        family.children = orderedChildren;
        return family;
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    const hasData = nodes.length > 0 || edges.length > 0;

    return res.status(200).json({
      tree: { id: tree.id, name: tree.name, code: tree.join_code },
      nodes,
      edges,
      families,
      issues,
      hasData,
    });
  } catch (e) {
    console.error("API /tree fatal error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}

function formatPersonRef(person) {
  if (!person) return null;
  return {
    id: person.id,
    name: person.primary_name || "Unnamed",
    dob: person.dob_dmy || null,
  };
}

function normalizeGender(raw) {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim().toLowerCase();
  if (!value) return null;
  if (["m", "male", "man", "boy"].includes(value)) return "male";
  if (["f", "female", "woman", "girl"].includes(value)) return "female";
  if (["nb", "nonbinary", "non-binary", "non binary"].includes(value)) return "nonbinary";
  return value;
}

function normalizeDob(dob) {
  if (!dob) return Number.POSITIVE_INFINITY;
  const trimmed = dob.trim();
  if (!trimmed) return Number.POSITIVE_INFINITY;

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;

  const ymdMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymdMatch) {
    const [_, y, m, d] = ymdMatch;
    return Date.parse(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`);
  }

  const dmyMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (dmyMatch) {
    const [_, d, m, yRaw] = dmyMatch;
    const year = yRaw.length === 2 ? `19${yRaw}` : yRaw.padStart(4, "0");
    return Date.parse(`${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`);
  }

  const yearMatch = trimmed.match(/(\d{4})/);
  if (yearMatch) {
    return Date.parse(`${yearMatch[1]}-01-01`);
  }

  return Number.POSITIVE_INFINITY;
}

function normalizeNameKey(name) {
  if (!name) return "";
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeDobKey(dob) {
  const value = normalizeDob(dob);
  if (!Number.isFinite(value)) return "unknown";
  return String(value);
}
