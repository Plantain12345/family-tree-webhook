import { 
  getFamilyTreeByCode,
  getFamilyMembers,
  getParentChildRelationships,
  getSpousalRelationships,
  createFamilyMember,
  updateFamilyMember,
  deleteFamilyMember,
  createParentChildRelationship,
  createSpousalRelationship
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
const chartToDbIdMap = new Map()

// Get tree code from URL
const urlParams = new URLSearchParams(window.location.search)
const treeCode = urlParams.get('code')

console.log('🌳 Tree code from URL:', treeCode)

if (!treeCode) {
  console.log('❌ No tree code, redirecting')
  window.location.href = 'index.html'
} else {
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (window.f3) {
        console.log('✅ f3 loaded')
        initializeTree(treeCode)
      } else {
        console.error('❌ f3 not loaded')
        alert('Error loading library. Refresh page.')
      }
    }, 300)
  })
}

// Copy code button
document.getElementById('copyCodeBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(currentTreeCode)
  const btn = document.getElementById('copyCodeBtn')
  const original = btn.textContent
  btn.textContent = '✓'
  setTimeout(() => btn.textContent = original, 2000)
})

async function initializeTree(code) {
  try {
    console.log('🚀 Init tree:', code)
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
    setupRealtimeSync(currentTreeId, loadTreeData)
    
    document.getElementById('loadingOverlay').classList.add('hidden')
    console.log('✅ Tree ready!')
    
  } catch (error) {
    console.error('❌ Init error:', error)
    alert('Error loading tree')
    document.getElementById('loadingOverlay').classList.add('hidden')
  }
}

async function loadTreeData() {
  console.log('📡 Loading data...')
  
  try {
    const [membersResult, parentChildResult, spousalResult] = await Promise.all([
      getFamilyMembers(currentTreeId),
      getParentChildRelationships(currentTreeId),
      getSpousalRelationships(currentTreeId)
    ])
    
    if (!membersResult.success || !parentChildResult.success || !spousalResult.success) {
      throw new Error('Failed to load data')
    }
    
    allMembers = membersResult.data
    allParentChildRels = parentChildResult.data
    allSpousalRels = spousalResult.data
    
    console.log('✅ Loaded:', allMembers.length, 'members')
    
    chartToDbIdMap.clear()
    allMembers.forEach(m => chartToDbIdMap.set(m.id, m.id))
    
    const familyChartData = transformDatabaseToFamilyChart(
      allMembers,
      allParentChildRels,
      allSpousalRels
    )
    
    if (!f3Chart) {
      createChart(familyChartData)
    } else {
      updateChart(familyChartData)
    }
    
  } catch (error) {
    console.error('❌ Load error:', error)
    throw error
  }
}

function createChart(data) {
  console.log('🎨 Creating chart:', data.length, 'members')
  
  try {
    f3Chart = window.f3.createChart('#FamilyChart', data)
      .setTransitionTime(1000)
      .setCardXSpacing(250)
      .setCardYSpacing(150)
    
    const f3Card = f3Chart.setCardHtml()
      .setCardDisplay([["first name", "last name"], ["birthday"]])
    
    const f3EditTree = f3Chart.editTree()
      .setFields(["first name", "last name", "birthday"])
      .setEditFirst(true)
      .setCardClickOpen(f3Card)
    
    const mainPersonId = findMainPersonId(allMembers)
    if (mainPersonId) {
      f3Chart.updateMainId(mainPersonId)
    }
    
    console.log('🔄 Step 1: Initial render')
    f3Chart.updateTree({ initial: true })
    
    console.log('📝 Step 2: Open edit form')
    f3EditTree.open(f3Chart.getMainDatum())
    
    console.log('🔄 Step 3: Re-render with edit mode')
    f3Chart.updateTree({ initial: true })
    
    hookFormSubmissions()
    
    window.f3Chart = f3Chart
    console.log('✅ Chart ready!')
    
  } catch (error) {
    console.error('❌ Chart error:', error)
    throw error
  }
}

function updateChart(data) {
  if (!isSaving) {
    f3Chart.updateData(data)
    f3Chart.updateTree({ initial: false })
  }
}

function hookFormSubmissions() {
  document.addEventListener('click', async (e) => {
    if (e.target.matches('.f3-form button[type="submit"]')) {
      console.log('💾 Submit clicked')
      setTimeout(() => saveTreeToDatabase(), 200)
    }
    
    if (e.target.matches('.f3-form .f3-delete-btn')) {
      console.log('🗑️ Delete clicked')
      setTimeout(() => saveTreeToDatabase(), 200)
    }
  }, true)
}

async function saveTreeToDatabase() {
  if (isSaving) return
  
  isSaving = true
  console.log('💾 Saving...')
  
  try {
    const currentChartData = f3Chart.store.getData()
    
    for (const datum of currentChartData) {
      const dbId = chartToDbIdMap.get(datum.id)
      
      // Get gender from the datum (family-chart stores it)
      let genderValue = null
      if (datum.data && datum.data.gender) {
        genderValue = datum.data.gender
      }
      
      const memberData = {
        tree_id: currentTreeId,
        first_name: datum.data['first name'] || '',
        last_name: datum.data['last name'] || '',
        birthday: datum.data['birthday'] ? parseInt(datum.data['birthday']) : null,
        death: null, // We're not using death field for now
        gender: genderValue,
        is_main: false
      }
      
      if (!dbId) {
        const result = await createFamilyMember(memberData)
        if (result.success) {
          chartToDbIdMap.set(datum.id, result.data.id)
          await syncRelationships(datum, result.data.id)
        }
      } else {
        await updateFamilyMember(dbId, memberData)
        await syncRelationships(datum, dbId)
      }
    }
    
    setTimeout(() => {
      isSaving = false
      loadTreeData()
    }, 1000)
    
    console.log('✅ Saved!')
    
  } catch (error) {
    console.error('❌ Save error:', error)
    isSaving = false
  }
}

async function syncRelationships(datum, dbId) {
  if (datum.rels?.father) {
    const fatherDbId = chartToDbIdMap.get(datum.rels.father)
    if (fatherDbId) {
      await createParentChildRelationship(currentTreeId, fatherDbId, dbId)
        .catch(() => {})
    }
  }
  
  if (datum.rels?.mother) {
    const motherDbId = chartToDbIdMap.get(datum.rels.mother)
    if (motherDbId) {
      await createParentChildRelationship(currentTreeId, motherDbId, dbId)
        .catch(() => {})
    }
  }
  
  if (datum.rels?.spouses) {
    for (const spouseChartId of datum.rels.spouses) {
      const spouseDbId = chartToDbIdMap.get(spouseChartId)
      if (spouseDbId) {
        await createSpousalRelationship(currentTreeId, dbId, spouseDbId, 'married')
          .catch(() => {})
      }
    }
  }
}
