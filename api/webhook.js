// api/webhook.js
// WhatsApp Flow-based webhook handler with encryption

import crypto from 'crypto';
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
const PRIVATE_KEY = process.env.FLOW_RSA_PRIVATE_KEY; // Your private key from Meta
const PASSPHRASE = process.env.FLOW_PASSPHRASE; // Passphrase for private key

// ============================================================================
// ENCRYPTION HELPERS - Get keys inside functions, not at module level
// ============================================================================

function getPrivateKey() {
  // Try multiple possible variable names
  let privateKey = process.env.FLOW_RSA_PRIVATE_KEY || 
                   process.env.FLOWS_RSA_PRIVATE_KEY ||
                   process.env.PRIVATE_KEY;
  
  // Debug logging
  console.log('Environment variables check:', {
    FLOW_RSA_PRIVATE_KEY: !!process.env.FLOW_RSA_PRIVATE_KEY,
    FLOWS_RSA_PRIVATE_KEY: !!process.env.FLOWS_RSA_PRIVATE_KEY,
    allEnvKeys: Object.keys(process.env).filter(k => k.includes('KEY') || k.includes('FLOW'))
  });
  
  if (!privateKey) {
    const availableKeys = Object.keys(process.env).filter(k => 
      k.includes('KEY') || k.includes('FLOW') || k.includes('RSA')
    );
    throw new Error(`FLOW_RSA_PRIVATE_KEY environment variable is not set. Available keys: ${availableKeys.join(', ')}`);
  }
  
  console.log('Private key found, length:', privateKey.length);
  
  // Replace literal \n with actual newlines if needed
  privateKey = privateKey.replace(/\\n/g, '\n');
  
  // Ensure proper formatting
  if (!privateKey.includes('\n')) {
    // If key is on one line, add line breaks
    privateKey = privateKey
      .replace('-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----\n')
      .replace('-----END RSA PRIVATE KEY-----', '\n-----END RSA PRIVATE KEY-----');
  }
  
  return privateKey;
}

function decryptRequest(encryptedFlowData, encryptedAesKey, initialVector) {
  const privateKey = getPrivateKey();
  const passphrase = process.env.FLOW_PASSPHRASE;

  try {
    // Prepare decryption config
    const decryptConfig = {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    };
    
    // Only add passphrase if it exists
    if (passphrase) {
      decryptConfig.passphrase = passphrase;
    }

    // Decrypt the AES key using RSA private key
    const decryptedAesKey = crypto.privateDecrypt(
      decryptConfig,
      Buffer.from(encryptedAesKey, 'base64')
    );

    // Decrypt the flow data using AES
    const flowDataBuffer = Buffer.from(encryptedFlowData, 'base64');
    const initialVectorBuffer = Buffer.from(initialVector, 'base64');
    
    const decipher = crypto.createDecipheriv(
      'aes-128-gcm',
      decryptedAesKey,
      initialVectorBuffer
    );

    const TAG_LENGTH = 16;
    const encrypted = flowDataBuffer.subarray(0, flowDataBuffer.length - TAG_LENGTH);
    const tag = flowDataBuffer.subarray(flowDataBuffer.length - TAG_LENGTH);
    
    decipher.setAuthTag(tag);

    const decryptedData = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return JSON.parse(decryptedData.toString('utf-8'));
  } catch (error) {
    console.error('Decryption error:', error.message);
    console.error('Private key exists:', !!privateKey);
    console.error('Private key length:', privateKey?.length);
    throw error;
  }
}

function encryptResponse(response, aesKey, initialVector) {
  try {
    // Encrypt response using AES
    const cipher = crypto.createCipheriv(
      'aes-128-gcm',
      Buffer.from(aesKey, 'base64'),
      Buffer.from(initialVector, 'base64')
    );

    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(response), 'utf-8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();
    const encryptedData = Buffer.concat([encrypted, tag]);

    return encryptedData.toString('base64');
  } catch (error) {
    console.error('Encryption error:', error.message);
    throw error;
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

  // Handle POST requests
  if (req.method === "POST") {
    const body = req.body;
    
    // WhatsApp Flow Data Exchange Endpoint (encrypted)
    if (body.encrypted_flow_data) {
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
// FLOW DATA EXCHANGE HANDLER
// ============================================================================

async function handleFlowDataExchange(req, res) {
  try {
    let decryptedRequest;
    let isEncrypted = false;
    
    // Log received request
    console.log('Flow request body keys:', Object.keys(req.body));
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    // IMPORTANT: Check for health check FIRST before checking encryption
    if (req.body.action === "ping") {
      console.log('Health check (ping) detected - responding without decryption');
      
      const responseData = {
        version: req.body.version || "3.0",
        data: {
          status: "active"
        }
      };
      
      console.log('Responding to health check with:', responseData);
      return res.status(200).json(responseData);
    }
    
    // Now check if request is encrypted
    if (req.body.encrypted_flow_data && req.body.encrypted_aes_key && req.body.initial_vector) {
      isEncrypted = true;
      
      console.log('Processing encrypted request...');
      
      // Decrypt the request
      decryptedRequest = decryptRequest(
        req.body.encrypted_flow_data,
        req.body.encrypted_aes_key,
        req.body.initial_vector
      );
      
      console.log('Decrypted request:', decryptedRequest);
    } else {
      // Handle unencrypted request
      decryptedRequest = req.body;
      console.log('Unencrypted request:', decryptedRequest);
    }

    const { action, screen, data, flow_token, version } = decryptedRequest;
    
    let responseData = {};
    
    // Double-check for ping action after decryption
    if (action === "ping") {
      responseData = {
        version: version || "3.0",
        data: {
          status: "active"
        }
      };
      
      console.log('Ping action after decryption');
      
      // If it was encrypted, encrypt response; otherwise plain JSON
      if (isEncrypted) {
        const encryptedResponse = encryptResponse(
          responseData,
          req.body.encrypted_aes_key,
          req.body.initial_vector
        );
        return res.status(200).send(encryptedResponse);
      } else {
        return res.status(200).json(responseData);
      }
    }
    
    // Handle INIT action (when flow is first opened)
    if (action === "INIT") {
      responseData = {
        version: version || "3.0",
        screen: "ADD_MEMBER",
        data: {}
      };
    }
    
    // Handle data_exchange (form submission or navigation)
    else if (action === "data_exchange") {
      const context = flow_token ? JSON.parse(Buffer.from(flow_token, 'base64').toString()) : {};
      
      switch (screen) {
        case "ADD_MEMBER":
          responseData = await handleAddMemberScreen(data, context, version);
          break;
          
        default:
          responseData = {
            version: version || "3.0",
            data: {
              error: "Unknown screen"
            }
          };
      }
    }
    
    // Send response
    if (isEncrypted) {
      console.log('Encrypting response...');
      const encryptedResponse = encryptResponse(
        responseData,
        req.body.encrypted_aes_key,
        req.body.initial_vector
      );
      
      console.log('Sending encrypted response');
      return res.status(200).send(encryptedResponse);
    } else {
      console.log('Sending plain JSON response:', responseData);
      return res.status(200).json(responseData);
    }
    
  } catch (error) {
    console.error("Flow data exchange error:", error.message);
    console.error("Error stack:", error.stack);
    
    // For encrypted requests, we MUST return encrypted errors
    if (req.body.encrypted_aes_key && req.body.initial_vector) {
      try {
        const errorResponse = {
          version: "3.0",
          data: {
            error: error.message || "Internal server error"
          }
        };
        
        console.log('Attempting to encrypt error response...');
        const encryptedError = encryptResponse(
          errorResponse,
          req.body.encrypted_aes_key,
          req.body.initial_vector
        );
        
        console.log('Sending encrypted error response');
        return res.status(200).send(encryptedError);
      } catch (encryptError) {
        console.error("Failed to encrypt error response:", encryptError);
        // If we can't encrypt, we have to return 500
        return res.status(500).json({
          error: "Failed to process encrypted request: " + error.message
        });
      }
    }
    
    // For unencrypted requests, return plain JSON
    return res.status(200).json({
      version: "3.0",
      data: {
        error: error.message || "Internal server error"
      }
    });
  }
}

// ============================================================================
// FLOW SCREEN HANDLERS
// ============================================================================

async function handleAddMemberScreen(data, context, version) {
  // When user submits the "Add Family Member" form
  const { first_name, last_name, gender, birth_year, death_year } = data;
  
  // Get tree from context
  const treeId = context.tree_id;
  if (!treeId) {
    return {
      version: version || "3.0",
      screen: "ADD_MEMBER",
      data: {
        error: "No tree selected. Please start from WhatsApp menu."
      }
    };
  }
  
  try {
    // Map gender from dropdown ID to database type
    const genderType = gender === 'male' ? GENDER_TYPES.MALE :
                       gender === 'female' ? GENDER_TYPES.FEMALE : null;
    
    // Insert person into database
    const newPerson = await insertPerson(
      treeId, 
      first_name, 
      last_name || null, 
      genderType, 
      birth_year || null,
      death_year || null
    );
    
    const fullName = `${first_name} ${last_name || ''}`.trim();
    
    // Success response - this will close the flow
    return {
      version: version || "3.0",
      screen: "SUCCESS",
      data: {
        extension_message_response: {
          params: {
            flow_token: context.flow_token,
            some_param_name: "some_param_value"
          }
        }
      }
    };
    
  } catch (error) {
    console.error('Error adding member:', error);
    
    return {
      version: version || "3.0",
      screen: "ADD_MEMBER",
      data: {
        error: `Failed to add member: ${error.message}`
      }
    };
  }
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
  
  // Extract member data from the payload
  const memberData = responseData.member || responseData;
  const { first_name, last_name, gender, birth_year, death_year } = memberData;
  
  try {
    // Map gender from dropdown ID to database type
    const genderType = gender === 'male' ? GENDER_TYPES.MALE :
                       gender === 'female' ? GENDER_TYPES.FEMALE : null;
    
    // Insert person into database
    const newPerson = await insertPerson(
      tree.id,
      first_name,
      last_name || null,
      genderType,
      birth_year || null,
      death_year || null
    );
    
    const fullName = `${first_name} ${last_name || ''}`.trim();
    await setUserState(phoneNumber, tree.id, newPerson.id, fullName);
    
    const genderText = gender === 'male' ? 'Male' : 
                       gender === 'female' ? 'Female' : 
                       'Prefer not to say';
    
    let message = `✅ *${fullName}* has been added to *${tree.name}*!\n\n`;
    message += `👤 Gender: ${genderText}\n`;
    if (birth_year) message += `🎂 Born: ${birth_year}\n`;
    if (death_year) message += `🕊️ Died: ${death_year}\n`;
    message += `\nReply with *MENU* to add more family members.`;
    
    return sendWhatsAppMessage(phoneNumber, message);
    
  } catch (error) {
    console.error('Error saving member:', error);
    return sendWhatsAppMessage(
      phoneNumber, 
      `❌ Sorry, I couldn't add ${first_name}. Error: ${error.message}\n\nPlease try again.`
    );
  }
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
          `✅ Successfully joined family tree *${joinedTree.name}*!\n\nReply with *MENU* to see options.`
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
        `🎉 Family tree *${treeName}* created!\n\n*Join Code:* ${newTree.join_code}\n\nView tree: ${shareUrl}\n\nReply with *MENU* to add family members.`
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
      `📤 Share this code with family:\n\n*${tree.join_code}*\n\nThey can join by sending this code to me!`
    );
  }

  if (normalizedText === "info") {
    return sendWhatsAppMessage(
      phoneNumber,
      `*${tree.name}*\n\n👥 Members: ${tree.person_count || 0}\n📋 Code: ${tree.join_code}\n\nReply *MENU* to add more people.`
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
  const flowId = process.env.WHATSAPP_FLOW_ID;

  if (!token || !phoneNumberId || !flowId) {
    return sendWhatsAppMessage(phoneNumber, "⚠️ API credentials missing. Please contact admin.");
  }

  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  
  // Create flow_token with user context
  const flowToken = Buffer.from(JSON.stringify({
    tree_id: tree.id,
    phone_number: phoneNumber
  })).toString('base64');
  
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phoneNumber,
    type: "interactive",
    interactive: {
      type: "flow",
      header: {
        type: "text",
        text: `${tree.name} 🌳`
      },
      body: {
        text: `👥 *${tree.person_count || 0} family members*\n\nAdd a new person to your family tree using the form below:`
      },
      footer: {
        text: "Tap the button to continue"
      },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: "➕ Add Family Member",
          flow_action: "navigate",
          flow_action_payload: {
            screen: "ADD_MEMBER",
            data: {}
          }
        }
      }
    }
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
      console.error(`WhatsApp API error:`, errorText);
      
      // Fallback to simple menu
      return sendWhatsAppMessage(
        phoneNumber,
        `*${tree.name}* Menu\n\n👥 ${tree.person_count || 0} members\n\nCommands:\n• *VIEW* - See your tree\n• *SHARE* - Get invite code\n• *INFO* - Tree details\n• *HELP* - Get help`
      );
    }
  } catch (error) {
    console.error("Failed to send flow menu:", error);
    return sendWhatsAppMessage(
      phoneNumber,
      `*${tree.name}* Menu\n\n👥 ${tree.person_count || 0} members\n\nCommands:\n• *VIEW* - See your tree\n• *SHARE* - Get invite code\n• *INFO* - Tree details`
    );
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
• *MENU* - Open form to add family members
• *VIEW* - Get link to view your tree
• *SHARE* - Get invite code for family
• *INFO* - See tree details

Use the *MENU* button to open the form and add family members!`;
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
