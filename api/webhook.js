// api/webhook.js
import {
  createTree,
  joinTreeByCode,
  listPersonsForTree,
  findInTreeByName,
  listPersonsByExactName,
  upsertPersonByName,
  addRelationship,
  addChildWithParents,
  editPerson,
  personSummary,
  leaveCurrentTree,
  savePending,
  popPending,
  getUserState,
  setLastPerson,
  setActiveTreeState,
  normalizeName,
} from "./_db.js";

import { parseOps } from "./_nlp.js";
import { dobRange, normalizeDobInput, parseFlexibleDate } from "./date-utils.js";

const BASE_URL = "https://family-tree-webhook.vercel.app";
const VERIFY_TOKEN = "myfamilytree123";
const FOLLOW_UP_PROMPT =
  "What else would you like to do to your family tree? I understand plain english. Or type 'menu' to view your options.";

function treeUrl(code) {
  return `${BASE_URL}/tree.html?code=${encodeURIComponent(code)}`;
}

function shareLinkText(tree) {
  if (!tree?.join_code) return null;
  const liveUrl = treeUrl(tree.join_code);
  return `Forward this link to your family so they can join:\n${liveUrl}`;
}

const PRONOUNS = new Set([
  "his",
  "her",
  "their",
  "him",
  "hers",
  "theirs",
  "my",
  "our",
  "i",
]);
const looksLikePronoun = (s) => PRONOUNS.has((s || "").trim().toLowerCase());

const PARENT_KEYWORD_PATTERN = "(?:mother|father|mom|mum|dad|parent|parents)";

const GENDER_SYNONYMS = new Map([
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

const DOB_DAY_FORMATTER = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const DOB_MONTH_FORMATTER = new Intl.DateTimeFormat("en", {
  month: "long",
  year: "numeric",
});

function escapeRegExp(value) {
  const str = String(value);
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function guessParentDirection(message, nameA, nameB) {
  const lower = (message || "").toLowerCase();
  const a = (nameA || "").trim().toLowerCase();
  const b = (nameB || "").trim().toLowerCase();
  if (!a || !b || !lower) return null;

  const possA = new RegExp(`${escapeRegExp(a)}\s*['’]s\s+${PARENT_KEYWORD_PATTERN}`);
  const possB = new RegExp(`${escapeRegExp(b)}\s*['’]s\s+${PARENT_KEYWORD_PATTERN}`);

  const aIsChild = possA.test(lower);
  const bIsChild = possB.test(lower);
  if (aIsChild && !bIsChild) return { parent: "b", reason: "possessive" };
  if (bIsChild && !aIsChild) return { parent: "a", reason: "possessive" };

  const parentAfterA = new RegExp(`${PARENT_KEYWORD_PATTERN}[^a-z0-9]+${escapeRegExp(a)}\\b`);
  const parentAfterB = new RegExp(`${PARENT_KEYWORD_PATTERN}[^a-z0-9]+${escapeRegExp(b)}\\b`);
  const parentBeforeA = new RegExp(`${escapeRegExp(a)}\\b[^a-z0-9]+${PARENT_KEYWORD_PATTERN}`);
  const parentBeforeB = new RegExp(`${escapeRegExp(b)}\\b[^a-z0-9]+${PARENT_KEYWORD_PATTERN}`);

  const aLooksParent = parentAfterA.test(lower) || parentBeforeA.test(lower);
@@ -136,50 +149,235 @@ async function describeAmbiguity(treeId, name) {
  return (
    `I know more than one person named ${name}. Please tell me which one you mean by adding a detail such as their birth year or a close relative.` +
    (bullets.length ? `\n${bullets.join("\n")}` : "")
  );
}

async function ensureNamesAreDistinct(tree, names, replies) {
  if (!tree) return false;
  for (const rawName of names) {
    if (!rawName || looksLikePronoun(rawName)) continue;
    const note = await describeAmbiguity(tree.id, rawName);
    if (note) {
      replies.push(`${note}\nI haven't made any changes yet.`);
      return false;
    }
  }
  return true;
}

function ensureKnownName(known, name) {
  if (!name) return;
  const norm = name.trim().toLowerCase();
  if (!known.some((n) => n.trim().toLowerCase() === norm)) known.push(name);
}

function upsertLocalPerson(records, person) {
  if (!person) return;
  const payload = {
    id: person.id,
    primary_name: person.primary_name,
    dob_dmy: person.dob_dmy || null,
  };
  const index = records.findIndex((p) => p.id === payload.id);
  if (index >= 0) {
    records[index] = { ...records[index], ...payload };
  } else {
    records.push(payload);
  }
}

function levenshteinDistance(a, b) {
  const s = a || "";
  const t = b || "";
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    const si = s.charAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const tj = t.charAt(j - 1);
      const cost = si === tj ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function tokenizeName(raw) {
  if (!raw) return [];
  return raw
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenMatches(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const aClean = a.replace(/\.+$/, "");
  const bClean = b.replace(/\.+$/, "");
  if (aClean === bClean) return true;
  if (aClean.length === 1 && bClean.startsWith(aClean)) return true;
  if (bClean.length === 1 && aClean.startsWith(bClean)) return true;
  if (aClean.length > 2 && bClean.length > 2) {
    const distance = levenshteinDistance(aClean, bClean);
    if (distance <= 1) return true;
  }
  return false;
}

function buildNameProfile(name) {
  const tokens = tokenizeName(name);
  return {
    original: name,
    normalized: normalizeName(name),
    tokens,
  };
}

function surnameMatches(aProfile, bProfile) {
  if (!aProfile.tokens.length || !bProfile.tokens.length) return false;
  const aSurname = aProfile.tokens[aProfile.tokens.length - 1];
  const bSurname = bProfile.tokens[bProfile.tokens.length - 1];
  if (!aSurname || !bSurname) return false;
  return tokenMatches(aSurname, bSurname);
}

function nameSimilarity(aProfile, bProfile) {
  if (!aProfile.tokens.length || !bProfile.tokens.length) return 0;
  const used = new Set();
  let matches = 0;
  for (const token of aProfile.tokens) {
    for (let i = 0; i < bProfile.tokens.length; i++) {
      if (used.has(i)) continue;
      if (tokenMatches(token, bProfile.tokens[i])) {
        used.add(i);
        matches += 1;
        break;
      }
    }
  }
  return matches / Math.max(aProfile.tokens.length, bProfile.tokens.length);
}

function rangesOverlap(a, b) {
  if (!a || !b) return true;
  const startA = Number.isFinite(a.start) ? a.start : null;
  const endA = Number.isFinite(a.end) ? a.end : startA;
  const startB = Number.isFinite(b.start) ? b.start : null;
  const endB = Number.isFinite(b.end) ? b.end : startB;
  if (startA === null || startB === null) return true;
  return (endA ?? startA) >= startB && (endB ?? startB) >= startA;
}

function formatDobForSpeech(dob) {
  if (!dob) return null;
  const trimmed = String(dob).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split("-");
    const year = Number.parseInt(y, 10);
    const month = Number.parseInt(m, 10);
    const day = Number.parseInt(d, 10);
    if (
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      Number.isInteger(day)
    ) {
      const date = new Date(Date.UTC(year, month - 1, day));
      return DOB_DAY_FORMATTER.format(date);
    }
  }
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    const [y, m] = trimmed.split("-");
    const year = Number.parseInt(y, 10);
    const month = Number.parseInt(m, 10);
    if (Number.isInteger(year) && Number.isInteger(month)) {
      const date = new Date(Date.UTC(year, month - 1, 1));
      return DOB_MONTH_FORMATTER.format(date);
    }
  }
  if (/^\d{4}$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed;
}

function describeDuplicatePerson(person) {
  if (!person) return null;
  const name = person.primary_name || "Unnamed person";
  const dob = formatDobForSpeech(person.dob_dmy);
  if (dob) return `${name} (born ${dob})`;
  return name;
}

function formatDuplicateSummary(matches) {
  const names = matches.map((entry) => describeDuplicatePerson(entry.person)).filter(Boolean);
  if (!names.length) return "someone with a similar name";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, 2).join(", ")}, and ${names.length - 2} other${
    names.length - 2 === 1 ? "" : "s"
  }`;
}

function findDuplicateCandidates(records, name, dob) {
  if (!name) return [];
  const profile = buildNameProfile(name);
  if (!profile.tokens.length) return [];
  const normalizedName = profile.normalized;
  const targetDate = parseFlexibleDate(dob);
  const targetRange = targetDate?.range || null;
  const results = [];
  for (const person of records) {
    if (!person?.primary_name) continue;
    const candidateProfile = buildNameProfile(person.primary_name);
    if (!candidateProfile.tokens.length) continue;
    if (candidateProfile.normalized === normalizedName) continue;
    const similarity = nameSimilarity(profile, candidateProfile);
    if (similarity < 0.58) continue;
    if (similarity < 0.8 && !surnameMatches(profile, candidateProfile)) continue;
    const candidateRange = dobRange(person.dob_dmy);
    if (targetRange && candidateRange && !rangesOverlap(targetRange, candidateRange)) continue;
    results.push({ person, similarity });
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 5);
}

function menuGuidanceText(id, tree) {
  switch (id) {
    case "MENU_START_TREE":
      return "I didn't change anything; when you're ready, tell me the name of the new family tree. For example, say \"Create a family tree called The Kintu Family\".";
    case "MENU_JOIN_TREE":
      return "I didn't change anything; to join a tree, send the six-letter code. Try something like \"Join ABC123\".";
    case "MENU_SHOW_CODE":
      if (tree) {
        const shareMessage = shareLinkText(tree);
        const base = `I didn't change anything; “${tree.name}” uses join code ${tree.join_code}.`;
        return shareMessage ? `${base}\n${shareMessage}` : base;
      }
      return "I didn't change anything because you're not in a tree yet. Start one or join with a code that someone shares with you.";
    case "MENU_ADD_PERSON":
      return "I didn't change anything; tell me who you'd like to add. For example, say \"Add Alice born 1950\".";
    case "MENU_LINK_RELATIVES":
      return "I didn't change anything; describe the relationship, such as \"Link Maria is John's mother\" or \"Add his son Noah\".";
    case "MENU_EDIT_PERSON":
      return "I didn't change anything; let me know what to update. Try \"Rename Maria to Mary\" or \"Set John's birth year to 1980\".";
    case "MENU_LEAVE_TREE":
      if (tree) {
        return `I didn't change anything; when you're sure, say \"Leave tree\" and I'll remove you from “${tree.name}”.`;
      }
      return "I didn't change anything because you're not currently part of a family tree.";
    case "MENU_HELP":
@@ -240,50 +438,53 @@ export default async function handler(req, res) {
      if (pending) {
        await runConfirmed(pending, from);
        return res.status(200).send("ok");
      }
    }

    if (["no", "n", "cancel", "stop"].includes(lower)) {
      const pending = await popPending(from);
      if (pending) {
        await sendText(
          from,
          withFollowUp("No problem, I cancelled that request. Nothing has changed.")
        );
        return res.status(200).send("ok");
      }
    }

    const [{ tree, people = [], rels = [] } = {}, userState] = await Promise.all([
      listPersonsForTree(from),
      getUserState(from),
    ]);

    let activeTree = tree || null;
    let lastPersonName = userState?.last_person_name || null;
    const knownNames = people.map((p) => p.primary_name);
    const personRecords = Array.isArray(people)
      ? people.map((p) => ({ id: p.id, primary_name: p.primary_name, dob_dmy: p.dob_dmy || null }))
      : [];

    const ctx = {
      active_tree_name: activeTree?.name || null,
      last_person_name: lastPersonName,
      people: knownNames,
      relationships: rels,
    };

    const ops = (await parseOps(text, ctx)) || [];
    if (!ops.length) {
      await sendText(
        from,
        withFollowUp(
          "I didn't quite understand that. Try rephrasing your request or type 'help' for examples."
        )
      );
      return res.status(200).send("ok");
    }

    const replies = [];

    for (const op of ops) {
      if (op.op === "help") {
        replies.push(helpText());
        continue;
@@ -390,70 +591,91 @@ export default async function handler(req, res) {

        const target = await findInTreeByName(activeTree.id, op.name);
        if (!target) {
          replies.push(`I couldn't find anyone named ${op.name} in this tree.`);
          continue;
        }
        const summary = await personSummary(activeTree.id, target.id);
        const parts = [`I didn't change anything; here's what I know about ${summary.me || target.primary_name}.`];
        if (summary.parents?.length) parts.push(`Parents: ${summary.parents.join(", ")}.`);
             if (summary.spouses?.length) parts.push(`Partners: ${summary.spouses.join(", ")}.`);
        if (summary.children?.length) parts.push(`Children: ${summary.children.join(", ")}.`);
        replies.push(parts.join(" "));
        await setLastPerson(from, activeTree.id, target.id, target.primary_name);
        lastPersonName = target.primary_name;
        continue;
      }

      if (op.op === "add_person") {
        const name = (op.name || "").trim();
        if (!name) {
          replies.push("Please tell me the person's name so I can add them.");
          continue;
        }

        const existing = await findInTreeByName(activeTree.id, name);
        if (!existing) {
          const duplicates = findDuplicateCandidates(personRecords, name, op.dob || null);
          if (duplicates.length) {
            const summary = formatDuplicateSummary(duplicates);
            const normalizedDob = normalizeDobInput(op.dob);
            await savePending(from, activeTree.id, {
              type: "add_person_duplicate",
              name,
              dob: normalizedDob || op.dob || null,
            });
            const prefix = duplicates.length > 1 ? "There are already" : "There is already";
            replies.push(
              `${prefix} ${summary} in this tree. Reply YES to add another one anyway or NO to cancel. I haven't added anyone yet.`
            );
            continue;
          }
        }

        const person = await upsertPersonByName(
          activeTree.id,
          name,
          op.dob || null
        );

        let message;
        if (!existing) {
          const formattedDob = formatDobForSpeech(person.dob_dmy);
          const birthDetail = formattedDob ? `, born ${formattedDob}` : "";
          message = `I've added ${person.primary_name}${birthDetail} to your family tree.`;
        } else if (op.dob && op.dob !== (existing.dob_dmy || "")) {
          const formattedDob = formatDobForSpeech(person.dob_dmy) || "unknown";
          message = `I've updated ${person.primary_name}'s birth information to ${formattedDob} in the tree.`;
        } else {
          message = `${person.primary_name} was already in the tree, so nothing changed.`;
        }

        replies.push(message);
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        lastPersonName = person.primary_name;
        ensureKnownName(knownNames, person.primary_name);
        upsertLocalPerson(personRecords, person);
        continue;
      }

      if (op.op === "link") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.a, op.b], replies);
        if (!ok) continue;

        const A = await upsertPersonByName(activeTree.id, op.a);
        const B = await upsertPersonByName(activeTree.id, op.b);
        ensureKnownName(knownNames, A.primary_name);
        ensureKnownName(knownNames, B.primary_name);

        const msgLower = text.toLowerCase();
        let kind = (op.kind || "").toLowerCase();
        if (!["spouse_of", "partner_of", "parent_of"].includes(kind)) {
          if (/(married|wife|husband|spouse|wed|weds)/.test(msgLower)) {
            kind = "spouse_of";
          } else if (/partner/.test(msgLower)) {
            kind = "partner_of";
          } else if (/(father|mother|parent|son|daughter|child)/.test(msgLower)) {
            kind = "parent_of";
          } else {
            kind = "spouse_of";
          }
        }
@@ -481,90 +703,113 @@ export default async function handler(req, res) {
            childPerson.id,
            childPerson.primary_name
          );
          lastPersonName = childPerson.primary_name;
          continue;
        }

        await addRelationship(activeTree.id, A.id, kind, B.id);
        const pretty = kind === "partner_of" ? "partners" : "spouses";
        replies.push(
          `I've linked ${A.primary_name} and ${B.primary_name} as ${pretty} on the family tree.`
        );
        await setLastPerson(from, activeTree.id, B.id, B.primary_name);
        lastPersonName = B.primary_name;
        continue;
      }

      if (op.op === "add_child") {
        const ok = await ensureNamesAreDistinct(
          activeTree,
          [op.parentA, op.parentB].filter(Boolean),
          replies
        );
        if (!ok) continue;

        const duplicates = findDuplicateCandidates(personRecords, op.child, op.dob || null);
        if (duplicates.length) {
          const summary = formatDuplicateSummary(duplicates);
          const normalizedDob = normalizeDobInput(op.dob);
          await savePending(from, activeTree.id, {
            type: "add_child_duplicate",
            child: op.child,
            dob: normalizedDob || op.dob || null,
            parentA: op.parentA,
            parentB: op.parentB || null,
          });
          const prefix = duplicates.length > 1 ? "There are already" : "There is already";
          replies.push(
            `${prefix} ${summary} in this tree. Reply YES to add another child with that name anyway or NO to cancel. I haven't added them yet.`
          );
          continue;
        }

        const child = await addChildWithParents(
          activeTree.id,
          op.child,
          op.dob || null,
          op.parentA,
          op.parentB || null
        );

        const parents = [op.parentA, op.parentB].filter(Boolean).join(" and ");
        const childDob = formatDobForSpeech(child.dob_dmy);
        const childBirthDetail = childDob ? `, born ${childDob}` : "";
        replies.push(
          `I've added ${child.primary_name}${childBirthDetail} as the child of ${parents} and connected them to the family.`
        );
        await setLastPerson(
          from,
          activeTree.id,
          child.id,
          child.primary_name
        );
        lastPersonName = child.primary_name;
        ensureKnownName(knownNames, child.primary_name);
        upsertLocalPerson(personRecords, child);
        continue;
      }

      if (op.op === "set_dob") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.name], replies);
        if (!ok) continue;

        const person = await upsertPersonByName(
          activeTree.id,
          op.name,
          op.dob || null
        );
        const message = op.dob
          ? `I've updated ${person.primary_name}'s birth information to ${
              formatDobForSpeech(person.dob_dmy) || "unknown"
            } on the tree.`
          : `I've cleared ${person.primary_name}'s birth information in the tree.`;
        replies.push(message);
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        lastPersonName = person.primary_name;
        ensureKnownName(knownNames, person.primary_name);
        upsertLocalPerson(personRecords, person);
        continue;
      }

      if (op.op === "set_gender") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.name], replies);
        if (!ok) continue;

        const normalized = normalizeGenderValue(op.gender);
        if (!normalized) {
          replies.push(
            `I couldn't understand the gender you provided for ${op.name}, so I didn't change anything.`
          );
          continue;
        }

        const person = await upsertPersonByName(activeTree.id, op.name);
        await editPerson(activeTree.id, person.id, { gender: normalized });
        const prettyGender =
          normalized.charAt(0).toUpperCase() + normalized.slice(1);
        replies.push(
          `I've recorded ${person.primary_name}'s gender as ${prettyGender} in the family tree.`
        );
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        lastPersonName = person.primary_name;
        ensureKnownName(knownNames, person.primary_name);
@@ -624,50 +869,91 @@ export default async function handler(req, res) {

    try {
      await sendText(
        req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from,
        withFollowUp(
          "Something went wrong while handling your request. Please try again in a moment."
        )
      );
    } catch (notifyError) {
      console.error("Failed to notify user of error:", notifyError);
    }

    return res.status(500).json({ error: "Internal server error" });
  }
}

/* ---------- run confirmed actions ---------- */
async function runConfirmed(pending, phone) {
  const action = pending.action || {};
  const treeId = pending.tree_id;
  if (!action.type || !treeId) {
    await sendText(phone, withFollowUp("That action can't be completed."));
    return;
  }

  if (action.type === "add_person_duplicate") {
    if (!action.name) {
      await sendText(phone, withFollowUp("I couldn't add that person because the name was missing."));
      return;
    }
    const person = await upsertPersonByName(treeId, action.name, action.dob || null);
    const birthDob = formatDobForSpeech(person.dob_dmy);
    const birthDetail = birthDob ? `, born ${birthDob}` : "";
    await setLastPerson(phone, treeId, person.id, person.primary_name);
    await sendText(
      phone,
      withFollowUp(`I've added ${person.primary_name}${birthDetail} to your family tree.`)
    );
    return;
  }

  if (action.type === "add_child_duplicate") {
    if (!action.child || !action.parentA) {
      await sendText(phone, withFollowUp("I couldn't add that child because key details were missing."));
      return;
    }
    const child = await addChildWithParents(
      treeId,
      action.child,
      action.dob || null,
      action.parentA,
      action.parentB || null
    );
    const parents = [action.parentA, action.parentB].filter(Boolean).join(" and ");
    const childDob = formatDobForSpeech(child.dob_dmy);
    const birthDetail = childDob ? `, born ${childDob}` : "";
    await setLastPerson(phone, treeId, child.id, child.primary_name);
    await sendText(
      phone,
      withFollowUp(
        `I've added ${child.primary_name}${birthDetail} as the child of ${parents} and connected them to the family.`
      )
    );
    return;
  }

  if (action.type === "rename") {
    await editPerson(treeId, action.personId, { newName: action.to });
    await sendText(
      phone,
      withFollowUp(`I've renamed that person to “${action.to}” in the family tree.`)
    );
    return;
  }

  if (action.type === "divorce") {
    await addRelationship(treeId, action.aId, "divorced_from", action.bId);
    const divorceMessage =
      action.aName && action.bName
        ? `I've marked ${action.aName} and ${action.bName} as divorced on the family tree.`
        : "I've marked them as divorced on the family tree.";
    await sendText(phone, withFollowUp(divorceMessage));
    return;
  }

  await sendText(phone, withFollowUp("That action can't be completed."));
}

/* ---------- WhatsApp helpers ---------- */
async function sendText(to, body) {
  if (!to) return;
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WABA_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body },
        }),
      }
    );

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(
        `[${new Date().toISOString()}] Send error:`,
        resp.status,
        errorText
      );
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to send message:`,
      error
    );
  }
}

async function sendMenu(to) {
  if (!to) return;
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WABA_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "interactive",
          interactive: {
            type: "list",
            header: { type: "text", text: "Family tree helper" },
            body: {
              text: "Choose a shortcut or just tell me what you need in plain English.",
            },
            footer: { text: "You can also type 'menu' any time." },
            action: {
              button: "Show options",
              sections: [
                {
                  title: "Common actions",
                  rows: [
                    {
                      id: "MENU_START_TREE",
                      title: "Start a tree",
                      description: "Create a brand new family tree",
                    },
                    {
                      id: "MENU_JOIN_TREE",
                      title: "Join a tree",
                      description: "Enter a six-letter join code",
                    },
                    {
                      id: "MENU_SHOW_CODE",
                      title: "Show my tree code",
                      description: "Share or save your current join code",
                    },
                    {
                      id: "MENU_ADD_PERSON",
                      title: "Add a person",
                      description: "Add someone new to the tree",
                    },
                    {
                      id: "MENU_LINK_RELATIVES",
                      title: "Link relatives",
                      description: "Add parent, child, or marriage links",
                    },
                    {
                      id: "MENU_EDIT_PERSON",
                      title: "Edit someone's details",
                      description: "Rename or update birth year/gender",
                    },
                    {
                      id: "MENU_LEAVE_TREE",
                      title: "Leave tree",
                      description: "Remove yourself from the current tree",
                    },
                    {
                      id: "MENU_HELP",
                      title: "Help",
                      description: "See examples of what you can ask",
                    },
                  ],
                },
              ],
            },
          },
        }),
      }
    );

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(
        `[${new Date().toISOString()}] Send menu error:`,
        resp.status,
        errorText
      );
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to send menu:`,
      error
    );
  }
}

function helpText() {
  return [
    "I understand plain English. You can say things like:",
    "• \"Start a new tree called Kintu Family\"",
    "• \"Join code ABC123\"",
    "• \"Add Alice born 1950\"",
    "• \"Add his son Zaake born 1983\"",
    "• \"Link Alice is Bob's mother\" or \"Link Alice married to Bob\"",
    "• \"Show Alice\" or \"Show the tree\"",
    "• \"Set Alice's birth year to 1950\" or \"Rename Alice to Aaliyah\"",
    "• \"Leave tree\"",
    "Type 'menu' any time for quick shortcuts.",
  ].join("\n");
}
