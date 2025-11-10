// ===== tree-sync.js =====
import { supabaseClient } from "./supabase-client.js";

// Simple live reload mechanism: re-run the provided loader on any change.
export function watchTree(treeId, onChange) {
  const channel = supabaseClient
    .channel(`tree-${treeId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "family_members", filter: `tree_id=eq.${treeId}` }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "parent_child_relationships", filter: `tree_id=eq.${treeId}` }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "spousal_relationships", filter: `tree_id=eq.${treeId}` }, onChange)
    .subscribe();

  return () => {
    try {
      supabaseClient.removeChannel(channel);
    } catch {}
  };
}
