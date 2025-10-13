// api/webhook.js
// Main webhook handler with dual-mode processing, entity resolution, and Flows support

import {
  createTree,
  getTreeById,
  getTreeByCode,
  getUserState,
  setUserState,
  findPersonByName,
  findSimilarPersons,
  insertPerson,
  addRelationship,
  updatePerson,
  updatePersonGender,
  relationshipExists,
  savePendingAction,
  getPendingAction,
  clearPendingAction,
  addMember,
  isMember,
  RELATIONSHIP_TYPES
} from "./_db.js";

import { parseOps, getTreeContext } from "./_nlp.js";
import * as db from "./_db.js";
import crypto from 'crypto';

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const BASE_URL = process.env.BASE_URL || "https://family-tree-webhook.vercel.app";
const FLOWS_RSA_PRIVATE_KEY = process.env.FLOWS_RSA_PRIVATE_KEY;

// ============================================================================
// RSA DECRYPTION UTILITY
// ============================================================================

function decryptFlowToken(encryptedBase64) {
  if (!FLOWS_RSA_PRIVATE_KEY) {
    console.error("FLOWS_RSA_PRIVATE_KEY is missing from environment variables.");
    return null;
  }
  
  try {
    const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');
    const decryptedBuffer = crypto.privateDecrypt(
      {
        key: FLOWS_RSA_PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      encryptedBuffer
    );
    return decryptedBuffer.toString('utf8');
  } catch (error) {
    console.error("RSA Decryption failed:", error.message);
    return null;
  }
}

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
      return res.status(403).send("Verification failed");
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
    const profileName = changes?.value?.contacts?.[0]?.profile?.name || "User";

    // Check for Flow Completion Message
    if (message.type === 'interactive' && message.interactive?.type === 'flow_completion') {
      await handleFlowCompletion(phoneNumber, profileName, message.interactive.flow_completion);
      return res.status(200).send("EVENT_RECEIVED");
    }

    // Handle text messages
    if (message.type === "text") {
      const messageText = message.text?.body?.trim();
      console.log("Incoming message:", phoneNumber, messageText);

      const reply = await processMessage(phoneNumber, messageText);
      if (reply) {
        await sendWhatsAppMessage(phoneNumber, reply);
      }
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================================================
// FLOW COMPLETION HANDLER
// ============================================================================

async function handleFlowCompletion(phoneNumber, profileName, flowCompletionData) {
  const { flow_token: encryptedFlowToken, encrypted_flow_data } = flowCompletionData;

  console.log(`Received flow_completion from ${profileName}. Encrypted Token: ${encryptedFlowToken}`);

  // Decrypt the flow_token
  const decryptedFlowToken = decryptFlowToken(encryptedFlowToken);

  if (!decryptedFlowToken) {
    await sendWhatsAppMessage(phoneNumber, "Sorry, I couldn't securely process your request. Please try again.");
    return;
  }

  console.log(`Decrypted Flow Token: ${decryptedFlowToken}`);

  // TODO: Call Meta API to get final submitted data using decryptedFlowToken
  // For now, confirm receipt
  await sendWhatsAppMessage(phoneNumber, `Thank you for completing the flow! Your unique ID is: ${decryptedFlowToken}`);

  // TODO: Parse flow data and add to database
  // Example:
  // const flowData = await fetchFlowData(decryptedFlowToken);
  // await insertPerson(treeId, flowData.firstName, flowData.lastName, ...);
}

// ============================================================================
// MESSAGE PROCESSING
// ============================================================================

async function processMessage(phoneNumber, messageText) {
  if (!messageText) {
    return "Please say something!";
  }

  const userState = await getUserState(phoneNumber);
  
  // Get tree context for better parsing
  let treeContext = null;
  if (userState?.tree_id) {
    treeContext = await getTreeContext(userState.tree_id, db);
  }

  const operation = await parseOps(messageText, treeContext);

  // --- HANDLE INFERENCE MODE ---
  if (operation.mode === 'inference') {
    return await handleInferenceMode(phoneNumber, operation);
  }

  // --- HANDLE CONFIRMATIONS ---
  if (operation.action === 'confirm') {
    return await handleConfirm(phoneNumber);
  }

  if (operation.action === 'cancel') {
    await clearPendingAction(phoneNumber);
    return "Okay, I've cancelled that action. What would you like to do instead?";
  }

  // --- HELP/MENU ---
  if (operation.action === 'help') {
    return buildHelpMessage();
  }

  // --- CREATE TREE ---
  if (operation.action === 'create_tree') {
    const tree = await createTree(phoneNumber, operation.treeName);
    await setUserState(phoneNumber, tree.id, null, null);
    return buildCreateTreeMessage(tree);
  }

  // --- JOIN TREE ---
  if (operation.action === 'join_tree') {
    const tree = await getTreeByCode(operation.code);
    if (!tree) {
      return `I couldn't find a tree with code ${operation.code}. Please check the code and try again.`;
    }
    await addMember(tree.id, phoneNumber);
    await setUserState(phoneNumber, tree.id, null, null);
    return `Welcome! You've joined the tree "${tree.name}". You can view it here:\n${BASE_URL}/tree.html?code=${tree.join_code}`;
  }

  // --- ALL OTHER ACTIONS REQUIRE AN ACTIVE TREE ---
  if (!userState?.tree_id) {
    return "You don't have an active tree. Create one by saying:\n`Create tree called Smith Family`\n\nOr join an existing tree with:\n`Join tree AB12CD`";
  }

  const tree = await getTreeById(userState.tree_id);
  if (!tree) {
    return "Your active tree was not found. Please create a new one.";
  }

  // --- ADD PERSON (with entity resolution) ---
  if (operation.action === 'add_person') {
    return await handleAddPerson(phoneNumber, tree, operation);
  }

  // --- EDIT PERSON ---
  if (operation.action === 'edit_person') {
    return await handleEditPerson(phoneNumber, tree, operation);
  }

  // --- SET GENDER ---
  if (operation.action === 'set_gender') {
    const persons = await findPersonByName(tree.id, operation.name);

    if (persons.length === 0) {
      return `I couldn't find anyone named ${operation.name} in your tree.`;
    }
    if (persons.length > 1) {
      return buildMultipleMatchesMessage(operation.name, persons);
    }

    const person = persons[0];
    await updatePersonGender(person.id, operation.gender);

    const genderWord = operation.gender === 'M' ? 'male' : 'female';
    return `Updated ${operation.name}'s gender to ${genderWord}.\n\nWhat else would you like to do?`;
  }

  // --- RELATE PEOPLE (with duplicate detection) ---
  if (operation.action === 'relate') {
    return await handleRelate(phoneNumber, tree, operation, messageText);
  }

  return "I didn't quite understand that. Try:\n• `Add John born 1980`\n• `John is Mary's father`\n• `John and Mary are married`\n\nOr type `menu` for all commands.";
}

// ============================================================================
// INFERENCE MODE HANDLER
// ============================================================================

async function handleInferenceMode(phoneNumber, operation) {
  if (operation.confidence < 0.6) {
    return "I'm not sure I understood that correctly. Could you rephrase it more directly?\n\nFor example: `Add John born 1980` or `John is Mary's father`";
  }

  await savePendingAction(phoneNumber, null, operation);

  let message = `I think you mean:\n_${operation.interpretation}_\n\n`;
  message += "This would:\n";

  operation.suggestedActions.forEach((action, i) => {
    if (action.action === 'add_person') {
      message += `${i + 1}. Add ${action.firstName} ${action.lastName || ''}`;
      if (action.birthday) message += ` (born ${action.birthday})`;
      message += '\n';
    } else if (action.action === 'relate') {
      message += `${i + 1}. Link ${action.nameA} and ${action.nameB} as ${action.kind}\n`;
    }
  });

  message += "\nIs this correct? Reply `yes` to confirm or `no` to cancel.";
  return message;
}

// ============================================================================
// CONFIRMATION HANDLER
// ============================================================================

async function handleConfirm(phoneNumber) {
  const pending = await getPendingAction(phoneNumber);
  
  if (!pending) {
    return "There's nothing to confirm. What would you like to do?";
  }

  const userState = await getUserState(phoneNumber);
  if (!userState?.tree_id) {
    await clearPendingAction(phoneNumber);
    return "You need to create or join a tree first.";
  }

  const tree = await getTreeById(userState.tree_id);
  const action = pending.action;

  let results = [];

  for (const suggestedAction of action.suggestedActions) {
    try {
      if (suggestedAction.action === 'add_person') {
        const person = await insertPerson(
          tree.id,
          suggestedAction.firstName,
          suggestedAction.lastName,
          suggestedAction.gender,
          suggestedAction.birthday
        );
        results.push(`Added ${person.data.first_name} ${person.data.last_name || ''}`);
      } else if (suggestedAction.action === 'relate') {
        const personsA = await findPersonByName(tree.id, suggestedAction.nameA);
        const personsB = await findPersonByName(tree.id, suggestedAction.nameB);
        
        if (personsA.length > 0 && personsB.length > 0) {
          const result = await addRelationshipSmart(tree.id, suggestedAction.kind, personsA[0].id, personsB[0].id);
          if (!result.duplicate) {
            results.push(`Linked ${suggestedAction.nameA} and ${suggestedAction.nameB}`);
          }
        }
      }
    } catch (err) {
      console.error('Error executing suggested action:', err);
    }
  }

  await clearPendingAction(phoneNumber);

  if (results.length === 0) {
    return "I tried to make those changes but ran into some issues. Please try adding them one at a time.";
  }

  let message = "Done! I've:\n";
  results.forEach(r => message += `✓ ${r}\n`);
  message += `\nView your tree: ${BASE_URL}/tree.html?code=${tree.join_code}`;
  return message;
}

// ============================================================================
// ADD PERSON HANDLER (with entity resolution)
// ============================================================================

async function handleAddPerson(phoneNumber, tree, operation) {
  const similar = await findSimilarPersons(
    tree.id,
    operation.firstName,
    operation.lastName,
    operation.birthday
  );

  if (similar.length > 0) {
    let message = `There's already someone similar in your tree:\n`;
    similar.forEach(p => {
      const fullName = `${p.data.first_name} ${p.data.last_name || ''}`.trim();
      const birthday = p.data.birthday || 'unknown birth year';
      message += `• ${fullName} (${birthday})\n`;
    });
    message += `\nWould you still like to add ${operation.firstName} ${operation.lastName || ''}`;
    if (operation.birthday) message += ` (born ${operation.birthday})`;
    message += `?\n\nReply 'yes' to add anyway, or 'no' to cancel.`;

    await savePendingAction(phoneNumber, tree.id, {
      action: 'add_person',
      firstName: operation.firstName,
      lastName: operation.lastName,
      gender: operation.gender,
      birthday: operation.birthday
    });

    return message;
  }

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
    `${operation.firstName} ${operation.lastName || ''}`.trim()
  );

  return buildAddPersonMessage(person, tree);
}

// ============================================================================
// EDIT PERSON HANDLER
// ============================================================================

async function handleEditPerson(phoneNumber, tree, operation) {
  const persons = await findPersonByName(tree.id, operation.oldName);

  if (persons.length === 0) {
    return `I couldn't find anyone named ${operation.oldName} in your tree.`;
  }
  if (persons.length > 1) {
    return buildMultipleMatchesMessage(operation.oldName, persons);
  }

  const person = persons[0];
  const updates = {};

  if (operation.newName) {
    const parts = operation.newName.split(/\s+/);
    updates.first_name = parts[0];
    updates.last_name = parts.length > 1 ? parts.slice(1).join(' ') : null;
  }

  if (operation.newBirthday) {
    updates.birthday = operation.newBirthday;
  }

  if (operation.newGender) {
    updates.gender = operation.newGender;
  }

  await updatePerson(person.id, updates);

  const oldName = `${person.data.first_name} ${person.data.last_name || ''}`.trim();
  const newName = operation.newName || oldName;

  return `Updated ${oldName} → ${newName}\n\nView your tree: ${BASE_URL}/tree.html?code=${tree.join_code}`;
}

// ============================================================================
// RELATE HANDLER (with duplicate detection and multi-parent support)
// ============================================================================

async function handleRelate(phoneNumber, tree, operation, originalText) {
  // Check if this is a "X is Y and Z's child" pattern
  const multiParentPattern = /(.+?)\s+is\s+(.+?)\s+and\s+(.+?)(?:'s|s')\s+(son|daughter|child)/i;
  const match = originalText.match(multiParentPattern);
  
  if (match) {
    const childName = match[1].trim();
    const parent1Name = match[2].trim();
    const parent2Name = match[3].trim();
    const childType = match[4].toLowerCase();
    
    const childPersons = await findPersonByName(tree.id, childName);
    const parent1Persons = await findPersonByName(tree.id, parent1Name);
    const parent2Persons = await findPersonByName(tree.id, parent2Name);
    
    if (childPersons.length === 0) {
      return `I couldn't find ${childName}. Try adding them first:\n\`Add ${childName}\``;
    }
    if (parent1Persons.length === 0) {
      return `I couldn't find ${parent1Name}. Try adding them first:\n\`Add ${parent1Name}\``;
    }
    if (parent2Persons.length === 0) {
      return `I couldn't find ${parent2Name}. Try adding them first:\n\`Add ${parent2Name}\``;
    }
    
    if (childPersons.length > 1) return buildMultipleMatchesMessage(childName, childPersons);
    if (parent1Persons.length > 1) return buildMultipleMatchesMessage(parent1Name, parent1Persons);
    if (parent2Persons.length > 1) return buildMultipleMatchesMessage(parent2Name, parent2Persons);
    
    const child = childPersons[0];
    const parent1 = parent1Persons[0];
    const parent2 = parent2Persons[0];
    
    const result1 = await addRelationshipSmart(tree.id, childType, child.id, parent1.id);
    const result2 = await addRelationshipSmart(tree.id, childType, child.id, parent2.id);
    
    let message = `OK, I've linked:\n`;
    if (!result1.duplicate) message += `✓ ${parent1Name} as ${childName}'s parent\n`;
    if (!result2.duplicate) message += `✓ ${parent2Name} as ${childName}'s parent\n`;
    
    if (result1.duplicate && result2.duplicate) {
      return `Both of those relationships already exist.`;
    }
    
    message += `\nView your updated tree: ${BASE_URL}/tree.html?code=${tree.join_code}`;
    return message;
  }
  
  // Single relationship
  const personsA = await findPersonByName(tree.id, operation.nameA);
  if (personsA.length === 0) {
    return `I couldn't find ${operation.nameA}. Try adding them first:\n\`Add ${operation.nameA}\``;
  }
  if (personsA.length > 1) {
    return buildMultipleMatchesMessage(operation.nameA, personsA);
  }

  const personsB = await findPersonByName(tree.id, operation.nameB);
  if (personsB.length === 0) {
    return `I couldn't find ${operation.nameB}. Try adding them first:\n\`Add ${operation.nameB}\``;
  }
  if (personsB.length > 1) {
    return buildMultipleMatchesMessage(operation.nameB, personsB);
  }

  const personA = personsA[0];
  const personB = personsB[0];

  const result = await addRelationshipSmart(tree.id, operation.kind, personA.id, personB.id);

  if (result.duplicate) {
    return `That relationship already exists between ${operation.nameA} and ${operation.nameB}.`;
  }

  return buildAddRelationshipMessage(operation, tree);
}

// ============================================================================
// SMART RELATIONSHIP ADDER
// ============================================================================

async function addRelationshipSmart(treeId, kind, personAId, personBId) {
  let dbKind = kind;
  let idA = personAId;
  let idB = personBId;

  if (['father', 'mother', 'parent'].includes(kind)) {
    dbKind = RELATIONSHIP_TYPES.PARENT;
  } else if (['son', 'daughter', 'child'].includes(kind)) {
    dbKind = RELATIONSHIP_TYPES.PARENT;
    [idA, idB] = [idB, idA];
  } else if (kind === 'spouse') {
    dbKind = RELATIONSHIP_TYPES.SPOUSE;
  } else if (kind === 'divorced') {
    dbKind = RELATIONSHIP_TYPES.DIVORCED;
  } else if (kind === 'separated') {
    dbKind = RELATIONSHIP_TYPES.SEPARATED;
  } else if (['brother', 'sister'].includes(kind)) {
    return { error: "Sibling relationships need to be set up through parents. Try: 'Alice is Bob's daughter' and 'Bob is Charlie's daughter'" };
  }

  return await addRelationship(treeId, dbKind, idA, idB);
}

// ============================================================================
// MESSAGE BUILDERS
// ============================================================================

function buildHelpMessage() {
  let message = "🌿 *Family Tree Bot Commands* 🌿\n\n";
  message += "*Getting Started:*\n";
  message += "• `Create tree called [name]`\n";
  message += "• `Join tree [6-char code]`\n\n";
  message += "*Adding People:*\n";
  message += "• `Add [name] born [year]`\n";
  message += "• `Add [name]` (without birth year)\n\n";
  message += "*Creating Relationships:*\n";
  message += "• `[Name] and [Name] are married`\n";
  message += "• `[Name] is [Name]'s father`\n";
  message += "• `[Name] is [Name]'s daughter`\n";
  message += "• `[Name] and [Name] are divorced`\n\n";
  message += "*Editing:*\n";
  message += "• `Change [old name] to [new name]`\n";
  message += "• `Set [name]'s gender to male/female`\n\n";
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
  let message = `Congrats! 🎉 You've created a tree called *${tree.name}*.\n\n`;
  message += `You can view it here:\n${BASE_URL}/tree.html?code=${tree.join_code}\n\n`;
  message += `Share this code with family to collaborate: *${tree.join_code}*\n\n`;
  message += "Add your first person by giving me their name (and maybe date of birth):\n";
  message += "`Add John Smith born 1980`";
  return message;
}

function buildAddPersonMessage(person, tree) {
  let name = `${person.data.first_name || ''} ${person.data.last_name || ''}`.trim();
  let message = `I've added *${name}*`;
  if (person.data.birthday) {
    message += ` (born ${person.data.birthday})`;
  }
  message += " to your family tree.\n\n";
  message += "What else would you like to do? You can:\n";
  message += "• Add more people\n";
  message += "• Create relationships\n";
  message += "• Type 'menu' for all commands";
  return message;
}

function buildAddRelationshipMessage(operation, tree) {
  let message = `OK, I've linked *${operation.nameA}* and *${operation.nameB}*`;
  
  const kindMap = {
    'father': 'father and child',
    'mother': 'mother and child',
    'parent': 'parent and child',
    'son': 'parent and son',
    'daughter': 'parent and daughter',
    'child': 'parent and child',
    'spouse': 'spouses',
    'divorced': 'divorced',
    'separated': 'separated'
  };
  
  if (kindMap[operation.kind]) {
    message += ` as ${kindMap[operation.kind]}`;
  }
  
  message += ".\n\n";
  message += `View your updated tree: ${BASE_URL}/tree.html?code=${tree.join_code}`;
  return message;
}

function buildMultipleMatchesMessage(name, persons) {
  let message = `I found multiple people named *${name}*:\n\n`;
  persons.forEach((p, i) => {
    const fullName = `${p.data.first_name} ${p.data.last_name || ''}`.trim();
    const birthday = p.data.birthday || 'no birth year';
    message += `${i + 1}. ${fullName} (${birthday})\n`;
  });
  message += "\nPlease be more specific, maybe by using their full name or birth year.";
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
