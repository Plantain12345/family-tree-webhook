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

      if (/^help$/i.test(text)) {
        await sendText(
          from,
          [
            "Commands:",
            "• NEW <Tree Name>",
            "• JOIN <Code> (also switches to that tree)",
            "• LEAVE (leave your current tree)",
            "• ADD: <person details>",
            "• LINK: Alice spouse Bob | Alice parent_of Carol",
            "• EDIT: Old Name -> New Name",
            "• EDIT: Name, b. 1960",
            "• VIEW TREE",
            "• VIEW <Name>",
          ].join("\n")
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
          await sendText(from, `✅ Switched to “${tree.name}”. You can ADD / VIEW / LINK now.`);
        }

      } else if (/^leave$/i.test(text)) {
        const result = await leaveCurrentTree(from);
        if (!result.left) await sendText(from, "You’re not in any tree yet.");
        else await sendText(from, `✅ You left “${result.tree.name}”.`);

      } else if (/^add:/i.test(text)) {
        // ADD: <name>, b. 19xx  (very simple capture)
        const details = text.replace(/^add:\s*/i, "");
        const tree = await latestTreeFor(from);
        if (!tree) {
          await sendText(from, "Create or join a tree first (type HELP).");
        } else {
          const [namePart, maybeDob] = details.split(",").map(s => s.trim());
          const norm = normalizeName(namePart);
          if (!norm) { await sendText(from, "Please include a name."); return; }

          // MERGE RULE: try to reuse/merge by normalized name
          // 1) look for existing with same normalized name
          const { data: all } = await db.from("persons").select("*").eq("tree_id", tree.id);
          let existing = all?.find(p => normalizeName(p.primary_name) === norm);

          if (existing) {
            // update missing DOB if provided
            if (maybeDob && !existing.dob_dmy) {
              await db.from("persons").update({ dob_dmy: maybeDob.replace(/^b\.\s*/i, "") }).eq("id", existing.id);
            }
            await sendText(from, `ℹ️ Using existing person: ${existing.primary_name}.`);
          } else {
            // create new
            const { data: created, error } = await db
              .from("persons")
              .insert({ tree_id: tree.id, primary_name: namePart.trim(), dob_dmy: maybeDob?.replace(/^b\.\s*/i, "") || null })
              .select()
              .single();
            if (error) { console.error(error); await sendText(from, "❌ Couldn't add that person."); return; }
            existing = created;
            await sendText(from, `✅ Added ${existing.primary_name} to “${tree.name}”.`);
          }

          // If a different record already exists that looks the same, merge (very conservative)
          const dup = all?.find(p => p.id !== existing.id && normalizeName(p.primary_name) === norm);
          if (dup) {
            await mergePersons(tree.id, existing.id, dup.id);
            await sendText(from, `🔁 Merged duplicate “${dup.primary_name}” into “${existing.primary_name}”.`);
          }
        }

      } else if (/^link:\s*/i.test(text)) {
        // LINK: Alice spouse Bob | partner | married to
        // LINK: Jane parent_of John  (also "parent of")
        const tree = await latestTreeFor(from);
        if (!tree) { await sendText(from, "Create or join a tree first (HELP)."); }
        else {
          const body = text.replace(/^link:\s*/i, "").trim();

          // spouse/partner/married to
          let m = body.match(/^(.+?)\s+(spouse|partner|married to)\s+(.+)$/i);
          if (m) {
            const aName = m[1], bName = m[3];
            const a = await upsertPersonByName(tree.id, aName);
            const b = await upsertPersonByName(tree.id, bName);
            await addRelationship(tree.id, a.id, "spouse_of", b.id);
            await sendText(from, `✅ Linked ${a.primary_name} ↔ ${b.primary_name} as spouses/partners.`);
          } else {
            // parent_of (supports "parent_of" and "parent of")
            m = body.match(/^(.+?)\s+(parent[_\s]?of)\s+(.+)$/i);
            if (m) {
              const parentName = m[1], childName = m[3];
              const parent = await upsertPersonByName(tree.id, parentName);
              const child  = await upsertPersonByName(tree.id, childName);
              await addRelationship(tree.id, parent.id, "parent_of", child.id);
              await sendText(from, `✅ Linked ${parent.primary_name} → ${child.primary_name} (parent_of).`);
            } else {
              await sendText(from, "Try:\nLINK: Alice spouse Bob\nLINK: Jane parent_of John");
            }
          }
        }

      } else if (/^edit:\s*/i.test(text)) {
        // EDIT: Old Name -> New Name
        // EDIT: Name, b. 1960
        const tree = await latestTreeFor(from);
        if (!tree) { await sendText(from, "Create or join a tree first (HELP)."); }
        else {
          const body = text.replace(/^edit:\s*/i, "").trim();
          let m = body.match(/^(.+?)\s*->\s*(.+)$/); // rename
          if (m) {
            const fromName = m[1], toName = m[2];
            const person = await upsertPersonByName(tree.id, fromName); // find or create
            await editPerson(tree.id, person.id, { newName: toName });
            await sendText(from, `✏️ Renamed “${fromName}” → “${toName}”.`);
          } else {
            // set birth year
            m = body.match(/^(.+?),\s*b\.\s*(.+)$/i);
            if (m) {
              const who = m[1], dob = m[2];
              const person = await upsertPersonByName(tree.id, who);
              await editPerson(tree.id, person.id, { dob_dmy: dob });
              await sendText(from, `✏️ Updated ${person.primary_name}: b. ${dob}.`);
            } else {
              await sendText(from, "Try:\nEDIT: Old Name -> New Name\nEDIT: Name, b. 1960");
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
