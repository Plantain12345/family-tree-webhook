// api/webhook.js
// WhatsApp bot: HELP/NEW/JOIN/ADD with optional Supabase persistence.
// Works on Vercel Node.js 20+ (fetch is global).

const VERIFY_TOKEN = "myfamilytree123";

// --------- optional DB (Supabase) ---------
let db = null;
const useDb =
  !!process.env.SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY;

if (useDb) {
  // lazy import to keep cold starts small if not configured
  const { createClient } = await import("@supabase/supabase-js");
  db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  console.log("Supabase enabled");
} else {
  console.log("Supabase NOT configured — using in-memory store");
}

// In-memory fallback (clears on each deploy)
const memory = { trees: {} };

// ---------- helpers ----------
function makeJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

async function sendText(to, body) {
  const resp = await fetch(`https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`, {
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
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.error("Send error:", resp.status, t);
  }
}

async function sendMenu(to) {
  const resp = await fetch(`https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`, {
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
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.error("Menu send error:", resp.status, t);
  }
}

// ---------- data layer (DB if available, else memory) ----------
async function createTree(name, ownerPhone) {
  if (useDb) {
    const code = makeJoinCode();
    const { data: tree, error } = await db
      .from("trees")
      .insert({ name, join_code: code })
      .select()
      .single();
    if (error) throw error;
    await db.from("members").insert({ tree_id: tree.id, phone: ownerPhone });
    return tree; // has id, name, join_code
  } else {
    const code = makeJoinCode();
    memory.trees[code] = { name, members: new Set([ownerPhone]), people: [] };
    return { id: code, name, join_code: code };
  }
}

async function joinTreeByCode(code, phone) {
  if (useDb) {
    const { data: tree } = await db.from("trees").select("*").eq("join_code", code).single();
    if (!tree) return null;
    await db.from("members").insert({ tree_id: tree.id, phone }).onConflict("tree_id,phone").ignore();
    return tree;
  } else {
    const tree = memory.trees[code] || null;
    if (tree) tree.members.add(phone);
    return tree ? { id: code, name: tree.name, join_code: code } : null;
  }
}

async function latestTreeFor(phone) {
  if (useDb) {
    const { data, error } = await db
      .from("members")
      .select("joined_at, tree_id, trees!inner(id, name, join_code, created_at)")
      .eq("phone", phone)
      .order("joined_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    return data?.[0]?.trees || null;
  } else {
    // pick the most recently created (arbitrary in memory)
    const code = Object.keys(memory.trees)[Object.keys(memory.trees).length - 1];
    if (!code) return null;
    const t = memory.trees[code];
    if (!t?.members?.has(phone)) return null;
    return { id: code, name: t.name, join_code: code };
  }
}

async function addSimplePerson(tree, name, dobMaybe) {
  if (useDb) {
    const { error } = await db
      .from("persons")
      .insert({ tree_id: tree.id, primary_name: name, dob_dmy: dobMaybe || null });
    if (error) throw error;
  } else {
    memory.trees[tree.join_code].people.push({ primary_name: name, dob_dmy: dobMaybe || null });
  }
}

// ---------- main webhook ----------
export default async function handler(req, res) {
  // Verification handshake
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(404).send("Not found");

  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];

    if (!msg?.from) return res.status(200).send("ok");

    const from = msg.from;
    // support text or button taps
    const text = (msg.text?.body || msg.interactive?.button_reply?.id || "").trim();

    // ---------- ROUTER ----------
    if (!text || /^help$/i.test(text)) {
      await sendText(from, "Commands:\nNEW <Tree Name>\nJOIN <Code>\nADD: <details>\nVIEW <Name> (coming soon)");
      await sendMenu(from);
      return res.status(200).send("ok");
    }

    // Button shortcuts
    if (text === "NEW")  { await sendText(from, "Reply with: NEW <Tree Name>");  return res.status(200).send("ok"); }
    if (text === "JOIN") { await sendText(from, "Reply with: JOIN <Code>");      return res.status(200).send("ok"); }

    if (/^new\s+.+/i.test(text)) {
      const name = text.replace(/^new\s+/i, "").slice(0, 80);
      try {
        const tree = await createTree(name, from);
        await sendText(from, `✅ Created tree “${tree.name}”. Share code: ${tree.join_code}\nOthers can reply here: JOIN ${tree.join_code}`);
      } catch (e) {
        console.error("Create tree error:", e);
        await sendText(from, "Sorry, I couldn't create that tree. Try a different name.");
      }
      return res.status(200).send("ok");
    }

    if (/^join\s+([A-Z0-9]{6})$/i.test(text)) {
      const code = text.match(/^join\s+([A-Z0-9]{6})$/i)[1].toUpperCase();
      const tree = await joinTreeByCode(code, from);
      if (!tree) await sendText(from, "❌ That code wasn’t found. Ask the owner to re-share.");
      else await sendText(from, `✅ Joined “${tree.name}”. Now send: ADD: <person details>\nExample: ADD: Hajara Namutebi, b. 1943`);
      return res.status(200).send("ok");
    }

    if (/^add:/i.test(text)) {
      const details = text.slice(4).trim();
      const tree = await latestTreeFor(from);
      if (!tree) {
        await sendText(from, "Join or create a tree first (NEW / JOIN). Type HELP for options.");
        return res.status(200).send("ok");
      }

      // naive parse for MVP: "Name, b. 1943"
      const [namePartRaw, second] = details.split(",").map(s => (s || "").trim());
      const namePart = namePartRaw || "Unknown person";
      const dob = second?.replace(/^b\.\s*/i, "") || null;

      try {
        await addSimplePerson(tree, namePart, dob);
        await sendText(from, `✅ Added **${namePart}** to “${tree.name}”. (Parsing is basic for now — we’ll upgrade to AI next.)`);
      } catch (e) {
        console.error("Add person error:", e);
        await sendText(from, "Sorry, I couldn't add that person.");
      }
      return res.status(200).send("ok");
    }

    if (/^view\s+.+/i.test(text)) {
      await sendText(from, "VIEW is coming soon — I’ll show spouses/children/parents here.");
      return res.status(200).send("ok");
    }

    // default
    await sendText(from, "I didn’t catch that. Type HELP for commands.");
    await sendMenu(from);
    return res.status(200).send("ok");

  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(200).send("ok"); // always 200 to avoid retries while testing
  }
}
