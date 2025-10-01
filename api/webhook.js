// api/webhook.js
import {
  createTree,
  joinTreeByCode,
  latestTreeFor,
  listPersonsForTree,
  findInTreeByName,
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

export default async function handler(req, res) {
  // webhook verify
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
    const text = (msg.text?.body || msg.interactive?.button_reply?.id || "").trim();
    const lower = text.toLowerCase();

@@ -258,116 +322,142 @@ export default async function handler(req, res) {
        await setLastPerson(from, tree.id, p.id, p.primary_name);
        continue;
      }

      // LINK — robust to missing/invalid kind
      if (op.op === "link") {
        const A = await upsertPersonByName(tree.id, op.a);
        const B = await upsertPersonByName(tree.id, op.b);

        // Normalize kind with fallbacks based on the user's original text
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
            // Safe default for ambiguous "link A and B"
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
          await addRelationship(tree.id, parentPerson.id, "parent_of", childPerson.id);
          replies.push(
            `✅ Linked ${parentPerson.primary_name} → ${childPerson.primary_name} (parent of).`
          );
          await setLastPerson(from, tree.id, childPerson.id, childPerson.primary_name);
          continue;
        }

        await addRelationship(tree.id, A.id, kind, B.id);

        const pretty = kind.replace("_", " ");
        replies.push(`✅ Linked ${A.primary_name} ↔ ${B.primary_name} (${pretty}).`);

        await setLastPerson(from, tree.id, B.id, B.primary_name);
        continue;
      }

      // ADD CHILD (supports one or two parents)
      if (op.op === "add_child") {
        const child = await addChildWithParents(
          tree.id,
          op.child,
          op.dob || null,
          op.parentA,
          op.parentB || null
        );
        replies.push(
          `✅ Added ${op.child}${
            op.dob ? ` (b. ${op.dob})` : ""
          } as child of ${op.parentA}${op.parentB ? " and " + op.parentB : ""}.`
        );
        await setLastPerson(from, tree.id, child.id, child.primary_name);
        continue;
      }

      // SET DOB
      if (op.op === "set_dob") {
        const p = await upsertPersonByName(tree.id, op.name, op.dob || null);
        replies.push(`✅ Set ${p.primary_name}'s birth to ${op.dob}.`);
        await setLastPerson(from, tree.id, p.id, p.primary_name);
        continue;
      }

      if (op.op === "set_gender") {
        const normalized = normalizeGenderValue(op.gender);
        if (!normalized) {
          replies.push(`❌ I couldn't understand the gender for “${op.name}”.`);
          continue;
        }
        const p = await upsertPersonByName(tree.id, op.name);
        await editPerson(tree.id, p.id, { gender: normalized });
        const prettyGender = normalized.charAt(0).toUpperCase() + normalized.slice(1);
        replies.push(`✅ Set ${p.primary_name}'s gender to ${prettyGender}.`);
        await setLastPerson(from, tree.id, p.id, p.primary_name);
        continue;
      }

      // RENAME (confirmation)
      if (op.op === "rename") {
        const target =
          (await findInTreeByName(tree.id, op.from)) ||
          (await upsertPersonByName(tree.id, op.from));
        await savePending(from, tree.id, {
          type: "rename",
          personId: target.id,
          to: op.to,
        });
        replies.push(
          `You want to rename “${target.primary_name}” to “${op.to}”. Reply YES to confirm, NO to cancel.`
        );
        continue;
      }

      // DIVORCE (confirmation)
      if (op.op === "divorce") {
        const A = await upsertPersonByName(tree.id, op.a);
        const B = await upsertPersonByName(tree.id, op.b);
        await savePending(from, tree.id, {
          type: "divorce",
          aId: A.id,
          bId: B.id,
        });
        replies.push(
          `You want to mark “${A.primary_name}” and “${B.primary_name}” as divorced. Reply YES to confirm, NO to cancel.`
        );
        continue;
      }
    }

    // send combined reply (split if long)
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

    // Try to notify the user
@@ -378,51 +468,51 @@ export default async function handler(req, res) {
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
    await sendText(phone, "That action can't be completed.");
    return;
  }

  if (action.type === "rename") {
    await editPerson(treeId, action.personId, { newName: action.to });
    await sendText(phone, `✏️ Renamed successfully to “${action.to}”.`);
    return;
  }
  if (action.type === "divorce") {
    await addRelationship(treeId, action.aId, "divorced_from", action.bId);
    await sendText(phone, "✅ Marked as divorced.");
    return;
  }
  await sendText(phone, "That action can't be completed.");
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
      console.error(
        `[${new Date().toISOString()}] Send error:`,
        resp.status,
        errorText
      );
    } else {
      console.log(
        `[${new Date().toISOString()}] Message sent successfully to ${to}`
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
            type: "button",
            body: { text: "What would you like to do?" },
            action: {
              buttons: [
                { type: "reply", reply: { id: "NEW",  title: "Start a tree" } },
                { type: "reply", reply: { id: "JOIN", title: "Join a tree" } },
                { type: "reply", reply: { id: "HELP", title: "Help" } },
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
    "I understand plain English. Try:",
    "• \"Start a new tree called Kintu Family\"",
    "• \"Join code ABC123\"",
    "• \"Add Alice born 1950\"",
    "• \"Add his son Zaake born 1983\"",
    "• \"Link Alice married to Bob\"",
    "• \"Show Alice\" or \"Show the tree\"",
    "• \"Divorce Alice and Bob\" (will ask to confirm)",
    "• \"Leave tree\"",
  ].join("\n");
}
