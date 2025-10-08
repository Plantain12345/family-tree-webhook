// api/webhook.js
import {
  createTree,
  getTreeByCode,
  getUserState,
  setUserState,
  findPersonByName,
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
  
  // Get user's current state
  const userState = await getUserState(from);

  // --- HELP/MENU ---
  if (ops.action === "help") {
    return `📋 *Family Tree Bot Commands*

*Getting Started:*
• "Create tree called [name]" - Start a new family tree

*Adding People:*
• "Add [name] born [year]" - Add a new person
• "Add [name]" - Add person without birth year

*Creating Relationships:*
• "[Name] is [Name]'s father/mother/son/daughter"
• "Link [Name] and [Name] as spouses"
• "[Name] is [Name]'s husband/wife"

*Examples:*
• "Create tree called Smith Family"
• "Add John Smith born 1980"
• "Add Mary Johnson born 1982"
• "John is Mary's husband"
• "Add baby Alice born 2010"
• "Alice is John's daughter"

*View Tree:*
Your tree link will be sent after creation!`;
  }

  // --- CREATE TREE ---
  if (ops.action === "create_tree") {
    const tree = await createTree(from, ops.name);
    // Save this as user's active tree
    await setUserState(from, tree.id, null, null);
    
    return `✅ Created your family tree: "${tree.name}"\n\n📋 Join Code: *${tree.join_code}*\n\nYou can start by adding a person:\n• "Add John born 1980"\n• "Add Mary"\n\n🌐 View your tree at:\n${BASE_URL}/tree.html?code=${tree.join_code}\n\n${FOLLOW_UP_PROMPT}`;
  }

  // For all other actions, we need an active tree
  if (!userState?.tree_id) {
    return "❌ You don't have an active tree. Create one first:\n• \"Create tree called Smith Family\"";
  }

  const tree = await getTreeByCode(null, userState.tree_id);
  if (!tree) {
    return "❌ Your active tree was not found. Please create a new one.";
  }

  // --- ADD PERSON ---
  if (ops.action === "add_person") {
    const person = await insertPerson(
      tree.id,
      ops.first_name,
      ops.last_name,
      ops.gender,
      ops.birthday
    );
    
    // Remember this person as the last one added
    await setUserState(from, tree.id, person.id, `${ops.first_name} ${ops.last_name}`.trim());
    
    return `✅ I've added *${person.data.first_name}${person.data.last_name ? ' ' + person.data.last_name : ''}*${
      person.data.birthday ? ` (born ${person.data.birthday})` : ""
    } to your family tree.\n\nYou can now:\n• Add more people\n• Create relationships: "[Name] is [Name]'s father"\n\n${FOLLOW_UP_PROMPT}`;
  }

  // --- SET GENDER ---
  if (ops.action === "set_gender") {
    const persons = await findPersonByName(tree.id, ops.first_name);
    if (persons.length === 0) {
      return `❌ I couldn't find anyone named "${ops.first_name}" in your tree.`;
    }
    
    const person = persons[0];
    await updatePersonGender(person.id, ops.gender);
    
    return `✅ Updated ${ops.first_name}'s gender to ${ops.gender === 'M' ? 'male' : 'female'}.\n\n${FOLLOW_UP_PROMPT}`;
  }

  // --- ADD RELATIONSHIP ---
  if (ops.action === "add_relationship") {
    // Find person A
    const personsA = await findPersonByName(tree.id, ops.a_name);
    if (personsA.length === 0) {
      return `❌ I couldn't find "${ops.a_name}" in your tree. Add them first:\n• "Add ${ops.a_name} born [year]"`;
    }
    if (personsA.length > 1) {
      const names = personsA.map(p => `${p.data.first_name} ${p.data.last_name || ''} (born ${p.data.birthday || 'unknown'})`).join('\n• ');
      return `❌ I found multiple people named "${ops.a_name}":\n• ${names}\n\nPlease use full names to be more specific.`;
    }

    // Find person B
    const personsB = await findPersonByName(tree.id, ops.b_name);
    if (personsB.length === 0) {
      return `❌ I couldn't find "${ops.b_name}" in your tree. Add them first:\n• "Add ${ops.b_name} born [year]"`;
    }
    if (personsB.length > 1) {
      const names = personsB.map(p => `${p.data.first_name} ${p.data.last_name || ''} (born ${p.data.birthday || 'unknown'})`).join('\n• ');
      return `❌ I found multiple people named "${ops.b_name}":\n• ${names}\n\nPlease use full names to be more specific.`;
    }

    const personA = personsA[0];
    const personB = personsB[0];

    // Create the relationship
    await addRelationship(tree.id, ops.kind, personA.id, personB.id);
    
    const kindDisplay = ops.kind.replace(/_/g, ' ');
    return `✅ I've linked *${ops.a_name}* as the ${kindDisplay} of *${ops.b_name}*.\n\n🌐 View your tree:\n${BASE_URL}/tree.html?code=${tree.join_code}\n\n${FOLLOW_UP_PROMPT}`;
  }

  return "❌ I didn't quite understand that. Try:\n• \"Add John born 1980\"\n• \"Link John and Mary as spouses\"\n• Type 'menu' for all commands";
}

// ---------- Outgoing message ----------
async function sendWhatsAppMessage(to, text) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  
  if (!token) {
    console.error("Missing WhatsApp access token");
    return;
  }
  
  const url = "https://graph.facebook.com/v18.0/me/messages";

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
