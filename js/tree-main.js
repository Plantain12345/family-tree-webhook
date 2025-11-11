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

// Global variables
let currentTreeId = null
let currentTreeCode = null
let f3Chart = null
let allMembers = []
let allParentChildRels = []
let allSpousalRels = []
let isSaving = false

// Track chart IDs to database IDs
const chartToDbIdMap = new Map()

// Get tree code from URL
const urlParams = new URLSearchParams(window.location.search)
const treeCode = urlParams.get('code')

console.log('🌳 Tree code from URL:', treeCode)

if (!treeCode) {
  console.log('❌ No tree code found, redirecting to index')
  window.location.href = 'index.html'
} else {
  // Wait for DOM and f3 library to load
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
    
    // Get tree info
    const treeResult = await getFamilyTreeByCode(code)
    
    if (!treeResult.success) {
      alert('Tree not found!')
      window.location.href = 'index.html'
      return
    }
    
    const tree = treeResult.data
    currentTreeId = tree.id
    currentTreeCode = tree.tree_code
    
    // Update UI
    document.getElementById('treeName').textContent = tree.tree_name
    document.getElementById('treeCodeDisplay').textContent = tree.tree_code
    
    // Load all data
    await loadTreeData()
    
    // Setup realtime sync to reload when others make changes
    setupRealtimeSync(currentTreeId, loadTreeData)
    
    document.getElementById('loadingOverlay').classList.add('hidden')
    console.log('✅ Tree initialized!')
    
  } catch (error) {
    console.error('❌ Error initializing tree:', error)
    alert('Error loading tree. Please try again.')
    document.getElementById('loadingOverlay').classList.add('hidden')
  }
}

async function loadTreeData() {
  console.log('📡 Loading tree data from Supabase...')
  
  try {
    // Load all data from Supabase
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
    
    // Build ID mapping (database ID = chart ID, we use same IDs)
    chartToDbIdMap.clear()
    allMembers.forEach(member => {
      chartToDbIdMap.set(member.id, member.id)
    })
    
    // Transform to family-chart format
    const familyChartData = transformDatabaseToFamilyChart(
      allMembers,
      allParentChildRels,
      allSpousalRels
    )
    
    // Create or update chart
    if (!f3Chart) {
      createChart(familyChartData)
    } else {
      updateChart(familyChartData)
    }
    
  } catch (error) {
    console.error('❌ Error loading tree data:', error)
    throw error
  }
}

function createChart(data) {
  console.log('🎨 Creating chart with', data.length, 'members')
  
  try {
    // Create chart
    f3Chart = window.f3.createChart('#FamilyChart', data)
      .setTransitionTime(1000)
      .setCardXSpacing(250)
      .setCardYSpacing(150)
    
    // Setup card display
    f3Chart.setCardHtml()
      .setCardDisplay([["first name", "last name"], ["birthday"]])
    
    // Setup edit tree functionality
    const f3Card = f3Chart.setCardHtml()
      .setCardDisplay([["first name", "last name"], ["birthday"]])
    
    const f3EditTree = f3Chart.editTree()
      .setFields(["first name", "last name", "birthday", "death", "gender"])
      .setEditFirst(true)
      .setCardClickOpen(f3Card)
    
    // Set main person
    const mainPersonId = findMainPersonId(allMembers)
    if (mainPersonId) {
      f3Chart.updateMainId(mainPersonId)
    }
    
    // CRITICAL: First update to render the tree
    f3Chart.updateTree({ initial: true })
    
    // CRITICAL: Open the main person's form to activate edit mode
    f3EditTree.open(f3Chart.getMainDatum())
    
    // CRITICAL: Update again after opening the form
    f3Chart.updateTree({ initial: true })
    
    // Hook into form submissions
    hookFormSubmissions()
    
    window.f3Chart = f3Chart
    console.log('✅ Chart created and interactive!')
    
  } catch (error) {
    console.error('❌ Error creating chart:', error)
    throw error
  }
}

function updateChart(data) {
  console.log('🔄 Updating chart with new data')
  
  if (!isSaving) { // Don't update if we're currently saving
    f3Chart.updateData(data)
    f3Chart.updateTree({ initial: false })
  }
}

function hookFormSubmissions() {
  console.log('🔗 Hooking into form submissions...')
  
  // Listen for form submissions by intercepting the submit button clicks
  // We'll use event delegation on the document
  document.addEventListener('click', async (e) => {
    // Check if the clicked element is a submit button in the f3 form
    if (e.target.matches('.f3-form button[type="submit"]')) {
      console.log('💾 Form submit detected!')
      
      // Give the library a moment to update its internal data
      setTimeout(async () => {
        await saveTreeToDatabase()
      }, 100)
    }
    
    // Check for delete button
    if (e.target.matches('.f3-form .f3-delete-btn')) {
      console.log('🗑️ Delete button detected!')
      
      setTimeout(async () => {
        await saveTreeToDatabase()
      }, 100)
    }
  })
  
  console.log('✅ Form submission hooks set up')
}

async function saveTreeToDatabase() {
  if (isSaving) return
  
  isSaving = true
  console.log('💾 Saving entire tree to Supabase...')
  
  try {
    // Get current chart data
    const currentChartData = f3Chart.store.getData()
    
    // Find what changed compared to our database state
    // For simplicity, we'll do a full sync approach:
    // 1. Get all members from chart
    // 2. Update/create each one in database
    // 3. Update relationships
    
    for (const datum of currentChartData) {
      const dbId = chartToDbIdMap.get(datum.id)
      
      const memberData = {
        tree_id: currentTreeId,
        first_name: datum.data['first name'] || '',
        last_name: datum.data['last name'] || '',
        birthday: datum.data['birthday'] ? parseInt(datum.data['birthday']) : null,
        death: datum.data['death'] ? parseInt(datum.data['death']) : null,
        gender: datum.data['gender'] || null,
        is_main: false
      }
      
      if (!dbId) {
        // New member - create in database
        console.log('🆕 Creating new member:', memberData.first_name)
        const result = await createFamilyMember(memberData)
        
        if (result.success) {
          chartToDbIdMap.set(datum.id, result.data.id)
          
          // Create relationships
          await syncRelationships(datum, result.data.id)
        }
      } else {
        // Existing member - update
        console.log('📝 Updating member:', memberData.first_name)
        await updateFamilyMember(dbId, memberData)
        
        // Update relationships
        await syncRelationships(datum, dbId)
      }
    }
    
    // Reload from database to ensure sync
    setTimeout(() => {
      isSaving = false
      loadTreeData()
    }, 1000)
    
    console.log('✅ Save complete!')
    
  } catch (error) {
    console.error('❌ Error saving tree:', error)
    isSaving = false
  }
}

async function syncRelationships(datum, dbId) {
  // This is a simplified version - in production you'd want to:
  // 1. Compare existing relationships
  // 2. Only create new ones
  // 3. Delete removed ones
  
  // For now, we'll rely on the loadTreeData to refresh everything
  console.log('🔗 Syncing relationships for:', dbId)
  
  // Parent relationships
  if (datum.rels?.father) {
    const fatherDbId = chartToDbIdMap.get(datum.rels.father)
    if (fatherDbId) {
      await createParentChildRelationship(currentTreeId, fatherDbId, dbId)
        .catch(e => console.log('Relationship might already exist'))
    }
  }
  
  if (datum.rels?.mother) {
    const motherDbId = chartToDbIdMap.get(datum.rels.mother)
    if (motherDbId) {
      await createParentChildRelationship(currentTreeId, motherDbId, dbId)
        .catch(e => console.log('Relationship might already exist'))
    }
  }
  
  // Spouse relationships
  if (datum.rels?.spouses) {
    for (const spouseChartId of datum.rels.spouses) {
      const spouseDbId = chartToDbIdMap.get(spouseChartId)
      if (spouseDbId) {
        await createSpousalRelationship(currentTreeId, dbId, spouseDbId, 'married')
          .catch(e => console.log('Relationship might already exist'))
      }
    }
  }
}
