import {
  getFamilyTreeByCode,
  getFamilyMembers,
  getParentChildRelationships,
  getSpousalRelationships,
} from "./supabase-client.js";
import { buildFamilyChartPayload } from "./tree-data.js";
import { watchTree } from "./tree-sync.js";
import { APP } from "./config.js";

const $ = (selector) => document.querySelector(selector);
let teardown = null;
let chartInstance = null;

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

async function fetchTreeData(tree) {
  const [members, parentChild, spousal] = await Promise.all([
    getFamilyMembers(tree.id),
    getParentChildRelationships(tree.id),
    getSpousalRelationships(tree.id),
  ]);

  return buildFamilyChartPayload({ members, parentChild, spousal });
}

async function renderTree(tree) {
  if (!window.FamilyChart) {
    throw new Error("family-chart library not loaded");
  }

  const data = await fetchTreeData(tree);
  const container = $("#chart");
  container.innerHTML = "";

  chartInstance = window.FamilyChart.create({
    container,
    data,
  });

  if (teardown) teardown();
  teardown = watchTree(tree.id, async () => {
    try {
      const updated = await fetchTreeData(tree);
      chartInstance.update(updated);
    } catch (error) {
      console.warn("Realtime refresh failed", error);
    }
  });
}

async function loadTree(code) {
  $("#loading").hidden = false;
  try {
    const tree = await getFamilyTreeByCode(code);
    $("#treeName").textContent = tree.tree_name ?? APP.brand;
    $("#treeCodeDisplay").textContent = tree.tree_code;
    await renderTree(tree);
  } finally {
    $("#loading").hidden = true;
  }
}

export async function initializeTree() {
  const rawCode = getQueryParam("code");
  if (!rawCode) {
    alert("Missing tree code. Redirecting to home page.");
    window.location.replace("index.html");
    return;
  }

  const code = String(rawCode).trim().toUpperCase();
  if (code.length !== APP.codeLength) {
    alert("Invalid tree code provided.");
    window.location.replace("index.html");
    return;
  }

  try {
    await loadTree(code);
  } catch (error) {
    console.error("Error initializing tree", error);
    alert("We couldn't load that tree. Please try again.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.body.dataset.page === "tree") {
    initializeTree();
    $("#backBtn").addEventListener("click", () => window.location.replace("index.html"));
  }
});

window.addEventListener("beforeunload", () => {
  if (teardown) teardown();
});
