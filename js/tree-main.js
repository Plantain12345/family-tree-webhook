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
    
    // Setup edit tree with custom field labels and no gender text field
    f3EditTree = f3Chart.editTree()
      .setFields(["first name", "last name", "birthday", "death"])
      .setEditFirst(true)
      .setCardClickOpen(f3Card)
    
    const mainPersonId = findMainPersonId(allMembers)
    if (mainPersonId) {
      f3Chart.updateMainId(mainPersonId)
    }
    
    f3Chart.updateTree({ initial: true })
    
    // Customize form labels and remove gender text field after render
    setTimeout(() => {
      customizeFormFields()
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
      
      // Re-customize form after update
      setTimeout(() => {
        customizeFormFields()
        setupFormHooks()
      }, 500)
    } catch (error) {
      console.error('Error updating chart:', error)
    }
  }
}

// Customize form field labels
function customizeFormFields() {
  const form = document.querySelector('#familyForm')
  if (!form) return
  
  // Change birthday label to "Year of birth"
  const birthdayLabel = Array.from(form.querySelectorAll('label')).find(
    label => label.textContent.trim() === 'birthday'
  )
  if (birthdayLabel) {
    birthdayLabel.textContent = 'Year of birth'
  }
  
  // Change death label to "Year of death"
  const deathLabel = Array.from(form.querySelectorAll('label')).find(
    label => label.textContent.trim() === 'death'
  )
  if (deathLabel) {
    deathLabel.textContent = 'Year of death'
  }
  
  // Remove gender text input field (keep only radio buttons)
  const genderInput = form.querySelector('input[name="gender"][type="text"]')
  if (genderInput) {
    const genderFormField = genderInput.closest('.f3-form-field')
    if (genderFormField) {
      genderFormField.style.display = 'none'
    }
  }
  
  // Ensure radio buttons update the hidden gender field when changed
  const radioButtons = form.querySelectorAll('input[name="gender"][type="radio"]')
  radioButtons.forEach(radio => {
    radio.addEventListener('change', () => {
      if (genderInput) {
        genderInput.value = radio.value
      }
    })
  })
}

// Setup form submission hooks
function setupFormHooks() {
  console.log('🔗 Setting up form hooks...')
  
  const formContainer = document.querySelector('.f3-form-cont')
  if (!formContainer) {
    console.log('Form container not found yet')
    return
  }
  
  // Remove old listeners by cloning
  const newFormContainer = formContainer.cloneNode(true)
  formContainer.parentNode.replaceChild(newFormContainer, formContainer)
  
  // Use event delegation for form submissions
  newFormContainer.addEventListener('submit', async (e) => {
    e.preventDefault()
    console.log('💾 Form submit intercepted')
    
    // Small delay to let family-chart update its internal state
    setTimeout(async () => {
      await saveTreeToDatabase()
    }, 100)
  }, true)
  
  // Listen for delete button clicks
  newFormContainer.addEventListener('click', async (e) => {
    if (e.target.classList.contains('f3-delete-btn')) {
      console.log('🗑️ Delete button clicked')
      
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
    const currentChartData = f3Chart.store.getData()
    console.log('Current chart data:', currentChartData.length, 'members')
    
    const chartIds = new Set(currentChartData.map(d => d.id))
    const dbIds = new Set(allMembers.map(m => m.id))
    
    const newMemberIds = [...chartIds].filter(id => !dbIds.has(id))
    const deletedMemberIds = [...dbIds].filter(id => !chartIds.has(id))
    const existingMemberIds = [...chartIds].filter(id => dbIds.has(id))
    
    console.log('Changes:', {
      new: newMemberIds.length,
      deleted: deletedMemberIds.length,
      existing: existingMemberIds.length
    })
    
    // STEP 1: Handle deletions first
    for (const deletedId of deletedMemberIds) {
      console.log('🗑️ Deleting member:', deletedId)
      
      const parentRels = allParentChildRels.filter(r => r.parent_id === deletedId || r.child_id === deletedId)
      const spouseRels = allSpousalRels.filter(r => r.person1_id === deletedId || r.person2_id === deletedId)
      
      for (const rel of parentRels) {
        await deleteParentChildRelationship(rel.parent_id, rel.child_id)
      }
      
      for (const rel of spouseRels) {
        await deleteSpousalRelationship(rel.person1_id, rel.person2_id)
      }
      
      await deleteFamilyMember(deletedId)
    }
    
    // STEP 2: Create all new members FIRST (before creating relationships)
    const newMembersData = []
    for (const newId of newMemberIds) {
      const datum = currentChartData.find(d => d.id === newId)
      if (!datum) continue
      
      console.log('🆕 Creating member:', datum.data['first name'] || '(unnamed)')
      
      const memberData = {
        id: newId,
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
        newMembersData.push({ id: newId, rels: datum.rels })
      }
    }
    
    // STEP 3: Update existing members
    for (const existingId of existingMemberIds) {
      const datum = currentChartData.find(d => d.id === existingId)
      const dbMember = allMembers.find(m => m.id === existingId)
      
      if (!datum || !dbMember) continue
      
      const hasChanged = 
        datum.data['first name'] !== dbMember.first_name ||
        datum.data['last name'] !== dbMember.last_name ||
        (datum.data['birthday'] ? parseInt(datum.data['birthday']) : null) !== dbMember.birthday ||
        (datum.data['death'] ? parseInt(datum.data['death']) : null) !== dbMember.death ||
        datum.data['gender'] !== dbMember.gender
      
      if (hasChanged) {
        console.log('📝 Updating member:', datum.data['first name'] || '(unnamed)')
        
        const updates = {
          first_name: datum.data['first name'] || '',
          last_name: datum.data['last name'] || '',
          birthday: datum.data['birthday'] ? parseInt(datum.data['birthday']) : null,
          death: datum.data['death'] ? parseInt(datum.data['death']) : null,
          gender: datum.data['gender'] || null
        }
        
        await updateFamilyMember(existingId, updates)
      }
    }
    
    // STEP 4: Now create relationships for new members
    for (const { id, rels } of newMembersData) {
      await syncRelationshipsForMember(rels, id)
    }
    
    // STEP 5: Sync relationships for existing members
    for (const existingId of existingMemberIds) {
      const datum = currentChartData.find(d => d.id === existingId)
      if (!datum) continue
      await syncRelationshipsForMember(datum.rels, existingId)
    }
    
    // STEP 6: Auto-create spousal relationships for parents
    await autoCreateParentSpouseRelationships(currentChartData)
    
    const afterState = await reloadStateFromDatabase()
    addToHistory('save', beforeState, afterState)
    
    showSuccess('Changes saved')
    
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

// Auto-create spousal relationships between parents of same child
async function autoCreateParentSpouseRelationships(chartData) {
  console.log('💑 Auto-creating parent spouse relationships...')
  
  // Find all children with both father and mother
  for (const person of chartData) {
    const { father, mother } = person.rels || {}
    
    if (father && mother) {
      // Check if spousal relationship exists
      const existingSpouseRel = allSpousalRels.find(r =>
        (r.person1_id === father && r.person2_id === mother) ||
        (r.person1_id === mother && r.person2_id === father)
      )
      
      if (!existingSpouseRel) {
        console.log('💑 Creating spouse relationship between parents')
        const result = await createSpousalRelationship(currentTreeId, father, mother, 'married')
        if (result.success && result.data) {
          allSpousalRels.push(result.data)
        }
      }
    }
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
        const result = await createParentChildRelationship(currentTreeId, rels.father, memberId)
        if (result.success && result.data) {
          allParentChildRels.push(result.data)
        }
      }
    }
    
    if (rels.mother) {
      const existing = currentParentRels.find(r => r.parent_id === rels.mother)
      if (!existing) {
        const result = await createParentChildRelationship(currentTreeId, rels.mother, memberId)
        if (result.success && result.data) {
          allParentChildRels.push(result.data)
        }
      }
    }
    
    // Remove parent relationships that no longer exist
    for (const rel of currentParentRels) {
      if (rel.parent_id !== rels.father && rel.parent_id !== rels.mother) {
        await deleteParentChildRelationship(rel.parent_id, memberId)
        allParentChildRels = allParentChildRels.filter(r => 
          !(r.parent_id === rel.parent_id && r.child_id === memberId)
        )
      }
    }
    
    // Sync child relationships
    if (rels.children && rels.children.length > 0) {
      for (const childId of rels.children) {
        const existing = currentChildRels.find(r => r.child_id === childId)
        if (!existing) {
          const result = await createParentChildRelationship(currentTreeId, memberId, childId)
          if (result.success && result.data) {
            allParentChildRels.push(result.data)
          }
        }
      }
      
      for (const rel of currentChildRels) {
        if (!rels.children.includes(rel.child_id)) {
          await deleteParentChildRelationship(memberId, rel.child_id)
          allParentChildRels = allParentChildRels.filter(r => 
            !(r.parent_id === memberId && r.child_id === rel.child_id)
          )
        }
      }
    }
    
    // Sync spouse relationships
    if (rels.spouses && rels.spouses.length > 0) {
      for (const spouseId of rels.spouses) {
        const existing = currentSpouseRels.find(r => 
          (r.person1_id === spouseId && r.person2_id === memberId) ||
          (r.person1_id === memberId && r.person2_id === spouseId)
        )
        
        if (!existing) {
          const result = await createSpousalRelationship(currentTreeId, memberId, spouseId, 'married')
          if (result.success && result.data) {
            allSpousalRels.push(result.data)
          }
        }
      }
      
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

// Show modal to change relationship type
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
