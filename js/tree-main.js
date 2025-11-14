import { getTreeByCode, getMembers, getParentChildRels, getSpousalRels } from "./supabase-client.js";
import { transformDatabaseToFamilyChart, transformFamilyChartToDatabase } from "./tree-data.js";
import { syncToDatabase } from "./tree-sync.js";

let f3Chart = null;
let f3EditTree = null;   // ⭐️ we keep this reference
let addRelInstance = null;

document.addEventListener("DOMContentLoaded", () => {
  initTree();
});

async function initTree() {
  const urlParams = new URLSearchParams(window.location.search);
  const treeCode = urlParams.get("code");

  if (!treeCode) {
    console.error("No tree code in URL");
    return;
  }

  const { data: tree } = await getTreeByCode(treeCode);
  if (!tree) {
    console.error("Family tree not found");
    return;
  }

  const [membersRes, pcRes, spRes] = await Promise.all([
    getMembers(tree.id),
    getParentChildRels(tree.id),
    getSpousalRels(tree.id)
  ]);

  const data = transformDatabaseToFamilyChart(
    membersRes.data,
    pcRes.data,
    spRes.data
  );

  createChart(data, tree);
}

function createChart(data, tree) {
  f3Chart = window.f3.createChart("#FamilyChart", data);

  const f3Card = f3Chart.getCard();

  // ⭐️ ENABLE EDIT MODE, CAPTURE INSTANCE
  f3EditTree = f3Chart
    .editTree()
    .setFields(["first name", "last name", "birthday", "death"])
    .setEditFirst(false)
    .setAddRelLabels({
      father: "Add Parent",
      mother: "Add Parent",
      son: "Add Child",
      daughter: "Add Child",
      spouse: "Add Partner"
    })
    .setCardClickOpen(f3Card)   // ⭐️ card click → open form for that person
    .setOnFormCreation(({ cont, form_creator }) => {
      // ⭐️ Give form a stable ID
      const form = cont.querySelector("form");
      if (form) form.id = "familyForm";

      // ⭐️ Auto-activate "add relative" mode when form opens
      if (form_creator.addRelative && !form_creator.addRelativeActive) {
        form_creator.addRelative();
        form_creator.addRelativeActive = true;
      }

      // ⭐️ We capture instance so we can cancel it later
      addRelInstance = form_creator.addRelative ? form_creator : null;

      // Custom form tweaks remain here:
      customizeFormInputs();
    });

  // CANCEL + bubbles when clicking on canvas
  setupCanvasClick();

  // Sync changes
  setupFormSubmit(tree);
}

function setupCanvasClick() {
  document.addEventListener(
    "click",
    (e) => {
      const clickedOnCard = e.target.closest(".card");
      const clickedOnForm = e.target.closest(".f3-form-cont");
      const clickedOnAddBtn = e.target.closest(".card_add_relative");

      const formCont = document.querySelector(".f3-form-cont.opened");

      // If clicked on empty canvas
      if (!clickedOnCard && !clickedOnForm && !clickedOnAddBtn) {
        // close the form
        if (formCont) {
          const closeBtn = formCont.querySelector(".f3-close-btn");
          if (closeBtn) closeBtn.click();
        }

        // cancel add-relative mode
        if (addRelInstance && addRelInstance.onCancel) {
          addRelInstance.onCancel(addRelInstance);
        }
      }
    },
    true
  );
}

function setupFormSubmit(tree) {
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "familyForm") return;

    e.preventDefault();

    const newData = f3Chart.getData();
    await syncToDatabase(tree.id, newData);

    alert("Saved!");
  });
}

function customizeFormInputs() {
  const form = document.getElementById("familyForm");
  if (!form) return;

  // Replace Birthday/Death label names
  const labels = form.querySelectorAll(".f3-form-field label");
  labels.forEach((lab) => {
    if (lab.textContent.includes("Birthday")) lab.textContent = "Year of Birth";
    if (lab.textContent.includes("Death")) lab.textContent = "Year of Death";
  });

  // Add relationship-type dropdown if needed
  addRelationshipTypeSelector(form);
}

function addRelationshipTypeSelector(form) {
  const spouseField = form.querySelector('.f3-form-field [name="relationship_type"]');
  if (spouseField) return; // already exists

  // Only add if the form refers to spouses
  const relSection = form.querySelector(".f3-link-existing-relative");
  if (!relSection) return;

  const wrapper = document.createElement("div");
  wrapper.className = "f3-form-field";

  wrapper.innerHTML = `
    <label>Relationship Type</label>
    <select name="relationship_type">
      <option value="married">Married</option>
      <option value="partner">Partner</option>
      <option value="separated">Separated</option>
      <option value="divorced">Divorced</option>
    </select>
  `;

  form.appendChild(wrapper);
}
