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
import crypto from 'crypto'; // Import Node.js crypto module for decryption

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const BASE_URL = process.env.BASE_URL || "https://family-tree-webhook.vercel.app";
// Retrieve the Private Key from Vercel environment variables
const FLOWS_RSA_PRIVATE_KEY = process.env.FLOWS_RSA_PRIVATE_KEY;


// ============================================================================
// RSA DECRYPTION UTILITY
// ============================================================================

/**
 * Decrypts a base64-encoded payload using RSA private key decryption.
 * @param {string} encryptedBase64 The base64-encoded encrypted data.
 * @returns {string | null} The decrypted plain text, or null on failure.
 */
function decryptFlowToken(encryptedBase64) {
  if (!FLOWS_RSA_PRIVATE_KEY) {
    console.error("FLOWS_RSA_PRIVATE_KEY is missing from environment variables.");
    return null;
  }
  
  try {
    // 1. Convert the Base64 encrypted string to a Buffer
    const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');

    // 2. Decrypt the buffer using the private key and PKCS1 padding
    // Note: The WhatsApp Flows API uses PKCS1 padding (RSA/ECB/PKCS1Padding)
    const decryptedBuffer = crypto.privateDecrypt(
      {
        key: FLOWS_RSA_PRIVATE_KEY,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      encryptedBuffer
    );
    
    // 3. Convert the decrypted buffer back to a string (which is the flow_token)
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

  // Handle incoming messages
  if (req.method === "POST") {
    try {
      const body = req.body;
      const changes = body?.entry?.[0]?.changes?.[0];
      const messages = changes?.value?.messages;

      if (messages) {
        for (const message of messages) {
          const phoneNumber = message.from;
          const profileName = changes.value.contacts[0].profile.name;
          
          // Check for a Flow Completion Message
          if (message.type === 'interactive' && message.interactive.type === 'flow_completion') {
            await handleFlowCompletion(phoneNumber, profileName, message.interactive.flow_completion);
            continue; // Skip normal text/NLP processing
          }
          
          // Normal text message processing
          if (message.type === "text") {
            await processTextMessage(phoneNumber, message.text.body, profileName);
          }
          // Add other message type handling (media, location, etc.) here if needed
        }
      }

      return res.status(200).send("EVENT_RECEIVED");
    } catch (error) {
      console.error("Webhook processing error:", error);
      return res.status(500).send("Internal Server Error");
    }
  }
}

// ============================================================================
// FLOW HANDLER
// ============================================================================

async function handleFlowCompletion(phoneNumber, profileName, flowCompletionData) {
  const { flow_token: encryptedFlowToken, encrypted_flow_data } = flowCompletionData;

  console.log(`Received flow_completion from ${profileName}. Encrypted Token: ${encryptedFlowToken}`);

  // 1. DECRYPT the flow_token
  const decryptedFlowToken = decryptFlowToken(encryptedFlowToken);

  if (!decryptedFlowToken) {
    // Respond to the user that the system is unable to process the flow
    await sendWhatsAppMessage(phoneNumber, "Sorry, I couldn't securely process your request. Please try again.");
    return;
  }

  console.log(`Decrypted Flow Token: ${decryptedFlowToken}`);
  
  // 2. USE the decrypted token to fetch the final data from Meta
  // You will need a new function here to call the WhatsApp API:
  // const finalFlowData = await fetchFlowData(decryptedFlowToken);

  // For now, let's just confirm receipt.
  await sendWhatsAppMessage(phoneNumber, `Thank you for completing the flow! Your unique ID is: ${decryptedFlowToken}`);

  // TODO: Add logic here to:
  // a) Call the Meta API to get the final submitted data using the decryptedFlowToken
  // b) Parse the final data (like names, birthdays, relationships)
  // c) Use the logic from _db.js (e.g., insertPerson, addRelationship) to update your Supabase database.
}

// ============================================================================
// EXISTING FUNCTIONS (Moved for brevity, assume they remain at the bottom)
// ============================================================================

// [Existing processTextMessage and related functions should remain here]

async function processTextMessage(phoneNumber, text, profileName) {
  // ... (existing logic) ...
}

function formatPersonsMessage(persons, searchName) {
  // ... (existing logic) ...
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
    console.error("Error sending WhatsApp message:", error);
  }
}
