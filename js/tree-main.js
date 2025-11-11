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
  findMainPersonId,
  createMemberData
} from './tree-data.js'

import { setupRealtimeSync } from './tree-sync.js'

// Global variables
let currentTreeId = null
let currentTreeCode = null
let f3Chart = null
let allMembers = []
let allParentChildRels = []
let allSpousalRels = []

// Get tree code from URL
const urlParams = new URLSearchParams(window.location.search)
const treeCode = urlParams.get('code')

console.log('🌳 Tree code from URL:', treeCode)

if (!treeCode) {
  console.log('❌ No tree code found, redirecting to index')
  window.location.href = 'index.html'
} else {
  // Wait for f3 to load before initializing
  if (window.f3) {
    console.log('✅ f3 library already loaded')
    initializeTree(treeCode)
  } else {
    console.log('⏳ Waiting for f3 library to load...')
    window.addEventListener('load', () => {
      setTimeout(() => {
        console.log('✅ f3 library loaded after page load')
        initializeTree(treeCode)
      }, 100)
    })
  }
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
    console.log('🚀 Starting tree initialization for code:', code)
    
    // Show loading overlay
    document.getElementById('loadingOverlay').classList.remove('hidden')
    
    // Get tree info
    console.log('📡 Fetching tree from database...')
    const treeResult = await getFamilyTreeByCode(code)
    console.log('📊 Tree result:', treeResult)
    
    if (!treeResult.success) {
      console.error('❌ Tree not found in database')
      alert('Tree not found!')
      window.location.href = 'index.html'
      return
    }
    
    const tree = treeResult.data
    currentTreeId = tree.id
    currentTreeCode = tree.tree_code
    console.log('✅ Tree loaded:', { id: currentTreeId, code: currentTreeCode, name: tree.tree_name })
    
    // Update UI
    document.getElementById('treeName').textContent = tree.tree_name
    document.getElementById('treeCodeDisplay').textContent = tree.tree_code
    
    // Load all data
    console.log('📡 Loading family members and relationships...')
    const [membersResult, parentChildResult, spousalResult] = await Promise.all([
      getFamilyMembers(tree.id),
      getParentChildRelationships(tree.id),
      getSpousalRelationships(tree.id)
    ])
    
    console.log('📊 Members result:', membersResult)
    console.log('📊 Parent-child result:', parentChildResult)
    console.log('📊 Spousal result:', spousalResult)
    
    if (!membersResult.success || !parentChildResult.success || !spousalResult.success) {
      console.error('❌ Failed to load tree data')
      throw new Error('Failed to load tree data')
    }
    
    allMembers = membersResult.data
    allParentChildRels = parentChildResult.data
    allSpousalRels = spousalResult.data
    
    console.log('✅ Data loaded:', {
      members: allMembers.length,
      parentChildRels: allParentChildRels.length,
      spousalRels: allSpousalRels.length
    })
    
    // Transform data for family-chart
    console.log('🔄 Transforming data for family-chart...')
    const familyChartData = transformDatabaseToFamilyChart(
      allMembers,
      allParentChildRels,
      allSpousalRels
    )
    console.log('📊 Family chart data:', familyChartData)
    
    // Initialize chart
    console.log('🎨 Creating chart...')
    createChart(familyChartData)
    
    // Setup realtime sync
    console.log('🔄 Setting up real-time sync...')
    setupRealtimeSync(currentTreeId, refreshTree)
    
    // Hide loading
    document.getElementById('loadingOverlay').classList.add('hidden')
    console.log('✅ Tree initialization complete!')
    
  } catch (error) {
    console.error('❌ Error initializing tree:', error)
    console.error('Error details:', {
      message: error.message,
      stack: error.stack
    })
    alert('Error loading tree. Check console for details.')
    document.getElementById('loadingOverlay').classList.add('hidden')
  }
}

function createChart(data) {
  console.log('🎨 createChart called with data:', data)
  
  // Check if f3 is available
  if (!window.f3) {
    console.error('❌ f3 library not available on window object')
    console.log('Window.f3:', window.f3)
    alert('Error: Family chart library not loaded. Please refresh the page.')
    return
  }
  
  console.log('✅ f3 library available:', window.f3)
  
  try {
    // Create family-chart instance
    console.log('🏗️ Creating f3 chart instance...')
    f3Chart = window.f3.createChart('#FamilyChart', data)
      .setTransitionTime(1000)
      .setCardXSpacing(250)
      .setCardYSpacing(150)
    
    console.log('✅ Chart instance created')
    
    // Setup card display
    console.log('🎨 Setting up card display...')
    const f3Card = f3Chart.setCardHtml()
      .setCardDisplay([["first name", "last name"], ["birthday"]])
    
    console.log('✅ Card display configured')
    
    // Setup edit tree functionality
    console.log('✏️ Setting up edit functionality...')
    const f3EditTree = f3Chart.editTree()
      .setFields(["first name", "last name", "birthday", "death", "gender"])
      .setEditFirst(true)
      .setCardClickOpen(f3Card)
      .onUpdate(handlePersonUpdate)
      .onRemove(handlePersonRemove)
    
    console.log('✅ Edit functionality configured')
    
    // Set main person
    const mainPersonId = findMainPersonId(allMembers)
    console.log('👤 Main person ID:', mainPersonId)
    
    if (mainPersonId) {
      f3Chart.updateMainId(mainPersonId)
    }
    
    // Initial tree update
    console.log('🔄 Updating tree...')
    f3Chart.updateTree({ initial: true })
    
    // Apply relationship styling to links
    applyRelationshipStyling()
    
    // Store globally
    window.f3Chart = f3Chart
    console.log('✅ Chart creation complete!')
    
  } catch (error) {
    console.error('❌ Error creating chart:', error)
    console.error('Error details:', {
      message: error.message,
      stack: error.stack
    })
    alert('Error creating chart. Check console for details.')
  }
}

// Handle person update/create
async function handlePersonUpdate(personData) {
  console.log('✏️ handlePersonUpdate called:', personData)
  
  try {
    const isNewPerson = !personData.id || personData.id.startsWith('new_')
    console.log('Is new person?', isNewPerson)
    
    if (isNewPerson) {
      // Create new person
      const memberData = createMemberData(currentTreeId, personData.data)
      console.log('Creating new member:', memberData)
      
      const result = await createFamilyMember(memberData)
      console.log('Create result:', result)
      
      if (result.success) {
        const newMember = result.data
        
        // Handle relationships
        if (personData.rels) {
          console.log('Processing relationships:', personData.rels)
          
          // Parent relationships
          if (personData.rels.father) {
            await createParentChildRelationship(currentTreeId, personData.rels.father, newMember.id)
          }
          if (personData.rels.mother) {
            await createParentChildRelationship(currentTreeId, personData.rels.mother, newMember.id)
          }
          
          // Spouse relationships
          if (personData.rels.spouses) {
            for (const spouseId of personData.rels.spouses) {
              await createSpousalRelationship(currentTreeId, newMember.id, spouseId, 'married')
            }
          }
        }
        
        // Refresh tree
        console.log('Refreshing tree...')
        await refreshTree()
      }
    } else {
      // Update existing person
      const updates = {
        first_name: personData.data['first name'] || '',
        last_name: personData.data['last name'] || '',
        birthday: personData.data['birthday'] ? parseInt(personData.data['birthday']) : null,
        death: personData.data['death'] ? parseInt(personData.data['death']) : null,
        gender: personData.data['gender'] || null
      }
      
      console.log('Updating member:', updates)
      await updateFamilyMember(personData.id, updates)
      
      // Refresh tree
      await refreshTree()
    }
  } catch (error) {
    console.error('❌ Error updating person:', error)
    alert('Error saving changes. Please try again.')
  }
}

// Handle person removal
async function handlePersonRemove(personId) {
  console.log('🗑️ handlePersonRemove called for:', personId)
  
  try {
    await deleteFamilyMember(personId)
    await refreshTree()
  } catch (error) {
    console.error('❌ Error removing person:', error)
    alert('Error removing person. Please try again.')
  }
}

// Refresh tree data
async function refreshTree() {
  console.log('🔄 Refreshing tree...')
  
  try {
    // Reload all data
    const [membersResult, parentChildResult, spousalResult] = await Promise.all([
      getFamilyMembers(currentTreeId),
      getParentChildRelationships(currentTreeId),
      getSpousalRelationships(currentTreeId)
    ])
    
    allMembers = membersResult.data
    allParentChildRels = parentChildResult.data
    allSpousalRels = spousalResult.data
    
    // Transform and update
    const familyChartData = transformDatabaseToFamilyChart(
      allMembers,
      allParentChildRels,
      allSpousalRels
    )
    
    // Update chart data
    f3Chart.updateData(familyChartData)
    f3Chart.updateTree({ initial: false })
    
    // Reapply styling
    setTimeout(() => applyRelationshipStyling(), 500)
    
    console.log('✅ Tree refresh complete')
    
  } catch (error) {
    console.error('❌ Error refreshing tree:', error)
  }
}

// Apply relationship styling to spousal links
function applyRelationshipStyling() {
  console.log('🎨 Applying relationship styling...')
  
  // Find all spousal links and apply styling based on relationship type
  allSpousalRels.forEach(rel => {
    const linkClass = `link-${rel.relationship_type.toLowerCase()}`
    
    // Find the link element between these two people
    const links = document.querySelectorAll('.f3 .link')
    links.forEach(link => {
      link.classList.add(linkClass)
    })
  })
}
