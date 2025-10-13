// api/webhook.js
// WhatsApp Flow-based webhook handler

import {
  createTree,
  getTreeById,
  getTreeByCode,
  getUserState,
  setUserState,
  insertPerson,
  addRelationship,
  addMember,
  isMember,
  RELATIONSHIP_TYPES,
  GENDER_TYPES
} from "./_db.js";

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

  // Handle POST requests
  if (req.method === "POST") {
    const body = req.body;
    
    // WhatsApp Flow Data Exchange Endpoint
    if (body.action) {
      return handleFlowDataExchange(req, res);
    }
    
    // WhatsApp Business Account messages
    if (body.object === "whatsapp_business_account") {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.value.messages) {
            const message = change.value.messages[0];
            const from = message.from;
            
            // Handle flow response
            if (message.type === "interactive" && message.interactive?.type === "nfm_reply") {
              await handleFlowResponse(from, message.interactive.nfm_reply);
              return res.status(200).send("FLOW_RESPONSE_RECEIVED");
            }
            
            // Handle regular text messages
            const text = message.text?.body || 
                        message.button?.text || 
                        message.interactive?.button_reply?.title || 
                        message.interactive?.list_reply?.title || '';
            
            console.log(`Received message from ${from}: ${text}`);
            await handleMessage(from, text);
            return res.status(200).send("MESSAGE_RECEIVED");
            
          } else if (change.value.statuses) {
            console.log(`Status update: ${change.value.statuses[0].status}`);
            return res.status(200).send("STATUS_UPDATE_RECEIVED");
          }
        }
      }
    }
    
    return res.status(200).send("OK");
  }
  
  return res.status(404).send("Not found");
}

// ============================================================================
// FLOW DATA EXCHANGE HANDLER (for Flow endpoints)
// ============================================================================

async function handleFlowDataExchange(req, res) {
  const { action, screen, data, flow_token } = req.body;
  
  try {
    let responseData = {};
    
    // Health check
    if (action === "ping") {
      responseData = {
        version: "3.0",
        data: {
          status: "active"
        }
      };
    }
    
    // Handle screen data requests
    else if (action === "data_exchange") {
      // Decode flow_token if needed (contains user context)
      const context = flow_token ? JSON.parse(Buffer.from(flow_token, 'base64').toString()) : {};
      
      switch (screen) {
        case "ADD_MEMBER":
          responseData = await handleAddMemberScreen(data, context);
          break;
          
        case "ADD_RELATIONSHIP":
          responseData = await handleAddRelationshipScreen(data, context);
          break;
          
        default:
          responseData = {
            version: "3.0",
            data: {
              error: "Unknown screen"
            }
          };
      }
    }
    
    // Encode response data as Base64
    const encodedData = Buffer.from(JSON.stringify(responseData.data)).toString('base64');
    
    return res.status(200).json({
      version: "3.0",
      data: encodedData
    });
    
  } catch (error) {
    console.error("Flow data exchange error:", error);
    
    const errorData = {
      error: error.message || "Internal server error"
    };
    
    const encodedError = Buffer.from(JSON.stringify(errorData)).toString('base64');
    
    return res.status(200).json({
      version: "3.0",
      data: encodedError
    });
  }
}

// ============================================================================
// FLOW SCREEN HANDLERS
// ============================================================================

async function handleAddMemberScreen(data, context) {
  // When user submits the "Add Family Member" form
  const { first_name, last_name, gender, year_of_birth } = data;
  
  // Get tree from context
  const treeId = context.tree_id;
  if (!treeId) {
    return {
      version: "3.0",
      data: {
        error: "No tree selected"
      }
    };
  }
  
  // Insert person into database
  const newPerson = await insertPerson(
    treeId, 
    first_name, 
    last_name || null, 
    gender || null, 
    year_of_birth || null
  );
  
  const fullName = `${first_name} ${last_name || ''}`.trim();
  
  return {
    version: "3.0",
    data: {
      success: true,
      person_id: newPerson.id,
      person_name: fullName,
      message: `${fullName} has been added!`
    }
  };
}

async function handleAddRelationshipScreen(data, context) {
  // When user submits the "Add Relationship" form
  const { person_a_name, relationship_type, person_b_name } = data;
  
  const treeId = context.tree_id;
  if (!treeId) {
    return {
      version: "3.0",
      data: {
        error: "No tree selected"
      }
    };
  }
  
  // Note: You'll need to implement person lookup by name
  // For now, returning success
  
  return {
    version: "3.0",
    data: {
      success: true,
      message: `Relationship added: ${person_a_name} is ${relationship_type} of ${person_b_name}`
    }
  };
}

// ============================================================================
// FLOW RESPONSE HANDLER (when user completes a flow)
// ============================================================================

async function handleFlowResponse(phoneNumber, nfmReply) {
  const { name, response_json } = nfmReply;
  const responseData = JSON.parse(response_json);
  
  console.log(`Flow completed: ${name}`, responseData);
  
  // Get user's current tree
  const state = await getUserState(phoneNumber);
  const tree = state?.tree_id ? await getTreeById(state.tree_id) : null;
  
  if (!tree) {
    return sendWhatsAppMessage(phoneNumber, "⚠️ Please create or join a tree first!");
  }
  
  // Handle based on flow name
  if (name === "add_family_member") {
    const { first_name, last_name, gender, year_of_birth } = responseData;
    
    // Map gender string to GENDER_TYPES
    const genderType = gender?.toLowerCase() === 'male' ? GENDER_TYPES.MALE :
                       gender?.toLowerCase() === 'female' ? GENDER_TYPES.FEMALE : null;
    
    const newPerson = await insertPerson(
      tree.id,
      first_name,
      last_name || null,
      genderType,
      year_of_birth || null
    );
    
    const fullName = `${first_name} ${last_name || ''}`.trim();
    await setUserState(phoneNumber, tree.id, newPerson.id, fullName);
    
    return sendWhatsAppMessage(
      phoneNumber, 
      `✅ *${fullName}* has been added to *${tree.name}*!\n\nBorn: ${year_of_birth || 'Unknown'}\nGender: ${gender || 'Not specified'}`
    );
  }
  
  if (name === "add_relationship") {
    // Handle relationship flow response
    return sendWhatsAppMessage(phoneNumber, "✅ Relationship added successfully!");
  }
  
  return sendWhatsAppMessage(phoneNumber, "Flow completed!");
}

// ============================================================================
// MESSAGE HANDLER (for button clicks and text commands)
// ============================================================================

async function handleMessage(phoneNumber, text) {
  const state = await getUserState(phoneNumber);
  let tree = null;

  if (state?.tree_id) {
    tree = await getTreeById(state.tree_id);
    if (!tree) {
      await setUserState(phoneNumber, null, null, null);
    }
  }

  const normalizedText = text.trim().toLowerCase();

  // Commands without a tree
  if (normalizedText === "menu" || normalizedText === "start") {
    return sendMainMenu(phoneNumber, tree);
  }

  if (normalizedText === "help") {
    return sendWhatsAppMessage(phoneNumber, generateHelpMessage(tree));
  }
  
  // Join tree with code
  if (!tree) {
    const joinCodeMatch = text.toUpperCase().match(/^[A-Z0-9]{6}$/);
    if (joinCodeMatch) {
      const joinCode = joinCodeMatch[0];
      const joinedTree = await getTreeByCode(joinCode);
      if (joinedTree) {
        await addMember(joinedTree.id, phoneNumber);
        await setUserState(phoneNumber, joinedTree.id, null, null);
        return sendWhatsAppMessage(
          phoneNumber, 
          `✅ Successfully joined family tree *${joinedTree.name}*!`
        );
      } else {
        return sendWhatsAppMessage(
          phoneNumber, 
          `❌ I couldn't find a tree with code *${joinCode}*. Please check and try again.`
        );
      }
    }

    // Create new tree
    const createMatch = text.match(/^(create|new)\s+(.+)/i);
    if (createMatch) {
      const treeName = createMatch[2].trim();
      const newTree = await createTree(phoneNumber, treeName);
      await setUserState(phoneNumber, newTree.id, null, null);
      const shareUrl = `${BASE_URL}/tree.html?code=${newTree.join_code}`;
      return sendWhatsAppMessage(
        phoneNumber,
        `🎉 Family tree *${treeName}* created!\n\n*Join Code:* ${newTree.join_code}\n\nView tree: ${shareUrl}\n\nReply with *MENU* to see options.`
      );
    }

    return sendWhatsAppMessage(phoneNumber, generateWelcomeMessage());
  }
  
  // Check membership
  if (!(await isMember(tree.id, phoneNumber))) {
    await setUserState(phoneNumber, null, null, null);
    return sendWhatsAppMessage(
      phoneNumber, 
      `You are no longer a member of *${tree.name}*. Type *MENU* to see options.`
    );
  }

  // Tree commands
  if (normalizedText === "view" || normalizedText === "view tree") {
    const link = `${BASE_URL}/tree.html?code=${tree.join_code}`;
    return sendWhatsAppMessage(phoneNumber, `🌳 View your tree: ${link}`);
  }

  if (normalizedText === "share" || normalizedText === "share code") {
    return sendWhatsAppMessage(
      phoneNumber,
      `Share this code with family:\n\n*${tree.join_code}*`
    );
  }

  if (normalizedText === "info") {
    return sendWhatsAppMessage(
      phoneNumber,
      `*${tree.name}*\n\n👥 Members: ${tree.person_count || 0}\n📋 Code: ${tree.join_code}`
    );
  }

  // Default: show menu
  return sendMainMenu(phoneNumber, tree);
}

// ============================================================================
// MENU SENDERS
// ============================================================================

async function sendMainMenu(phoneNumber, tree) {
  if (!tree) {
    return sendWhatsAppMessage(phoneNumber, generateWelcomeMessage());
  }
  
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const flowId = process.env.WHATSAPP_FLOW_ID; // Your Flow ID from Meta

  if (!token || !phoneNumberId) {
    return sendWhatsAppMessage(phoneNumber, "API credentials missing.");
  }

  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  
  // Create flow_token with user context
  const flowToken = Buffer.from(JSON.stringify({
    tree_id: tree.id,
    phone_number: phoneNumber
  })).toString('base64');
  
  const payload = {
    messaging_product: "whatsapp",
    to: phoneNumber,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: `*${tree.name}* Menu\n\n👥 ${tree.person_count || 0} family members\n\nWhat would you like to do?`
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: "view_tree",
              title: "🌳 View Tree"
            }
          },
          {
            type: "reply",
            reply: {
              id: "share_code",
              title: "📤 Share Code"
            }
          },
          {
            type: "reply",
            reply: {
              id: "add_member_flow",
              title: "➕ Add Member"
            }
          }
        ]
      }
    }
  };
  
  // If you want to use Flow button instead of regular button:
  if (flowId) {
    payload.interactive = {
      type: "flow",
      header: {
        type: "text",
        text: `${tree.name} Menu`
      },
      body: {
        text: `👥 ${tree.person_count || 0} family members\n\nAdd a new family member using the form below:`
      },
      footer: {
        text: "Powered by Family Tree Bot"
      },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: "Add Family Member",
          flow_action: "navigate",
          flow_action_payload: {
            screen: "ADD_MEMBER"
          }
        }
      }
    };
  }

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
      console.error(`WhatsApp API error:`, errorText);
    }
  } catch (error) {
    console.error("Failed to send menu:", error);
  }
}

// ============================================================================
// RESPONSE GENERATORS
// ============================================================================

function generateWelcomeMessage() {
  return `👋 *Welcome to Family Tree Bot!*

To get started:

📝 *Create* a new tree:
   Reply: *Create [family name]*
   Example: *Create Smith Family*

🔗 *Join* an existing tree:
   Reply with the 6-digit code
   Example: *A1B2C3*

Type *HELP* anytime for assistance.`;
}

function generateHelpMessage(tree) {
  if (!tree) {
    return `*Family Tree Bot Help*

*Getting Started:*
• *Create [name]* - Start a new family tree
• *[CODE]* - Join existing tree with 6-digit code

Type *START* to see the welcome message again.`;
  }

  return `*Family Tree Bot Help*

You're working on: *${tree.name}*

*Commands:*
• *MENU* - Show main menu with options
• *VIEW* - Get link to view your tree
• *SHARE* - Get invite code for family
• *INFO* - See tree details

Use the buttons in the menu to add family members and relationships!`;
}

// ============================================================================
// WHATSAPP API
// ============================================================================

async function sendWhatsAppMessage(phoneNumber, messageText) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.error("Missing WhatsApp API credentials.");
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
    console.error("Failed to send message:", error);
  }
}
