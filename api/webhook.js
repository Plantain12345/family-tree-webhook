// api/webhook.js
// WhatsApp Flows webhook – Flows-only (no NLP, no typed menu)
// RSA-OAEP(SHA-256) + AES-128-GCM for Flow data_api_version 3.0

import crypto from "crypto";
import {
  getTreeByCode,
  getUserState,
  setUserState,
  insertPerson,
  addMember,
  isMember,
  GENDER_TYPES
} from "./_db.js";

// --- config ---
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WABA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// --- utilities ---
function getPrivateKeyObject() {
  let pem = process.env.FLOW_PRIVATE_KEY;
  if (!pem) throw new Error("FLOW_PRIVATE_KEY is not set (PKCS#8 PEM)");
  if (pem.includes("\\n")) pem = pem.replace(/\\n/g, "\n");
  return crypto.createPrivateKey({
    key: pem,
    format: "pem",
    passphrase: process.env.FLOW_PASSPHRASE || undefined
  });
}

// decrypt payload from Meta
function decryptRequest(encryptedFlowData, encryptedAesKey, initialVector) {
  const keyObject = getPrivateKeyObject();

  const aesKey = crypto.privateDecrypt(
    {
      key: keyObject,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    Buffer.from(encryptedAesKey, "base64")
  );

  const iv = Buffer.from(initialVector, "base64");
  const cipherText = Buffer.from(encryptedFlowData, "base64");

  const authTag = cipherText.subarray(cipherText.length - 16);
  const ciphertextBody = cipherText.subarray(0, cipherText.length - 16);

  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, iv);
  decipher.setAuthTag(authTag);

  const json = Buffer.concat([decipher.update(ciphertextBody), decipher.final()]).toString("utf8");
  return { payload: JSON.parse(json), aesKey, iv };
}

// encrypt response for Meta
function maybeInvertIv(iv) {
  const useInvert = String(process.env.FLOW_INVERT_IV || "").toLowerCase() === "true";
  if (!useInvert) return iv;
  const out = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) out[i] = ~iv[i];
  return out;
}

function encryptResponseJson(obj, aesKey, requestIv) {
  const iv = maybeInvertIv(requestIv);
  const plain = Buffer.from(JSON.stringify(obj), "utf8");
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([enc, tag]).toString("base64");
}

// send a simple WhatsApp text message
async function sendText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
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
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("sendText failed:", res.status, t);
  }
}

// --- Flow logic (ONLY) ---
// We support three flows (IDs on Meta side):
// 1) ADD_MEMBER
// 2) EDIT_REMOVE (will be used by your Edit/Remove flow screens)
// 3) LINK_UNLINK (used by your relationship flow screens)
//
// This webhook implements ADD_MEMBER fully.
// EDIT_REMOVE and LINK_UNLINK stubs are ready (no-ops until those screens submit).

function buildAckResponse(version = "3.0", screenId = "ADD_MEMBER") {
  // Return an extension_message_response so client can close the sheet.
  return {
    version,
    screen: screenId,
    data: {
      extension_message_response: { params: { ok: true } }
    }
  };
}

async function handleAddMemberDataExchange(flowRequest) {
  // We do server-side validation here but DO NOT write to DB yet.
  // Actual write happens on nfm_reply to avoid double inserts.
  const { version, current_screen, data } = flowRequest;
  const form = data?.form || data || {};
  const first = String(form.first_name || "").trim();
  const last = String(form.last_name || "").trim();
  const gender = String(form.gender || "").trim();
  const birth = String(form.birth_year || "").trim();
  const death = String(form.death_year || "").trim();

  if (!first || !last || !gender) {
    return {
      version,
      screen: current_screen || "ADD_MEMBER",
      data: {
        errors: [
          { field: "first_name", message: !first ? "First name is required" : undefined },
          { field: "last_name", message: !last ? "Last name is required" : undefined },
          { field: "gender", message: !gender ? "Gender is required" : undefined }
        ].filter(Boolean)
      }
    };
  }
  if (birth && !/^\d{4}$/.test(birth)) {
    return {
      version,
      screen: current_screen || "ADD_MEMBER",
      data: { errors: [{ field: "birth_year", message: "Year must be YYYY" }] }
    };
  }
  if (death && !/^\d{4}$/.test(death)) {
    return {
      version,
      screen: current_screen || "ADD_MEMBER",
      data: { errors: [{ field: "death_year", message: "Year must be YYYY" }] }
    };
  }
  return buildAckResponse(version, current_screen || "ADD_MEMBER");
}

// nfm_reply contains the submitted data – do the actual insert here
async function handleAddMemberNfmReply(msg) {
  // Who submitted?
  const phone = msg.from;
  // Payload with the form fields
  const payload = msg?.interactive?.nfm_reply?.response_json;
  if (!payload) return;

  // Your flow JSON sent these keys inside payload.member
  const m = payload.member || payload; // tolerate both shapes
  const first = String(m.first_name || "").trim();
  const last = String(m.last_name || "").trim();
  const gender = String(m.gender || "").trim();
  const birth = m.birth_year || null;
  const death = m.death_year || null;

  const state = await getUserState(phone);
  const treeId = state?.tree_id;
  if (!treeId) {
    await sendText(phone, "Please join a tree first, then try again.");
    return;
  }

  const person = await insertPerson(treeId, first, last, gender || GENDER_TYPES.UNKNOWN, birth, death);
  await setUserState(phone, treeId, person.id, `${person.data.first_name} ${person.data.last_name}`.trim());

  await sendText(phone, `✅ Added ${person.data.first_name} ${person.data.last_name}. Use the Link flow to connect them to family.`);
}

// placeholders for future flows you’ll add
async function handleEditRemoveNfmReply(_msg) { /* implement when screens exist */ }
async function handleLinkUnlinkNfmReply(_msg) { /* implement when screens exist */ }

// --- Vercel handler ---
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      // Webhook verification
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

    // 1) Flow data_exchange (encrypted)
    if (body.encrypted_flow_data) {
      const { payload, aesKey, iv } = decryptRequest(
        body.encrypted_flow_data,
        body.encrypted_aes_key,
        body.initial_vector
      );

      // payload.data.action == "data_exchange"
      // payload.data.current_screen is your screen id
      const flowId = payload.data?.flow_token || ""; // optional
      const current = payload.data?.current_screen || "ADD_MEMBER";

      let responseObj;
      if (current === "ADD_MEMBER") {
        responseObj = await handleAddMemberDataExchange(payload.data);
      } else {
        // default ack
        responseObj = buildAckResponse(payload.data?.version || "3.0", current);
      }

      const b64 = encryptResponseJson(responseObj, aesKey, iv);
      return res.status(200).json({ encrypted_flow_data: b64 });
    }

    // 2) Normal webhook notifications (messages, incl. interactive nfm_reply)
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages || [];

    for (const msg of messages) {
      if (msg.type === "interactive" && msg.interactive?.type === "nfm_reply") {
        // Route by the flow title you configured in Meta (or by button id)
        const title = msg.interactive?.nfm_reply?.name || ""; // "Add a Family Member" etc.
        if (/add/i.test(title)) await handleAddMemberNfmReply(msg);
        else if (/edit|remove/i.test(title)) await handleEditRemoveNfmReply(msg);
        else if (/link|unlink/i.test(title)) await handleLinkUnlinkNfmReply(msg);
      }

      // NOTE: No free-text command handling; this is flows-only.
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook error:", err);
    return res.status(200).json({ ok: true }); // respond 200 so Meta doesn't retry aggressively
  }
}
