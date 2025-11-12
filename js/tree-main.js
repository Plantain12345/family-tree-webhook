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
    const f3EditTree = f3Chart.editTree()
      .setFields(["first name", "last name", "birthday", "death", "gender"])
      .setEditFirst(true)
      .setCardClickOpen(f3Card)
    
    // Override handlers for database sync
    const originalOnUpdate = f3EditTree.handlers().onUpdate
    const originalOnRemove = f3EditTree.handlers().onRemove
    
    f3EditTree.handlers({
      onUpdate: async (props) => {
        console.log('💾 Update triggered:', props)
        await handleChartUpdate(props)
      },
      onRemove: async (props) => {
        console.log('🗑️ Remove triggered:', props)
        await handleChartRemove(props)
      }
    })
    
    const mainPersonId = findMainPersonId(allMembers)
    if (mainPersonId) {
      f3Chart.updateMainId(mainPersonId)
    }
    
    f3Chart.updateTree({ initial: true })
    
    // Add relationship type editing to spousal links
    addRelationshipTypeEditor()
    
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
      addRelationshipTypeEditor() // Re-add after update
    } catch (error) {
      console.error('Error updating chart:', error)
    }
  }
}

// OPTIMISTIC UPDATE: Update UI immediately, then sync to database
function updateChartOptimistically(updateFn) {
  try {
    updateFn()
    f3Chart.updateTree({ initial: false })
    addRelationshipTypeEditor()
  } catch (error) {
    console.error('Error in optimistic update:', error)
  }
}

// Handle updates from the chart
async function handleChartUpdate(props) {
  if (isSaving) {
    console.log('⏸️ Already saving, queuing update')
    return
  }
  
  // Save operation for undo/redo
  const beforeState = captureState()
  
  isSaving = true
  
  try {
    const { id, data, rels } = props
    
    // OPTIMISTIC: Update chart immediately
    updateChartOptimistically(() => {
      // Chart is already updated by family-chart library
    })
    
    // Check if this is a new member
    const existingMember = allMembers.find(m => m.id === id)
    
    if (!existingMember) {
      // New member - create in database
      console.log('🆕 Creating new member:', data['first name'])
      
      const memberData = {
        tree_id: currentTreeId,
        first_name: data['first name'] || '',
        last_name: data['last name'] || '',
        birthday: data['birthday'] ? parseInt(data['birthday']) : null,
        death: data['death'] ? parseInt(data['death']) : null,
        gender: data['gender'] || null,
        is_main: false
      }
      
      // CRITICAL: Use the chart ID as the database ID
      // family-chart generates UUIDs that we'll use directly
      const result = await createFamilyMember({
        ...memberData,
        id: id // Use same ID for chart and database
      })
      
      if (result.success) {
        // Update local state
        allMembers.push(result.data)
        
        // Create relationships
        await syncRelationshipsForMember(rels, id)
        
        // Add to history
        addToHistory('create', beforeState, captureState())
        
        showSuccess('Member added successfully')
      } else {
        throw new Error(result.error)
      }
    } else {
      // Existing member - update
      console.log('📝 Updating member:', data['first name'])
      
      const updates = {
        first_name: data['first name'] || '',
        last_name: data['last name'] || '',
        birthday: data['birthday'] ? parseInt(data['birthday']) : null,
        death: data['death'] ? parseInt(data['death']) : null,
        gender: data['gender'] || null
      }
      
      const result = await updateFamilyMember(id, updates)
      
      if (result.success) {
        // Update local state
        const index = allMembers.findIndex(m => m.id === id)
        if (index !== -1) {
          allMembers[index] = { ...allMembers[index], ...updates }
        }
        
        // Sync relationships
        await syncRelationshipsForMember(rels, id)
        
        // Add to history
        addToHistory('update', beforeState, captureState())
        
        showSuccess('Changes saved')
      } else {
        throw new Error(result.error)
      }
    }
    
  } catch (error) {
    console.error('❌ Error handling update:', error)
    showError('Error saving changes: ' + error.message)
    // Reload from database to revert optimistic update
    await loadTreeData()
  } finally {
    isSaving = false
  }
}

// Handle deletion from chart
async function handleChartRemove(props) {
  if (isSaving) return
  
  const beforeState = captureState()
  
  isSaving = true
  
  try {
    const { id } = props
    console.log('🗑️ Deleting member:', id)
    
    // OPTIMISTIC: Update chart immediately (already done by family-chart)
    
    // Delete all relationships first
    const parentRels = allParentChildRels.filter(r => r.parent_id === id || r.child_id === id)
    const spouseRels = allSpousalRels.filter(r => r.person1_id === id || r.person2_id === id)
    
    for (const rel of parentRels) {
      await deleteParentChildRelationship(rel.parent_id, rel.child_id)
    }
    
    for (const rel of spouseRels) {
      await deleteSpousalRelationship(rel.person1_id, rel.person2_id)
    }
    
    // Delete the member
    const result = await deleteFamilyMember(id)
    
    if (result.success) {
      // Update local state
      allMembers = allMembers.filter(m => m.id !== id)
      allParentChildRels = allParentChildRels.filter(r => r.parent_id !== id && r.child_id !== id)
      allSpousalRels = allSpousalRels.filter(r => r.person1_id !== id && r.person2_id !== id)
      
      // Add to history
      addToHistory('delete', beforeState, captureState())
      
      showSuccess('Member deleted')
    } else {
      throw new Error(result.error)
    }
    
  } catch (error) {
    console.error('❌ Error handling removal:', error)
    showError('Error deleting member: ' + error.message)
    await loadTreeData()
  } finally {
    isSaving = false
  }
}

// Sync relationships for a specific member
async function syncRelationshipsForMember(rels, memberId) {
  console.log('🔗 Syncing relationships for:', memberId, rels)
  
  try {
    const currentParentRels = allParentChildRels.filter(r => r.child_id === memberId)
    const currentChildRels = allParentChildRels.filter(r => r.parent_id === memberId)
    const currentSpouseRels = allSpousalRels.filter(r => r.person1_id === memberId || r.person2_id === memberId)
    
    // Sync parent relationships
    if (rels.father) {
      const existing = currentParentRels.find(r => r.parent_id === rels.father)
      if (!existing) {
        const result = await createParentChildRelationship(currentTreeId, rels.father, memberId)
        if (result.success) {
          allParentChildRels.push(result.data)
        }
      }
    }
    
    if (rels.mother) {
      const existing = currentParentRels.find(r => r.parent_id === rels.mother)
      if (!existing) {
        const result = await createParentChildRelationship(currentTreeId, rels.mother, memberId)
        if (result.success) {
          allParentChildRels.push(result.data)
        }
      }
    }
    
    // Sync child relationships
    if (rels.children) {
      for (const childId of rels.children) {
        const existing = currentChildRels.find(r => r.child_id === childId)
        if (!existing) {
          const result = await createParentChildRelationship(currentTreeId, memberId, childId)
          if (result.success) {
            allParentChildRels.push(result.data)
          }
        }
      }
      
      // Remove relationships that no longer exist
      for (const rel of currentChildRels) {
        if (!rels.children.includes(rel.child_id)) {
          await deleteParentChildRelationship(memberId, rel.child_id)
          allParentChildRels = allParentChildRels.filter(r => !(r.parent_id === memberId && r.child_id === rel.child_id))
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
          const result = await createSpousalRelationship(currentTreeId, memberId, spouseId, 'married')
          if (result.success) {
            allSpousalRels.push(result.data)
          }
        }
      }
      
      // Remove relationships that no longer exist
      for (const rel of currentSpouseRels) {
        const otherId = rel.person1_id === memberId ? rel.person2_id : rel.person1_id
        if (!rels.spouses.includes(otherId)) {
          await deleteSpousalRelationship(rel.person1_id, rel.person2_id)
          allSpousalRels = allSpousalRels.filter(r => 
            !((r.person1_id === memberId && r.person2_id === otherId) ||
              (r.person1_id === otherId && r.person2_id === memberId))
          )
        }
      }
    }
    
  } catch (error) {
    console.error('Error syncing relationships:', error)
  }
}

// Add relationship type editor to spousal links
function addRelationshipTypeEditor() {
  setTimeout(() => {
    document.querySelectorAll('.link').forEach(link => {
      // Check if this is a spousal link (has specific class or data attribute)
      const linkData = link.__data__
      if (linkData && linkData.type === 'spouse') {
        link.style.cursor = 'pointer'
        link.addEventListener('click', (e) => {
          e.stopPropagation()
          showRelationshipTypeModal(linkData)
        })
      }
    })
  }, 500)
}

// Show modal to change relationship type
function showRelationshipTypeModal(linkData) {
  const person1Id = linkData.source.data.id
  const person2Id = linkData.target.data.id
  
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
      // Update local state
      const rel = allSpousalRels.find(r => r.id === relationshipId)
      if (rel) {
        rel.relationship_type = newType
      }
      
      // Reload chart to apply new styling
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
  // Remove any history after current index
  operationHistory = operationHistory.slice(0, currentHistoryIndex + 1)
  
  operationHistory.push({
    action,
    before: beforeState,
    after: afterState,
    timestamp: Date.now()
  })
  
  // Limit history size
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
  addRelationshipTypeEditor()
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
