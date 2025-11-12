import { 
  getFamilyTreeByCode,
  getFamilyMembers,
  getParentChildRelationships,
  getSpousalRelationships,
  createFamilyMember,
  updateFamilyMember,
  deleteFamilyMember,
  createParentChildRelationship,
  createSpousalRelationship,
  updateSpousalRelationship,
  deleteParentChildRelationship,
  deleteSpousalRelationship
} from './supabase-client.js'

import { 
  transformDatabaseToFamilyChart,
  findMainPersonId
} from './tree-data.js'

import { setupRealtimeSync } from './tree-sync.js'

// Global variables
let currentTreeId = null
let currentTreeCode = null
let f3Chart = null
let f3EditTree = null
let allMembers = []
let allParentChildRels = []
let allSpousalRels = []
let isSaving = false
let isLoadingFromDatabase = false

// Undo/Redo functionality
let operationHistory = []
let currentHistoryIndex = -1
const MAX_HISTORY = 50

// Get tree code from URL
const urlParams = new URLSearchParams(window.location.search)
const treeCode = urlParams.get('code')

console.log('🌳 Tree code from URL:', treeCode)

if (!treeCode) {
  console.log('❌ No tree code found, redirecting to index')
  window.location.href = 'index.html'
} else {
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (window.f3) {
        console.log('✅ f3 library loaded')
        initializeTree(treeCode)
      } else {
        console.error('❌ f3 library not loaded')
        alert('Error loading family chart library. Please refresh.')
      }
    }, 300)
  })
}

// Copy tree code to clipboard
document.getElementById('copyCodeBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(currentTreeCode)
  const btn = document.getElementById('copyCodeBtn')
  const originalText = btn.textContent
  btn.textContent = '✓'
  setTimeout(() => {
    btn.textContent = originalText
  }, 2000)
})

// Undo/Redo keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault()
    undo()
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
    e.preventDefault()
    redo()
  }
})

async function initializeTree(code) {
  try {
    console.log('🚀 Initializing tree for code:', code)
    document.getElementById('loadingOverlay').classList.remove('hidden')
    
    const treeResult = await getFamilyTreeByCode(code)
    
    if (!treeResult.success) {
      alert('Tree not found!')
      window.location.href = 'index.html'
      return
    }
    
    const tree = treeResult.data
    currentTreeId = tree.id
    currentTreeCode = tree.tree_code
    
    document.getElementById('treeName').textContent = tree.tree_name
    document.getElementById('treeCodeDisplay').textContent = tree.tree_code
    
    await loadTreeData()
    
    // Setup realtime sync with debounced reload
    setupRealtimeSync(currentTreeId, handleRealtimeUpdate)
    
    // Setup undo/redo buttons
    setupUndoRedoUI()
    
    document.getElementById('loadingOverlay').classList.add('hidden')
    console.log('✅ Tree initialized!')
    
  } catch (error) {
    console.error('❌ Error initializing tree:', error)
    showError('Error loading tree. Please try again.')
    document.getElementById('loadingOverlay').classList.add('hidden')
  }
}

// Handle realtime updates from other users
function handleRealtimeUpdate() {
  console.log('🔄 Realtime update detected from another user')
  if (!isSaving) {
    loadTreeData()
  } else {
    console.log('⏸️ Skipping reload while saving')
  }
}

async function loadTreeData() {
  console.log('📡 Loading tree data from Supabase...')
  isLoadingFromDatabase = true
  
  try {
    const [membersResult, parentChildResult, spousalResult] = await Promise.all([
      getFamilyMembers(currentTreeId),
      getParentChildRelationships(currentTreeId),
      getSpousalRelationships(currentTreeId)
    ])
    
    if (!membersResult.success || !parentChildResult.success || !spousalResult.success) {
      throw new Error('Failed to load tree data')
    }
    
    allMembers = membersResult.data
    allParentChildRels = parentChildResult.data
    allSpousalRels = spousalResult.data
    
    console.log('✅ Loaded from Supabase:', {
      members: allMembers.length,
      relationships: allParentChildRels.length + allSpousalRels.length
    })
    
    const familyChartData = transformDatabaseToFamilyChart(
      allMembers,
      allParentChildRels,
      allSpousalRels
    )
    
    if (!f3Chart) {
      createChart(familyChartData)
    } else {
      updateChartFromDatabase(familyChartData)
    }
    
  } catch (error) {
    console.error('❌ Error loading tree data:', error)
    showError('Failed to load tree data')
    throw error
  } finally {
    isLoadingFromDatabase = false
  }
}

function createChart(data) {
  console.log('🎨 Creating chart with', data.length, 'members')
  
  try {
    f3Chart = window.f3.createChart('#FamilyChart', data)
      .setTransitionTime(1000)
      .setCardXSpacing(250)
      .setCardYSpacing(150)
    
    // Setup card display with death year
    const f3Card = f3Chart.setCardHtml()
      .setCardDisplay([
        ["first name", "last name"], 
        ["birthday", "death"]
      ])
    
    // Setup edit tree with death field
    f3EditTree = f3Chart.editTree()
      .setFields(["first name", "last name", "birthday", "death", "gender"])
      .setEditFirst(true)
      .setCardClickOpen(f3Card)
    
    const mainPersonId = findMainPersonId(allMembers)
    if (mainPersonId) {
      f3Chart.updateMainId(mainPersonId)
    }
    
    f3Chart.updateTree({ initial: true })
    
    // Hook into form submissions after chart is rendered
    setTimeout(() => {
      setupFormHooks()
    }, 500)
    
    window.f3Chart = f3Chart
    console.log('✅ Chart created and interactive!')
    
  } catch (error) {
    console.error('❌ Error creating chart:', error)
    showError('Error creating chart')
    throw error
  }
}

function updateChartFromDatabase(data) {
  console.log('🔄 Updating chart from database with', data.length, 'members')
  
  if (!isSaving && !isLoadingFromDatabase) {
    try {
      f3Chart.updateData(data)
      f3Chart.updateTree({ initial: false })
      
      // Re-setup form hooks after update
      setTimeout(() => {
        setupFormHooks()
      }, 500)
    } catch (error) {
      console.error('Error updating chart:', error)
    }
  }
}

// Setup form submission hooks
function setupFormHooks() {
  console.log('🔗 Setting up form hooks...')
  
  // Listen for form submissions (save button)
  const formContainer = document.querySelector('.f3-form-cont')
  if (!formContainer) {
    console.log('Form container not found yet')
    return
  }
  
  // Use event delegation to catch all form submissions
  formContainer.addEventListener('submit', async (e) => {
    e.preventDefault()
    console.log('💾 Form submit intercepted')
    
    // Let family-chart process the form first
    setTimeout(async () => {
      await saveTreeToDatabase()
    }, 100)
  }, true)
  
  // Listen for delete button clicks
  formContainer.addEventListener('click', async (e) => {
    if (e.target.classList.contains('f3-delete-btn')) {
      console.log('🗑️ Delete button clicked')
      
      // Let family-chart process the deletion first
      setTimeout(async () => {
        await saveTreeToDatabase()
      }, 100)
    }
  }, true)
  
  console.log('✅ Form hooks set up')
}

// Save entire tree state to database
async function saveTreeToDatabase() {
  if (isSaving) {
    console.log('⏸️ Already saving, skipping...')
    return
  }
  
  isSaving = true
  console.log('💾 Saving tree to database...')
  
  const beforeState = captureState()
  
  try {
    // Get current chart data
    const currentChartData = f3Chart.store.getData()
    
    console.log('Current chart data:', currentChartData.length, 'members')
    
    // Find members in chart that aren't in database
    const chartIds = new Set(currentChartData.map(d => d.id))
    const dbIds = new Set(allMembers.map(m => m.id))
    
    // New members
    const newMemberIds = [...chartIds].filter(id => !dbIds.has(id))
    
    // Deleted members
    const deletedMemberIds = [...dbIds].filter(id => !chartIds.has(id))
    
    // Updated members (existing in both)
    const existingMemberIds = [...chartIds].filter(id => dbIds.has(id))
    
    console.log('Changes:', {
      new: newMemberIds.length,
      deleted: deletedMemberIds.length,
      existing: existingMemberIds.length
    })
    
    // Handle deletions
    for (const deletedId of deletedMemberIds) {
      console.log('🗑️ Deleting member:', deletedId)
      
      // Delete relationships first
      const parentRels = allParentChildRels.filter(r => r.parent_id === deletedId || r.child_id === deletedId)
      const spouseRels = allSpousalRels.filter(r => r.person1_id === deletedId || r.person2_id === deletedId)
      
      for (const rel of parentRels) {
        await deleteParentChildRelationship(rel.parent_id, rel.child_id)
      }
      
      for (const rel of spouseRels) {
        await deleteSpousalRelationship(rel.person1_id, rel.person2_id)
      }
      
      // Delete member
      await deleteFamilyMember(deletedId)
    }
    
    // Handle new members
    for (const newId of newMemberIds) {
      const datum = currentChartData.find(d => d.id === newId)
      if (!datum) continue
      
      console.log('🆕 Creating member:', datum.data['first name'])
      
      const memberData = {
        id: newId, // Use chart ID as database ID
        tree_id: currentTreeId,
        first_name: datum.data['first name'] || '',
        last_name: datum.data['last name'] || '',
        birthday: datum.data['birthday'] ? parseInt(datum.data['birthday']) : null,
        death: datum.data['death'] ? parseInt(datum.data['death']) : null,
        gender: datum.data['gender'] || null,
        is_main: false
      }
      
      const result = await createFamilyMember(memberData)
      
      if (result.success) {
        // Create relationships
        await syncRelationshipsForMember(datum.rels, newId)
      }
    }
    
    // Handle updates to existing members
    for (const existingId of existingMemberIds) {
      const datum = currentChartData.find(d => d.id === existingId)
      const dbMember = allMembers.find(m => m.id === existingId)
      
      if (!datum || !dbMember) continue
      
      // Check if data changed
      const hasChanged = 
        datum.data['first name'] !== dbMember.first_name ||
        datum.data['last name'] !== dbMember.last_name ||
        (datum.data['birthday'] ? parseInt(datum.data['birthday']) : null) !== dbMember.birthday ||
        (datum.data['death'] ? parseInt(datum.data['death']) : null) !== dbMember.death ||
        datum.data['gender'] !== dbMember.gender
      
      if (hasChanged) {
        console.log('📝 Updating member:', datum.data['first name'])
        
        const updates = {
          first_name: datum.data['first name'] || '',
          last_name: datum.data['last name'] || '',
          birthday: datum.data['birthday'] ? parseInt(datum.data['birthday']) : null,
          death: datum.data['death'] ? parseInt(datum.data['death']) : null,
          gender: datum.data['gender'] || null
        }
        
        await updateFamilyMember(existingId, updates)
      }
      
      // Always sync relationships (they might have changed)
      await syncRelationshipsForMember(datum.rels, existingId)
    }
    
    // Add to history
    const afterState = await reloadStateFromDatabase()
    addToHistory('save', beforeState, afterState)
    
    showSuccess('Changes saved')
    
    // Reload from database to ensure consistency
    setTimeout(() => {
      isSaving = false
      loadTreeData()
    }, 500)
    
  } catch (error) {
    console.error('❌ Error saving tree:', error)
    showError('Error saving changes: ' + error.message)
    isSaving = false
    await loadTreeData()
  }
}

// Reload state from database (for history)
async function reloadStateFromDatabase() {
  const [membersResult, parentChildResult, spousalResult] = await Promise.all([
    getFamilyMembers(currentTreeId),
    getParentChildRelationships(currentTreeId),
    getSpousalRelationships(currentTreeId)
  ])
  
  return {
    members: membersResult.data,
    parentChildRels: parentChildResult.data,
    spousalRels: spousalResult.data
  }
}

// Sync relationships for a specific member
async function syncRelationshipsForMember(rels, memberId) {
  if (!rels) return
  
  console.log('🔗 Syncing relationships for:', memberId)
  
  try {
    const currentParentRels = allParentChildRels.filter(r => r.child_id === memberId)
    const currentChildRels = allParentChildRels.filter(r => r.parent_id === memberId)
    const currentSpouseRels = allSpousalRels.filter(r => r.person1_id === memberId || r.person2_id === memberId)
    
    // Sync parent relationships
    if (rels.father) {
      const existing = currentParentRels.find(r => r.parent_id === rels.father)
      if (!existing) {
        await createParentChildRelationship(currentTreeId, rels.father, memberId)
      }
    }
    
    if (rels.mother) {
      const existing = currentParentRels.find(r => r.parent_id === rels.mother)
      if (!existing) {
        await createParentChildRelationship(currentTreeId, rels.mother, memberId)
      }
    }
    
    // Remove parent relationships that no longer exist
    for (const rel of currentParentRels) {
      if (rel.parent_id !== rels.father && rel.parent_id !== rels.mother) {
        await deleteParentChildRelationship(rel.parent_id, memberId)
      }
    }
    
    // Sync child relationships
    if (rels.children) {
      for (const childId of rels.children) {
        const existing = currentChildRels.find(r => r.child_id === childId)
        if (!existing) {
          await createParentChildRelationship(currentTreeId, memberId, childId)
        }
      }
      
      // Remove relationships that no longer exist
      for (const rel of currentChildRels) {
        if (!rels.children.includes(rel.child_id)) {
          await deleteParentChildRelationship(memberId, rel.child_id)
        }
      }
    }
    
    // Sync spouse relationships
    if (rels.spouses) {
      for (const spouseId of rels.spouses) {
        const existing = currentSpouseRels.find(r => 
          (r.person1_id === spouseId && r.person2_id === memberId) ||
          (r.person1_id === memberId && r.person2_id === spouseId)
        )
        
        if (!existing) {
          await createSpousalRelationship(currentTreeId, memberId, spouseId, 'married')
        }
      }
      
      // Remove relationships that no longer exist
      for (const rel of currentSpouseRels) {
        const otherId = rel.person1_id === memberId ? rel.person2_id : rel.person1_id
        if (!rels.spouses.includes(otherId)) {
          await deleteSpousalRelationship(rel.person1_id, rel.person2_id)
        }
      }
    }
    
  } catch (error) {
    console.error('Error syncing relationships:', error)
  }
}

// Show modal to change relationship type (when clicking spousal links)
function showRelationshipTypeModal(person1Id, person2Id) {
  const rel = allSpousalRels.find(r => 
    (r.person1_id === person1Id && r.person2_id === person2Id) ||
    (r.person1_id === person2Id && r.person2_id === person1Id)
  )
  
  if (!rel) return
  
  const currentType = rel.relationship_type
  
  const modal = document.createElement('div')
  modal.className = 'relationship-modal'
  modal.innerHTML = `
    <div class="relationship-modal-content">
      <h3>Relationship Type</h3>
      <div class="relationship-types">
        <button class="rel-type-btn ${currentType === 'married' ? 'active' : ''}" data-type="married">
          💍 Married
        </button>
        <button class="rel-type-btn ${currentType === 'divorced' ? 'active' : ''}" data-type="divorced">
          💔 Divorced
        </button>
        <button class="rel-type-btn ${currentType === 'partner' ? 'active' : ''}" data-type="partner">
          🤝 Partner
        </button>
        <button class="rel-type-btn ${currentType === 'separated' ? 'active' : ''}" data-type="separated">
          ↔️ Separated
        </button>
      </div>
      <button class="close-modal-btn">Close</button>
    </div>
  `
  
  document.body.appendChild(modal)
  
  modal.querySelectorAll('.rel-type-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newType = btn.dataset.type
      await updateRelationshipType(rel.id, newType)
      modal.remove()
    })
  })
  
  modal.querySelector('.close-modal-btn').addEventListener('click', () => {
    modal.remove()
  })
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove()
    }
  })
}

async function updateRelationshipType(relationshipId, newType) {
  try {
    const beforeState = captureState()
    
    const result = await updateSpousalRelationship(relationshipId, newType)
    
    if (result.success) {
      const rel = allSpousalRels.find(r => r.id === relationshipId)
      if (rel) {
        rel.relationship_type = newType
      }
      
      await loadTreeData()
      
      addToHistory('update_relationship', beforeState, captureState())
      showSuccess('Relationship type updated')
    }
  } catch (error) {
    console.error('Error updating relationship type:', error)
    showError('Failed to update relationship type')
  }
}

// UNDO/REDO FUNCTIONALITY
function captureState() {
  return {
    members: JSON.parse(JSON.stringify(allMembers)),
    parentChildRels: JSON.parse(JSON.stringify(allParentChildRels)),
    spousalRels: JSON.parse(JSON.stringify(allSpousalRels))
  }
}

function addToHistory(action, beforeState, afterState) {
  operationHistory = operationHistory.slice(0, currentHistoryIndex + 1)
  
  operationHistory.push({
    action,
    before: beforeState,
    after: afterState,
    timestamp: Date.now()
  })
  
  if (operationHistory.length > MAX_HISTORY) {
    operationHistory.shift()
  } else {
    currentHistoryIndex++
  }
  
  updateUndoRedoButtons()
}

async function undo() {
  if (currentHistoryIndex < 0) {
    showError('Nothing to undo')
    return
  }
  
  const operation = operationHistory[currentHistoryIndex]
  console.log('⏪ Undoing:', operation.action)
  
  await restoreState(operation.before)
  currentHistoryIndex--
  updateUndoRedoButtons()
  showSuccess('Undo successful')
}

async function redo() {
  if (currentHistoryIndex >= operationHistory.length - 1) {
    showError('Nothing to redo')
    return
  }
  
  currentHistoryIndex++
  const operation = operationHistory[currentHistoryIndex]
  console.log('⏩ Redoing:', operation.action)
  
  await restoreState(operation.after)
  updateUndoRedoButtons()
  showSuccess('Redo successful')
}

async function restoreState(state) {
  allMembers = state.members
  allParentChildRels = state.parentChildRels
  allSpousalRels = state.spousalRels
  
  const familyChartData = transformDatabaseToFamilyChart(
    allMembers,
    allParentChildRels,
    allSpousalRels
  )
  
  f3Chart.updateData(familyChartData)
  f3Chart.updateTree({ initial: false })
}

function setupUndoRedoUI() {
  const undoBtn = document.getElementById('undoBtn')
  const redoBtn = document.getElementById('redoBtn')
  
  if (undoBtn) {
    undoBtn.addEventListener('click', undo)
  }
  
  if (redoBtn) {
    redoBtn.addEventListener('click', redo)
  }
  
  updateUndoRedoButtons()
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('undoBtn')
  const redoBtn = document.getElementById('redoBtn')
  
  if (undoBtn) {
    undoBtn.disabled = currentHistoryIndex < 0
    undoBtn.title = currentHistoryIndex >= 0 ? 
      `Undo ${operationHistory[currentHistoryIndex]?.action}` : 
      'Nothing to undo'
  }
  
  if (redoBtn) {
    redoBtn.disabled = currentHistoryIndex >= operationHistory.length - 1
    redoBtn.title = currentHistoryIndex < operationHistory.length - 1 ? 
      `Redo ${operationHistory[currentHistoryIndex + 1]?.action}` : 
      'Nothing to redo'
  }
}

// UI Feedback
function showSuccess(message) {
  showNotification(message, 'success')
}

function showError(message) {
  showNotification(message, 'error')
}

function showNotification(message, type) {
  const notification = document.createElement('div')
  notification.className = `notification notification-${type}`
  notification.textContent = message
  document.body.appendChild(notification)
  
  setTimeout(() => {
    notification.classList.add('show')
  }, 10)
  
  setTimeout(() => {
    notification.classList.remove('show')
    setTimeout(() => notification.remove(), 300)
  }, 3000)
}
