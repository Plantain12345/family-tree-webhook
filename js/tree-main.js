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

// -----------------------------------------------------------------------------
// Constants & shared state
// -----------------------------------------------------------------------------

const FIRST_PERSON_DEFAULT_GENDER = 'M'

const ADD_LABELS = {
  parent: 'Add Parent',
  child: 'Add Child',
  partner: 'Add Partner'
}

const SELECTORS = {
  card: '.card',
  addBubble: '.card_add_relative',
  addCard: '.card_add',
  editButton: '.card_edit',
  formContainer: '.f3-form-cont.opened',
  form: 'form',
  formDeleteButton: '.f3-delete-btn',
  formCloseButton: '.f3-close-btn',
  relationshipTypeSelect: '.relationship-type-select'
}

const state = {
  treeId: null,
  treeCode: null,
  chart: null,
  editApi: null,
  members: [],
  parentChildRels: [],
  spousalRels: [],
  isSaving: false,
  saveTimer: null,
  listenersRegistered: false,
  activeCardElement: null
}

initializePage()

// -----------------------------------------------------------------------------
// Initialisation & data loading
// -----------------------------------------------------------------------------

function initializePage() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')

  if (!code) {
    window.location.href = 'index.html'
    return
  }

  document.getElementById('copyCodeBtn')?.addEventListener('click', handleCopyTreeCode)

  window.addEventListener('load', () => {
    if (window.f3) initializeTree(code)
    else alert('Error loading library. Please refresh.')
  })
}

async function initializeTree(code) {
  try {
    toggleLoading(true)

    const result = await getFamilyTreeByCode(code)
    if (!result.success) {
      alert('Tree not found!')
      window.location.href = 'index.html'
      return
    }

    const tree = result.data
    state.treeId = tree.id
    state.treeCode = tree.tree_code

    document.getElementById('treeName').textContent = tree.tree_name
    document.getElementById('treeCodeDisplay').textContent = tree.tree_code

    await loadTreeData()
    setupRealtimeSync(state.treeId, () => {
      if (!state.isSaving) loadTreeData()
    })
  } catch (error) {
    console.error('Init error:', error)
  } finally {
    toggleLoading(false)
  }
}

async function loadTreeData() {
  try {
    const [memberRes, pcRes, spRes] = await Promise.all([
      getFamilyMembers(state.treeId),
      getParentChildRelationships(state.treeId),
      getSpousalRelationships(state.treeId)
    ])

    state.members = memberRes.data || []
    state.parentChildRels = pcRes.data || []
    state.spousalRels = spRes.data || []

    const chartData = transformDatabaseToFamilyChart(
      state.members,
      state.parentChildRels,
      state.spousalRels
    )

    renderTree(chartData)
  } catch (error) {
    console.error('Load error:', error)
  }
}

// -----------------------------------------------------------------------------
// Chart creation & updates
// -----------------------------------------------------------------------------

function renderTree(chartData) {
  if (!state.chart) {
    state.chart = createChart(chartData)
    window.f3Chart = state.chart
  } else {
    configureGlobalAddLabels()
    exitAddMode()
    state.chart.updateData(chartData)
    const mainId = findMainPersonId(state.members)
    if (mainId) state.chart.updateMainId(mainId)
    state.chart.updateTree({ initial: false })
    hideAllAddButtons()
  }
}

function createChart(chartData) {
  configureGlobalAddLabels()

  const chart = window.f3.createChart('#FamilyChart', chartData)
    .setTransitionTime(1000)
    .setCardXSpacing(250)
    .setCardYSpacing(150)

  chart
    .setCardHtml()
    .setCardDisplay([
      ['first name', 'last name'],
      (d) => {
        const birth = d.data['birthday'] || ''
        const death = d.data['death'] || ''
        if (birth && death) return `${birth} - ${death}`
        if (birth) return birth
        if (death) return `- ${death}`
        return ''
      }
    ])

  state.editApi = chart.editTree()
    .setFields(['first name', 'last name', 'birthday', 'death'])
    .setEditFirst(false)

  applyAddButtonLabels(state.editApi)

  const mainId = findMainPersonId(state.members)
  if (mainId) chart.updateMainId(mainId)

  chart.updateTree({ initial: true })
  hideAllAddButtons()
  setupGlobalHandlers()

  return chart
}

function applyAddButtonLabels(editApi) {
  if (!editApi) return

  if (typeof editApi.setAddLabels === 'function') {
    editApi.setAddLabels({
      father: ADD_LABELS.parent,
      mother: ADD_LABELS.parent,
      son: ADD_LABELS.child,
      daughter: ADD_LABELS.child,
      spouse: ADD_LABELS.partner
    })
  }

  if (typeof editApi.setAddParentLabel === 'function') {
    editApi.setAddParentLabel(ADD_LABELS.parent)
  }
  if (typeof editApi.setAddChildLabel === 'function') {
    editApi.setAddChildLabel(ADD_LABELS.child)
  }
  if (typeof editApi.setAddSpouseLabel === 'function') {
    editApi.setAddSpouseLabel(ADD_LABELS.partner)
  }
}

function configureGlobalAddLabels() {
  const dictionaries = [
    window.f3?.strings,
    window.f3?.language?.strings,
    window.f3?.edit?.strings
  ].filter(Boolean)

  if (dictionaries.length === 0) return

  const replacements = [
    ['addFather', ADD_LABELS.parent],
    ['addMother', ADD_LABELS.parent],
    ['addSon', ADD_LABELS.child],
    ['addDaughter', ADD_LABELS.child],
    ['addSpouse', ADD_LABELS.partner],
    ['Add Father', ADD_LABELS.parent],
    ['Add Mother', ADD_LABELS.parent],
    ['Add Son', ADD_LABELS.child],
    ['Add Daughter', ADD_LABELS.child],
    ['Add Spouse', ADD_LABELS.partner]
  ]

  dictionaries.forEach(dict => {
    replacements.forEach(([key, value]) => {
      if (dict[key] !== undefined) dict[key] = value
    })
  })
}

// -----------------------------------------------------------------------------
// Interaction handling
// -----------------------------------------------------------------------------

function setupGlobalHandlers() {
  if (state.listenersRegistered) return
  state.listenersRegistered = true

  const chartContainer = document.getElementById('FamilyChart')
  if (chartContainer) {
    chartContainer.addEventListener('click', handleChartClick)
  }

  document.addEventListener('click', handleDocumentClick, true)
  document.addEventListener('submit', handleFormSubmit, true)
  document.addEventListener('click', handleFormOpenTriggers, true)
}

function handleChartClick(event) {
  const addBubble = event.target.closest(SELECTORS.addBubble)
  if (addBubble) {
    queueMicrotask(prepareActiveForm)
    return
  }

  const card = event.target.closest(SELECTORS.card)
  if (!card) return

  event.stopPropagation()
  enterAddMode(card)
  openFormForCard(card)
}

function handleFormOpenTriggers(event) {
  if (
    event.target.closest(SELECTORS.addCard) ||
    event.target.closest(SELECTORS.addBubble) ||
    event.target.closest(SELECTORS.editButton)
  ) {
    queueMicrotask(prepareActiveForm)
  }
}

function handleDocumentClick(event) {
  if (event.target.matches(SELECTORS.formDeleteButton)) {
    queueMicrotask(scheduleSave)
    return
  }

  if (event.target.matches(SELECTORS.formCloseButton)) {
    queueMicrotask(exitAddMode)
    return
  }

  const clickedCard = event.target.closest(SELECTORS.card)
  const clickedForm = event.target.closest('.f3-form-cont')
  const clickedAddBubble = event.target.closest(SELECTORS.addBubble)
  const clickedAddCard = event.target.closest(SELECTORS.addCard)

  if (!clickedCard && !clickedForm && !clickedAddBubble && !clickedAddCard) {
    exitAddMode()
  }
}

function enterAddMode(card) {
  if (!card) return

  if (state.activeCardElement === card) {
    toggleRelativeButtons(card, true)
    return
  }

  exitAddMode()
  state.activeCardElement = card
  card.classList.add('f3-card-active')
  toggleRelativeButtons(card, true)
}

function exitAddMode() {
  if (state.activeCardElement) {
    toggleRelativeButtons(state.activeCardElement, false)
    state.activeCardElement.classList.remove('f3-card-active')
    state.activeCardElement = null
  }
  hideAllAddButtons()
  closeOpenForm()
}

function hideAllAddButtons() {
  document.querySelectorAll(SELECTORS.addBubble).forEach(btn => {
    btn.style.opacity = '0'
    btn.style.pointerEvents = 'none'
  })
}

function toggleRelativeButtons(card, show) {
  card.querySelectorAll(SELECTORS.addBubble).forEach(btn => {
    btn.style.opacity = show ? '1' : '0'
    btn.style.pointerEvents = show ? 'auto' : 'none'
  })
}

function openFormForCard(card) {
  const editButton = card.querySelector(SELECTORS.editButton)
  if (!editButton) return

  editButton.dispatchEvent(new Event('click', { bubbles: true }))
  queueMicrotask(prepareActiveForm)
}

function closeOpenForm() {
  const formContainer = document.querySelector(SELECTORS.formContainer)
  if (!formContainer) return
  const closeBtn = formContainer.querySelector(SELECTORS.formCloseButton)
  if (closeBtn) closeBtn.click()
}

// -----------------------------------------------------------------------------
// Form preparation & validation
// -----------------------------------------------------------------------------

function handleFormSubmit(event) {
  if (event.target.id !== 'familyForm') return

  event.preventDefault()
  if (!validateYearFields(event.target)) return

  const relationshipSelect = event.target.querySelector(SELECTORS.relationshipTypeSelect)
  if (relationshipSelect) {
    window.lastRelationshipType = relationshipSelect.value
  }

  queueMicrotask(scheduleSave)
}

function prepareActiveForm() {
  const formContainer = document.querySelector(SELECTORS.formContainer)
  if (!formContainer) return

  const form = formContainer.querySelector(SELECTORS.form)
  if (!form) return

  form.id = 'familyForm'

  if (!form.dataset.prepared) {
    configureYearInputs(form)
    configureGenderField(form)
    hideRemoveRelationship(form)
    form.dataset.prepared = 'true'
  }

  ensureRelationshipTypeSelector(form)
  renameYearLabels(form)
  applyDefaultGenderIfNeeded(form)
}

function configureYearInputs(form) {
  ['birthday', 'death'].forEach(name => {
    const input = form.querySelector(`input[name="${name}"]`)
    if (!input || input.dataset.prepared) return

    input.dataset.prepared = 'true'
    input.type = 'text'
    input.maxLength = 4
    input.placeholder = 'YYYY'
    input.pattern = '[0-9]{4}'

    input.addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/[^0-9]/g, '')
    })

    input.addEventListener('keypress', (event) => {
      if (!/[0-9]/.test(event.key)) event.preventDefault()
    })
  })
}

function configureGenderField(form) {
  const textInput = form.querySelector('input[name="gender"][type="text"]')
  if (!textInput) return

  const genderField = textInput.closest('.f3-form-field')
  if (genderField) genderField.style.display = 'none'

  form.querySelectorAll('input[name="gender"][type="radio"]').forEach(radio => {
    if (radio.dataset.bound) return
    radio.dataset.bound = 'true'
    radio.addEventListener('change', () => {
      textInput.value = radio.value
    })
  })
}

function hideRemoveRelationship(form) {
  const removeBtn = form.querySelector('.f3-remove-relative-btn')
  if (removeBtn) removeBtn.style.display = 'none'
}

function ensureRelationshipTypeSelector(form) {
  const title = form.querySelector('.f3-form-title')
  if (!title) return

  const isPartnerForm = /partner|spouse/i.test(title.textContent)
  if (!isPartnerForm) return

  if (!form.querySelector('.relationship-type-selector')) {
    const wrapper = document.createElement('div')
    wrapper.className = 'f3-form-field relationship-type-selector'
    wrapper.innerHTML = `
      <label>Relationship Type</label>
      <select name="relationship_type" class="relationship-type-select">
        <option value="married">Married</option>
        <option value="partner">Partner</option>
        <option value="divorced">Divorced</option>
        <option value="separated">Separated</option>
      </select>
    `

    const radioGroup = form.querySelector('.f3-radio-group')
    if (radioGroup?.parentNode) {
      radioGroup.parentNode.insertBefore(wrapper, radioGroup.nextSibling)
    }
  }

  const select = form.querySelector(SELECTORS.relationshipTypeSelect)
  if (select && !select.dataset.bound) {
    select.dataset.bound = 'true'
    select.addEventListener('change', () => {
      window.lastRelationshipType = select.value
    })
  }

  if (select && window.lastRelationshipType) {
    select.value = window.lastRelationshipType
  }
}

function renameYearLabels(form) {
  setFieldLabel(form, 'birthday', 'Year of birth')
  setFieldLabel(form, 'death', 'Year of death')
}

function setFieldLabel(form, fieldName, labelText) {
  const input = form.querySelector(`input[name="${fieldName}"]`)
  if (!input) return

  const label = form.querySelector(`label[for="${input.id}"]`) ||
    input.closest('.f3-form-field')?.querySelector('label')

  if (label) label.textContent = labelText
}

function applyDefaultGenderIfNeeded(form) {
  if (state.members.length > 0) return

  const maleRadio = form.querySelector('input[name="gender"][type="radio"][value="M"]')
  const genderText = form.querySelector('input[name="gender"][type="text"]')
  if (!maleRadio) return

  if (!maleRadio.checked) {
    maleRadio.checked = true
    maleRadio.dispatchEvent(new Event('change', { bubbles: true }))
  }

  if (genderText) genderText.value = FIRST_PERSON_DEFAULT_GENDER
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
    const yearNum = Number.parseInt(year, 10)
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
    const yearNum = Number.parseInt(year, 10)
    if (yearNum < 1000 || yearNum > 9999) {
      alert('Year of death must be between 1000 and 9999')
      deathInput.focus()
      return false
    }

    if (birthdayInput && birthdayInput.value) {
      const birthYear = Number.parseInt(birthdayInput.value, 10)
      if (yearNum < birthYear) {
        alert('Year of death cannot be before year of birth')
        deathInput.focus()
        return false
      }
    }
  }

  return true
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

function scheduleSave() {
  if (state.saveTimer) clearTimeout(state.saveTimer)
  state.saveTimer = setTimeout(() => syncToDatabase(), 1000)
}

async function syncToDatabase() {
  if (state.isSaving) return
  state.isSaving = true

  try {
    const chartData = state.chart.store.getData()
    const chartIds = new Set(chartData.map(item => item.id))
    const dbIds = new Set(state.members.map(member => member.id))

    const newIds = [...chartIds].filter(id => !dbIds.has(id))
    const deletedIds = [...dbIds].filter(id => !chartIds.has(id))
    const existingIds = [...chartIds].filter(id => dbIds.has(id))

    for (const id of deletedIds) {
      const relatedParents = state.parentChildRels.filter(rel => rel.parent_id === id || rel.child_id === id)
      const relatedSpouses = state.spousalRels.filter(rel => rel.person1_id === id || rel.person2_id === id)

      for (const rel of relatedParents) {
        await deleteParentChildRelationship(rel.parent_id, rel.child_id)
      }
      for (const rel of relatedSpouses) {
        await deleteSpousalRelationship(rel.person1_id, rel.person2_id)
      }

      await deleteFamilyMember(id)
    }

    for (const id of newIds) {
      const person = chartData.find(datum => datum.id === id)
      if (!person) continue

      await createFamilyMember({
        id,
        tree_id: state.treeId,
        first_name: person.data['first name'] || '',
        last_name: person.data['last name'] || '',
        birthday: person.data['birthday'] ? Number.parseInt(person.data['birthday'], 10) : null,
        death: person.data['death'] ? Number.parseInt(person.data['death'], 10) : null,
        gender: person.data['gender'] || null,
        is_main: false
      })
    }

    for (const id of existingIds) {
      const chartPerson = chartData.find(datum => datum.id === id)
      const dbPerson = state.members.find(member => member.id === id)
      if (!chartPerson || !dbPerson) continue

      const updates = {
        first_name: chartPerson.data['first name'] || '',
        last_name: chartPerson.data['last name'] || '',
        birthday: chartPerson.data['birthday'] ? Number.parseInt(chartPerson.data['birthday'], 10) : null,
        death: chartPerson.data['death'] ? Number.parseInt(chartPerson.data['death'], 10) : null,
        gender: chartPerson.data['gender'] || null
      }

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

    const membersResult = await getFamilyMembers(state.treeId)
    if (membersResult.success) state.members = membersResult.data

    await syncRelationships(chartData)

    const pcResult = await getParentChildRelationships(state.treeId)
    if (pcResult.success) state.parentChildRels = pcResult.data

    const spResult = await getSpousalRelationships(state.treeId)
    if (spResult.success) state.spousalRels = spResult.data
  } catch (error) {
    console.error('Sync error:', error)
  } finally {
    state.isSaving = false
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

  for (const target of targetParentChild) {
    const exists = state.parentChildRels.find(rel =>
      rel.parent_id === target.parent_id && rel.child_id === target.child_id
    )
    if (!exists) {
      const result = await createParentChildRelationship(state.treeId, target.parent_id, target.child_id)
      if (result.success && result.data) state.parentChildRels.push(result.data)
    }
  }

  for (const existing of state.parentChildRels) {
    const shouldExist = targetParentChild.find(target =>
      target.parent_id === existing.parent_id && target.child_id === existing.child_id
    )
    if (!shouldExist) {
      await deleteParentChildRelationship(existing.parent_id, existing.child_id)
    }
  }

  for (const target of targetSpousal) {
    const exists = state.spousalRels.find(rel =>
      (rel.person1_id === target.p1 && rel.person2_id === target.p2) ||
      (rel.person1_id === target.p2 && rel.person2_id === target.p1)
    )
    if (!exists) {
      const relType = window.lastRelationshipType || 'married'
      const result = await createSpousalRelationship(state.treeId, target.p1, target.p2, relType)
      if (result.success && result.data) state.spousalRels.push(result.data)
      window.lastRelationshipType = null
    }
  }

  for (const existing of state.spousalRels) {
    const shouldExist = targetSpousal.find(target =>
      (target.p1 === existing.person1_id && target.p2 === existing.person2_id) ||
      (target.p1 === existing.person2_id && target.p2 === existing.person1_id)
    )
    if (!shouldExist) {
      await deleteSpousalRelationship(existing.person1_id, existing.person2_id)
    }
  }
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function handleCopyTreeCode() {
  if (!state.treeCode) return

  navigator.clipboard.writeText(state.treeCode)
  const btn = document.getElementById('copyCodeBtn')
  if (!btn) return

  const original = btn.textContent
  btn.textContent = '✓'
  setTimeout(() => {
    btn.textContent = original
  }, 2000)
}

function toggleLoading(show) {
  const overlay = document.getElementById('loadingOverlay')
  if (!overlay) return
  overlay.classList.toggle('hidden', !show)
}
