import { createFamilyTree, createFamilyMember } from "./supabase-client.js";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("createTreeForm");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const treeName = document.getElementById("treeName").value.trim();

    if (!treeName) {
      alert("Please enter a name for your family tree.");
      return;
    }

    // Create new family tree
    const { data: treeData, error: treeError } = await createFamilyTree(treeName);

    if (treeError) {
      console.error("Error creating tree:", treeError);
      alert("Could not create the tree. Try again.");
      return;
    }

    const treeId = treeData.id;

    // Create first person (main root person)
    const { data: firstPerson, error: personError } = await createFamilyMember({
      tree_id: treeId,
      first_name: "Name",
      last_name: "",
      birthday: null,
      death: null,
      gender: "M",   // ⭐️ DEFAULT GENDER
      is_main: true
    });

    if (personError) {
      console.error("Error creating initial person:", personError);
    }

    // Redirect to tree
    window.location.href = `tree.html?code=${treeData.tree_code}`;
  });
});
