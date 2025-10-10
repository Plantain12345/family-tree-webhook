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
  updatePersonGender,
} from "./_db.js";

import { parseOps } from "./_nlp.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const BASE_URL = "https://family-tree-webhook.vercel.app";
const FOLLOW_UP_PROMPT =
  "What else would you like to do? You can add people, create relationships, or type 'menu' for options.";

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");

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
    return "Please say something!";
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

  // --- ALL OTHER ACTIONS REQUIRE AN ACTIVE TREE ---
  if (!userState?.tree_id) {
    return "You don't have an active tree. Create one by saying: Create tree called Smith Family";
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
      `${operation.firstName} ${operation.lastName || ""}`.trim()
    );

    return buildAddPersonMessage(person);
  }

  // --- SET GENDER ---
  if (operation.action === "set_gender") {
    const persons = await findPersonByName(tree.id, operation.name);

    if (persons.length === 0) {
      return `I couldn't find anyone named ${operation.name} in your tree.`;
    }
    if (persons.length > 1) {
      return buildMultipleMatchesMessage(operation.name, persons);
    }

    const person = persons[0];
    await updatePersonGender(person.id, operation.gender);

    const genderWord = operation.gender === "M" ? "male" : "female";
    return `Updated ${operation.name}'s gender to ${genderWord}.\n\n${FOLLOW_UP_PROMPT}`;
  }

  // --- RELATE PEOPLE ---
  if (operation.action === "relate") {
    const personsA = await findPersonByName(tree.id, operation.nameA);
    if (personsA.length === 0) {
      return `I couldn't find ${operation.nameA}. Try adding them first: Add ${operation.nameA}`;
    }
    if (personsA.length > 1) {
      return buildMultipleMatchesMessage(operation.nameA, personsA);
    }

    const personsB = await findPersonByName(tree.id, operation.nameB);
    if (personsB.length === 0) {
      return `I couldn't find ${operation.nameB}. Try adding them first: Add ${operation.nameB}`;
    }
    if (personsB.length > 1) {
      return buildMultipleMatchesMessage(operation.nameB, personsB);
    }

    const personA = personsA[0];
    const personB = personsB[0];
    let dbKind = operation.kind;
    let personAId = personA.id;
    let personBId = personB.id;

    // FIXED: Translate NLP kinds to DB kinds and handle relationship direction
    if (["father", "mother", "parent"].includes(operation.kind)) {
      dbKind = "parent"; // A is the parent of B
    } else if (["son", "daughter", "child"].includes(operation.kind)) {
      dbKind = "parent"; // B is the parent of A, so we swap
      [personAId, personBId] = [personBId, personAId];
    } else if (operation.kind === "spouse") {
      dbKind = "spouse";
    } else {
      return `I don't know how to handle the relationship '${operation.kind}'.`;
    }

    await addRelationship(tree.id, dbKind, personAId, personBId);

    return buildAddRelationshipMessage(operation, tree);
  }

  return "I didn't quite understand. Try 'Add John born 1980' or 'John is Mary's father'. Type 'menu' for all commands.";
}

// ============================================================================
// MESSAGE BUILDERS
// ============================================================================

function buildHelpMessage() {
  let message = "🌿 *Family Tree Bot Commands* 🌿\n\n";
  message += "*Getting Started:*\n";
  message += "• `Create tree called [name]`\n\n";
  message += "*Adding People:*\n";
  message += "• `Add [name] born [year]`\n";
  message += "• `Add [name]`\n\n";
  message += "*Creating Relationships:*\n";
  message += "• `[Name] and [Name] are married`\n";
  message += "• `[Name] is [Name]'s father`\n";
  message += "• `[Name] is [Name]'s daughter`\n\n";
  message += "*Examples:*\n";
  message += "• `Create tree called The Smiths`\n";
  message += "• `Add John Smith born 1980`\n";
  message += "• `Add Mary Johnson born 1982`\n";
  message += "• `John and Mary are married`\n";
  message += "• `Add Alice born 2010`\n";
  message += "• `Alice is John's daughter`";
  return message;
}

function buildCreateTreeMessage(tree) {
  let message = `Created your family tree: *${tree.name}*\n\n`;
  message += `Share this code with family to collaborate: *${tree.join_code}*\n\n`;
  message += "Now, let's add the first person:\n`Add John born 1980`\n\n";
  message += "View your tree anytime at:\n";
  message += `${BASE_URL}/tree.html?code=${tree.join_code}`;
  return message;
}

function buildAddPersonMessage(person) {
  let name = `${person.data.first_name || ""} ${person.data.last_name || ""}`.trim();
  let message = `I've added *${name}*`;
  if (person.data.birthday) {
    message += ` (born ${person.data.birthday})`;
  }
  message += " to your family tree.\n\n";
  message += FOLLOW_UP_PROMPT;
  return message;
}

function buildAddRelationshipMessage(operation, tree) {
  let message = `OK, I've linked *${operation.nameA}* and *${operation.nameB}* as requested.\n\n`;
  message += "You can see the updated tree here:\n";
  message += `${BASE_URL}/tree.html?code=${tree.join_code}\n\n`;
  message += FOLLOW_UP_PROMPT;
  return message;
}

function buildMultipleMatchesMessage(name, persons) {
  let message = `I found a few people named *${name}*:\n`;
  persons.forEach((p) => {
    const fullName = `${p.data.first_name} ${p.data.last_name || ""}`.trim();
    const birthday = p.data.birthday || "no birth year";
    message += `• ${fullName} (${birthday})\n`;
  });
  message += "\nPlease be more specific, maybe by using their full name.";
  return message;
}

// ============================================================================
// WHATSAPP API
// ============================================================================

async function sendWhatsAppMessage(phoneNumber, messageText) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.error("Missing WhatsApp API credentials from environment variables.");
    return;
  }

  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: phoneNumber,
    text: { body: messageText },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`WhatsApp API error: ${response.statusText}`, errorText);
    }
  } catch (error) {
    console.error("Failed to send WhatsApp message:", error);
  }
}
