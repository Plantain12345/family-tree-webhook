// api/webhook.js
// Main webhook handler with dual-mode processing and entity resolution

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

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const BASE_URL = process.env.BASE_URL || "https://family-tree-webhook.vercel.app";

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

  // Handle POST requests from WhatsApp
  if (req.method === "POST") {
    const body = req.body;
    
    // Check if the event is a valid message or status from the WhatsApp Business Account
    if (body.object === "whatsapp_business_account") {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.value.messages) {
            // --- MESSAGE RECEIVED ---
            const message = change.value.messages[0];
            const from = message.from; // Sender phone number
            // Consolidated text extraction for various message types
            const text = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || ' ';
            
            console.log(`Received message from ${from}: ${text}`);

            await handleMessage(from, text);
          
            return res.status(200).send("MESSAGE_RECEIVED");
          } else if (change.value.statuses) {
            // --- STATUS UPDATE RECEIVED (DELIVERED/READ/FAILED) ---
            // Log and explicitly acknowledge status updates to prevent retries
            console.log(`Received status update for message ID: ${change.value.statuses[0].id} - Status: ${change.value.statuses[0].status}`);
            
            return res.status(200).send("STATUS_UPDATE_RECEIVED");
          }
        }
      }
    }
    
    // --- GENERIC ACKNOWLEDGEMENT ---
    // Acknowledge all other valid webhook calls (e.g., account updates, unknown event types) 
    // with a simple "OK" to prevent the descriptive log message from being sent back.
    console.log("Webhook event received but not a message or status. Acknowledging with 200.");
    return res.status(200).send("OK"); 
  }
  
  // Method not POST or GET
  return res.status(404).send("Not found");
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

async function handleMessage(phoneNumber, text) {
  // 1. Get user state
  const state = await getUserState(phoneNumber);
  let tree = null;
  let treeContext = null;

  if (state?.tree_id) {
    tree = await getTreeById(state.tree_id);
    if (tree) {
      treeContext = await getTreeContext(tree.id, db);
    } else {
      // Tree state is stale, clear it
      await setUserState(phoneNumber, null, null, null);
    }
  }

  const normalizedText = text.trim();

  // 2. Handle commands that don't need a tree
  if (normalizedText.toLowerCase() === "menu") {
    return sendWhatsAppMessage(phoneNumber, generateMenu(!!tree));
  }

  if (normalizedText.toLowerCase() === "start") {
    return sendWhatsAppMessage(phoneNumber, generateWelcomeMessage());
  }

  if (normalizedText.toLowerCase() === "help") {
    return sendWhatsAppMessage(phoneNumber, generateHelpMessage(!!tree));
  }
  
  // 3. Command mode: Join or Create
  if (!tree) {
    const joinCodeMatch = normalizedText.toUpperCase().match(/^[A-Z0-9]{6}$/);
    if (joinCodeMatch) {
      const joinCode = joinCodeMatch[0];
      const joinedTree = await getTreeByCode(joinCode);
      if (joinedTree) {
        await addMember(joinedTree.id, phoneNumber);
        await setUserState(phoneNumber, joinedTree.id, null, null);
        return sendWhatsAppMessage(phoneNumber, `Successfully joined family tree *${joinedTree.name}*! You can now add people and relationships.`);
      } else {
        return sendWhatsAppMessage(phoneNumber, `I couldn't find a family tree with the code *${joinCode}*. Please check the code and try again.`);
      }
    }

    const createMatch = normalizedText.match(/^(create|new)\s+(.+)/i);
    if (createMatch) {
      const treeName = createMatch[2].trim();
      const newTree = await createTree(phoneNumber, treeName);
      await setUserState(phoneNumber, newTree.id, null, null);
      const shareUrl = `${BASE_URL}/tree.html?code=${newTree.join_code}`;
      return sendWhatsAppMessage(phoneNumber, generateTreeCreatedMessage(newTree.name, newTree.join_code, shareUrl));
    }

    return sendWhatsAppMessage(phoneNumber, generateWelcomeMessage());
  }
  
  // 4. Check if member of the current tree
  if (!(await isMember(tree.id, phoneNumber))) {
    // Should not happen if state is good, but good for safety
    await setUserState(phoneNumber, null, null, null);
    return sendWhatsAppMessage(phoneNumber, `It looks like you are no longer a member of the *${tree.name}* tree. Type *MENU* to see options.`);
  }

  // 5. Handle Pending Actions (Confirmation mode)
  const pendingAction = await getPendingAction(phoneNumber);
  if (pendingAction) {
    const confirmationMatch = normalizedText.toLowerCase().match(/^(yes|y|no|n)$/);

    if (confirmationMatch) {
      await clearPendingAction(phoneNumber);
      const response = confirmationMatch[1];
      
      if (response === 'yes' || response === 'y') {
        return handlePendingConfirmation(phoneNumber, tree, pendingAction);
      } else {
        return sendWhatsAppMessage(phoneNumber, "Action cancelled. What would you like to do next?");
      }
    } else {
      return sendWhatsAppMessage(phoneNumber, "I'm currently waiting for a confirmation. Please reply with *YES* or *NO*.");
    }
  }

  // 6. NLP Processing
  try {
    const nlpResult = await parseOps(normalizedText, treeContext);

    switch (nlpResult.action) {
      case 'create_person':
        return await handleCreatePerson(phoneNumber, tree, nlpResult.params);
      case 'add_relationship':
        return await handleAddRelationship(phoneNumber, tree, nlpResult.params);
      case 'confirm_person':
        return await handlePersonConfirmation(phoneNumber, tree, nlpResult.params);
      case 'update_person':
        return await handleUpdatePerson(phoneNumber, tree, nlpResult.params);
      case 'list_tree':
        return await handleListTree(phoneNumber, tree);
      case 'view_tree_link':
        return await handleViewTreeLink(phoneNumber, tree);
      case 'share_code':
        return await handleShareCode(phoneNumber, tree);
      case 'unknown':
      default:
        // Try to treat unknown message as a person name search
        const personMatch = normalizedText.match(/^([a-z\s]+)$/i);
        if (personMatch) {
          const persons = await findPersonByName(tree.id, personMatch[1]);
          if (persons.length === 1) {
            return sendWhatsAppMessage(phoneNumber, generatePersonInfo(persons[0]));
          } else if (persons.length > 1) {
            return sendWhatsAppMessage(phoneNumber, generatePersonList(persons, personMatch[1]));
          }
        }
        return sendWhatsAppMessage(phoneNumber, generateDefaultResponse(tree.name));
    }

  } catch (error) {
    console.error("NLP or Command processing error:", error);
    return sendWhatsAppMessage(phoneNumber, `Oops! I ran into an error: ${error.message}. Please try again or type *HELP*.`);
  }
}

// ============================================================================
// PENDING ACTION HANDLERS
// ============================================================================

async function handlePendingConfirmation(phoneNumber, tree, pendingAction) {
  const { action, params } = pendingAction.action;

  try {
    switch (action) {
      case 'create_person':
        return await handleCreatePerson(phoneNumber, tree, params, true);
      case 'add_relationship':
        return await handleAddRelationship(phoneNumber, tree, params, true);
      default:
        return sendWhatsAppMessage(phoneNumber, "Unknown pending action. Please try your request again.");
    }
  } catch (error) {
    console.error("Pending action execution error:", error);
    return sendWhatsAppMessage(phoneNumber, `I ran into an error while trying to complete the action: ${error.message}.`);
  }
}

// ============================================================================
// ACTION IMPLEMENTATIONS
// ============================================================================

async function handleCreatePerson(phoneNumber, tree, params, confirmed = false) {
  const { first_name, last_name, gender, birthday } = params;
  const fullName = `${first_name} ${last_name || ''}`.trim();

  // 1. Search for similar people if not confirmed
  if (!confirmed) {
    const similar = await findSimilarPersons(tree.id, first_name, last_name, birthday);
    if (similar.length > 0) {
      // Save pending action and ask for confirmation
      await savePendingAction(phoneNumber, tree.id, { action: 'create_person', params });
      return sendWhatsAppMessage(phoneNumber, generatePersonConflictMessage(fullName, similar));
    }
  }
  
  // 2. Insert the person
  const newPerson = await insertPerson(tree.id, first_name, last_name, gender, birthday);
  await setUserState(phoneNumber, tree.id, newPerson.id, fullName); // Update state to last person created

  // 3. Respond
  return sendWhatsAppMessage(phoneNumber, `✅ Person *${fullName}* (Born ${newPerson.data.birthday || 'Year Unknown'}) has been added to *${tree.name}*.`);
}

async function handleAddRelationship(phoneNumber, tree, params, confirmed = false) {
  const { person_a, relationship, person_b } = params;
  const kind = RELATIONSHIP_TYPES[relationship.toUpperCase()];

  // 1. Resolve Person A
  const personAs = await findPersonByName(tree.id, person_a);
  if (personAs.length !== 1) {
    await savePendingAction(phoneNumber, tree.id, { action: 'confirm_person', params: { ...params, person_key: 'person_a', persons: personAs } });
    return sendWhatsAppMessage(phoneNumber, generatePersonList(personAs, person_a, "person_a"));
  }
  const personAId = personAs[0].id;
  
  // 2. Resolve Person B
  const personBs = await findPersonByName(tree.id, person_b);
  if (personBs.length !== 1) {
    await savePendingAction(phoneNumber, tree.id, { action: 'confirm_person', params: { ...params, person_key: 'person_b', persons: personBs } });
    return sendWhatsAppMessage(phoneNumber, generatePersonList(personBs, person_b, "person_b"));
  }
  const personBId = personBs[0].id;

  // 3. Prevent duplicate/invalid
  if (!confirmed) {
    const exists = await relationshipExists(tree.id, kind, personAId, personBId);
    if (exists) {
      // If it's a symmetric relationship (spouse), no need to ask for confirmation again.
      if ([RELATIONSHIP_TYPES.SPOUSE, RELATIONSHIP_TYPES.DIVORCED, RELATIONSHIP_TYPES.SEPARATED].includes(kind)) {
         return sendWhatsAppMessage(phoneNumber, `*${personAs[0].data.first_name}* is already linked as the ${kind} of *${personBs[0].data.first_name}*. No change made.`);
      }
      
      // For parent/child, ask for confirmation to override or confirm.
      await savePendingAction(phoneNumber, tree.id, { action: 'add_relationship', params });
      return sendWhatsAppMessage(phoneNumber, `Warning: *${personAs[0].data.first_name}* is already linked as the ${kind} of *${personBs[0].data.first_name}*. Reply *YES* to add this relationship again or *NO* to cancel.`);
    }
  }

  // 4. Add the relationship
  const relResult = await addRelationship(tree.id, kind, personAId, personBId);

  // 5. Respond
  const aName = personAs[0].data.first_name;
  const bName = personBs[0].data.first_name;

  if (relResult?.duplicate) {
     return sendWhatsAppMessage(phoneNumber, `*${aName}* is already linked as the ${kind} of *${bName}*. No change made.`);
  }

  const successMessage = `✅ Relationship added: *${aName}* is the ${kind} of *${bName}* in *${tree.name}*.`;
  
  // Add reverse relationship if symmetric (spouse, divorced, separated)
  if ([RELATIONSHIP_TYPES.SPOUSE, RELATIONSHIP_TYPES.DIVORCED, RELATIONSHIP_TYPES.SEPARATED].includes(kind)) {
    // Check if reverse is needed (it may already exist if confirmed=true)
    const reverseExists = await relationshipExists(tree.id, kind, personBId, personAId);
    if (!reverseExists) {
        await addRelationship(tree.id, kind, personBId, personAId);
    }
  }
  
  // For parent/child, auto-add child/parent relationship too
  if (kind === RELATIONSHIP_TYPES.PARENT) {
    await addRelationship(tree.id, RELATIONSHIP_TYPES.CHILD, personBId, personAId);
  } else if (kind === RELATIONSHIP_TYPES.CHILD) {
    await addRelationship(tree.id, RELATIONSHIP_TYPES.PARENT, personBId, personAId);
  }

  return sendWhatsAppMessage(phoneNumber, successMessage);
}

async function handlePersonConfirmation(phoneNumber, tree, params) {
  const { person_key, persons, person_a, relationship, person_b } = params;

  // The confirmation message should have presented the list with numbers.
  const indexMatch = params.message.match(/^(\d+)$/);
  if (!indexMatch) {
    await savePendingAction(phoneNumber, tree.id, { action: 'confirm_person', params }); // Re-save
    return sendWhatsAppMessage(phoneNumber, "Please reply with the *number* of the person you want to select, or *CANCEL*.");
  }

  const selectedIndex = parseInt(indexMatch[1]) - 1;
  const selectedPerson = persons[selectedIndex];

  if (!selectedPerson) {
    await savePendingAction(phoneNumber, tree.id, { action: 'confirm_person', params }); // Re-save
    return sendWhatsAppMessage(phoneNumber, "Invalid number. Please reply with the *number* of the person you want to select, or *CANCEL*.");
  }

  // Update the original relationship parameters with the confirmed person ID/Name
  const updatedParams = { ...params };

  if (person_key === 'person_a') {
    updatedParams.person_a = selectedPerson.data.first_name; // Use full name if needed later
    updatedParams.person_a_id = selectedPerson.id;
  } else if (person_key === 'person_b') {
    updatedParams.person_b = selectedPerson.data.first_name; // Use full name if needed later
    updatedParams.person_b_id = selectedPerson.id;
  }

  // Clear the confirmation action and re-run the main relationship handler
  await clearPendingAction(phoneNumber);
  
  // Check if both persons are now resolved
  if (updatedParams.person_a_id && updatedParams.person_b_id) {
    // Both resolved, proceed to add relationship
    return await handleAddRelationship(phoneNumber, tree, updatedParams);
  } else {
    // One is resolved, now re-run to resolve the other
    // For this example, we'll simplify and re-run the main handler which will re-resolve all
    return await handleAddRelationship(phoneNumber, tree, updatedParams);
  }
}

async function handleUpdatePerson(phoneNumber, tree, params) {
  const { person_name, updates } = params;
  
  // 1. Resolve Person
  const persons = await findPersonByName(tree.id, person_name);
  if (persons.length !== 1) {
    await savePendingAction(phoneNumber, tree.id, { action: 'confirm_person', params: { person_key: 'person_to_update', persons: persons, updates } });
    return sendWhatsAppMessage(phoneNumber, generatePersonList(persons, person_name, "update"));
  }
  const person = persons[0];

  // 2. Perform Update
  const updatedPerson = await updatePerson(person.id, updates);
  const updatedName = `${updatedPerson.data.first_name} ${updatedPerson.data.last_name || ''}`.trim();
  
  // 3. Respond
  const updateKeys = Object.keys(updates).map(k => k.replace('_', ' ')).join(', ');
  return sendWhatsAppMessage(phoneNumber, `✅ *${updatedName}*'s *${updateKeys}* has been updated in *${tree.name}*.`);
}

async function handleListTree(phoneNumber, tree) {
  // Simple view of the last updated person and count
  const count = tree.person_count;
  const lastPerson = tree.last_person_name || 'No people added yet.';
  const link = `${BASE_URL}/tree.html?code=${tree.join_code}`;
  
  let message = `*${tree.name}* (${tree.join_code}) has ${count} people.\n`;
  message += `\nLast person added/updated: ${lastPerson}`;
  message += `\n\nTo view the tree, click the link: ${link}`;
  message += `\n\nType *HELP* for more commands.`;
  
  return sendWhatsAppMessage(phoneNumber, message);
}

async function handleViewTreeLink(phoneNumber, tree) {
  const link = `${BASE_URL}/tree.html?code=${tree.join_code}`;
  return sendWhatsAppMessage(phoneNumber, `Open your family tree *${tree.name}* here:\n${link}`);
}

async function handleShareCode(phoneNumber, tree) {
  const code = tree.join_code;
  const link = `${BASE_URL}/tree.html?code=${code}`;
  const message = generateTreeCreatedMessage(tree.name, code, link);
  return sendWhatsAppMessage(phoneNumber, message);
}


// ============================================================================
// RESPONSE GENERATORS
// ============================================================================

function generateWelcomeMessage() {
  return `👋 Welcome to the Family Tree Bot!
\nTo *create* a new tree, reply with:
> *Create* [your family name]
\nTo *join* an existing tree, reply with the 6-digit join code:
> *[Code]* (e.g., A1B2C3)
\nType *HELP* for more details at any time.`;
}

function generateMenu(hasTree) {
  let menu = "*Family Tree Menu*\n\n";
  if (hasTree) {
    menu += "🌳 *Current Tree:*\n";
    menu += "1. *View Link* - Get the web link to see the graph.\n";
    menu += "2. *Share Code* - Get the code to invite others.\n";
    menu += "3. *Help* - See commands for adding people/relationships.\n";
    menu += "4. *List Tree* - Get a quick summary.\n";
  } else {
    menu += "5. *Create* [name] - Start a new tree (e.g., Create Smith Family).\n";
    menu += "6. *[Code]* - Join an existing tree (e.g., A1B2C3).\n";
  }
  return menu;
}

function generateHelpMessage(hasTree) {
  let help = "*Family Tree Bot Help*\n\n";

  if (hasTree) {
    help += `You are currently working on the tree *${hasTree}*.`;
    help += "\n\n*1. Add a Person:*\n";
    help += "> *Add John Doe 1990 Male*\n";
    help += "*(Last Name and Birth Year are optional)*\n";
    
    help += "\n*2. Add a Relationship:*\n";
    help += "> *John is Mary's father*\n";
    help += "> *Mike and Grace are spouses*\n";
    help += "*(Supported relationships: parent, child, spouse, divorced, separated)*\n";
    
    help += "\n*3. Update a Person:*\n";
    help += "> *Change John's gender to Male*\n";
    
    help += "\n*4. Find a Person:*\n";
    help += "> *John*\n";
    
    help += "\n*5. Menu:*\n";
    help += "> *Menu* - See options for sharing the tree link and code.\n";

  } else {
    help += "\n*Getting Started:*\n";
    help += "To create a new tree, use: *Create [Name]*\n";
    help += "To join an existing tree, just send the 6-digit code.\n";
  }

  return help;
}

function generateTreeCreatedMessage(treeName, joinCode, shareUrl) {
  return `🎉 Family tree *${treeName}* has been created!
\n*Join Code:* ${joinCode}
\nSend this code to family members so they can join and contribute.
\nView your tree here: ${shareUrl}
\n\nStart adding people now (e.g., *Add John Doe 1990 Male*) or type *HELP*.`;
}

function generateDefaultResponse(treeName) {
  return `I'm sorry, I didn't understand that command. You are working on *${treeName}*. 
\nType *HELP* for commands (like *Add*, *Change*, or relationship formats).
\nType *MENU* to get the link/code.`;
}

function generatePersonInfo(person) {
  const name = `${person.data.first_name} ${person.data.last_name || ''}`.trim();
  const gender = person.data.gender === db.GENDER_TYPES.MALE ? 'Male' : person.data.gender === db.GENDER_TYPES.FEMALE ? 'Female' : 'Unknown';
  const birthday = person.data.birthday || 'Year Unknown';
  
  let message = `*${name}* (${gender})\n`;
  message += `Born: ${birthday}\n`;
  
  // NOTE: This can be expanded to show relationships later, but for now, keep it simple.
  
  return message;
}

function generatePersonConflictMessage(fullName, similarPersons) {
  let message = `I found people similar to *${fullName}* in your tree:*\n\n`;
  
  similarPersons.forEach((p, i) => {
    const pName = `${p.data.first_name} ${p.data.last_name || ''}`.trim();
    const pYear = p.data.birthday || 'Unknown Year';
    message += `${i + 1}. ${pName} (${pYear})\n`;
  });
  
  message += "\nIf one of these is the person you meant, please correct your spelling. If you want to add this *new* person anyway, reply with *YES* or *NO* to cancel.";
  return message;
}

function generatePersonList(persons, searchName, personKey) {
  // If only one person, this function shouldn't be called, but handle it anyway
  if (persons.length === 1) {
    return `Did you mean *${persons[0].data.first_name}*?`;
  }
  
  let message = `I found multiple people for *${searchName}*:\n\n`;
  persons.forEach((p, i) => {
    const fullName = `${p.data.first_name} ${p.data.last_name || ''}`.trim();
    const birthday = p.data.birthday || 'no birth year';
    message += `${i + 1}. ${fullName} (${birthday})\n`;
  });
  
  if (personKey === 'person_a' || personKey === 'person_b') {
    message += "\n*Please reply with the number of the person you mean.*";
  } else if (personKey === 'update') {
    message += "\n*Please reply with the number of the person you want to update.*";
  } else {
    message += "\n*Please be more specific, maybe by using their full name or birth year.*";
  }
  
  return message;
}

// ============================================================================\n// WHATSAPP API
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
    console.error("Failed to send message to WhatsApp API:", error);
  }
}
