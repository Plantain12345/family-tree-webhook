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
} from "./_db.js";

import { parseOps } from "./_nlp.js";

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
  "me",
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
  const bLooksParent = parentAfterB.test(lower) || parentBeforeB.test(lower);

  if (aLooksParent && !bLooksParent) return { parent: "a", reason: "keyword" };
  if (bLooksParent && !aLooksParent) return { parent: "b", reason: "keyword" };

  const pronounParentRe = new RegExp(`(their|his|her)\s+${PARENT_KEYWORD_PATTERN}`);
  if (pronounParentRe.test(lower)) {
    if (parentAfterA.test(lower)) return { parent: "a", reason: "pronoun" };
    if (parentAfterB.test(lower)) return { parent: "b", reason: "pronoun" };
  }

  return null;
}

function normalizeGenderValue(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim().toLowerCase();
  if (!key) return null;
  return GENDER_SYNONYMS.get(key) || key;
}

function withFollowUp(message) {
  const trimmed = (message || "").trim();
  if (!trimmed) return FOLLOW_UP_PROMPT;
  return `${trimmed}\n\n${FOLLOW_UP_PROMPT}`;
}

async function describeAmbiguity(treeId, name) {
  if (!treeId || !name) return null;
  const matches = await listPersonsByExactName(treeId, name);
  if (!matches || matches.length <= 1) return null;

  const bullets = matches.map((person) => {
    const parts = [`• ${person.primary_name}`];
    if (person.dob_dmy) parts.push(`born ${person.dob_dmy}`);
    return parts.join(" ");
  });

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
      return "I understand plain English, so just tell me what you'd like to do.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const {
      "hub.mode": mode,
      "hub.verify_token": token,
      "hub.challenge": challenge,
    } = req.query;
    if (mode === "subscribe" && token === VERIFY_TOKEN)
      return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg?.from) return res.status(200).send("no-op");

    const from = msg.from;

    if (msg.type === "interactive" && msg.interactive?.type === "list_reply") {
      const selection = msg.interactive.list_reply;
      const context = (await listPersonsForTree(from)) || {};
      const guidance = menuGuidanceText(selection?.id, context.tree);
      await sendText(from, withFollowUp(guidance));
      return res.status(200).send("ok");
    }

    const text =
      (msg.text?.body ||
        msg.interactive?.button_reply?.id ||
        msg.button?.payload ||
        "")
        .trim();

    if (!text) {
      await sendText(
        from,
        withFollowUp("I didn't catch that. Please send a message in plain English so I can help.")
      );
      return res.status(200).send("ok");
    }

    const lower = text.toLowerCase();

    if (["yes", "y", "sure", "confirm"].includes(lower)) {
      const pending = await popPending(from);
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
      }

      if (op.op === "menu") {
        await sendMenu(from);
        replies.push("I sent you the menu of quick options.");
        continue;
      }

      if (op.op === "new_tree") {
        if (!op.name || !op.name.trim()) {
          replies.push(
            "I need a name for the new family tree. Try saying something like \"Create a tree called The Kintu Family\"."
          );
          continue;
        }

        const trimmed = op.name.trim();
        const { tree: createdTree } = await createTree(trimmed, from);
        await setActiveTreeState(from, createdTree.id);
        await setLastPerson(from, createdTree.id, null, null);
        activeTree = createdTree;
        lastPersonName = null;
        knownNames.length = 0;
        const shareMessage = shareLinkText(createdTree);
        const message = shareMessage
          ? `I created a new family tree called “${createdTree.name}” and made it your active tree.\n${shareMessage}`
          : `I created a new family tree called “${createdTree.name}” and made it your active tree.`;
        replies.push(message);
        continue;
      }

      if (op.op === "join_tree") {
        if (!op.code) {
          replies.push(
            "Please tell me the six-letter code you'd like to join, for example \"Join ABC123\"."
          );
          continue;
        }

        const joinResult = await joinTreeByCode(op.code.toUpperCase(), from);
        if (!joinResult.tree) {
          replies.push(
            `I couldn't find a tree with the code ${op.code.toUpperCase()}, so nothing changed.`
          );
          continue;
        }

        activeTree = joinResult.tree;
        await setActiveTreeState(from, activeTree.id);
        await setLastPerson(from, activeTree.id, null, null);
        lastPersonName = null;
        const shareMessage = shareLinkText(activeTree);
        const message = shareMessage
          ? `You're now part of “${activeTree.name}”, and it's set as your active tree.\n${shareMessage}`
          : `You're now part of “${activeTree.name}”, and it's set as your active tree.`;
        replies.push(message);

        // Refresh known names for the new tree
        const refreshed = await listPersonsForTree(from);
        if (refreshed?.people) {
          knownNames.length = 0;
          for (const person of refreshed.people) knownNames.push(person.primary_name);
        }
        continue;
      }

      if (op.op === "leave") {
        const result = await leaveCurrentTree(from);
        if (!result.left) {
          replies.push(
            "You're not currently in a family tree, so there's nothing for me to leave."
          );
          continue;
        }
        await setActiveTreeState(from, null);
        await setLastPerson(from, null, null, null);
        activeTree = null;
        lastPersonName = null;
        knownNames.length = 0;
        replies.push(`I removed you from “${result.tree.name}”.`);
        continue;
      }

      if (!activeTree) {
        replies.push(
          "You're not in a family tree yet. You can start one or join with a code that a relative shares with you."
        );
        break;
      }

      if (op.op === "view_tree") {
        const shareMessage = shareLinkText(activeTree);
        const base = `I didn't change anything; “${activeTree.name}” is still your active tree with join code ${activeTree.join_code}.`;
        replies.push(shareMessage ? `${base}\n${shareMessage}` : base);
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
        const person = await upsertPersonByName(
          activeTree.id,
          name,
          op.dob || null
        );

        let message;
        if (!existing) {
          const birthDetail = op.dob ? `, born ${op.dob}` : "";
          message = `I added ${person.primary_name}${birthDetail} to your tree.`;
        } else if (op.dob && op.dob !== (existing.dob_dmy || "")) {
          message = `I updated ${person.primary_name}'s birth information to ${op.dob}.`;
        } else {
          message = `${person.primary_name} was already in the tree, so nothing changed.`;
        }

        replies.push(message);
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        lastPersonName = person.primary_name;
        ensureKnownName(knownNames, person.primary_name);
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

        if (kind === "parent_of") {
          const hint = guessParentDirection(text, A.primary_name, B.primary_name);
          let parentPerson = A;
          let childPerson = B;
          if (hint?.parent === "b") {
            parentPerson = B;
            childPerson = A;
          }
          await addRelationship(
            activeTree.id,
            parentPerson.id,
            "parent_of",
            childPerson.id
          );
          replies.push(
            `${parentPerson.primary_name} is now listed as ${childPerson.primary_name}'s parent.`
          );
          await setLastPerson(
            from,
            activeTree.id,
            childPerson.id,
            childPerson.primary_name
          );
          lastPersonName = childPerson.primary_name;
          continue;
        }

        await addRelationship(activeTree.id, A.id, kind, B.id);
        const pretty = kind === "partner_of" ? "partners" : "spouses";
        replies.push(
          `${A.primary_name} and ${B.primary_name} have been linked as ${pretty}.`
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

        const child = await addChildWithParents(
          activeTree.id,
          op.child,
          op.dob || null,
          op.parentA,
          op.parentB || null
        );

        const parents = [op.parentA, op.parentB].filter(Boolean).join(" and ");
        const childBirthDetail = op.dob ? `, born ${op.dob}` : "";
        replies.push(
          `I added ${child.primary_name}${childBirthDetail} as the child of ${parents}.`
        );
        await setLastPerson(
          from,
          activeTree.id,
          child.id,
          child.primary_name
        );
        lastPersonName = child.primary_name;
        ensureKnownName(knownNames, child.primary_name);
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
          ? `I updated ${person.primary_name}'s birth information to ${op.dob}.`
          : `I cleared ${person.primary_name}'s birth information.`;
        replies.push(message);
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        lastPersonName = person.primary_name;
        ensureKnownName(knownNames, person.primary_name);
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
          `I recorded ${person.primary_name}'s gender as ${prettyGender}.`
        );
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        lastPersonName = person.primary_name;
        ensureKnownName(knownNames, person.primary_name);
        continue;
      }

      if (op.op === "rename") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.from], replies);
        if (!ok) continue;

        const target =
          (await findInTreeByName(activeTree.id, op.from)) ||
          (await upsertPersonByName(activeTree.id, op.from));
        await savePending(from, activeTree.id, {
          type: "rename",
          personId: target.id,
          to: op.to,
        });
        replies.push(
          `You asked me to rename “${target.primary_name}” to “${op.to}”. Reply YES to confirm or NO to cancel. I haven't changed anything yet.`
        );
        await setLastPerson(from, activeTree.id, target.id, target.primary_name);
        lastPersonName = target.primary_name;
        continue;
      }

      if (op.op === "divorce") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.a, op.b], replies);
        if (!ok) continue;

        const A = await upsertPersonByName(activeTree.id, op.a);
        const B = await upsertPersonByName(activeTree.id, op.b);
        await savePending(from, activeTree.id, {
          type: "divorce",
          aId: A.id,
          bId: B.id,
        });
        replies.push(
          `You asked me to mark “${A.primary_name}” and “${B.primary_name}” as divorced. Reply YES to confirm or NO to cancel. I haven't changed anything yet.`
        );
        await setLastPerson(from, activeTree.id, A.id, A.primary_name);
        lastPersonName = A.primary_name;
        continue;
      }
    }

    const combined = replies.join("\n\n");
    await sendText(from, withFollowUp(combined));
    return res.status(200).send("ok");
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Fatal error in webhook:`,
      error
    );

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

  if (action.type === "rename") {
    await editPerson(treeId, action.personId, { newName: action.to });
    await sendText(
      phone,
      withFollowUp(`I renamed that person to “${action.to}”.`)
    );
    return;
  }

  if (action.type === "divorce") {
    await addRelationship(treeId, action.aId, "divorced_from", action.bId);
    await sendText(phone, withFollowUp("I marked them as divorced."));
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
