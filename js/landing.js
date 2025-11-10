import { createFamilyTree, getFamilyTreeByCode, createFamilyMember } from './supabase-client.js'

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
  errorMessage.textContent = message
  errorMessage.classList.add('show')
  setTimeout(() => {
    errorMessage.classList.remove('show')
  }, 4000)
}

// View existing tree
viewTreeBtn.addEventListener('click', async () => {
  const code = treeCodeInput.value.trim().toUpperCase()
  
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
  
  const result = await getFamilyTreeByCode(code)
  
  if (result.success) {
    // Redirect to tree page with code
    window.location.href = `tree.html?code=${code}`
  } else {
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
  const treeName = treeNameInput.value.trim()
  
  if (!treeName) {
    showError('Please enter a family tree name')
    return
  }
  
  confirmCreateBtn.disabled = true
  confirmCreateBtn.textContent = 'Creating...'
  
  const result = await createFamilyTree(treeName)
  
  if (result.success) {
    const treeId = result.data.id
    const treeCode = result.treeCode
    
    // Create the first person (main person) with name "Name"
    const firstPersonResult = await createFamilyMember({
      tree_id: treeId,
      first_name: 'Name',
      last_name: '',
      birthday: null,
      death: null,
      gender: null,
      is_main: true
    })
    
    if (firstPersonResult.success) {
      // Redirect to tree page
      window.location.href = `tree.html?code=${treeCode}`
    } else {
      showError('Error creating initial person. Please try again.')
      confirmCreateBtn.disabled = false
      confirmCreateBtn.textContent = 'Create Tree'
    }
  } else {
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
