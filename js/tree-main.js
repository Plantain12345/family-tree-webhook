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

if (!treeCode) {
  window.location.href = 'index.html'
} else {
  initializeTree(treeCode)
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
    // Show loading overlay
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
    const [membersResult, parentChildResult, spousalResult] = await Promise.all([
      getFamilyMembers(tree.id),
      getParentChildRelationships(tree.id),
      getSpousalRelationships(tree.id)
    ])
    
    if (!membersResult.success || !parentChildResult.success || !spousalResult.success) {
      throw new Error('Failed to load tree data')
    }
    
    allMembers = membersResult.data
    allParentChildRels = parentChildResult.data
    allSpousalRels = spousalResult.data
    
    // Transform data for family-chart
    const familyChartData = transformDatabaseToFamilyChart(
      allMembers,
      allParentChildRels,
      allSpousalRels
    )
    
    // Initialize chart
    createChart(familyChartData)
    
    // Setup realtime sync
    setupRealtimeSync(currentTreeId, refreshTree)
    
    // Hide loading
    document.getElementById('loadingOverlay').classList.add('hidden')
    
  } catch (error) {
    console.error('Error initializing tree:', error)
    alert('Error loading tree. Please try again.')
    document.getElementById('loadingOverlay').classList.add('hidden')
  }
}

function createChart(data) {
  // Create family-chart instance
  f3Chart = window.f3.createChart('#FamilyChart', data)
    .setTransitionTime(1000)
    .setCardXSpacing(250)
    .setCardYSpacing(150)
  
  // Setup card display
  const f3Card = f3Chart.setCard(window.f3.CardHtml)
    .setCardDisplay([["first name", "last name"], ["birthday"]])
  
  // Setup edit tree functionality
  const f3EditTree = f3Chart.editTree()
    .setFields(["first name", "last name", "birthday", "death", "gender"])
    .setEditFirst(true)
    .setCardClickOpen(f3Card)
    .onUpdate(handlePersonUpdate)
    .onRemove(handlePersonRemove)
  
  // Set main person
  const mainPersonId = findMainPersonId(allMembers)
  if (mainPersonId) {
    f3Chart.updateMainId(mainPersonId)
  }
  
  // Initial tree update
  f3Chart.updateTree({ initial: true })
  
  // Apply relationship styling to links
  applyRelationshipStyling()
  
  // Store globally
  window.f3Chart = f3Chart
}

// Handle person update/create
async function handlePersonUpdate(personData) {
  try {
    const isNewPerson = !personData.id || personData.id.startsWith('new_')
    
    if (isNewPerson) {
      // Create new person
      const memberData = createMemberData(currentTreeId, personData.data)
      const result = await createFamilyMember(memberData)
      
      if (result.success) {
        const newMember = result.data
        
        // Handle relationships
        if (personData.rels) {
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
      
      await updateFamilyMember(personData.id, updates)
      
      // Refresh tree
      await refreshTree()
    }
  } catch (error) {
    console.error('Error updating person:', error)
    alert('Error saving changes. Please try again.')
  }
}

// Handle person removal
async function handlePersonRemove(personId) {
  try {
    await deleteFamilyMember(personId)
    await refreshTree()
  } catch (error) {
    console.error('Error removing person:', error)
    alert('Error removing person. Please try again.')
  }
}

// Refresh tree data
async function refreshTree() {
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
    
  } catch (error) {
    console.error('Error refreshing tree:', error)
  }
}

// Apply relationship styling to spousal links
function applyRelationshipStyling() {
  // Find all spousal links and apply styling based on relationship type
  allSpousalRels.forEach(rel => {
    const linkClass = `link-${rel.relationship_type.toLowerCase()}`
    
    // Find the link element between these two people
    // This is a simplified approach - you may need to adjust based on family-chart's DOM structure
    const links = document.querySelectorAll('.f3 .link')
    links.forEach(link => {
      // You'll need to identify which link corresponds to which relationship
      // This may require inspecting the family-chart library's link data attributes
      link.classList.add(linkClass)
    })
  })
}
