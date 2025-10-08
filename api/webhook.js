// api/webhook.js
import {
  createTree,
  getTreeByCode,
  listPersons,
  insertPerson,
  addRelationship
} from "./_db.js";

import { parseOps } from "./_nlp.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const BASE_URL = "https://family-tree-webhook.vercel.app";
const FOLLOW_UP_PROMPT =
  "What else would you like to do with your family tree? I understand plain English. Or type 'menu' to view your options.";

// ---------- Meta verification ----------
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified successfully.");
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send("Forbidden");
    }
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const body = req.body;
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) {
      return res.status(200).send("No message");
    }

    const from = message.from;
    const text = message.text?.body?.trim();
    console.log("Incoming:", from, text);

    const reply = await processMessage(from, text);
    if (reply) {
      await sendWhatsAppMessage(from, reply);
    }

    return res.status(200).send("OK");
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(500).json({ error: e.message });
  }
}

// ---------- Core logic ----------
async function processMessage(from, text) {
  if (!text) return "Please say something 🙂";

  const ops = parseOps(text);

  if (ops.action === "create_tree") {
    const tree = await createTree(from, ops.name);
    return `✅ Created your family tree: "${tree.name}".\nYou can start by adding a person, like "Add Alice born 1950".\nView your tree any time at: ${BASE_URL}/tree.html?code=${tree.join_code}\n\n${FOLLOW_UP_PROMPT}`;
  }

  if (ops.action === "add_person") {
    const tree = await getTreeByCode(ops.tree_code || ops.active_tree_code);
    if (!tree) return "❌ No active tree found.";
    const person = await insertPerson(
      tree.id,
      ops.first_name,
      ops.last_name,
      ops.gender,
      ops.birthday
    );
    return `I've added ${person.data.first_name}${
      person.data.birthday ? `, born ${person.data.birthday}` : ""
    } to your family tree.\n\n${FOLLOW_UP_PROMPT}`;
  }

  if (ops.action === "add_relationship") {
    const tree = await getTreeByCode(ops.tree_code || ops.active_tree_code);
    if (!tree) return "❌ No active tree found.";
    await addRelationship(tree.id, ops.kind, ops.a_id, ops.b_id);
    return `I've linked ${ops.a_name} as the ${ops.kind.replace(
      "_",
      " "
    )} of ${ops.b_name} on the family tree.\n\n${FOLLOW_UP_PROMPT}`;
  }

  return "I didn't quite understand that. Try: "Add John born 1980" or "Link John and Mary as spouses."";
}

// ---------- Outgoing message ----------
async function sendWhatsAppMessage(to, text) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  
  if (!token || !phoneNumberId) {
    console.error("Missing WhatsApp credentials");
    return;
  }
  
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    text: { body: text }
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("WhatsApp API error:", error);
    }
  } catch (error) {
    console.error("Failed to send WhatsApp message:", error);
  }
}
