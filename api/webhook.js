// api/webhook.js
// WhatsApp Flows webhook – Flows-only, with original working RSA-OAEP(SHA-256) + AES-128-GCM encryption/decryption

import crypto from "crypto";
import {
  getUserState,
  setUserState,
  insertPerson,
  GENDER_TYPES
} from "./_db.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WABA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ------------------------------------------------------
// CRYPTO HELPERS (kept exactly like the version Meta accepted)
// ------------------------------------------------------

function getPrivateKeyObject() {
  let pem = process.env.FLOW_PRIVATE_KEY;
  if (!pem) throw new Error("FLOW_PRIVATE_KEY not set (expect PKCS#8 PEM)");
  if (pem.includes("\\n")) pem = pem.replace(/\\n/g, "\n");
  return crypto.createPrivateKey({
    key: pem,
    format: "pem",
    passphrase: process.env.FLOW_PASSPHRASE || undefined
  });
}

function decryptRequest(encrypted_flow_data, encrypted_aes_key, initial_vector) {
  const keyObject = getPrivateKeyObject();

  // Decrypt AES key
  const aesKey = crypto.privateDecrypt(
    {
      key: keyObject,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    Buffer.from(encrypted_aes_key, "base64")
  );

  // Decrypt data with AES-128-GCM
  const iv = Buffer.from(initial_vector, "base64");
  const cipherText = Buffer.from(encrypted_flow_data, "base64");
  const authTag = cipherText.subarray(cipherText.length - 16);
  const encrypted = cipherText.subarray(0, cipherText.length - 16);

  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const json = JSON.parse(decrypted.toString("utf8"));

  return { payload: json, aesKey, iv };
}

function encryptResponseJson(obj, aesKey, iv) {
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([encrypted, tag]).toString("base64");
}

// ------------------------------------------------------
// UTILITIES
// ------------------------------------------------------

async function sendText(to, body) {
  try {
    await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WABA_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body }
      })
    });
  } catch (e) {
    console.error("sendText error", e);
  }
}

// ------------------------------------------------------
// FLOW LOGIC (Add, Edit, Connect)
// ------------------------------------------------------

function buildAckResponse(version = "3.0", screenId = "ADD_MEMBER") {
  return {
    version,
    screen: screenId,
    data: { extension_message_response: { params: { ok: true } } }
  };
}

// --- ADD MEMBER (data_exchange + nfm_reply) ---

async function handleAddMemberDataExchange(flowRequest) {
  const { version, current_screen, data } = flowRequest;
  const f = data?.form || data || {};
  if (!f.first_name || !f.last_name || !f.gender) {
    return {
      version,
      screen: current_screen || "ADD_MEMBER",
      data: {
        errors: [
          { field: "first_name", message: !f.first_name ? "Required" : undefined },
          { field: "last_name", message: !f.last_name ? "Required" : undefined },
          { field: "gender", message: !f.gender ? "Required" : undefined }
        ].filter(Boolean)
      }
    };
  }
  return buildAckResponse(version, current_screen || "ADD_MEMBER");
}

async function handleAddMemberNfmReply(msg) {
  const phone = msg.from;
  const payload = msg.interactive?.nfm_reply?.response_json;
  const m = payload?.member || payload;
  if (!m) return;

  const first = String(m.first_name || "").trim();
  const last = String(m.last_name || "").trim();
  const gender = String(m.gender || "").trim();
  const birth = m.birth_year || null;
  const death = m.death_year || null;

  const state = await getUserState(phone);
  const treeId = state?.tree_id;
  if (!treeId) {
    await sendText(phone, "Please join a family tree first.");
    return;
  }

  const person = await insertPerson(treeId, first, last, gender || GENDER_TYPES.UNKNOWN, birth, death);
  await setUserState(phone, treeId, person.id, `${person.data.first_name} ${person.data.last_name}`);
  await sendText(phone, `✅ Added ${person.data.first_name} ${person.data.last_name}.`);
}

// --- EDIT / REMOVE MEMBER (future implementation) ---
async function handleEditRemoveNfmReply(msg) {
  const phone = msg.from;
  const payload = msg.interactive?.nfm_reply?.response_json;
  const data = payload?.edit_remove || payload;
  if (!data) return;
  await sendText(phone, `✅ Received edit/remove request for ${data.target.first_name} ${data.target.last_name}.`);
}

// --- CONNECT / UNLINK MEMBERS (future implementation) ---
async function handleConnectNfmReply(msg) {
  const phone = msg.from;
  const payload = msg.interactive?.nfm_reply?.response_json;
  const data = payload?.relationship || payload;
  if (!data) return;
  await sendText(phone, `✅ Received ${data.action} request between ${data.a.first_name} and ${data.b.first_name}.`);
}

// ------------------------------------------------------
// MAIN HANDLER
// ------------------------------------------------------

export default async function handler(req, res) {
  try {
    // Meta verification handshake
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send("Forbidden");
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};

    // --- ENCRYPTED FLOW DATA (data_exchange) ---
    if (body.encrypted_flow_data) {
      const { payload, aesKey, iv } = decryptRequest(
        body.encrypted_flow_data,
        body.encrypted_aes_key,
        body.initial_vector
      );

      let responseObj;
      const screen = payload.data?.current_screen || "ADD_MEMBER";

      if (screen === "ADD_MEMBER") {
        responseObj = await handleAddMemberDataExchange(payload.data);
      } else {
        responseObj = buildAckResponse(payload.data?.version || "3.0", screen);
      }

      const encrypted = encryptResponseJson(responseObj, aesKey, iv);
      return res.status(200).json({ encrypted_flow_data: encrypted });
    }

    // --- NORMAL WHATSAPP MESSAGE WEBHOOKS ---
    const entry = body.entry?.[0];
    const messages = entry?.changes?.[0]?.value?.messages || [];

    for (const msg of messages) {
      if (msg.type === "interactive" && msg.interactive?.type === "nfm_reply") {
        const name = msg.interactive?.nfm_reply?.name || "";
        if (/add/i.test(name)) await handleAddMemberNfmReply(msg);
        else if (/edit|remove/i.test(name)) await handleEditRemoveNfmReply(msg);
        else if (/connect|unlink/i.test(name)) await handleConnectNfmReply(msg);
      }
    }

    // Meta healthchecks expect a 200 with a valid JSON body, not encrypted.
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    // Still respond 200 so Meta doesn’t retry
    return res.status(200).json({ ok: false });
  }
}
