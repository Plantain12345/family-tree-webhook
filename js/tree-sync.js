import { subscribeFamilyMembers, subscribeRelationships } from './supabase-client.js'

let membersSubscription = null
let relationshipsSubscription = null

/**
 * Setup real-time synchronization for collaborative editing
 * @param {string} treeId - The tree ID to subscribe to
 * @param {Function} onChangeCallback - Callback to refresh tree when changes occur
 */
export function setupRealtimeSync(treeId, onChangeCallback) {
  // Clean up existing subscriptions
  if (membersSubscription) {
    membersSubscription.unsubscribe()
  }
  if (relationshipsSubscription) {
    relationshipsSubscription.unsubscribe()
  }
  
  // Subscribe to family member changes
  membersSubscription = subscribeFamilyMembers(treeId, (payload) => {
    console.log('Family member change detected:', payload)
    
    // Refresh tree after a short delay to batch multiple changes
    debounceRefresh(onChangeCallback)
  })
  
  // Subscribe to relationship changes
  relationshipsSubscription = subscribeRelationships(treeId, (payload) => {
    console.log('Relationship change detected:', payload)
    
    // Refresh tree after a short delay to batch multiple changes
    debounceRefresh(onChangeCallback)
  })
  
  console.log('Real-time sync enabled for tree:', treeId)
}

// Debounce function to avoid too many refreshes
let refreshTimeout = null
function debounceRefresh(callback) {
  if (refreshTimeout) {
    clearTimeout(refreshTimeout)
  }
  
  refreshTimeout = setTimeout(() => {
    callback()
  }, 1000) // Wait 1 second before refreshing
}

/**
 * Clean up subscriptions
 */
export function cleanupSync() {
  if (membersSubscription) {
    membersSubscription.unsubscribe()
    membersSubscription = null
  }
  if (relationshipsSubscription) {
    relationshipsSubscription.unsubscribe()
    relationshipsSubscription = null
  }
}

// Clean up on page unload
window.addEventListener('beforeunload', cleanupSync)
