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
let formHooksSetup = false

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
    
    // Setup card display with death year and dash separator
    const f3Card = f3Chart.setCardHtml()
      .setCardDisplay([
        ["first name", "last name"], 
        ["birthday", "death"]
      ])
      .setCardDisplayFormatCustom((d) => {
        // Custom formatting for birth-death display
        const birth = d.data['birthday'] || ''
        const death = d.data['death'] || ''
        
        // Build custom display
        let displayLines = []
        
        // First line: name
        const firstName = d.data['first name'] || ''
        const lastName = d.data['last name'] || ''
        const fullName = [firstName, lastName].filter(n => n).join(' ')
        if (fullName) displayLines.push(fullName)
        
        // Second line: birth - death
        if (birth && death) {
          displayLines.push(`${birth} - ${death}`)
        } else if (birth) {
          displayLines.push(birth)
        }
        
        return displayLines
      })
    
    // Setup edit tree
    f3EditTree = f3Chart.editTree()
      .setFields(["first name", "last name", "birthday", "death"])
      .setEditFirst(true)
      .setCardClickOpen(f3Card)
    
    const mainPersonId = findMainPersonId(allMembers)
    if (mainPersonId) {
      f3Chart.updateMainId(mainPersonId)
    }
    
    f3Chart.updateTree({ initial: true })
    
    // Customize form after initial render
    setTimeout(() => {
      customizeForm()
      if (!formHooksSetup) {
        setupFormHooks()
        formHooksSetup = true
      }
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
        customizeForm()
      }, 500)
    } catch (error) {
      console.error('Error updating chart:', error)
    }
  }
}

// Customize form labels and button text
function customizeForm() {
  // Customize field labels
  customizeFormFields()
  
  // Customize "Add" card labels
  customizeAddCardLabels()
}

// Customize form field labels
function customizeFormFields() {
  const form = document.querySelector('#familyForm')
  if (!form) return
  
  // Change birthday label to "Year of birth"
  const birthdayLabel = Array.from(form.querySelectorAll('label')).find(
    label => label.textContent.trim().toLowerCase() === 'birthday'
  )
  if (birthdayLabel) {
    birthdayLabel.textContent = 'Year of birth'
  }
  
  // Change birthday input placeholder
  const birthdayInput = form.querySelector('input[name="birthday"]')
  if (birthdayInput) {
    birthdayInput.placeholder = 'YYYY'
  }
  
  // Change death label to "Year of death"
  const deathLabel = Array.from(form.querySelectorAll('label')).find(
    label => label.textContent.trim().toLowerCase() === 'death'
  )
  if (deathLabel) {
    deathLabel.textContent = 'Year of death'
  }
  
  // Change death input placeholder
  const deathInput = form.querySelector('input[name="death"]')
  if (deathInput) {
    deathInput.placeholder = 'YYYY'
  }
  
  // Hide gender text input field (keep only radio buttons)
  const genderInput = form.querySelector('input[name="gender"][type="text"]')
  if (genderInput) {
    const genderFormField = genderInput.closest('.f3-form-field')
    if (genderFormField) {
      genderFormField.style.display = 'none'
    }
  }
  
  // Ensure radio buttons update the hidden gender field
  const radioButtons = form.querySelectorAll('input[name="gender"][type="radio"]')
  radioButtons.forEach(radio => {
    radio.addEventListener('change', () => {
      if (genderInput) {
        genderInput.value = radio.value
      }
    })
  })
  
  // Add relationship type selector for partner forms
  addRelationshipTypeSelector(form)
  
  // Hide or customize "Remove Relation" button
  const removeRelationBtn = form.querySelector('.f3-remove-relative-btn')
  if (removeRelationBtn) {
    // Change text to be more clear
    removeRelationBtn.textContent = 'Remove Link to This Person'
    removeRelationBtn.title = 'Removes the relationship link but keeps the person in the tree'
  }
}

// Add relationship type selector to spouse/partner forms
function addRelationshipTypeSelector(form) {
  // Check if this is a partner form
  const formTitle = form.querySelector('.f3-form-title')
  if (!formTitle) return
  
  const titleText = formTitle.textContent.toLowerCase()
  const isPartnerForm = titleText.includes('partner') || titleText.includes('spouse')
  if (!isPartnerForm) return
  
  // Check if selector already exists
  if (form.querySelector('.relationship-type-selector')) return
  
  // Create relationship type selector
  const relTypeDiv = document.createElement('div')
  relTypeDiv.className = 'f3-form-field relationship-type-selector'
  relTypeDiv.innerHTML = `
    <label>Relationship Type</label>
    <select name="relationship_type" class="relationship-type-select">
      <option value="married">Married</option>
      <option value="partner">Partner</option>
      <option value="divorced">Divorced</option>
      <option value="separated">Separated</option>
    </select>
  `
  
  // Insert after gender field
  const genderField = form.querySelector('.f3-radio-group')
  if (genderField && genderField.parentNode) {
    genderField.parentNode.insertBefore(relTypeDiv, genderField.nextSibling)
  }
}

// Customize "Add" card labels
function customizeAddCardLabels() {
  // Change "Add Father" and "Add Mother" to "Add Parent"
  document.querySelectorAll('.card').forEach(card => {
    const labels = card.querySelectorAll('.card-label, [class*="card-label"]')
    labels.forEach(label => {
      const text = label.textContent.trim()
      if (text === 'Add Father' || text === 'Add Mother') {
        label.textContent = 'Add Parent'
      } else if (text === 'Add Son' || text === 'Add Daughter') {
        label.textContent = 'Add Child'
      } else if (text === 'Add Spouse') {
        label.textContent = 'Add Partner'
      }
    })
    
    // Also check text nodes directly
    card.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.includes('Add Father') || node.textContent.includes('Add Mother')) {
          node.textContent = node.textContent.replace(/Add (Father|Mother)/g, 'Add Parent')
        } else if (node.textContent.includes('Add Son') || node.textContent.includes('Add Daughter')) {
          node.textContent = node.textContent.replace(/Add (Son|Daughter)/g, 'Add Child')
        } else if (node.textContent.includes('Add Spouse')) {
          node.textContent = node.textContent.replace(/Add Spouse/g, 'Add Partner')
        }
      }
    })
  })
  
  // Also check SVG text elements
  document.querySelectorAll('svg text').forEach(text => {
    const content = text.textContent.trim()
    if (content === 'Add Father' || content === 'Add Mother') {
      text.textContent = 'Add Parent'
    } else if (content === 'Add Son' || content === 'Add Daughter') {
      text.textContent = 'Add Child'
    } else if (content === 'Add Spouse') {
      text.textContent = 'Add Partner'
    }
  })
}

// Setup form submission hooks (only once)
function setupFormHooks() {
  console.log('🔗 Setting up form hooks...')
  
  // Use event delegation on document level
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'familyForm') {
      e.preventDefault()
      console.log('💾 Form submit intercepted')
      
      // Get relationship type if it's a partner form
      let relationshipType = 'married'
      const relTypeSelect = e.target.querySelector('.relationship-type-select')
      if (relTypeSelect) {
        relationshipType = relTypeSelect.value
      }
      
      window.lastRelationshipType = relationshipType
      
      setTimeout(async () => {
        await saveTreeToDatabase()
      }, 100)
    }
  }, true)
  
  // Listen for delete button clicks
  document.addEventListener('click', async (e) => {
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
    
    // STEP 1: Handle deletions
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
    
    // STEP 2: Create ALL new members first (no relationships yet)
    console.log('📝 Creating new members...')
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
      
      await createFamilyMember(memberData)
    }
    
    // STEP 3: Update existing members
    console.log('📝 Updating existing members...')
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
    
    // STEP 4: Now that ALL members exist, create relationships
    console.log('🔗 Creating relationships...')
    
    // Reload member list to ensure we have all IDs
    const refreshedMembers = await getFamilyMembers(currentTreeId)
    if (refreshedMembers.success) {
      allMembers = refreshedMembers.data
    }
    
    // Create relationships for ALL members (new and existing)
    for (const datum of currentChartData) {
      await syncRelationshipsForMember(datum.rels, datum.id)
    }
    
    // STEP 5: Auto-create spousal relationships for parents
    await autoCreateParentSpouseRelationships(currentChartData)
    
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

// Auto-create spousal relationships between parents
async function autoCreateParentSpouseRelationships(chartData) {
  console.log('💑 Auto-creating parent spouse relationships...')
  
  for (const person of chartData) {
    const { father, mother } = person.rels || {}
    
    if (father && mother) {
      const existingSpouseRel = allSpousalRels.find(r =>
        (r.person1_id === father && r.person2_id === mother) ||
        (r.person1_id === mother && r.person2_id === father)
      )
      
      if (!existingSpouseRel) {
        console.log('💑 Creating spouse relationship between parents')
        
        const relType = window.lastRelationshipType || 'married'
        
        const result = await createSpousalRelationship(currentTreeId, father, mother, relType)
        if (result.success && result.data) {
          allSpousalRels.push(result.data)
        }
        
        window.lastRelationshipType = null
      }
    }
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
    
    // Verify member exists before creating relationships
    const memberExists = allMembers.find(m => m.id === memberId)
    if (!memberExists) {
      console.warn('⚠️ Member does not exist yet, skipping relationships:', memberId)
      return
    }
    
    // Sync parent relationships
    if (rels.father) {
      const fatherExists = allMembers.find(m => m.id === rels.father)
      if (fatherExists) {
        const existing = currentParentRels.find(r => r.parent_id === rels.father)
        if (!existing) {
          const result = await createParentChildRelationship(currentTreeId, rels.father, memberId)
          if (result.success && result.data) {
            allParentChildRels.push(result.data)
          }
        }
      }
    }
    
    if (rels.mother) {
      const motherExists = allMembers.find(m => m.id === rels.mother)
      if (motherExists) {
        const existing = currentParentRels.find(r => r.parent_id === rels.mother)
        if (!existing) {
          const result = await createParentChildRelationship(currentTreeId, rels.mother, memberId)
          if (result.success && result.data) {
            allParentChildRels.push(result.data)
          }
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
        const childExists = allMembers.find(m => m.id === childId)
        if (childExists) {
          const existing = currentChildRels.find(r => r.child_id === childId)
          if (!existing) {
            const result = await createParentChildRelationship(currentTreeId, memberId, childId)
            if (result.success && result.data) {
              allParentChildRels.push(result.data)
            }
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
        const spouseExists = allMembers.find(m => m.id === spouseId)
        if (spouseExists) {
          const existing = currentSpouseRels.find(r => 
            (r.person1_id === spouseId && r.person2_id === memberId) ||
            (r.person1_id === memberId && r.person2_id === spouseId)
          )
          
          if (!existing) {
            const relType = window.lastRelationshipType || 'married'
            
            const result = await createSpousalRelationship(currentTreeId, memberId, spouseId, relType)
            if (result.success && result.data) {
              allSpousalRels.push(result.data)
            }
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
