// api/webhook.js
import {
  db,
  createTree, joinTreeByCode, latestTreeFor,
  listPersonsForTree, findInTreeByName, upsertPersonByName,
  addRelationship, addChildWithParents, editPerson,
  personSummary, leaveCurrentTree,
  savePending, popPending, normalizeName
} from "./_db.js";

import { parseOps } from "./_nlp.js";

const BASE_URL = "https://family-tree-webhook.vercel.app";
const VERIFY_TOKEN = "myfamilytree123";

function treeUrl(code) { return `${BASE_URL}/tree.html?code=${encodeURIComponent(code)}`; }

export default async function handler(req, res) {
  // webhook verify
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const change = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg = change?.messages?.[0];
  if (!msg?.from) return res.status(200).send("no-op");

  const from = msg.from;
  const text = (msg.text?.body || msg.interactive?.button_reply?.id || "").trim();

  // Handle YES/NO confirmations first
  const lower = text.toLowerCase();
  if (["yes", "y"].includes(lower)) {
    const pending = await popPending(from);
    if (!pending) { await sendText(from, "Nothing pending to confirm."); return res.status(200).send("ok"); }
    await runConfirmed(pending, from);
    return res.status(200).send("ok");
  }
  if (["no", "n", "cancel", "stop"].includes(lower)) {
    const pending = await popPending(from);
    if (!pending) { await sendText(from, "Nothing pending to cancel."); return res.status(200).send("ok"); }
    await sendText(from, "Okay, cancelled.");
    return res.status(200).send("ok");
  }

  // Parse ops via LLM (LLM-first)
  const ops = await parseOps(text);
  if (!ops || !ops.length) {
    await sendText(from, "I didn’t get that. Try: “Start a new tree called Kintu Family”, “Join code ABC123”, “Add Alice born 1950”, “Link Alice married to Bob”, “Show Alice”. Type HELP for more.");
    await sendMenu(from);
    return res.status(200).send("ok");
  }

  const replies = [];

  for (const op of ops) {
    // HELP
    if (op.op === "help") {
      replies.push(helpText());
      continue;
    }

    // LEAVE
    if (op.op === "leave") {
      const r = await leaveCurrentTree(from);
      replies.push(r.left ? `✅ You left “${r.tree.name}”.` : "You’re not in any tree yet.");
      continue;
    }

    // NEW TREE (returns {tree, tip})
    if (op.op === "new_tree") {
      const name = (op.name || "My Family").slice(0, 80);
      try {
        const { tree, tip } = await createTree(name, from);
        replies.push(`✅ Created “${tree.name}”. Code: ${tree.join_code}\n${tip}`);
      } catch (e) {
        console.error(e);
        replies.push("❌ Couldn't create the tree. Try a different name.");
      }
      continue;
    }

    // JOIN TREE (returns {tree, tip})
    if (op.op === "join_tree") {
      const code = (op.code || "").toUpperCase();
      const { tree, tip } = await joinTreeByCode(code, from);
      replies.push(
        tree
          ? `✅ Switched to “${tree.name}”.\n${tip}`
          : "❌ Code not found. Ask the owner to re-share."
      );
      continue;
    }

    // VIEW TREE
    if (op.op === "view_tree") {
      const result = await listPersonsForTree(from);
      if (!result) { replies.push("No tree found. Create or join one first."); continue; }
      if (!result.people.length) { replies.push(`Tree “${result.tree.name}” is empty.\nLive tree: ${treeUrl(result.tree.join_code)}`); continue; }
      const lines = result.people.map(p => `• ${p.primary_name}${p.dob_dmy ? " (b. " + p.dob_dmy + ")" : ""}`);
      replies.push(`👪 Tree: ${result.tree.name}\n${lines.join("\n")}\n\nLive tree: ${treeUrl(result.tree.join_code)}`);
      continue;
    }

    // VIEW PERSON
    if (op.op === "view_person") {
      const result = await listPersonsForTree(from);
      if (!result) { replies.push("No tree found. Create or join one first."); continue; }
      const person = await findInTreeByName(result.tree.id, op.name);
      if (!person) { replies.push(`❌ No match found for “${op.name}”.`); continue; }
      const rels = await personSummary(result.tree.id, person.id);
      replies.push(
        [
          `ℹ️ ${person.primary_name}${person.dob_dmy ? `, b. ${person.dob_dmy}` : ""}`,
          rels.spouses?.length ? `• Spouse(s): ${rels.spouses.join(", ")}` : null,
          rels.parents?.length ? `• Parent(s): ${rels.parents.join(", ")}` : null,
          rels.children?.length ? `• Children: ${rels.children.join(", ")}` : null,
          `Live tree: ${treeUrl(result.tree.join_code)}`
        ].filter(Boolean).join("\n")
      );
      continue;
    }

    // ---------- All ops below require an active tree ----------
    const tree = await latestTreeFor(from);
    if (!tree) { replies.push("Create or join a tree first (type HELP)."); break; }

    // ADD PERSON
    if (op.op === "add_person") {
      const p = await upsertPersonByName(tree.id, op.name, op.dob || null);
      replies.push(`✅ Added ${p.primary_name}${p.dob_dmy ? ` (b. ${p.dob_dmy})` : ""} to “${tree.name}”.`);
      continue;
    }

    // LINK (spouse_of/partner_of/parent_of)
    if (op.op === "link") {
      const A = await upsertPersonByName(tree.id, op.a);
      const B = await upsertPersonByName(tree.id, op.b);
      await addRelationship(tree.id, A.id, op.kind, B.id);
      replies.push(
        op.kind === "parent_of"
          ? `✅ Linked ${A.primary_name} → ${B.primary_name} (parent_of).`
          : `✅ Linked ${A.primary_name} ↔ ${B.primary_name} (${op.kind.replace("_"," ")}).`
      );
      continue;
    }

    // ADD CHILD (supports one or two parents)
    if (op.op === "add_child") {
      await addChildWithParents(tree.id, op.child, op.dob || null, op.parentA, op.parentB || null);
      replies.push(`✅ Added ${op.child}${op.dob ? ` (b. ${op.dob})` : ""} as child of ${op.parentA}${op.parentB ? " and " + op.parentB : ""}.`);
      continue;
    }

    // SET DOB
    if (op.op === "set_dob") {
      const p = await upsertPersonByName(tree.id, op.name, op.dob || null);
      replies.push(`✅ Set ${p.primary_name}'s birth to ${op.dob}.`);
      continue;
    }

    // RENAME (confirmation)
    if (op.op === "rename") {
      const target = await findInTreeByName(tree.id, op.from) || await upsertPersonByName(tree.id, op.from);
      await savePending(from, tree.id, { type: "rename", personId: target.id, to: op.to });
      replies.push(`You want to rename “${target.primary_name}” to “${op.to}”. Reply YES to confirm, NO to cancel.`);
      continue;
    }

    // DIVORCE (confirmation)
    if (op.op === "divorce") {
      const A = await upsertPersonByName(tree.id, op.a);
      const B = await upsertPersonByName(tree.id, op.b);
      await savePending(from, tree.id, { type: "divorce", aId: A.id, bId: B.id });
      replies.push(`You want to remove the spouse link between “${A.primary_name}” and “${B.primary_name}”. Reply YES to confirm, NO to cancel.`);
      continue;
    }
  }

  // send combined reply (split if long)
  const out = replies.join("\n\n");
  await sendText(from, out.length > 3900 ? out.slice(0, 3900) : out);
  return res.status(200).send("ok");
}

/* ---------- run confirmed actions ---------- */
async function runConfirmed(pending, phone) {
  const action = pending.action || {};
  const treeId = pending.tree_id;
  if (!action.type || !treeId) { await sendText(phone, "That action can't be completed."); return; }

  if (action.type === "rename") {
    await editPerson(treeId, action.personId, { newName: action.to });
    await sendText(phone, `✏️ Renamed successfully to “${action.to}”.`);
    return;
  }
  if (action.type === "divorce") {
    await addRelationship(treeId, action.aId, "divorced_from", action.bId);
    await sendText(phone, "✅ Spouse link removed.");
    return;
  }
  await sendText(phone, "That action can't be completed.");
}

/* ---------- WhatsApp helpers ---------- */
async function sendText(to, body) {
  const resp = await fetch(`https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WABA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
  });
  if (!resp.ok) console.log("Send error:", resp.status, await resp.text());
}

async function sendMenu(to) {
  await fetch(`https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WABA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "What would you like to do?" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "NEW", title: "Start a tree" } },
            { type: "reply", reply: { id: "JOIN", title: "Join a tree" } },
            { type: "reply", reply: { id: "HELP", title: "Help" } }
          ]
        }
      }
    })
  });
}

function helpText() {
  return [
    "I understand plain English. Try:",
    "• “Start a new tree called Kintu Family”",
    "• “Join code ABC123”",
    "• “Add Alice born 1950”",
    "• “Link Alice married to Bob”",
    "• “Rename Link Alice to Jane”",
    "• “Jane is Alice and Bob’s daughter born 1973”",
    "• “Show Alice” or “Show the tree”",
    "• “Divorce Alice and Bob” (will ask to confirm)",
    "• “Leave tree”"
  ].join("\n");
}
