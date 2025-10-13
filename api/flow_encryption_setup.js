// api/flow_encryption_setup.js
import crypto from 'crypto';

// IMPORTANT: Replace these with your actual environment variables!
const FLOWS_RSA_PRIVATE_KEY = process.env.FLOWS_RSA_PRIVATE_KEY;
// META_PUBLIC_KEY is the public key Meta provides for the reverse encryption.
// You need to find this in the WhatsApp Flows documentation (it is NOT your key).
// For now, use a placeholder.
const META_PUBLIC_KEY = process.env.META_FLOWS_PUBLIC_KEY; 

// ============================================================================
// RSA UTILITIES
// ============================================================================

// Decrypts payload using your private key
function decrypt(encryptedBase64) {
  try {
    const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');
    const decryptedBuffer = crypto.privateDecrypt(
      { key: FLOWS_RSA_PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      encryptedBuffer
    );
    return decryptedBuffer.toString('utf8');
  } catch (error) {
    console.error("Decryption failed:", error.message);
    return null;
  }
}

// Encrypts payload using Meta's public key (for the response)
function encrypt(plaintext) {
  try {
    const plaintextBuffer = Buffer.from(plaintext, 'utf8');
    const encryptedBuffer = crypto.publicEncrypt(
      { key: META_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      plaintextBuffer
    );
    // CRUCIAL: Convert the encrypted binary data to a Base64 string
    return encryptedBuffer.toString('base64');
  } catch (error) {
    console.error("Encryption failed:", error.message);
    return null;
  }
}


// ============================================================================
// ENCRYPTION CHALLENGE HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // Ensure keys are present before proceeding
  if (!FLOWS_RSA_PRIVATE_KEY || !META_PUBLIC_KEY) {
      console.error("Missing required keys for flow encryption setup.");
      return res.status(500).send("Server Keys Missing");
  }

  try {
    const body = req.body;
    const encrypted_payload = body.encrypted_payload;
    
    if (!encrypted_payload) {
        return res.status(400).send("Missing encrypted_payload");
    }

    // 1. Decrypt the payload from Meta using *your* private key
    const decrypted_data = decrypt(encrypted_payload);

    if (!decrypted_data) {
      return res.status(500).send("Decryption Failed");
    }

    // 2. Re-encrypt the decrypted data using *Meta's* public key
    const final_base64_response = encrypt(decrypted_data);

    if (!final_base64_response) {
      return res.status(500).send("Encryption Failed");
    }

    // 3. Return the Base64-encoded string in the response body
    // This solves the "Response body is not Base64 encoded" error.
    return res.status(200).send(final_base64_response);

  } catch (error) {
    console.error("Flow encryption setup error:", error);
    return res.status(500).send("Internal Server Error");
  }
}
