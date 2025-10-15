// api/webhook.js
// WhatsApp Flow webhook with RSA-OAEP(SHA-256) + AES-128-GCM (OpenSSL 3 / PKCS#8)
// IMPORTANT: For data_api_version "3.0", encrypt responses with the SAME AES key but an INVERTED IV (bitwise NOT).
// References: Meta Flows endpoint guidance summarized by community posts (invert IV), e.g. n8n workflow + Elixir forum quotes.

// Node 18+ on Vercel
import crypto from "crypto";
import {
  createTree,
  getTreeById,
  getTreeByCode,
  getUserState,
  setUserState,
  insertPerson,
  addMember,
  isMember,
  GENDER_TYPES,
} from "./_db.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const BASE_URL = process.env.BASE_URL || "https://family-tree-webhook.vercel.app";

// ========================== CRYPTO HELPERS ===============================

function getPrivateKeyObject() {
  let pem = process.env.FLOW_PRIVATE_KEY;
  if (!pem) {
    throw new Error(
      "FLOW_PRIVATE_KEY is not set. Paste a PKCS#8 PEM (-----BEGIN PRIVATE KEY----- ...)."
    );
  }
  if (pem.includes("\\n")) pem = pem.replace(/\\n/g, "\n");
  return crypto.createPrivateKey({
    key: pem,
    format: "pem",
    passphrase: process.env.FLOW_PASSPHRASE || undefined,
  });
}

/** Bitwise invert IV bytes for response encryption (Flows v3 requirement). */
function invertIv(ivBuf) {
  const out = Buffer.alloc(ivBuf.length);
  for (let i = 0; i < ivBuf.length; i++) out[i] = ivBuf[i] ^ 0xff;
  return out;
}

/**
 * Decrypts Meta's request. Returns { payload, aesKey, iv }.
 */
function decryptRequest(encryptedFlowData, encryptedAesKey, initialVector) {
  const keyObject = getPrivateKeyObject();

  // 1) RSA-OAEP(SHA-256) => recover AES session key (16 bytes)
  const aesKey = crypto.privateDecrypt(
    {
      key: keyObject,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(encryptedAesKey, "base64")
  );

  if (aesKey.length !== 16) {
    throw new Error(
      `Decrypted AES key invalid length ${aesKey.length}; expected 16 for aes-128-gcm`
    );
  }

  // 2) AES-128-GCM => decrypt payload
  const iv = Buffer.from(initialVector, "base64"); // Meta may send 12 or 16
  if (iv.length !== 12 && iv.length !== 16) {
    console.warn(`Unexpected IV length ${iv.length}; proceeding`);
  }

  const blob = Buffer.from(encryptedFlowData, "base64");
  const TAG_LEN = 16;
  const ciphertext = blob.subarray(0, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);

  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const payload = JSON.parse(plaintext.toString("utf8"));

  return { payload, aesKey, iv };
}

/**
 * Encrypt JSON response with AES-128-GCM using decrypted aesKey + **INVERTED** iv.
 * Returns base64(ciphertext || tag).
 */
function encryptResponseJson(responseObj, aesKey, requestIv) {
  const respIv = invertIv(requestIv);
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, respIv);
  const body = Buffer.from(JSON.stringify(responseObj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    base64: Buffer.concat([ciphertext, tag]).toString("base64"),
    respIv, // return for self-check
  };
}

/**
 * Self-verify the encrypted blob (using inverted IV) can be decrypted locally.
 */
function trySelfDecrypt(base64Blob, aesKey, requestIv) {
  try {
    const respIv = invertIv(requestIv);
    const blob = Buffer.from(base64Blob, "base64");
    const TAG_LEN = 16;
    const ct = blob.subarray(0, blob.length - TAG_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const dec = crypto.createDecipheriv("aes-128-gcm", aesKey, respIv);
    dec.setAuthTag(tag);
    const plain = Buffer.concat([dec.update(ct), dec.final()]);
    return plain.toString("utf8");
  } catch (e) {
    console.error("Self-decrypt failed:", e.message);
    return null;
  }
}

// =========================== WEBHOOK =====================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");

  // GET: webhook verification (opening in a browser without hub params will show "Verification failed" — that's OK)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified successfully.");
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
  }

  if (req.method === "POST") {
    const body = req.body;

    // Flow Data Exchange (encrypted)
    if (body.encrypted_flow_data && body.encrypted_aes_key && body.initial_vector) {
      return handleFlowDataExchange(req, res);
    }

    // Regular WABA messages
    if (body.object === "whatsapp_business_account") {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.value.messages) {
            const message = change.value.messages[0];
            const from = message.from;

            if (message.type === "interactive" && message.interactive?.type === "nfm_reply") {
              await handleFlowResponse(from, message.interactive.nfm_reply);
              return res.status(200).send("FLOW_RESPONSE_RECEIVED");
            }

            const text =
              message.text?.body ||
              message.button?.text ||
              message.interactive?.button_reply?.title ||
              message.interactive?.list_reply?.title ||
              "";

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

// ===================== FLOW DATA EXCHANGE HANDLER =========================

async function handleFlowDataExchange(req, res) {
  try {
    console.log("Flow request body keys:", Object.keys(req.body));

    const { payload, aesKey, iv } = decryptRequest(
      req.body.encrypted_flow_data,
      req.body.encrypted_aes_key,
      req.body.initial_vector
    );

    const { action, screen, data, flow_token, version } = payload;
    console.log("Flow action:", action, "IV len:", iv.length, "AES len:", aesKey.length);

    let responseData;

    if (action === "ping") {
      // Health check
      responseData = { version: version || "3.0", data: { status: "active" } };
      const { base64 } = encryptResponseJson(responseData, aesKey, iv);
      const echo = trySelfDecrypt(base64, aesKey, iv);
      if (!echo) return res.status(500).json({ error: "Local self-decrypt failed" });
      res.setHeader("Content-Type", "text/plain");
      return res.status(200).send(base64);
    }

    if (action === "INIT") {
      responseData = { version: version || "3.0", screen: "ADD_MEMBER", data: {} };
    } else if (action === "data_exchange") {
      const context = flow_token ? JSON.parse(Buffer.from(flow_token, "base64").toString()) : {};
      switch (screen) {
        case "ADD_MEMBER":
          responseData = await handleAddMemberScreen(data, context, version);
          break;
        default:
          responseData = { version: version || "3.0", data: { error: "Unknown screen" } };
      }
    } else {
      responseData = { version: version || "3.0", data: { error: "Unknown action" } };
    }

    const { base64 } = encryptResponseJson(responseData, aesKey, iv);
    const echo = trySelfDecrypt(base64, aesKey, iv);
    if (!echo) return res.status(500).json({ error: "Local self-decrypt failed" });

    res.setHeader("Content-Type", "text/plain");
    return res.status(200).send(base64);
  } catch (error) {
    console.error("Flow data exchange error:", error.message);
    console.error("Full error object:", error);
    return res.status(500).json({
      error: `Failed to process encrypted request: ${error.message}`,
    });
  }
}

// ========================= FLOW SCREEN HANDLERS ===========================

async function handleAddMemberScreen(data, context, version) {
  const { first_name, last_name, gender, birth_year, death_year } = data;
  const treeId = context.tree_id;

  if (!treeId) {
    return {
      version: version || "3.0",
      screen: "ADD_MEMBER",
      data: { error: "No tree selected. Please start from WhatsApp menu." },
    };
  }

  try {
    const genderType =
      gender === "male" ? GENDER_TYPES.MALE : gender === "female" ? GENDER_TYPES.FEMALE : null;

    await insertPerson(
      treeId,
      first_name,
      last_name || null,
      genderType,
      birth_year || null,
      death_year || null
    );

    return {
      version: version || "3.0",
      screen: "SUCCESS",
      data: {
        extension_message_response: { params: { ok: true } },
      },
    };
  } catch (error) {
    console.error("Error adding member:", error);
    return {
      version: version || "3.0",
      screen: "ADD_MEMBER",
      data: { error: `Failed to add member: ${error.message}` },
    };
  }
}

// ===================== FLOW COMPLETION MESSAGE ============================

async function handleFlowResponse(phoneNumber, nfmReply) {
  const { name, response_json } = nfmReply;
  const responseData = JSON.parse(response_json);
  console.log(`Flow completed: ${name}`, responseData);

  const state = await getUserState(phoneNumber);
  const tree = state?.tree_id ? await getTreeById(state.tree_id) : null;

  if (!tree) {
    return sendWhatsAppMessage(phoneNumber, "⚠️ Please create or join a tree first!");
  }

  const memberData = responseData.member || responseData;
  const { first_name, last_name, gender, birth_year, death_year } = memberData;

  try {
    const genderType =
      gender === "male" ? GENDER_TYPES.MALE : gender === "female" ? GENDER_TYPES.FEMALE : null;

    const newPerson = await insertPerson(
      tree.id,
      first_name,
      last_name || null,
      genderType,
      birth_year || null,
      death_year || null
    );

    await setUserState(phoneNumber, tree.id, newPerson.id, `${first_name} ${last_name || ""}`.trim());

    const genderText =
      gender === "male" ? "Male" : gender === "female" ? "Female" : "Prefer not to say";

    let message = `✅ *${first_name}${last_name ? " " + last_name : ""}* has been added to *${tree.name}*!\n\n`;
    message += `👤 Gender: ${genderText}\n`;
    if (birth_year) message += `🎂 Born: ${birth_year}\n`;
    if (death_year) message += `🕊️ Died: ${death_year}\n`;
    message += `\nReply with *MENU* to add more family members.`;

    return sendWhatsAppMessage(phoneNumber, message);
  } catch (error) {
    console.error("Error saving member:", error);
    return sendWhatsAppMessage(
      phoneNumber,
      `❌ Sorry, I couldn't add ${first_name}. Error: ${error.message}\n\nPlease try again.`
    );
  }
}

// =========================== TEXT COMMANDS ================================

async function handleMessage(phoneNumber, text) {
  const state = await getUserState(phoneNumber);
  let tree = null;

  if (state?.tree_id) {
    tree = await getTreeById(state.tree_id);
    if (!tree) await setUserState(phoneNumber, null, null, null);
  }

  const normalizedText = (text || "").trim().toLowerCase();

  if (normalizedText === "menu" || normalizedText === "start") {
    return sendMainMenu(phoneNumber, tree);
  }
  if (normalizedText === "help") {
    return sendWhatsAppMessage(phoneNumber, generateHelpMessage(tree));
  }

  if (!tree) {
    const joinCodeMatch = (text || "").toUpperCase().match(/^[A-Z0-9]{6}$/);
    if (joinCodeMatch) {
      const joinCode = joinCodeMatch[0];
      const joinedTree = await getTreeByCode(joinCode);
      if (joinedTree) {
        await addMember(joinedTree.id, phoneNumber);
        await setUserState(joinedTree.id, phoneNumber, null, null);
        return sendWhatsAppMessage(
          phoneNumber,
          `✅ Successfully joined family tree *${joinedTree.name}*!\n\nReply with *MENU* to see options.`
        );
      }
      return sendWhatsAppMessage(
        phoneNumber,
        `❌ I couldn't find a tree with code *${joinCode}*. Please check and try again.`
      );
    }

    const createMatch = (text || "").match(/^(create|new)\s+(.+)/i);
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

  if (!(await isMember(tree.id, phoneNumber))) {
    await setUserState(phoneNumber, null, null, null);
    return sendWhatsAppMessage(
      phoneNumber,
      `You are no longer a member of *${tree.name}*. Type *MENU* to see options.`
    );
  }

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

  return sendMainMenu(phoneNumber, tree);
}

// ============================== MENUS =====================================

async function sendMainMenu(phoneNumber, tree) {
  if (!tree) return sendWhatsAppMessage(phoneNumber, generateWelcomeMessage());

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const flowId = process.env.WHATSAPP_FLOW_ID;

  if (!token || !phoneNumberId || !flowId) {
    return sendWhatsAppMessage(phoneNumber, "⚠️ API credentials missing. Please contact admin.");
  }

  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

  const flowToken = Buffer.from(
    JSON.stringify({
      tree_id: tree.id,
      phone_number: phoneNumber,
    })
  ).toString("base64");

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phoneNumber,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: `${tree.name} 🌳` },
      body: {
        text: `👥 *${tree.person_count || 0} family members*\n\nAdd a new person to your family tree using the form below:`,
      },
      footer: { text: "Tap the button to continue" },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: "➕ Add Family Member",
          flow_action: "navigate",
          flow_action_payload: { screen: "ADD_MEMBER", data: {} },
        },
      },
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`WhatsApp API error:`, errorText);
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

// ========================== SIMPLE TEXT SENDER ============================

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
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
