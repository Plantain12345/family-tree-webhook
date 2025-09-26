import {
  db,
  createTree,
  joinTreeByCode,
  latestTreeFor,
  findPersonByName,
  listPersonsForTree,
  upsertPersonByName,
  addRelationship,
  personSummary,
  mergePersons,
  editPerson,
  leaveCurrentTree,
  normalizeName,
} from "./_db.js";

import { parseIntent } from "./_nlp.js";

export default async function handler(req, res) {
  const VERIFY_TOKEN = "myfamilytree123";

  // Webhook verification
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  // WhatsApp events
  if (req.method === "POST") {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];

    if (msg?.from) {
      const from = msg.from;
      const textRaw = (msg.text?.body || msg.interactive?.button_reply?.id || "").trim();
      const text = textRaw.replace(/\s+/g, " "); // normalize spaces

      // 1) Try natural-language parse first
      const intent = await parseIntent(text);

      if (intent) {
        // Handle parsed intent
        switch (intent.type) {
          case "HELP": {
            await sendHelp(from);
            break;
          }
          case "LEAVE": {
            const result = await leaveCurrentTree(from);
            if (!result.left) await sendText(from, "You’re not in any tree yet.");
            else await sendText(from, `✅ You left “${result.tree.name}”.`);
            break;
          }
          case "NEW_TREE": {
            const name = intent.data.name?.slice(0, 80) || "My Family";
            try {
              const tree = await createTree(name, from);
              await sendText(from, `✅ Created “${tree.name}”. Code: ${tree.join_code}\nOthers can reply: JOIN ${tree.join_code}`);
            } catch (e) {
              console.error(e);
              await sendText(from, "❌ Couldn't create the tree. Try a different name.");
            }
            break;
          }
          case "JOIN_TREE": {
            const code = (intent.data.code || "").toUpperCase();
            const tree = await joinTreeByCode(code, from);
            if (!tree) await sendText(from, "❌ Code not found. Ask the owner to re-share.");
            else await sendText(from, `✅ Switched to “${tree.name}”. You can ADD / VIEW / LINK now.`);
            break;
          }
          case "ADD_PERSON": {
            const tree = await latestTreeFor(from);
            if (!tree) { await sendText(from, "Create or join a tree first (HELP)."); break; }
            const namePart = intent.data.person_name;
            const maybeDob = intent.data.dob || null;

            const norm = normalizeName(namePart);
            if (!norm) { await sendText(from, "Please include a name."); break; }

            const { data: all } = await db.from("persons").select("*").eq("tree_id", tree.id);
            let existing = all?.find(p => normalizeName(p.primary_name) === norm);

            if (existing) {
              if (maybeDob && !existing.dob_dmy) {
                await db.from("persons").update({ dob_dmy: maybeDob }).eq("id", existing.id);
              }
              await sendText(from, `ℹ️ Using existing person: ${existing.primary_name}.`);
            } else {
              const { data: created, error } = await db
                .from("persons")
                .insert({ tree_id: tree.id, primary_name: namePart.trim(), dob_dmy: maybeDob })
                .select()
                .single();
              if (error) { console.error(error); await sendText(from, "❌ Couldn't add that person."); break; }
              existing = created;
              await sendText(from, `✅ Added ${existing.primary_name} to “${tree.name}”.`);
            }
            break;
          }
          case "LINK_REL": {
            const tree = await latestTreeFor(from);
            if (!tree) { await sendText(from, "Create or join a tree first (HELP)."); break; }
            const { a, b, kind } = intent.data; // kind: spouse_of|partner_of|parent_of
            const A = await upsertPersonByName(tree.id, a);
            const B = await upsertPersonByName(tree.id, b);
            await addRelationship(tree.id, A.id, kind, B.id);
            await sendText(from,
              kind === "parent_of"
                ? `✅ Linked ${A.primary_name} → ${B.primary_name} (parent_of).`
                : `✅ Linked ${A.primary_name} ↔ ${B.primary_name} (${kind.replace("_", " ")}).`
            );
            break;
          }
          case "EDIT_PERSON": {
            const tree = await latestTreeFor(from);
            if (!tree) { await sendText(from, "Create or join a tree first (HELP)."); break; }
            const who = intent.data.target_name;
            const person = await upsertPersonByName(tree.id, who);
            await editPerson(tree.id, person.id, { newName: intent.data.new_name, dob_dmy: intent.data.new_dob });
            await sendText(from, `✏️ Updated ${person.primary_name}.`);
            break;
          }
          case "VIEW_TREE": {
            const result = await listPersonsForTree(from);
            if (!result) await sendText(from, "No tree found. Create or join one first.");
            else if (!result.people.length) await sendText(from, `Tree “${result.tree.name}” is empty.`);
            else {
              const lines = result.people.map(p => `• ${p.primary_name}${p.dob_dmy ? " (b. " + p.dob_dmy + ")" : ""}`);
              await sendText(from, `👪 Tree: ${result.tree.name}\n` + lines.join("\n"));
            }
            break;
          }
          case "VIEW_PERSON": {
            const name = intent.data.view_name;
            const person = await findPersonByName(from, name);
            if (!person) await sendText(from, `❌ No match found for “${name}”.`);
            else {
              const tree = await latestTreeFor(from);
              const rels = await personSummary(tree.id, person.id);
              const lines = [
                `ℹ️ ${person.primary_name}${person.dob_dmy ? `, b. ${person.dob_dmy}` : ""}`,
                rels.spouses?.length ? `• Spouse(s): ${rels.spouses.join(", ")}` : null,
                rels.parents?.length ? `• Parent(s): ${rels.parents.join(", ")}` : null,
                rels.children?.length ? `• Children: ${rels.children.join(", ")}` : null,
              ].filter(Boolean);
              await sendText(from, lines.join("\n"));
            }
            break;
          }
          default: {
            // Unknown intent → fall back
            await fallbackRouter(from, text);
          }
        }

        // Done handling parsed intent
        return res.status(200).send("ok");
      }

      // 2) No intent parsed → use your original keyword router (fallback)
      await fallbackRouter(from, text);
    }

    return res.status(200).send("ok");
  }

  return res.status(404).send("Not found");
}

/* ---------------------- Fallback keyword router ---------------------- */
async function fallbackRouter(from, text) {
  if (/^help$/i.test(text)) {
    await sendHelp(from);
  } else if (text === "NEW") {
    await sendText(from, "Reply with: NEW <Tree Name>");
  } else if (/^new\s+.+/i.test(text)) {
    // You can keep or remove these if you prefer only NL
    await sendText(from, "Tip: You can also say “Start a new tree called Kintu Family”.");
  } else if (text === "JOIN") {
    await sendText(from, "Reply with: JOIN <Code>");
  } else if (/^view\s+tree$/i.test(text)) {
    // Keep a minimal fallback
    await sendText(from, "Say: “Show me the tree” or “View tree”.");
  } else {
    await sendText(from, "I can understand plain English now 😊  Try: “Add Alice born 1950”, “Link Alice spouse Bob”, or “Show Alice”. Type HELP for more.");
    await sendMenu(from);
  }
}

async function sendHelp(to) {
  await sendText(
    to,
    [
      "I understand plain English. Try:",
      "• “Start a new tree called Kintu Family”",
      "• “Join code ABC123”",
      "• “Add Alice born 1950”",
      "• “Link Alice spouse Bob”",
      "• “Change Alice to Alice N.”",
      "• “Show Alice” or “Show the tree”",
      "• “Leave tree”",
    ].join("\n")
  );
  await sendMenu(to);
}

/* ----------------------- WhatsApp send helpers ----------------------- */
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
            { type: "reply", reply: { id: "HELP", title: "Help" } },
          ],
        },
      },
    }),
  });
}
