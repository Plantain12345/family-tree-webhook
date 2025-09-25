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
} from "./_db.js";

export default async function handler(req, res) {
  const VERIFY_TOKEN = "myfamilytree123";

  // Webhook verification
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  // Handle WhatsApp events
  if (req.method === "POST") {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];

    if (msg?.from) {
      const from = msg.from;
      const text = (msg.text?.body || msg.interactive?.button_reply?.id || "").trim();

      if (/^help$/i.test(text)) {
        await sendText(
          from,
          "Commands:\n" +
            "• NEW <Tree Name>\n" +
            "• JOIN <Code>\n" +
            "• ADD: <person details>\n" +
            "• LINK: Alice spouse Bob | Alice parent_of Carol\n" +
            "• VIEW TREE\n" +
            "• VIEW <Name>"
        );
        await sendMenu(from);

      } else if (text === "NEW") {
        await sendText(from, "Reply with: NEW <Tree Name>");

      } else if (/^new\s+.+/i.test(text)) {
        const name = text.replace(/^new\s+/i, "").slice(0, 80);
        try {
          const tree = await createTree(name, from);
          await sendText(
            from,
            `✅ Created “${tree.name}”. Share code: ${tree.join_code}\nOthers can reply: JOIN ${tree.join_code}`
          );
        } catch (e) {
          console.error(e);
          await sendText(from, "❌ Couldn't create the tree. Try a different name.");
        }

      } else if (text === "JOIN") {
        await sendText(from, "Reply with: JOIN <Code>");

      } else if (/^join\s+[A-Z0-9]{6}$/i.test(text)) {
        const code = text.replace(/^join\s+/i, "").toUpperCase();
        const tree = await joinTreeByCode(code, from);
        if (!tree) {
          await sendText(from, "❌ Code not found. Ask the owner to re-share.");
        } else {
          await sendText(from, `✅ Joined “${tree.name}”. Now send: ADD: <person details>`);
        }

      } else if (/^add:/i.test(text)) {
        // Capture & store a single person under member’s latest tree
        const details = text.slice(4).trim();
        const tree = await latestTreeFor(from);
        if (!tree) {
          await sendText(from, "Create or join a tree first (type HELP).");
        } else {
          const [namePart, maybeDob] = details.split(",").map((s) => s.trim());
          const person = {
            tree_id: tree.id,
            primary_name: namePart || "Unknown person",
            dob_dmy: maybeDob?.replace(/^b\.\s*/i, "") || null,
          };
          const { error } = await db.from("persons").insert(person);
          if (error) {
            console.error(error);
            await sendText(from, "❌ Couldn't add that person.");
          } else {
            await sendText(from, `✅ Added ${person.primary_name} to “${tree.name}”.`);
          }
        }

      } else if (/^link:\s*/i.test(text)) {
        // LINK: Alice spouse Bob
        // LINK: Alice partner Bob
        // LINK: Alice married to Bob
        // LINK: Jane parent_of John
        // LINK: Jane parent of John
        const tree = await latestTreeFor(from);
        if (!tree) {
          await sendText(from, "Create or join a tree first (HELP).");
        } else {
          const body = text.replace(/^link:\s*/i, "").trim();

          // spouse/partner/married to
          let m = body.match(/^(.+?)\s+(spouse|partner|married to)\s+(.+)$/i);
          if (m) {
            const aName = m[1];
            const bName = m[3];
            const a = await upsertPersonByName(tree.id, aName);
            const b = await upsertPersonByName(tree.id, bName);
            await addRelationship(tree.id, a.id, "spouse_of", b.id);
            await sendText(from, `✅ Linked ${a.primary_name} ↔ ${b.primary_name} as spouses/partners.`);
          } else {
            // parent_of (supports "parent_of" and "parent of")
            m = body.match(/^(.+?)\s+(parent[_\s]?of)\s+(.+)$/i);
            if (m) {
              const parentName = m[1];
              const childName = m[3];
              const parent = await upsertPersonByName(tree.id, parentName);
              const child = await upsertPersonByName(tree.id, childName);
              await addRelationship(tree.id, parent.id, "parent_of", child.id);
              await sendText(from, `✅ Linked ${parent.primary_name} → ${child.primary_name} (parent_of).`);
            } else {
              await sendText(from, "Try:\nLINK: Alice spouse Bob\nLINK: Jane parent_of John");
            }
          }
        }

      } else if (/^view\s+tree$/i.test(text)) {
        const result = await listPersonsForTree(from);
        if (!result) {
          await sendText(from, "No tree found. Create or join one first.");
        } else if (result.people.length === 0) {
          await sendText(from, `Tree “${result.tree.name}” is empty.`);
        } else {
          const lines = result.people.map(
            (p) => `• ${p.primary_name}${p.dob_dmy ? " (b. " + p.dob_dmy + ")" : ""}`
          );
          await sendText(from, `👪 Tree: ${result.tree.name}\n` + lines.join("\n"));
        }

      } else if (/^view\s+.+/i.test(text)) {
        const name = text.replace(/^view\s+/i, "").trim();
        const person = await findPersonByName(from, name);
        if (!person) {
          await sendText(from, `❌ No match found for “${name}”.`);
        } else {
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

      } else {
        await sendText(from, "Hi! Type HELP for commands.");
        await sendMenu(from);
      }
    }

    return res.status(200).send("ok");
  }

  return res.status(404).send("Not found");
}

// --- WhatsApp send helpers ---
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
