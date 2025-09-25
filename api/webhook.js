// Minimal WhatsApp bot with simple commands
export default async function handler(req, res) {
  const VERIFY_TOKEN = "myfamilytree123";

  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];

    if (msg?.from) {
      const from = msg.from;
      const text = (msg.text?.body || "").trim();

      // --- simple router ---
      if (/^help$/i.test(text)) {
        await sendText(from,
          "Commands:\nNEW <Tree Name>\nJOIN <Code>\nADD: <free text>\nVIEW <Name>\n(help shows this list)"
        );
      } else if (/^new\s+.+/i.test(text)) {
        const name = text.replace(/^new\s+/i, "").slice(0, 80);
        const code = makeJoinCode();
        memory.trees[code] = { name, members: new Set([from]), people: [] }; // temp in-memory
        await sendText(from, `✅ Created tree “${name}”. Share code: ${code}\nOthers can send: JOIN ${code}`);
      } else if (/^join\s+[A-Z0-9]{6}$/i.test(text)) {
        const code = text.replace(/^join\s+/i, "").toUpperCase();
        const tree = memory.trees[code];
        if (!tree) await sendText(from, "❌ That code wasn’t found. Ask the owner to re-share.");
        else { tree.members.add(from); await sendText(from, `✅ Joined “${tree.name}”. Type: ADD: <person details>`); }
      } else if (/^add:/i.test(text)) {
        // for now just echo; we’ll plug AI next
        await sendText(from, "Got it. I’ll parse this soon:\n" + text.slice(4).trim());
      } else if (/^view\s+.+/i.test(text)) {
        await sendText(from, "VIEW coming soon (will show relationships).");
      } else {
        await sendText(from, "Hi! Type HELP for commands.");
      }
    }

    return res.status(200).send("ok");
  }

  return res.status(404).send("Not found");
}

// ---- helpers ----
async function sendText(to, body) {
  await fetch(`https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WABA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } })
  }).catch(e => console.error("Send error:", e));
}

function makeJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // readable
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// temp in-memory store for testing (resets on deploy)
const memory = { trees: {} };
