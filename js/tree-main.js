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
  f3Chart = window.f3.createChart('#FamilyChart', data)
    .setTransitionTime(1000)
    .setCardXSpacing(250)
    .setCardYSpacing(150)
  
  f3Chart.setCardHtml()
    .setCardDisplay([["first name", "last name"], ["birthday", "death"]])
  
  f3Chart.editTree()
    .setFields(["first name", "last name", "birthday", "death"])
    .setEditFirst(true)
  
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
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'familyForm') {
      e.preventDefault()
      
      const relSelect = e.target.querySelector('.relationship-type-select')
      if (relSelect) window.lastRelationshipType = relSelect.value
      
      setTimeout(() => scheduleSave(), 200)
    }
  }, true)
  
  document.addEventListener('click', (e) => {
    if (e.target.matches('.f3-delete-btn')) {
      setTimeout(() => scheduleSave(), 200)
    }
  }, true)
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
    
    // Delete removed members
    for (const id of delIds) {
      const pRels = allParentChildRels.filter(r => r.parent_id === id || r.child_id === id)
      const sRels = allSpousalRels.filter(r => r.person1_id === id || r.person2_id === id)
      
      for (const r of pRels) await deleteParentChildRelationship(r.parent_id, r.child_id)
      for (const r of sRels) await deleteSpousalRelationship(r.person1_id, r.person2_id)
      
      await deleteFamilyMember(id)
    }
    
    // Create new members (all at once, before relationships)
    for (const id of newIds) {
      const p = chartData.find(d => d.id === id)
      if (!p) continue
      
      await createFamilyMember({
        id: id,
        tree_id: currentTreeId,
        first_name: p.data['first name'] || '',
        last_name: p.data['last name'] || '',
        birthday: p.data['birthday'] ? parseInt(p.data['birthday']) : null,
        death: p.data['death'] ? parseInt(p.data['death']) : null,
        gender: p.data['gender'] || null,
        is_main: false
      })
    }
    
    // Update existing members
    for (const id of existIds) {
      const cp = chartData.find(d => d.id === id)
      const dp = allMembers.find(m => m.id === id)
      if (!cp || !dp) continue
      
      const u = {
        first_name: cp.data['first name'] || '',
        last_name: cp.data['last name'] || '',
        birthday: cp.data['birthday'] ? parseInt(cp.data['birthday']) : null,
        death: cp.data['death'] ? parseInt(cp.data['death']) : null,
        gender: cp.data['gender'] || null
      }
      
      if (u.first_name !== dp.first_name || u.last_name !== dp.last_name || 
          u.birthday !== dp.birthday || u.death !== dp.death || u.gender !== dp.gender) {
        await updateFamilyMember(id, u)
      }
    }
    
    // Refresh member list
    const mResult = await getFamilyMembers(currentTreeId)
    if (mResult.success) allMembers = mResult.data
    
    // Now sync relationships
    await syncRelationships(chartData)
    
    // Refresh relationships
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
  const targetPC = []
  const targetS = []
  
  for (const p of chartData) {
    const { father, mother, spouses } = p.rels || {}
    
    if (father) targetPC.push({ parent_id: father, child_id: p.id })
    if (mother) targetPC.push({ parent_id: mother, child_id: p.id })
    
    if (spouses) {
      for (const sid of spouses) {
        if (p.id < sid) targetS.push({ p1: p.id, p2: sid })
      }
    }
  }
  
  // Create missing parent-child rels
  for (const t of targetPC) {
    const exists = allParentChildRels.find(r => 
      r.parent_id === t.parent_id && r.child_id === t.child_id
    )
    if (!exists) {
      const res = await createParentChildRelationship(currentTreeId, t.parent_id, t.child_id)
      if (res.success && res.data) allParentChildRels.push(res.data)
    }
  }
  
  // Delete extra parent-child rels
  for (const r of allParentChildRels) {
    const still = targetPC.find(t => t.parent_id === r.parent_id && t.child_id === r.child_id)
    if (!still) {
      await deleteParentChildRelationship(r.parent_id, r.child_id)
    }
  }
  
  // Create missing spousal rels
  for (const t of targetS) {
    const exists = allSpousalRels.find(r => 
      (r.person1_id === t.p1 && r.person2_id === t.p2) ||
      (r.person1_id === t.p2 && r.person2_id === t.p1)
    )
    if (!exists) {
      const type = window.lastRelationshipType || 'married'
      const res = await createSpousalRelationship(currentTreeId, t.p1, t.p2, type)
      if (res.success && res.data) allSpousalRels.push(res.data)
      window.lastRelationshipType = null
    }
  }
  
  // Delete extra spousal rels
  for (const r of allSpousalRels) {
    const still = targetS.find(t => 
      (t.p1 === r.person1_id && t.p2 === r.person2_id) ||
      (t.p1 === r.person2_id && t.p2 === r.person1_id)
    )
    if (!still) {
      await deleteSpousalRelationship(r.person1_id, r.person2_id)
    }
  }
}

function customizeUI() {
  const form = document.querySelector('#familyForm')
  if (form) {
    // Change labels
    form.querySelectorAll('label').forEach(l => {
      if (l.textContent.trim().toLowerCase() === 'birthday') l.textContent = 'Year of birth'
      if (l.textContent.trim().toLowerCase() === 'death') l.textContent = 'Year of death'
    })
    
    // Hide gender text field
    const gInput = form.querySelector('input[name="gender"][type="text"]')
    if (gInput) {
      const field = gInput.closest('.f3-form-field')
      if (field) field.style.display = 'none'
      
      // Link radio to hidden field
      form.querySelectorAll('input[name="gender"][type="radio"]').forEach(r => {
        r.addEventListener('change', () => gInput.value = r.value)
      })
    }
    
    // Hide remove relation button
    const removeBtn = form.querySelector('.f3-remove-relative-btn')
    if (removeBtn) removeBtn.style.display = 'none'
    
    // Add relationship type selector for partners
    addRelTypeSelector(form)
  }
  
  // Change Add labels
  document.querySelectorAll('.card, svg text').forEach(el => {
    const replace = (node) => {
      if (node.nodeType === 3) {
        let txt = node.textContent
        txt = txt.replace(/Add (Father|Mother)/g, 'Add Parent')
        txt = txt.replace(/Add (Son|Daughter)/g, 'Add Child')
        txt = txt.replace(/Add Spouse/g, 'Add Partner')
        node.textContent = txt
      } else {
        Array.from(node.childNodes).forEach(replace)
      }
    }
    replace(el)
  })
}

function addRelTypeSelector(form) {
  const title = form.querySelector('.f3-form-title')
  if (!title) return
  
  const txt = title.textContent.toLowerCase()
  if (!txt.includes('partner') && !txt.includes('spouse')) return
  if (form.querySelector('.relationship-type-selector')) return
  
  const div = document.createElement('div')
  div.className = 'f3-form-field relationship-type-selector'
  div.innerHTML = `
    <label>Relationship Type</label>
    <select name="relationship_type" class="relationship-type-select">
      <option value="married">Married</option>
      <option value="partner">Partner</option>
      <option value="divorced">Divorced</option>
      <option value="separated">Separated</option>
    </select>
  `
  
  const gField = form.querySelector('.f3-radio-group')
  if (gField?.parentNode) {
    gField.parentNode.insertBefore(div, gField.nextSibling)
    div.querySelector('select').addEventListener('change', (e) => {
      window.lastRelationshipType = e.target.value
    })
  }
}
