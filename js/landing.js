import { createFamilyTree, getFamilyTreeByCode, createFamilyMember } from './supabase-client.js'

console.log('🚀 Landing page script loaded')


// DOM Elements
const treeCodeInput = document.getElementById('treeCode')
const viewTreeBtn = document.getElementById('viewTreeBtn')
const createTreeBtn = document.getElementById('createTreeBtn')
const errorMessage = document.getElementById('errorMessage')
const createModal = document.getElementById('createModal')
const closeModal = document.querySelector('.close')
const treeNameInput = document.getElementById('treeName')
const confirmCreateBtn = document.getElementById('confirmCreateBtn')

// Show error message
function showError(message) {
  console.log('⚠️ Showing error:', message)
  errorMessage.textContent = message
  errorMessage.classList.add('show')
  setTimeout(() => {
    errorMessage.classList.remove('show')
  }, 4000)
}

// View existing tree
viewTreeBtn.addEventListener('click', async () => {
  console.log('👁️ View Tree button clicked')
  const code = treeCodeInput.value.trim().toUpperCase()
  console.log('Tree code entered:', code)
  
  if (!code) {
    showError('Please enter a tree code')
    return
  }
  
  if (code.length !== 6) {
    showError('Tree code must be 6 characters')
    return
  }
  
  viewTreeBtn.disabled = true
  viewTreeBtn.textContent = 'Loading...'
  
  console.log('📡 Fetching tree with code:', code)
  const result = await getFamilyTreeByCode(code)
  console.log('📊 Fetch result:', result)
  
  if (result.success) {
    console.log('✅ Tree found, redirecting...')
    // Redirect to tree page with code
    window.location.href = `tree.html?code=${code}`
  } else {
    console.error('❌ Tree not found')
    showError('Tree not found. Please check the code and try again.')
    viewTreeBtn.disabled = false
    viewTreeBtn.textContent = 'View Tree'
  }
})

// Enter key on tree code input
treeCodeInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    viewTreeBtn.click()
  }
})

// Auto-format tree code to uppercase
treeCodeInput.addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
})

// Open create tree modal
createTreeBtn.addEventListener('click', () => {
  console.log('➕ Create Tree button clicked')
  createModal.style.display = 'block'
  treeNameInput.focus()
})

// Close modal
closeModal.addEventListener('click', () => {
  createModal.style.display = 'none'
  treeNameInput.value = ''
})

// Close modal when clicking outside
window.addEventListener('click', (e) => {
  if (e.target === createModal) {
    createModal.style.display = 'none'
    treeNameInput.value = ''
  }
})

// Confirm create tree
confirmCreateBtn.addEventListener('click', async () => {
  console.log('✅ Confirm Create button clicked')
  const treeName = treeNameInput.value.trim()
  console.log('Tree name:', treeName)
  
  if (!treeName) {
    showError('Please enter a family tree name')
    return
  }
  
  confirmCreateBtn.disabled = true
  confirmCreateBtn.textContent = 'Creating...'
  
  console.log('📡 Creating family tree...')
  const result = await createFamilyTree(treeName)
  console.log('📊 Create tree result:', result)
  
  if (result.success) {
    const treeId = result.data.id
    const treeCode = result.treeCode
    console.log('✅ Tree created:', { id: treeId, code: treeCode })
    
    // Create the first person (main person) with name "Name"
    console.log('👤 Creating first person...')
    const firstPersonResult = await createFamilyMember({
      tree_id: treeId,
      first_name: 'Name',
      last_name: '',
      birthday: null,
      death: null,
      gender: null,
      is_main: true
    })
    
    console.log('📊 First person result:', firstPersonResult)
    
    if (firstPersonResult.success) {
      console.log('✅ First person created, redirecting to tree...')
      // Redirect to tree page
      window.location.href = `tree.html?code=${treeCode}`
    } else {
      console.error('❌ Error creating initial person:', firstPersonResult.error)
      showError('Error creating initial person. Please try again.')
      confirmCreateBtn.disabled = false
      confirmCreateBtn.textContent = 'Create Tree'
    }
  } else {
    console.error('❌ Error creating tree:', result.error)
    showError('Error creating tree. Please try again.')
    confirmCreateBtn.disabled = false
    confirmCreateBtn.textContent = 'Create Tree'
  }
})

// Enter key on tree name input
treeNameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    confirmCreateBtn.click()
  }
})

console.log('✅ Landing page event listeners attached')
