// api/webhook.js
import {
  createTree,
  getTreeByCode,
  getUserState,
  setUserState,
  findPersonByName,
  insertPerson,
  addRelationship,
  updatePersonGender
} from "./_db.js";

import { parseOps } from "./_nlp.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const BASE_URL = "https://family-tree-webhook.vercel.app";
const FOLLOW_UP_PROMPT = "What else would you like to do with your family tree? I understand plain English. Or type 'menu' to view your options.";

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
  if (!text) return "Please say something";

  const ops = parseOps(text);
  
  // Get user's current state
  const userState = await getUserState(from);

  // --- HELP/MENU ---
  if (ops.action === "help") {
    let helpText = "Family Tree Bot Commands\n\n";
    helpText += "Getting Started:\n";
    helpText += "- Create tree called [name]\n\n";
    helpText += "Adding People:\n";
    helpText += "- Add [name] born [year]\n";
    helpText += "- Add [name]\n\n";
    helpText += "Creating Relationships:\n";
    helpText += "- [Name] is [Name]'s father/mother/son/daughter\n";
    helpText += "- Link [Name] and [Name] as spouses\n\n";
    helpText += "Examples:\n";
    helpText += "- Create tree called Smith Family\n";
    helpText += "- Add John Smith born 1980\n";
    helpText += "- Add Mary Johnson born 1982\n";
    helpText += "- John is Mary's husband\n";
    helpText += "- Add baby Alice born 2010\n";
    helpText += "- Alice is John's daughter";
    return helpText;
  }

  // --- CREATE TREE ---
  if (ops.action === "create_tree") {
    const tree = await createTree(from, ops.name);
    await setUserState(from, tree.id, null, null);
    
    let reply = "Created your family tree: " + tree.name + "\n\n";
    reply += "Join Code: " + tree.join_code + "\n\n";
    reply += "You can start by adding a person:\n";
    reply += "- Add John born 1980\n";
    reply += "- Add Mary\n\n";
    reply += "View your tree at:\n";
    reply += BASE_URL + "/tree.html?code=" + tree.join_code + "\n\n";
    reply += FOLLOW_UP_PROMPT;
    return reply;
  }

  // For all other actions, we need an active tree
  if (!userState?.tree_id) {
    return "You don't have an active tree. Create one first by saying: Create tree called Smith Family";
  }

  const tree = await getTreeByCode(null, userState.tree_id);
  if (!tree) {
    return "Your active tree was not found. Please create a new one.";
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
    
    await setUserState(from, tree.id, person.id, `${ops.first_name} ${ops.last_name}`.trim());
    
    let reply = "I've added " + person.data.first_name;
    if (person.data.last_name) {
      reply += " " + person.data.last_name;
    }
    if (person.data.birthday) {
      reply += " (born " + person.data.birthday + ")";
    }
    reply += " to your family tree.\n\n";
    reply += "You can now:\n";
    reply += "- Add more people\n";
    reply += "- Create relationships\n\n";
    reply += FOLLOW_UP_PROMPT;
    return reply;
  }

  // --- SET GENDER ---
  if (ops.action === "set_gender") {
    const persons = await findPersonByName(tree.id, ops.first_name);
    if (persons.length === 0) {
      return "I couldn't find anyone named " + ops.first_name + " in your tree.";
    }
    
    const person = persons[0];
    await updatePersonGender(person.id, ops.gender);
    
    const genderWord = ops.gender === 'M' ? 'male' : 'female';
    return "Updated " + ops.first_name + "'s gender to " + genderWord + ".\n\n" + FOLLOW_UP_PROMPT;
  }

  // --- ADD RELATIONSHIP ---
  if (ops.action === "add_relationship") {
    const personsA = await findPersonByName(tree.id, ops.a_name);
    if (personsA.length === 0) {
      return "I couldn't find " + ops.a_name + " in your tree. Add them first: Add " + ops.a_name + " born [year]";
    }
    if (personsA.length > 1) {
      let reply = "I found multiple people named " + ops.a_name + ":\n";
      personsA.forEach(p => {
        reply += "- " + p.data.first_name + " " + (p.data.last_name || '') + " (born " + (p.data.birthday || 'unknown') + ")\n";
      });
      reply += "\nPlease use full names to be more specific.";
      return reply;
    }

    const personsB = await findPersonByName(tree.id, ops.b_name);
    if (personsB.length === 0) {
      return "I couldn't find " + ops.b_name + " in your tree. Add them first: Add " + ops.b_name + " born [year]";
    }
    if (personsB.length > 1) {
      let reply = "I found multiple people named " + ops.b_name + ":\n";
      personsB.forEach(p => {
        reply += "- " + p.data.first_name + " " + (p.data.last_name || '') + " (born " + (p.data.birthday || 'unknown') + ")\n";
      });
      reply += "\nPlease use full names to be more specific.";
      return reply;
    }

    const personA = personsA[0];
    const personB = personsB[0];

    await addRelationship(tree.id, ops.kind, personA.id, personB.id);
    
    const kindDisplay = ops.kind.replace(/_/g, ' ');
    let reply = "I've linked " + ops.a_name + " as the " + kindDisplay + " of " + ops.b_name + ".\n\n";
    reply += "View your tree:\n";
    reply += BASE_URL + "/tree.html?code=" + tree.join_code + "\n\n";
    reply += FOLLOW_UP_PROMPT;
    return reply;
  }

  return "I didn't quite understand that. Try: Add John born 1980 or Link John and Mary as spouses. Type 'menu' for all commands.";
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
