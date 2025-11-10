// ===== tree-main.js =====
import {
  getFamilyTreeByCode,
  getFamilyMembers,
  getParentChildRelationships,
  getSpousalRelationships,
} from "./supabase-client.js";
import { toFamilyChartData } from "./tree-data.js";
import { watchTree } from "./tree-sync.js";
import { APP } from "./config.js";

// family-chart is assumed to be globally available (as in the example)
// e.g., included via <script src=".../family-chart.min.js"></script>

function getQueryParam(name) {
  const params = new URLSearchParams(location.search);
  return params.get(name);
}

function $(sel) {
  return document.querySelector(sel);
}

let unwatch = null;
let chart = null;

async function loadAndRender(treeCode) {
  $("#loading").style.display = "block";

  try {
    const tree = await getFamilyTreeByCode(treeCode);

    // Header UI
    $("#treeName").textContent = tree.tree_name || "Untitled Tree";
    $("#treeCodeDisplay").textContent = tree.tree_code;

    // Data loads
    const [members, pc, spousal] = await Promise.all([
      getFamilyMembers(tree.id),
      getParentChildRelationships(tree.id),
      getSpousalRelationships(tree.id),
    ]);

    const data = toFamilyChartData({ members, parentChild: pc, spousal });

    // Render (family-chart API)
    if (!window.FamilyChart) throw new Error("family-chart library not loaded");
    const container = $("#chart");
    container.innerHTML = ""; // clear previous mount

    chart = window.FamilyChart.create({
      container,
      data,
      // you can pass options here as per library docs
    });

    // Live updates
    if (unwatch) unwatch();
    unwatch = watchTree(tree.id, async () => {
      try {
        const [m2, pc2, sp2] = await Promise.all([
          getFamilyMembers(tree.id),
          getParentChildRelationships(tree.id),
          getSpousalRelationships(tree.id),
        ]);
        const d2 = toFamilyChartData({ members: m2, parentChild: pc2, spousal: sp2 });
        chart.update(d2);
      } catch (e) {
        console.warn("Live refresh failed:", e);
      }
    });
  } finally {
    $("#loading").style.display = "none";
  }
}

export async function initializeTree() {
  const raw = getQueryParam("code");
  if (!raw) {
    alert("Missing tree code; returning to home.");
    window.location.href = "index.html";
    return;
  }

  try {
    const code = String(raw).trim().toUpperCase();
    if (code.length !== APP.codeLength) throw new Error("Invalid code in URL");
    await loadAndRender(code);
  } catch (err) {
    console.error("Error initializing tree:", err);
    alert("Error loading tree. Please try again.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.body.dataset.page === "tree") initializeTree();
});
