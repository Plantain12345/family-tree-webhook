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
const FOLLOW_UP_PROMPT =
  "What else would you like to do to your family tree? I understand plain english. Or type 'menu' to view your options.";

const PRONOUNS = new Set(["his","her","their","him","hers","theirs","my","our","i"]);
const looksLikePronoun = (s) => PRONOUNS.has((s || "").trim().toLowerCase());

const PARENT_KEYWORD_PATTERN = "(?:mother|father|mom|mum|dad|parent|parents)";
const GENDER_SYNONYMS = new Map([
  ["m","male"],["male","male"],["man","male"],["boy","male"],
  ["f","female"],["female","female"],["woman","female"],["girl","female"],
  ["nonbinary","nonbinary"],["non-binary","nonbinary"],["non binary","nonbinary"],
  ["nb","nonbinary"],["enby","nonbinary"],["unknown","unknown"],["unspecified","unknown"],["other","other"]
]);

const DOB_DAY_FORMATTER = new Intl.DateTimeFormat("en", {day:"numeric",month:"short",year:"numeric"});
const DOB_MONTH_FORMATTER = new Intl.DateTimeFormat("en", {month:"long",year:"numeric"});

/* ------------- MAIN HANDLER ------------- */
export default async function handler(req, res) {
  // 1. GET – Meta webhook verification
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      console.log("✅ Webhook verified");
      return res.status(200).send(challenge || "");
    }
    return res.status(403).send("Forbidden");
  }

  // 2. Only accept POST for messages
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // 3. POST – Handle messages
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Status events – just 200 OK
    if (value?.statuses?.length) return res.status(200).send("ok");

    const message = value?.messages?.[0];
    if (!message) return res.status(200).send("ok");

    const from = message.from;
    if (!from) return res.status(200).send("ok");

    // Extract text / menu input
    let text = "";
    let menuSelectionId = null;
    if (message.type === "text") {
      text = message.text?.body || "";
    } else if (message.type === "interactive") {
      const interactive = message.interactive || {};
      if (interactive.list_reply) {
        menuSelectionId = interactive.list_reply.id;
        text =
          interactive.list_reply.title ||
          interactive.list_reply.description ||
          interactive.list_reply.id ||
          "";
      } else if (interactive.button_reply) {
        text = interactive.button_reply.title || interactive.button_reply.id || "";
      }
    } else if (message.type === "button") {
      text = message.button?.text || message.button?.payload || "";
    }
    text = (text || "").trim();
    const lower = text.toLowerCase();

    // Menu + confirmation handling
    if (lower === "menu") {
      await sendMenu(from);
      await sendText(from, withFollowUp("I've sent a menu with shortcuts you can tap."));
      return res.status(200).send("ok");
    }
    if (["yes","y"].includes(lower)) {
      const pending = await popPending(from);
      if (pending) {
        await runConfirmed(pending, from);
        return res.status(200).send("ok");
      }
    }
    if (["no","n","cancel","stop"].includes(lower)) {
      const pending = await popPending(from);
      if (pending) {
        await sendText(from, withFollowUp("No problem, I cancelled that request. Nothing has changed."));
        return res.status(200).send("ok");
      }
    }

    // Load state
    const [{ tree, people = [], rels = [] } = {}, userState] = await Promise.all([
      listPersonsForTree(from),
      getUserState(from),
    ]);
    let activeTree = tree || null;
    let lastPersonName = userState?.last_person_name || null;

    let knownNames = Array.isArray(people) ? people.map((p) => p.primary_name) : [];
    let personRecords = Array.isArray(people)
      ? people.map((p) => ({ id:p.id, primary_name:p.primary_name, dob_dmy:p.dob_dmy || null }))
      : [];

    // Menu selection IDs
    if (menuSelectionId) {
      const guidance = menuGuidanceText(menuSelectionId, activeTree);
      if (guidance) await sendText(from, withFollowUp(guidance));
      return res.status(200).send("ok");
    }

    // Parse operations
    const ctx = {
      active_tree_name: activeTree?.name || null,
      last_person_name: lastPersonName,
      people: knownNames,
      relationships: rels,
    };
    const ops = (await parseOps(text, ctx)) || [];
    if (!ops.length) {
      await sendText(from, withFollowUp("I didn't quite understand that. Try rephrasing or type 'help' for examples."));
      return res.status(200).send("ok");
    }

    const replies = [];
    for (const op of ops) {
      // all your op handlers below
      await handleOperation(op, {
        from,
        text,
        activeTreeRef: { activeTree, lastPersonName, knownNames, personRecords },
        replies,
      });
    }

    if (replies.length) await sendText(from, withFollowUp(replies.join("\n\n")));
    return res.status(200).send("ok");
  } catch (error) {
    console.error("Webhook handler error:", error);
    try {
      await sendText(
        req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from,
        withFollowUp("Something went wrong while handling your request. Please try again in a moment.")
      );
    } catch (notifyError) {
      console.error("Failed to notify user of error:", notifyError);
    }
    return res.status(500).json({ error: "Internal server error" });
  }
}

/* ------------- HELPERS ------------- */

// Everything else (formatDobForSpeech, guessParentDirection, findDuplicateCandidates, ensureNamesAreDistinct, upsertLocalPerson, runConfirmed, sendText, sendMenu, helpText, etc.) stays the same as in your file.
// Move them **below** the export default handler as pure helper functions. They do not export anything by default.

function withFollowUp(message) {
  const base = message || "";
  if (!FOLLOW_UP_PROMPT) return base;
  return `${base}\n\n${FOLLOW_UP_PROMPT}`.trim();
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
      return helpText();
    default:
      return null;
  }
}


if (op.op === "new_tree") {
  const name = (op.name || "My Family").slice(0, 80);
  try {
    // NOTE: createTree(phone, name) — phone first
    const tree = await createTree(from, name);

    const tip = `You’re now active in “${tree.name}”. Try: Add Alice born 1950
Live tree: ${BASE_URL}/tree.html?code=${tree.join_code}`;

    await setActiveTreeState(from, tree.id);
    replies.push(`✅ Created “${tree.name}”. Code: ${tree.join_code}\n${tip}`);
  } catch (e) {
    console.error("Error creating tree:", e);
    replies.push("❌ Couldn't create the tree. Try a different name.");
  }
  continue;
}

if (op.op === "join_tree") {
  const code = (op.code || "").toUpperCase();

  // NOTE: joinTreeByCode(phone, code) — phone first
  const { joined, reason, tree } = await joinTreeByCode(from, code);

  const tip = joined
    ? `You’re now active in “${tree.name}”. Try: Add Alice born 1950
Live tree: ${BASE_URL}/tree.html?code=${tree.join_code}`
    : null;

  replies.push(
    joined
      ? `✅ Switched to “${tree.name}”.\n${tip}`
      : reason === "invalid_code"
        ? "❌ That code looks invalid."
        : reason === "not_found"
          ? "❌ Code not found. Ask the owner to re-share."
          : "❌ Couldn’t join right now. Please try again."
  );

  if (joined && tree) await setActiveTreeState(from, tree.id);
  continue;
}
      
      if (!activeTree) {
        replies.push(
          "You're not currently part of a family tree. Start a new one or join with a code before making other changes."
        );
        break;
      }

      if (op.op === "view_tree") {
        const lines = [
          `You're viewing “${activeTree.name}”. The join code is ${activeTree.join_code}.`,
        ];
        const share = shareLinkText(activeTree);
        if (share) lines.push(share);
        replies.push(lines.join("\n"));
        continue;
      }

      if (op.op === "view_person") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.name], replies);
        if (!ok) continue;

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

        let kind = (op.kind || "").toLowerCase();
        if (!["spouse_of", "partner_of", "parent_of"].includes(kind)) {
          const msgLower = text.toLowerCase();
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

        if (kind === "parent_of") {
          let parent = A;
          let child = B;
          const guess = guessParentDirection(text, A.primary_name, B.primary_name);
          if (guess?.parent === "b") {
            parent = B;
            child = A;
          }
          await addRelationship(activeTree.id, parent.id, "parent_of", child.id);
          replies.push(
            `I've linked ${parent.primary_name} as the parent of ${child.primary_name} on the family tree.`
          );
          await setLastPerson(from, activeTree.id, child.id, child.primary_name);
          lastPersonName = child.primary_name;
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

      if (op.op === "rename") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.from], replies);
        if (!ok) continue;
        const candidates = await listPersonsByExactName(activeTree.id, op.from);
        if (!candidates?.length) {
          replies.push(`I couldn't find anyone named ${op.from} in this tree.`);
          continue;
        }
        if (candidates.length > 1) {
          const note = await describeAmbiguity(activeTree.id, op.from);
          if (note) {
            replies.push(`${note}\nI haven't made any changes yet.`);
            continue;
          }
        }
        const person = candidates[0];
        const newName = (op.to || "").trim();
        if (!newName) {
          replies.push("Tell me the new name you'd like to use.");
          continue;
        }
        await editPerson(activeTree.id, person.id, { newName });
        replies.push(`I've renamed ${person.primary_name} to "${newName}" in the family tree.`);
        await setLastPerson(from, activeTree.id, person.id, newName);
        lastPersonName = newName;
        ensureKnownName(knownNames, newName);
        upsertLocalPerson(personRecords, { ...person, primary_name: newName });
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
        const prettyGender = normalized.charAt(0).toUpperCase() + normalized.slice(1);
        replies.push(
          `I've recorded ${person.primary_name}'s gender as ${prettyGender} in the family tree.`
        );
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        lastPersonName = person.primary_name;
        ensureKnownName(knownNames, person.primary_name);
        continue;
      }

      if (op.op === "divorce") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.a, op.b], replies);
        if (!ok) continue;
        const A = await upsertPersonByName(activeTree.id, op.a);
        const B = await upsertPersonByName(activeTree.id, op.b);
        await addRelationship(activeTree.id, A.id, "divorced_from", B.id);
        replies.push(
          `I've marked ${A.primary_name} and ${B.primary_name} as divorced on the family tree.`
        );
        await setLastPerson(from, activeTree.id, B.id, B.primary_name);
        lastPersonName = B.primary_name;
        continue;
      }

      if (op.op === "leave") {
        const result = await leaveCurrentTree(from);
        if (result.left) {
          const treeName = result.tree?.name || "the tree";
          replies.push(`You're no longer a member of “${treeName}”.`);
          activeTree = null;
          knownNames = [];
          personRecords = [];
          await setLastPerson(from, null, null, null);
        } else {
          replies.push("You're not currently part of a family tree, so nothing changed.");
        }
        continue;
      }

      replies.push("I didn't change anything because I didn't recognise that instruction.");
    }

    if (replies.length) {
      await sendText(from, withFollowUp(replies.join("\n\n")));
    }

    return res.status(200).send("ok");
  } catch (error) {
    console.error("Webhook handler error:", error);
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
    if (!action.personId || !action.to) {
      await sendText(phone, withFollowUp("I couldn't rename that person because some details were missing."));
      return;
    }
    await editPerson(treeId, action.personId, { newName: action.to });
    await sendText(
      phone,
      withFollowUp(`I've renamed that person to "${action.to}" in the family tree.`)
    );
    return;
  }

  if (action.type === "divorce") {
    if (!action.aId || !action.bId) {
      await sendText(phone, withFollowUp("I couldn't mark them as divorced because some details were missing."));
      return;
    }
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
