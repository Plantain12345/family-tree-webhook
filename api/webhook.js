// api/webhook.js
// STANDARDIZED: Clean, consistent naming throughout

import {
  createTree,
  getTreeById,
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

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  
  // Meta webhook verification
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

    const phoneNumber = message.from;
    const messageText = message.text?.body?.trim();
    
    console.log("Incoming message:", phoneNumber, messageText);

    const reply = await processMessage(phoneNumber, messageText);
    if (reply) {
      await sendWhatsAppMessage(phoneNumber, reply);
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================================================
// MESSAGE PROCESSING
// ============================================================================

async function processMessage(phoneNumber, messageText) {
  if (!messageText) {
    return "Please say something";
  }

  const operation = await parseOps(messageText);
  const userState = await getUserState(phoneNumber);

  // --- HELP/MENU ---
  if (operation.action === "help") {
    return buildHelpMessage();
  }

  // --- CREATE TREE ---
  if (operation.action === "create_tree") {
    const tree = await createTree(phoneNumber, operation.treeName);
    await setUserState(phoneNumber, tree.id, null, null);
    return buildCreateTreeMessage(tree);
  }

  // --- ALL OTHER ACTIONS REQUIRE ACTIVE TREE ---
  if (!userState?.tree_id) {
    return "You don't have an active tree. Create one first by saying: Create tree called Smith Family";
  }

  const tree = await getTreeById(userState.tree_id);
  if (!tree) {
    return "Your active tree was not found. Please create a new one.";
  }

  // --- ADD PERSON ---
  if (operation.action === "add_person") {
    const person = await insertPerson(
      tree.id,
      operation.firstName,
      operation.lastName,
      operation.gender,
      operation.birthday
    );
    
    await setUserState(
      phoneNumber, 
      tree.id, 
      person.id, 
      `${operation.firstName} ${operation.lastName}`.trim()
    );
    
    return buildAddPersonMessage(person);
  }

  // --- SET GENDER ---
  if (operation.action === "set_gender") {
    const persons = await findPersonByName(tree.id, operation.firstName);
    
    if (persons.length === 0) {
      return `I couldn't find anyone named ${operation.firstName} in your tree.`;
    }
    if (persons.length > 1) {
      return buildMultipleMatchesMessage(operation.firstName, persons);
    }
    
    const person = persons[0];
    await updatePersonGender(person.id, operation.gender);
    
    const genderWord = operation.gender === 'M' ? 'male' : 'female';
    return `Updated ${operation.firstName}'s gender to ${genderWord}.\n\n${FOLLOW_UP_PROMPT}`;
  }

  // --- ADD RELATIONSHIP ---
  if (operation.action === "add_relationship") {
    const personsA = await findPersonByName(tree.id, operation.nameA);
    if (personsA.length === 0) {
      return `I couldn't find ${operation.nameA} in your tree. Add them first: Add ${operation.nameA} born [year]`;
    }
    if (personsA.length > 1) {
      return buildMultipleMatchesMessage(operation.nameA, personsA);
    }

    const personsB = await findPersonByName(tree.id, operation.nameB);
    if (personsB.length === 0) {
      return `I couldn't find ${operation.nameB} in your tree. Add them first: Add ${operation.nameB} born [year]`;
    }
    if (personsB.length > 1) {
      return buildMultipleMatchesMessage(operation.nameB, personsB);
    }

    const personA = personsA[0];
    const personB = personsB[0];

    await addRelationship(tree.id, operation.kind, personA.id, personB.id);
    
    return buildAddRelationshipMessage(operation, tree);
  }

  return "I didn't quite understand that. Try: Add John born 1980 or Link John and Mary as spouses. Type 'menu' for all commands.";
}

// ============================================================================
// MESSAGE BUILDERS
// ============================================================================

function buildHelpMessage() {
  let message = "Family Tree Bot Commands\n\n";
  message += "Getting Started:\n";
  message += "- Create tree called [name]\n\n";
  message += "Adding People:\n";
  message += "- Add [name] born [year]\n";
  message += "- Add [name]\n\n";
  message += "Creating Relationships:\n";
  message += "- [Name] and [Name] are married\n";
  message += "- [Name] is [Name]'s father/mother/son/daughter\n";
  message += "- Link [Name] and [Name]\n\n";
  message += "Examples:\n";
  message += "- Create tree called Smith Family\n";
  message += "- Add John Smith born 1980\n";
  message += "- Add Mary Johnson born 1982\n";
  message += "- John and Mary are married\n";
  message += "- Add Alice born 2010\n";
  message += "- Alice is John's daughter";
  return message;
}

function buildCreateTreeMessage(tree) {
  let message = `Created your family tree: ${tree.name}\n\n`;
  message += `Join Code: ${tree.join_code}\n\n`;
  message += "You can start by adding a person:\n";
  message += "- Add John born 1980\n";
  message += "- Add Mary\n\n";
  message += "View your tree at:\n";
  message += `${BASE_URL}/tree.html?code=${tree.join_code}\n\n`;
  message += FOLLOW_UP_PROMPT;
  return message;
}

function buildAddPersonMessage(person) {
  let message = `I've added ${person.data.first_name}`;
  if (person.data.last_name) {
    message += ` ${person.data.last_name}`;
  }
  if (person.data.birthday) {
    message += ` (born ${person.data.birthday})`;
  }
  message += " to your family tree.\n\n";
  message += "You can now:\n";
  message += "- Add more people\n";
  message += "- Create relationships\n\n";
  message += FOLLOW_UP_PROMPT;
  return message;
}

function buildAddRelationshipMessage(operation, tree) {
  const kindDisplay = operation.kind;
  let message = `I've linked ${operation.nameA} as the ${kindDisplay} of ${operation.nameB}.\n\n`;
  message += "View your tree:\n";
  message += `${BASE_URL}/tree.html?code=${tree.join_code}\n\n`;
  message += FOLLOW_UP_PROMPT;
  return message;
}

function buildMultipleMatchesMessage(name, persons) {
  let message = `I found multiple people named ${name}:\n`;
  persons.forEach(person => {
    const fullName = `${person.data.first_name} ${person.data.last_name || ''}`.trim();
    const birthday = person.data.birthday || 'unknown';
    message += `- ${fullName} (born ${birthday})\n`;
  });
  message += "\nPlease use full names to be more specific.";
  return message;
}

// ============================================================================
// WHATSAPP API
// ============================================================================

async function sendWhatsAppMessage(phoneNumber, messageText) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  
  if (!token) {
    console.error("Missing WhatsApp access token");
    return;
  }
  
  if (!phoneNumberId) {
    console.error("Missing WhatsApp phone number ID");
    return;
  }
  
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: phoneNumber,
    text: { body: messageText }
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
