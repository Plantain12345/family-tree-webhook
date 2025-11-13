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
  deleteParentChildRelationship,
  deleteSpousalRelationship
} from './supabase-client.js'

import { 
  transformDatabaseToFamilyChart,
  findMainPersonId
} from './tree-data.js'

import { setupRealtimeSync } from './tree-sync.js'

let currentTreeId = null
let currentTreeCode = null
let f3Chart = null
let allMembers = []
let allParentChildRels = []
let allSpousalRels = []
let isSaving = false
let saveTimer = null

const urlParams = new URLSearchParams(window.location.search)
const treeCode = urlParams.get('code')

if (!treeCode) {
  window.location.href = 'index.html'
} else {
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (window.f3) initializeTree(treeCode)
      else alert('Error loading library. Please refresh.')
    }, 300)
  })
}

document.getElementById('copyCodeBtn')?.addEventListener('click', () => {
  navigator.clipboard.writeText(currentTreeCode)
  const btn = document.getElementById('copyCodeBtn')
  const orig = btn.textContent
  btn.textContent = '✓'
  setTimeout(() => btn.textContent = orig, 2000)
})

async function initializeTree(code) {
  try {
    document.getElementById('loadingOverlay').classList.remove('hidden')
    
    const result = await getFamilyTreeByCode(code)
    if (!result.success) {
      alert('Tree not found!')
      window.location.href = 'index.html'
      return
    }
    
    const tree = result.data
    currentTreeId = tree.id
    currentTreeCode = tree.tree_code
    
    document.getElementById('treeName').textContent = tree.tree_name
    document.getElementById('treeCodeDisplay').textContent = tree.tree_code
    
    await loadTreeData()
    setupRealtimeSync(currentTreeId, () => { if (!isSaving) loadTreeData() })
    
    document.getElementById('loadingOverlay').classList.add('hidden')
  } catch (error) {
    console.error('Init error:', error)
    document.getElementById('loadingOverlay').classList.add('hidden')
  }
}

async function loadTreeData() {
  try {
    const [m, pc, s] = await Promise.all([
      getFamilyMembers(currentTreeId),
      getParentChildRelationships(currentTreeId),
      getSpousalRelationships(currentTreeId)
    ])
    
    allMembers = m.data || []
    allParentChildRels = pc.data || []
    allSpousalRels = s.data || []
    
    const data = transformDatabaseToFamilyChart(allMembers, allParentChildRels, allSpousalRels)
    
    if (!f3Chart) {
      createChart(data)
    } else {
      f3Chart.updateData(data)
      f3Chart.updateTree({ initial: false })
      setTimeout(() => customizeUI(), 500)
    }
  } catch (error) {
    console.error('Load error:', error)
  }
}

function createChart(data) {
  // Create chart
  f3Chart = window.f3.createChart('#FamilyChart', data)
    .setTransitionTime(1000)
    .setCardXSpacing(250)
    .setCardYSpacing(150)
  
  // Setup card display
  const f3Card = f3Chart.setCardHtml()
    .setCardDisplay([["first name", "last name"], ["birthday", "death"]])
  
  // Setup edit tree with card click functionality
  f3Chart.editTree()
    .setFields(["first name", "last name", "birthday", "death"])
    .setEditFirst(true)
    .setCardClickOpen(f3Card)  // THIS LINE IS CRITICAL - enables clicking on cards
  
  const mainId = findMainPersonId(allMembers)
  if (mainId) f3Chart.updateMainId(mainId)
  
  f3Chart.updateTree({ initial: true })
  
  setTimeout(() => {
    customizeUI()
    setupListeners()
  }, 500)
  
  window.f3Chart = f3Chart
}

function setupListeners() {
  // Listen for form submissions
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'familyForm') {
      e.preventDefault()
      
      // Capture relationship type if present
      const relSelect = e.target.querySelector('.relationship-type-select')
      if (relSelect) {
        window.lastRelationshipType = relSelect.value
      }
      
      // Let family-chart process the form, then save after a delay
      setTimeout(() => scheduleSave(), 300)
    }
  }, true)
  
  // Listen for delete button clicks
  document.addEventListener('click', (e) => {
    if (e.target.matches('.f3-delete-btn')) {
      setTimeout(() => scheduleSave(), 300)
    }
  }, true)
}

function scheduleSave() {
  // Debounce: wait 1 second after last change before saving
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => syncToDatabase(), 1000)
}

async function syncToDatabase() {
  if (isSaving) return
  isSaving = true
  
  try {
    // Get current state from family-chart (source of truth)
    const chartData = f3Chart.store.getData()
    
    // Compare chart state to database state
    const chartIds = new Set(chartData.map(d => d.id))
    const dbIds = new Set(allMembers.map(m => m.id))
    
    const newIds = [...chartIds].filter(id => !dbIds.has(id))
    const delIds = [...dbIds].filter(id => !chartIds.has(id))
    const existIds = [...chartIds].filter(id => dbIds.has(id))
    
    console.log('Syncing:', { new: newIds.length, deleted: delIds.length, existing: existIds.length })
    
    // PHASE 1: Delete removed members and their relationships
    for (const id of delIds) {
      const pRels = allParentChildRels.filter(r => r.parent_id === id || r.child_id === id)
      const sRels = allSpousalRels.filter(r => r.person1_id === id || r.person2_id === id)
      
      for (const r of pRels) {
        await deleteParentChildRelationship(r.parent_id, r.child_id)
      }
      
      for (const r of sRels) {
        await deleteSpousalRelationship(r.person1_id, r.person2_id)
      }
      
      await deleteFamilyMember(id)
    }
    
    // PHASE 2: Create ALL new members first (before relationships)
    for (const id of newIds) {
      const person = chartData.find(d => d.id === id)
      if (!person) continue
      
      await createFamilyMember({
        id: id, // Use family-chart's UUID directly
        tree_id: currentTreeId,
        first_name: person.data['first name'] || '',
        last_name: person.data['last name'] || '',
        birthday: person.data['birthday'] ? parseInt(person.data['birthday']) : null,
        death: person.data['death'] ? parseInt(person.data['death']) : null,
        gender: person.data['gender'] || null,
        is_main: false
      })
    }
    
    // PHASE 3: Update existing members
    for (const id of existIds) {
      const chartPerson = chartData.find(d => d.id === id)
      const dbPerson = allMembers.find(m => m.id === id)
      if (!chartPerson || !dbPerson) continue
      
      const updates = {
        first_name: chartPerson.data['first name'] || '',
        last_name: chartPerson.data['last name'] || '',
        birthday: chartPerson.data['birthday'] ? parseInt(chartPerson.data['birthday']) : null,
        death: chartPerson.data['death'] ? parseInt(chartPerson.data['death']) : null,
        gender: chartPerson.data['gender'] || null
      }
      
      // Only update if something changed
      const changed = 
        updates.first_name !== dbPerson.first_name ||
        updates.last_name !== dbPerson.last_name ||
        updates.birthday !== dbPerson.birthday ||
        updates.death !== dbPerson.death ||
        updates.gender !== dbPerson.gender
      
      if (changed) {
        await updateFamilyMember(id, updates)
      }
    }
    
    // PHASE 4: Refresh member list to ensure all IDs exist
    const mResult = await getFamilyMembers(currentTreeId)
    if (mResult.success) allMembers = mResult.data
    
    // PHASE 5: Now sync relationships (all members exist in DB now)
    await syncRelationships(chartData)
    
    // PHASE 6: Refresh relationships
    const pcResult = await getParentChildRelationships(currentTreeId)
    if (pcResult.success) allParentChildRels = pcResult.data
    
    const sResult = await getSpousalRelationships(currentTreeId)
    if (sResult.success) allSpousalRels = sResult.data
    
    console.log('Sync complete')
    
  } catch (error) {
    console.error('Sync error:', error)
  } finally {
    isSaving = false
  }
}

async function syncRelationships(chartData) {
  // Build target relationship state from family-chart
  const targetParentChild = []
  const targetSpousal = []
  
  for (const person of chartData) {
    const { father, mother, spouses } = person.rels || {}
    
    if (father) {
      targetParentChild.push({ parent_id: father, child_id: person.id })
    }
    
    if (mother) {
      targetParentChild.push({ parent_id: mother, child_id: person.id })
    }
    
    // For spousal relationships, only add once per pair
    if (spouses) {
      for (const spouseId of spouses) {
        // Use ID comparison to avoid creating duplicate entries
        if (person.id < spouseId) {
          targetSpousal.push({ p1: person.id, p2: spouseId })
        }
      }
    }
  }
  
  // Sync parent-child relationships
  // Create missing ones
  for (const target of targetParentChild) {
    const exists = allParentChildRels.find(r => 
      r.parent_id === target.parent_id && r.child_id === target.child_id
    )
    
    if (!exists) {
      const result = await createParentChildRelationship(
        currentTreeId,
        target.parent_id,
        target.child_id
      )
      if (result.success && result.data) {
        allParentChildRels.push(result.data)
      }
    }
  }
  
  // Delete ones that shouldn't exist anymore
  for (const existing of allParentChildRels) {
    const shouldExist = targetParentChild.find(t => 
      t.parent_id === existing.parent_id && t.child_id === existing.child_id
    )
    
    if (!shouldExist) {
      await deleteParentChildRelationship(existing.parent_id, existing.child_id)
    }
  }
  
  // Sync spousal relationships
  // Create missing ones
  for (const target of targetSpousal) {
    const exists = allSpousalRels.find(r => 
      (r.person1_id === target.p1 && r.person2_id === target.p2) ||
      (r.person1_id === target.p2 && r.person2_id === target.p1)
    )
    
    if (!exists) {
      const relType = window.lastRelationshipType || 'married'
      const result = await createSpousalRelationship(
        currentTreeId,
        target.p1,
        target.p2,
        relType
      )
      if (result.success && result.data) {
        allSpousalRels.push(result.data)
      }
      window.lastRelationshipType = null
    }
  }
  
  // Delete ones that shouldn't exist anymore
  for (const existing of allSpousalRels) {
    const shouldExist = targetSpousal.find(t => 
      (t.p1 === existing.person1_id && t.p2 === existing.person2_id) ||
      (t.p1 === existing.person2_id && t.p2 === existing.person1_id)
    )
    
    if (!shouldExist) {
      await deleteSpousalRelationship(existing.person1_id, existing.person2_id)
    }
  }
}

function customizeUI() {
  const form = document.querySelector('#familyForm')
  if (form) {
    // Change field labels
    form.querySelectorAll('label').forEach(label => {
      const text = label.textContent.trim().toLowerCase()
      if (text === 'birthday') label.textContent = 'Year of birth'
      if (text === 'death') label.textContent = 'Year of death'
    })
    
    // Hide gender text input (keep radio buttons)
    const genderInput = form.querySelector('input[name="gender"][type="text"]')
    if (genderInput) {
      const genderField = genderInput.closest('.f3-form-field')
      if (genderField) genderField.style.display = 'none'
      
      // Link radio buttons to hidden text field
      form.querySelectorAll('input[name="gender"][type="radio"]').forEach(radio => {
        radio.addEventListener('change', () => {
          genderInput.value = radio.value
        })
      })
    }
    
    // Hide "Remove Relation" button
    const removeBtn = form.querySelector('.f3-remove-relative-btn')
    if (removeBtn) removeBtn.style.display = 'none'
    
    // Add relationship type selector for partner forms
    addRelationshipTypeSelector(form)
  }
  
  // Change "Add" button labels
  changeAddLabels()
}

function addRelationshipTypeSelector(form) {
  const formTitle = form.querySelector('.f3-form-title')
  if (!formTitle) return
  
  const titleText = formTitle.textContent.toLowerCase()
  const isPartnerForm = titleText.includes('partner') || titleText.includes('spouse')
  if (!isPartnerForm) return
  
  // Don't add if already exists
  if (form.querySelector('.relationship-type-selector')) return
  
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
  
  const genderRadioGroup = form.querySelector('.f3-radio-group')
  if (genderRadioGroup && genderRadioGroup.parentNode) {
    genderRadioGroup.parentNode.insertBefore(relTypeDiv, genderRadioGroup.nextSibling)
    
    // Listen for changes
    const select = relTypeDiv.querySelector('select')
    select.addEventListener('change', () => {
      window.lastRelationshipType = select.value
    })
  }
}

function changeAddLabels() {
  // Change all "Add Father/Mother" to "Add Parent", etc.
  document.querySelectorAll('.card, svg text').forEach(element => {
    const replaceText = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        let text = node.textContent
        text = text.replace(/Add (Father|Mother)/g, 'Add Parent')
        text = text.replace(/Add (Son|Daughter)/g, 'Add Child')
        text = text.replace(/Add Spouse/g, 'Add Partner')
        node.textContent = text
      } else {
        Array.from(node.childNodes).forEach(replaceText)
      }
    }
    replaceText(element)
  })
}
