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
    
    console.log('Loaded members:', allMembers.length)
    
    const data = transformDatabaseToFamilyChart(allMembers, allParentChildRels, allSpousalRels)
    
    console.log('Transformed data:', data.length)
    
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
  console.log('Creating chart with data:', data)
  
  f3Chart = window.f3.createChart('#FamilyChart', data)
    .setTransitionTime(1000)
    .setCardXSpacing(250)
    .setCardYSpacing(150)
  
  // Use standard card display with dash between years
  const f3Card = f3Chart.setCardHtml()
    .setCardDisplay([
      ["first name", "last name"], 
      (d) => {
        const birth = d.data['birthday'] || ''
        const death = d.data['death'] || ''
        if (birth && death) return `${birth} - ${death}`
        if (birth) return birth
        if (death) return `- ${death}`
        return ''
      }
    ])
  
  // Setup edit tree - setEditFirst(false) makes add buttons appear on click
  f3Chart.editTree()
    .setFields(["first name", "last name", "birthday", "death"])
    .setEditFirst(false)
    .setCardClickOpen(f3Card)
  
  const mainId = findMainPersonId(allMembers)
  if (mainId) f3Chart.updateMainId(mainId)
  
  f3Chart.updateTree({ initial: true })
  
  console.log('Chart created, setting up UI...')
  
  setTimeout(() => {
    customizeUI()
    setupListeners()
  }, 500)
  
  window.f3Chart = f3Chart
}

function setupListeners() {
  console.log('Setting up listeners...')
  
  // Listen for form submissions
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'familyForm') {
      e.preventDefault()
      
      // Validate year fields
      if (!validateYearFields(e.target)) {
        return
      }
      
      // Capture relationship type
      const relSelect = e.target.querySelector('.relationship-type-select')
      if (relSelect) {
        window.lastRelationshipType = relSelect.value
      }
      
      setTimeout(() => scheduleSave(), 300)
    }
  }, true)
  
  // Listen for delete button clicks
  document.addEventListener('click', (e) => {
    if (e.target.matches('.f3-delete-btn')) {
      setTimeout(() => scheduleSave(), 300)
    }
  }, true)
  
  // Close form when clicking outside
  document.addEventListener('click', (e) => {
    const formCont = document.querySelector('.f3-form-cont.opened')
    const clickedOnCard = e.target.closest('.card, .card_add_relative, [data-rel-type]')
    const clickedInForm = formCont && formCont.contains(e.target)
    
    if (formCont && !clickedInForm && !clickedOnCard) {
      const closeBtn = formCont.querySelector('.f3-close-btn')
      if (closeBtn) closeBtn.click()
    }
  }, true)
}

function validateYearFields(form) {
  const birthdayInput = form.querySelector('input[name="birthday"]')
  const deathInput = form.querySelector('input[name="death"]')
  
  if (birthdayInput && birthdayInput.value) {
    const year = birthdayInput.value.trim()
    if (!/^\d{4}$/.test(year)) {
      alert('Year of birth must be exactly 4 digits (e.g., 1990)')
      birthdayInput.focus()
      return false
    }
    const yearNum = parseInt(year)
    if (yearNum < 1000 || yearNum > 9999) {
      alert('Year of birth must be between 1000 and 9999')
      birthdayInput.focus()
      return false
    }
  }
  
  if (deathInput && deathInput.value) {
    const year = deathInput.value.trim()
    if (!/^\d{4}$/.test(year)) {
      alert('Year of death must be exactly 4 digits (e.g., 2020)')
      deathInput.focus()
      return false
    }
    const yearNum = parseInt(year)
    if (yearNum < 1000 || yearNum > 9999) {
      alert('Year of death must be between 1000 and 9999')
      deathInput.focus()
      return false
    }
    
    // Check death after birth
    if (birthdayInput && birthdayInput.value) {
      const birthYear = parseInt(birthdayInput.value)
      if (yearNum < birthYear) {
        alert('Year of death cannot be before year of birth')
        deathInput.focus()
        return false
      }
    }
  }
  
  return true
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => syncToDatabase(), 1000)
}

async function syncToDatabase() {
  if (isSaving) return
  isSaving = true
  
  try {
    const chartData = f3Chart.store.getData()
    const chartIds = new Set(chartData.map(d => d.id))
    const dbIds = new Set(allMembers.map(m => m.id))
    
    const newIds = [...chartIds].filter(id => !dbIds.has(id))
    const delIds = [...dbIds].filter(id => !chartIds.has(id))
    const existIds = [...chartIds].filter(id => dbIds.has(id))
    
    console.log('Syncing:', { new: newIds.length, del: delIds.length, exist: existIds.length })
    
    // Delete removed members
    for (const id of delIds) {
      const pRels = allParentChildRels.filter(r => r.parent_id === id || r.child_id === id)
      const sRels = allSpousalRels.filter(r => r.person1_id === id || r.person2_id === id)
      
      for (const r of pRels) await deleteParentChildRelationship(r.parent_id, r.child_id)
      for (const r of sRels) await deleteSpousalRelationship(r.person1_id, r.person2_id)
      
      await deleteFamilyMember(id)
    }
    
    // Create all new members
    for (const id of newIds) {
      const person = chartData.find(d => d.id === id)
      if (!person) continue
      
      await createFamilyMember({
        id: id,
        tree_id: currentTreeId,
        first_name: person.data['first name'] || '',
        last_name: person.data['last name'] || '',
        birthday: person.data['birthday'] ? parseInt(person.data['birthday']) : null,
        death: person.data['death'] ? parseInt(person.data['death']) : null,
        gender: person.data['gender'] || null,
        is_main: false
      })
    }
    
    // Update existing members
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
      
      const changed = 
        updates.first_name !== dbPerson.first_name ||
        updates.last_name !== dbPerson.last_name ||
        updates.birthday !== dbPerson.birthday ||
        updates.death !== dbPerson.death ||
        updates.gender !== dbPerson.gender
      
      if (changed) await updateFamilyMember(id, updates)
    }
    
    // Refresh and sync relationships
    const mResult = await getFamilyMembers(currentTreeId)
    if (mResult.success) allMembers = mResult.data
    
    await syncRelationships(chartData)
    
    const pcResult = await getParentChildRelationships(currentTreeId)
    if (pcResult.success) allParentChildRels = pcResult.data
    
    const sResult = await getSpousalRelationships(currentTreeId)
    if (sResult.success) allSpousalRels = sResult.data
    
  } catch (error) {
    console.error('Sync error:', error)
  } finally {
    isSaving = false
  }
}

async function syncRelationships(chartData) {
  const targetParentChild = []
  const targetSpousal = []
  
  for (const person of chartData) {
    const { father, mother, spouses } = person.rels || {}
    
    if (father) targetParentChild.push({ parent_id: father, child_id: person.id })
    if (mother) targetParentChild.push({ parent_id: mother, child_id: person.id })
    
    if (spouses) {
      for (const spouseId of spouses) {
        if (person.id < spouseId) {
          targetSpousal.push({ p1: person.id, p2: spouseId })
        }
      }
    }
  }
  
  // Create missing parent-child relationships
  for (const target of targetParentChild) {
    const exists = allParentChildRels.find(r => 
      r.parent_id === target.parent_id && r.child_id === target.child_id
    )
    if (!exists) {
      const result = await createParentChildRelationship(currentTreeId, target.parent_id, target.child_id)
      if (result.success && result.data) allParentChildRels.push(result.data)
    }
  }
  
  // Delete extra parent-child relationships
  for (const existing of allParentChildRels) {
    const shouldExist = targetParentChild.find(t => 
      t.parent_id === existing.parent_id && t.child_id === existing.child_id
    )
    if (!shouldExist) {
      await deleteParentChildRelationship(existing.parent_id, existing.child_id)
    }
  }
  
  // Create missing spousal relationships
  for (const target of targetSpousal) {
    const exists = allSpousalRels.find(r => 
      (r.person1_id === target.p1 && r.person2_id === target.p2) ||
      (r.person1_id === target.p2 && r.person2_id === target.p1)
    )
    if (!exists) {
      const relType = window.lastRelationshipType || 'married'
      const result = await createSpousalRelationship(currentTreeId, target.p1, target.p2, relType)
      if (result.success && result.data) allSpousalRels.push(result.data)
      window.lastRelationshipType = null
    }
  }
  
  // Delete extra spousal relationships
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
  console.log('Customizing UI...')
  
  const form = document.querySelector('#familyForm')
  if (form) {
    // Change labels to "Year of birth" and "Year of death"
    form.querySelectorAll('label').forEach(label => {
      const text = label.textContent.trim().toLowerCase()
      if (text === 'birthday') label.textContent = 'Year of birth'
      if (text === 'death') label.textContent = 'Year of death'
    })
    
    // Add input restrictions for year fields
    const birthdayInput = form.querySelector('input[name="birthday"]')
    const deathInput = form.querySelector('input[name="death"]')
    
    [birthdayInput, deathInput].forEach(input => {
      if (input) {
        input.type = 'text'
        input.maxLength = 4
        input.placeholder = 'YYYY'
        input.pattern = '[0-9]{4}'
        
        // Only allow numbers
        input.addEventListener('input', (e) => {
          e.target.value = e.target.value.replace(/[^0-9]/g, '')
        })
        
        input.addEventListener('keypress', (e) => {
          if (!/[0-9]/.test(e.key)) {
            e.preventDefault()
          }
        })
      }
    })
    
    // Hide gender text input
    const genderInput = form.querySelector('input[name="gender"][type="text"]')
    if (genderInput) {
      const genderField = genderInput.closest('.f3-form-field')
      if (genderField) genderField.style.display = 'none'
      
      form.querySelectorAll('input[name="gender"][type="radio"]').forEach(radio => {
        radio.addEventListener('change', () => {
          genderInput.value = radio.value
        })
      })
    }
    
    // Hide remove relation button
    const removeBtn = form.querySelector('.f3-remove-relative-btn')
    if (removeBtn) removeBtn.style.display = 'none'
    
    addRelationshipTypeSelector(form)
  }
  
  changeAddLabels()
}

function addRelationshipTypeSelector(form) {
  const formTitle = form.querySelector('.f3-form-title')
  if (!formTitle) return
  
  const titleText = formTitle.textContent.toLowerCase()
  const isPartnerForm = titleText.includes('partner') || titleText.includes('spouse')
  if (!isPartnerForm) return
  
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
    
    const select = relTypeDiv.querySelector('select')
    select.addEventListener('change', () => {
      window.lastRelationshipType = select.value
    })
  }
}

function changeAddLabels() {
  // Change "Add Father/Mother" to "Add Parent", etc.
  document.querySelectorAll('.card_add_relative, svg text, [data-rel-type]').forEach(element => {
    const replaceText = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        let text = node.textContent
        // More specific replacements
        text = text.replace(/Add Father/gi, 'Add Parent')
        text = text.replace(/Add Mother/gi, 'Add Parent')
        text = text.replace(/Add Son/gi, 'Add Child')
        text = text.replace(/Add Daughter/gi, 'Add Child')
        text = text.replace(/Add Spouse/gi, 'Add Partner')
        node.textContent = text
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        Array.from(node.childNodes).forEach(replaceText)
      }
    }
    replaceText(element)
  })
  
  // Also check for title attributes
  document.querySelectorAll('[title*="Add Father"], [title*="Add Mother"], [title*="Add Son"], [title*="Add Daughter"], [title*="Add Spouse"]').forEach(el => {
    let title = el.getAttribute('title')
    title = title.replace(/Add Father/gi, 'Add Parent')
    title = title.replace(/Add Mother/gi, 'Add Parent')
    title = title.replace(/Add Son/gi, 'Add Child')
    title = title.replace(/Add Daughter/gi, 'Add Child')
    title = title.replace(/Add Spouse/gi, 'Add Partner')
    el.setAttribute('title', title)
  })
}
