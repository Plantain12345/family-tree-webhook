import { APP } from "./config.js";
import { createFamilyTree } from "./supabase-client.js";

const $ = (selector) => document.querySelector(selector);

function toast(message) {
  alert(message);
}

function parseCodeInput(value) {
  const code = String(value ?? "").trim().toUpperCase();
  if (code.length !== APP.codeLength) {
    throw new Error(`Enter a ${APP.codeLength}-character code.`);
  }
  if (!/^[A-Z0-9]+$/.test(code)) {
    throw new Error("Code must be alphanumeric (A–Z, 0–9).");
  }
  return code;
}

function onViewSubmit(event) {
  event.preventDefault();
  try {
    const code = parseCodeInput($("#treeCode").value);
    window.location.href = `tree.html?code=${encodeURIComponent(code)}`;
  } catch (error) {
    toast(error.message);
  }
}

async function onCreateSubmit(event) {
  event.preventDefault();
  const treeName = $("#treeName").value.trim();
  if (!treeName) {
    toast("Please provide a name for the tree.");
    return;
  }

  const payload = {
    treeName,
    firstName: $("#firstName").value.trim(),
    lastName: $("#lastName").value.trim(),
    birthday: $("#birthday").value ? Number($("#birthday").value) : null,
    death: $("#death").value ? Number($("#death").value) : null,
    gender: $("#gender").value || "U",
  };

  const button = $("#createBtn");
  button.disabled = true;

  try {
    const result = await createFamilyTree(payload);
    window.location.href = `tree.html?code=${encodeURIComponent(result.treeCode)}`;
  } catch (error) {
    console.error("Create tree failed", error);
    toast("Could not create tree. Please try again.");
  } finally {
    button.disabled = false;
  }
}

export function initLanding() {
  $("#viewForm").addEventListener("submit", onViewSubmit);
  $("#createForm").addEventListener("submit", onCreateSubmit);
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.body.dataset.page === "landing") {
    initLanding();
  }
});
