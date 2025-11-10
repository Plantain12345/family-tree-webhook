import { supabaseClient } from "./supabase-client.js";

export function watchTree(treeId, callback) {
  const channel = supabaseClient
    .channel(`tree-${treeId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "family_members", filter: `tree_id=eq.${treeId}` }, callback)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "parent_child_relationships", filter: `tree_id=eq.${treeId}` },
      callback,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "spousal_relationships", filter: `tree_id=eq.${treeId}` },
      callback,
    )
    .subscribe();

  return () => {
    try {
      supabaseClient.removeChannel(channel);
    } catch (error) {
      console.warn("Failed to remove channel", error);
    }
  };
}
