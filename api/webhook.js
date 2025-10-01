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

function treeUrl(code) {
  return `${BASE_URL}/tree.html?code=${encodeURIComponent(code)}`;
}

const PRONOUNS = new Set([
  "his",
  "her",
@@ -37,294 +37,764 @@ const PRONOUNS = new Set([
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
]);

const FOLLOW_UP_PROMPT =
  "What else would you like to do to your family tree? I understand plain english. Or type 'menu' to view your options.";

const MENU_ALIASES = {
  NEW: "MENU_START_TREE",
  JOIN: "MENU_JOIN_TREE",
  HELP: "MENU_HELP",
};

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

function appendFollowUp(message) {
  const trimmed = (message || "").trim();
  if (!trimmed) return FOLLOW_UP_PROMPT;
  return `${trimmed}\n\n${FOLLOW_UP_PROMPT}`;
}

function buildRelationshipContext(people = [], rels = []) {
  if (!people.length || !rels.length) return [];
  const nameById = new Map(people.map((p) => [p.id, p.primary_name]));
  return rels
    .map((rel) => {
      const aName = nameById.get(rel.a);
      const bName = nameById.get(rel.b);
      if (!aName || !bName) return null;
      return { a: aName, b: bName, kind: rel.kind };
    })
    .filter(Boolean);
}

async function describeAmbiguity(treeId, name) {
  if (!treeId || !name) return null;
  const matches = await listPersonsByExactName(treeId, name);
  if (matches.length <= 1) return null;

  const bullets = [];
  for (const match of matches) {
    let summary;
    try {
      summary = await personSummary(treeId, match.id);
    } catch (error) {
      console.error("personSummary error while disambiguating:", error);
      summary = null;
    }

    const details = [];
    if (match.dob_dmy) details.push(`born ${match.dob_dmy}`);
    if (summary?.parents?.length)
      details.push(`parent(s): ${summary.parents.join(", ")}`);
    if (summary?.children?.length)
      details.push(`child(ren): ${summary.children.join(", ")}`);
    if (summary?.spouses?.length)
      details.push(`spouse(s): ${summary.spouses.join(", ")}`);

    const descriptor = details.length
      ? `${match.primary_name} (${details.join("; ")})`
      : `${match.primary_name} (no extra details yet)`;
    bullets.push(`• ${descriptor}`);
  }

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
      replies.push(appendFollowUp(`${note}\nI haven't made any changes yet.`));
      return false;
    }
  }
  return true;
}

function menuGuidanceText(id, tree) {
  switch (id) {
    case "MENU_START_TREE":
      return "To start a new family tree, tell me its name. For example, say \"Create a family tree called The Kintu Family\".";
    case "MENU_JOIN_TREE":
      return "To join an existing tree, send the six-letter join code. Try something like \"Join ABC123\".";
    case "MENU_SHOW_CODE":
      if (tree) {
        return `Your current tree is “${tree.name}”. Share the join code ${tree.join_code} so others can join.`;
      }
      return "You're not in a tree yet. You can start one or join with a code that someone shares with you.";
    case "MENU_ADD_PERSON":
      return "Tell me about the person you'd like to add. For example, say \"Add Alice born 1950\".";
    case "MENU_LINK_RELATIVES":
      return "Describe the relationship you want me to add, such as \"Link Maria is John's mother\" or \"Add his son Noah\".";
    case "MENU_EDIT_PERSON":
      return "Let me know what needs updating. You can say things like \"Rename Maria to Mary\" or \"Set John's birth year to 1980\".";
    case "MENU_LEAVE_TREE":
      if (tree) {
        return `If you'd like to leave “${tree.name}”, just say \"Leave tree\" and I'll take care of it.`;
      }
      return "You're not currently part of a family tree, so there's nothing to leave.";
    case "MENU_HELP":
      return helpText();
    default:
      return "You can always tell me what you need in plain English.";
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

  if (req.method !== "POST")
    return res.status(405).send("Method Not Allowed");

  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg?.from) return res.status(200).send("no-op");

    const from = msg.from;
    const interactiveIdRaw =
      msg.interactive?.list_reply?.id ||
      msg.interactive?.button_reply?.id ||
      null;
    const textBody = msg.text?.body || "";
    const text = (textBody || interactiveIdRaw || "").trim();
    const lower = text.toLowerCase();

    const userState = await getUserState(from);
    const treeContext = await listPersonsForTree(from);
    const tree = treeContext?.tree || null;
    const people = treeContext?.people || [];
    const rels = treeContext?.rels || [];
    const relationships = buildRelationshipContext(people, rels);

    const ctx = {
      active_tree_name: tree?.name || null,
      last_person_name: userState?.last_person_name || null,
      people: people.map((p) => p.primary_name),
      relationships,
    };

    if (!text) {
      await sendText(
        from,
        appendFollowUp(
          "I didn't catch that. Please try again or type 'menu' to see your options."
        )
      );
      return res.status(200).send("ok");
    }

    const normalizedInteractiveId =
      interactiveIdRaw && (MENU_ALIASES[interactiveIdRaw] || interactiveIdRaw);

    if (
      normalizedInteractiveId &&
      normalizedInteractiveId.startsWith("MENU_")
    ) {
      const guidance = menuGuidanceText(normalizedInteractiveId, tree);
      await sendText(from, appendFollowUp(guidance));
      return res.status(200).send("ok");
    }

    if (lower === "menu") {
      await sendMenu(from);
      await sendText(
        from,
        appendFollowUp("I've sent you the menu of quick options.")
      );
      return res.status(200).send("ok");
    }

    if (/^(yes|y)$/i.test(lower)) {
      const pending = await popPending(from);
      if (!pending) {
        await sendText(
          from,
          appendFollowUp("There isn't anything waiting for confirmation right now.")
        );
      } else {
        await runConfirmed(pending, from);
      }
      return res.status(200).send("ok");
    }

    if (/^(no|n|cancel)$/i.test(lower)) {
      const pending = await popPending(from);
      if (pending) {
        await sendText(
          from,
          appendFollowUp("Okay, I cancelled that request.")
        );
      } else {
        await sendText(
          from,
          appendFollowUp("There's nothing waiting for confirmation right now.")
        );
      }
      return res.status(200).send("ok");
    }

    let ops = await parseOps(text, ctx);
    if (!ops || !ops.length) {
      await sendText(
        from,
        appendFollowUp(
          'I am not sure how to help with that. Try saying "help" or "menu".'
        )
      );
      return res.status(200).send("ok");
    }

    let activeTree = tree;
    const replies = [];

    for (const op of ops) {
      if (op.op === "help") {
        replies.push(appendFollowUp(helpText()));
        continue;
      }

      if (op.op === "menu") {
        await sendMenu(from);
        replies.push(appendFollowUp("I've sent you the menu of quick options."));
        continue;
      }

      if (op.op === "new_tree") {
        if (!op.name) {
          replies.push(
            appendFollowUp(
              "I need a name for the new family tree. Try saying something like \"Create a tree called The Kintu Family\"."
            )
          );
          continue;
        }

        const trimmed = op.name.trim();
        const { tree: createdTree } = await createTree(trimmed, from);
        await setActiveTreeState(from, createdTree.id);
        await setLastPerson(from, createdTree.id, null, null);
        activeTree = createdTree;
        const liveUrl = treeUrl(createdTree.join_code);
        const message =
          `I created a new family tree called “${createdTree.name}” and made it your active tree. Share the join code ${createdTree.join_code} or visit ${liveUrl} to view it.`;
        replies.push(appendFollowUp(message));
        continue;
      }

      if (op.op === "join_tree") {
        if (!op.code) {
          replies.push(
            appendFollowUp(
              "Please tell me the six-letter code you'd like to join, for example \"Join ABC123\"."
            )
          );
          continue;
        }

        const joinResult = await joinTreeByCode(op.code.toUpperCase(), from);
        if (!joinResult.tree) {
          replies.push(
            appendFollowUp(
              `I couldn't find a tree with the code ${op.code.toUpperCase()}, so nothing changed.`
            )
          );
          continue;
        }

        activeTree = joinResult.tree;
        await setActiveTreeState(from, activeTree.id);
        await setLastPerson(from, activeTree.id, null, null);
        const liveUrl = treeUrl(activeTree.join_code);
        const message =
          `I added you to “${activeTree.name}” and made it your active tree. Share the join code ${activeTree.join_code} or visit ${liveUrl} to see it.`;
        replies.push(appendFollowUp(message));
        continue;
      }

      if (op.op === "leave") {
        const result = await leaveCurrentTree(from);
        if (!result.left) {
          replies.push(
            appendFollowUp(
              "You're not currently in a family tree, so there's nothing for me to leave."
            )
          );
          continue;
        }
        await setActiveTreeState(from, null);
        await setLastPerson(from, null, null, null);
        activeTree = null;
        replies.push(
          appendFollowUp(
            `I removed you from “${result.tree.name}”.`
          )
        );
        continue;
      }

      if (op.op === "view_tree") {
        if (!activeTree) {
          replies.push(
            appendFollowUp(
              "You're not in a family tree yet. You can start one or join with a code from a relative."
            )
          );
          continue;
        }
        const liveUrl = treeUrl(activeTree.join_code);
        const message =
          `I didn't change anything; here's the information you asked for. “${activeTree.name}” uses join code ${activeTree.join_code} and you can view it at ${liveUrl}.`;
        replies.push(appendFollowUp(message));
        continue;
      }

      if (op.op === "view_person") {
        if (!activeTree) {
          replies.push(
            appendFollowUp(
              "You're not in a family tree yet, so I can't show any relatives."
            )
          );
          continue;
        }

        const ok = await ensureNamesAreDistinct(activeTree, [op.name], replies);
        if (!ok) continue;

        const target = await findInTreeByName(activeTree.id, op.name);
        if (!target) {
          replies.push(
            appendFollowUp(
              `I couldn't find anyone named ${op.name} in this tree.`
            )
          );
          continue;
        }

        const summary = await personSummary(activeTree.id, target.id);
        const bits = [`Here's what I know about ${summary?.me || target.primary_name}.`];
        if (summary?.parents?.length)
          bits.push(`Parents: ${summary.parents.join(", ")}`);
        if (summary?.spouses?.length)
          bits.push(`Spouses: ${summary.spouses.join(", ")}`);
        if (summary?.children?.length)
          bits.push(`Children: ${summary.children.join(", ")}`);
        if (bits.length === 1)
          bits.push("No relatives are linked yet.");
        replies.push(appendFollowUp(`${bits.join("\n")}`));
        await setLastPerson(from, activeTree.id, target.id, target.primary_name);
        continue;
      }

      if (!activeTree) {
        replies.push(
          appendFollowUp(
            "You're not in a family tree yet. Start one or join with a code before making changes."
          )
        );
        continue;
      }

      if (op.op === "add_person") {
        const name = (op.name || "").trim();
        if (!name) {
          replies.push(
            appendFollowUp(
              "Please tell me the person's name so I can add them."
            )
          );
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
          message = `I added ${person.primary_name}${
            op.dob ? `, born ${op.dob}` : ""
          } to your tree.`;
        } else if (op.dob && op.dob !== (existing.dob_dmy || "")) {
          message = `I updated ${person.primary_name}'s birth information to ${op.dob}.`;
        } else {
          message = `I found ${person.primary_name} already in your tree, so nothing needed to change.`;
        }

        replies.push(appendFollowUp(message));
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        continue;
      }

      if (op.op === "link") {
        const ok = await ensureNamesAreDistinct(
          activeTree,
          [op.a, op.b],
          replies
        );
        if (!ok) continue;

        const A = await upsertPersonByName(activeTree.id, op.a);
        const B = await upsertPersonByName(activeTree.id, op.b);

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
            appendFollowUp(
              `I linked ${parentPerson.primary_name} as ${childPerson.primary_name}'s parent.`
            )
          );
          await setLastPerson(
            from,
            activeTree.id,
            childPerson.id,
            childPerson.primary_name
          );
          continue;
        }

        await addRelationship(activeTree.id, A.id, kind, B.id);
        const pretty = kind === "partner_of" ? "partners" : "spouses";
        replies.push(
          appendFollowUp(
            `I linked ${A.primary_name} and ${B.primary_name} as ${pretty}.`
          )
        );
        await setLastPerson(from, activeTree.id, B.id, B.primary_name);
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
        const message = `I added ${child.primary_name}${
          op.dob ? `, born ${op.dob}` : ""
        } as the child of ${parents}.`;
        replies.push(appendFollowUp(message));
        await setLastPerson(
          from,
          activeTree.id,
          child.id,
          child.primary_name
        );
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
        replies.push(appendFollowUp(message));
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        continue;
      }

      if (op.op === "set_gender") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.name], replies);
        if (!ok) continue;

        const normalized = normalizeGenderValue(op.gender);
        if (!normalized) {
          replies.push(
            appendFollowUp(
              `I couldn't understand the gender you provided for ${op.name}, so I didn't change anything.`
            )
          );
          continue;
        }

        const person = await upsertPersonByName(activeTree.id, op.name);
        await editPerson(activeTree.id, person.id, { gender: normalized });
        const prettyGender =
          normalized.charAt(0).toUpperCase() + normalized.slice(1);
        replies.push(
          appendFollowUp(
            `I recorded ${person.primary_name}'s gender as ${prettyGender}.`
          )
        );
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
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
          appendFollowUp(
            `You asked me to rename “${target.primary_name}” to “${op.to}”. Reply YES to confirm or NO to cancel. I haven't changed anything yet.`
          )
        );
        continue;
      }

      if (op.op === "divorce") {
        const ok = await ensureNamesAreDistinct(
          activeTree,
          [op.a, op.b],
          replies
        );
        if (!ok) continue;

        const A = await upsertPersonByName(activeTree.id, op.a);
        const B = await upsertPersonByName(activeTree.id, op.b);
        await savePending(from, activeTree.id, {
          type: "divorce",
          aId: A.id,
          bId: B.id,
        });
        replies.push(
          appendFollowUp(
            `You asked me to mark “${A.primary_name}” and “${B.primary_name}” as divorced. Reply YES to confirm or NO to cancel. I haven't changed anything yet.`
          )
        );
        continue;
      }
    }

    if (!replies.length) {
      replies.push(
        appendFollowUp(
          "I'm ready for your next instruction whenever you are."
        )
      );
    }

    const out = replies.join("\n\n");
    const finalMessage = out.length > 3900 ? out.slice(0, 3900) : out;

    console.log(
      `[${new Date().toISOString()}] Sending reply to ${from}: ${finalMessage.substring(
        0,
        120
      )}...`
    );

    await sendText(from, finalMessage);
    return res.status(200).send("ok");
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Fatal error in webhook:`,
      error
    );

    try {
      const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) {
        await sendText(
          from,
          appendFollowUp(
            "Something went wrong on my side, so I didn't make any changes. Please try again in a moment."
          )
        );
      }
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
    await sendText(phone, appendFollowUp("That action can't be completed."));
    return;
  }

  if (action.type === "rename") {
    await editPerson(treeId, action.personId, { newName: action.to });
    await sendText(
      phone,
      appendFollowUp(`I renamed that person to “${action.to}”.`)
    );
    return;
  }
  if (action.type === "divorce") {
    await addRelationship(treeId, action.aId, "divorced_from", action.bId);
    let pairText = "those relatives";
    try {
      const [aSummary, bSummary] = await Promise.all([
        personSummary(treeId, action.aId),
        personSummary(treeId, action.bId),
      ]);
      if (aSummary?.me && bSummary?.me)
        pairText = `${aSummary.me} and ${bSummary.me}`;
    } catch (error) {
      console.error("divorce confirmation summary error:", error);
    }
    await sendText(
      phone,
      appendFollowUp(`I marked ${pairText} as divorced.`)
    );
    return;
  }
  await sendText(phone, appendFollowUp("That action can't be completed."));
}

/* ---------- WhatsApp helpers ---------- */
async function sendText(to, body) {
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
@@ -339,68 +809,116 @@ async function sendText(to, body) {
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
                      description: "Share the code for your current tree",
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
                      description: "Update a name, birth year, or gender",
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
