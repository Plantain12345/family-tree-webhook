// ===== landing.js =====
import { APP } from "./config.js";
import { createFamilyTree } from "./supabase-client.js";

function $(sel) {
  return document.querySelector(sel);
}

function showError(msg) {
  alert(msg);
}

function validateCodeInput(str) {
  const code = String(str || "").trim().toUpperCase();
  if (code.length !== APP.codeLength) throw new Error(`Enter a ${APP.codeLength}-character code`);
  if (!/^[A-Z0-9]+$/.test(code)) throw new Error("Code must be alphanumeric (A–Z, 0–9)");
  return code;
}

function handleViewTree(e) {
  e.preventDefault();
  try {
    const code = validateCodeInput($("#treeCode").value);
    window.location.href = `tree.html?code=${encodeURIComponent(code)}`;
  } catch (err) {
    showError(err.message || "Invalid code");
  }
}

async function handleCreateTree(e) {
  e.preventDefault();
  const name = $("#treeName").value.trim();
  const firstName = $("#firstName").value.trim();
  const lastName = $("#lastName").value.trim();
  const birthday = $("#birthday").value ? Number($("#birthday").value) : null;
  const death = $("#death").value ? Number($("#death").value) : null;
  const gender = $("#gender").value || "U";

  if (!name) return showError("Please enter a tree name.");

  try {
    $("#createBtn").disabled = true;
    const result = await createFamilyTree({ treeName: name, firstName, lastName, birthday, death, gender });
    const code = result.treeCode; // guaranteed string with the SQL fix, but also robust JS in supabase-client
    window.location.href = `tree.html?code=${encodeURIComponent(code)}`;
  } catch (err) {
    console.error("Create tree failed:", err);
    showError("Could not create tree. Please try again.");
  } finally {
    $("#createBtn").disabled = false;
  }
}

export function initLanding() {
  $("#viewForm").addEventListener("submit", handleViewTree);
  $("#createForm").addEventListener("submit", handleCreateTree);
}

// Auto-init if this script is loaded on index.html
document.addEventListener("DOMContentLoaded", () => {
  if (document.body.dataset.page === "landing") initLanding();
});
