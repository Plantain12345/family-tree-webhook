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
  deleteSpousalRelationship,
  updateSpousalRelationship // Ensure this is imported
} from './supabase-client.js'

import {
  transformDatabaseToFamilyChart,
  findMainPersonId,
  getRelationshipType // Ensure this is imported
} from './tree-data.js'

import { setupRealtimeSync } from './tree-sync.js'

// -----------------------------------------------------------------------------
// Constants & shared state
// -----------------------------------------------------------------------------

const FIRST_PERSON_DEFAULT_GENDER = 'M'

// REQUIREMENT #1: Define permanent labels
const ADD_LABELS = {
  parent: 'Add Parent',
  child: 'Add Child',
  partner: 'Add Partner'
}

const SELECTORS = {
  form: '#familyForm', // REQUIREMENT #5: Use stable form ID
  formDeleteButton: '.f3-delete-btn',
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
    window.f3Chart = state.chart // For debugging
  } else {
    // On data refresh, update data and main ID, then redraw
    state.chart.updateData(chartData)
    const mainId = findMainPersonId(state.members)
    if (mainId) state.chart.updateMainId(mainId)
    state.chart.updateTree({ initial: false })
  }
}

function createChart(chartData) {
  const chart = window.f3.createChart('#FamilyChart', chartData)
    .setTransitionTime(1000)
    .setCardXSpacing(250)
    .setCardYSpacing(150)

  // Set card rendering
  const f3Card = chart
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

  // Setup edit functionality
  state.editApi = chart.editTree()
    .setFields(['first name', 'last name', 'birthday', 'death'])
    // REQUIREMENT #3: Open form and show + bubbles on card click
    .setEditFirst(true)
    // REQUIREMENT #3 & #4: Use library's click handler
    .setCardClickOpen(f3Card)
    // REQUIREMENT #1 & #5: Hook into form creation
    .setOnFormCreation((props) => {
      const { cont } = props; // 'cont' is the form container element
      const form = cont.querySelector('form');
      if (form) {
        form.id = SELECTORS.form.substring(1); // REQUIREMENT #5
        
        // Run all form configuration functions
        configureForm(form);
      }
    })
    // Hook into form submission for validation and saving
    .setOnSubmit((e, datum, applyChanges, postSubmit) => {
      e.preventDefault(); 
      const form = e.target;
      
      if (!validateYearFields(form)) return; // Custom validation

      // Store last selected relationship type
      const relationshipSelect = form.querySelector(SELECTORS.relationshipTypeSelect);
      if (relationshipSelect) {
        window.lastRelationshipType = relationshipSelect.value;
      }

      applyChanges(); // Apply changes to library's internal store
      postSubmit();   // Run library's post-submit logic (closes form, updates history)
      
      scheduleSave(); // Schedule a save to database
    })
    // Hook into person deletion for saving
    .setOnDelete((datum, deletePerson, postSubmit) => {
      deletePerson(); // Tell library to delete
      postSubmit({ delete: true }); // Run library's post-delete logic
      scheduleSave(); // Schedule a save to database
    });

  // REQUIREMENT #1: Apply permanent labels via the API
  applyAddButtonLabels(state.editApi);

  // Set initial main person
  const mainId = findMainPersonId(state.members);
  if (mainId) chart.updateMainId(mainId);

  // Render the tree
  chart.updateTree({ initial: true });

  return chart;
}

/**
 * REQUIREMENT #1: Apply permanent labels using the library's API
 */
function applyAddButtonLabels(editApi) {
  if (!editApi) return;

  // This is the primary API method
  if (typeof editApi.setAddRelLabels === 'function') {
    editApi.setAddRelLabels({
      father: ADD_LABELS.parent,
      mother: ADD_LABELS.parent,
      son: ADD_LABELS.child,
      daughter: ADD_LABELS.child,
      spouse: ADD_LABELS.partner
    });
  } else {
    // Fallbacks just in case (as in your original code)
    if (typeof editApi.setAddParentLabel === 'function') {
      editApi.setAddParentLabel(ADD_LABELS.parent);
    }
    if (typeof editApi.setAddChildLabel === 'function') {
      editApi.setAddChildLabel(ADD_LABELS.child);
    }
    if (typeof editApi.setAddSpouseLabel === 'function') {
      editApi.setAddSpouseLabel(ADD_LABELS.partner);
    }
  }
}

// -----------------------------------------------------------------------------
// Form preparation & validation (Called by .setOnFormCreation)
// -----------------------------------------------------------------------------

/**
 * Main function to configure the form when it's created by the library
 */
function configureForm(form) {
  if (!form || form.dataset.prepared) return;

  configureYearInputs(form);
  configureGenderField(form);
  hideRemoveRelationship(form);
  ensureRelationshipTypeSelector(form);
  renameYearLabels(form);
  applyDefaultGenderIfNeeded(form); // REQUIREMENT #2

  form.dataset.prepared = 'true';
}

function configureYearInputs(form) {
  ['birthday', 'death'].forEach(name => {
    const input = form.querySelector(`input[name="${name}"]`);
    if (!input) return;

    input.type = 'text';
    input.maxLength = 4;
    input.placeholder = 'YYYY';
    input.pattern = '[0-9]{4}';

    input.addEventListener('input', (event) => {
      event.target.value = event.target.value.replace(/[^0-9]/g, '');
    });

    input.addEventListener('keypress', (event) => {
      if (!/[0-9]/.test(event.key)) event.preventDefault();
    });
  });
}

function configureGenderField(form) {
  const textInput = form.querySelector('input[name="gender"][type="text"]');
  if (!textInput) return;

  const genderField = textInput.closest('.f3-form-field');
  if (genderField) genderField.style.display = 'none';

  form.querySelectorAll('input[name="gender"][type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      textInput.value = radio.value;
    });
  });
}

function hideRemoveRelationship(form) {
  // This button is for removing a *specific* relationship, not deleting a person.
  // We handle deletion via the .f3-delete-btn, so we hide this.
  const removeBtn = form.querySelector('.f3-remove-relative-btn');
  if (removeBtn) removeBtn.style.display = 'none';
}

function ensureRelationshipTypeSelector(form) {
  const title = form.querySelector('.f3-form-title');
  if (!title) return;

  const isPartnerForm = /partner|spouse/i.test(title.textContent);
  
  // Find the person ID from the form creator data (stored by the library)
  const formCont = form.closest('.f3-form-cont');
  const datum = formCont?.__f3_form_creator__?.datum;

  // Check if it's an *existing* partner
  const isExistingPartner = datum && state.members.find(m => m.id === datum.id) &&
                            (datum.rels?.spouses?.length > 0 || /partner|spouse/i.test(datum._new_rel_data?.rel_type));

  if (!isPartnerForm && !isExistingPartner) return;

  if (!form.querySelector('.relationship-type-selector')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'f3-form-field relationship-type-selector';
    wrapper.innerHTML = `
      <label>Relationship Type</label>
      <select name="relationship_type" class="relationship-type-select">
        <option value="married">Married</option>
        <option value="partner">Partner</option>
        <option value="divorced">Divorced</option>
        <option value="separated">Separated</option>
      </select>
    `;

    const radioGroup = form.querySelector('.f3-radio-group');
    if (radioGroup?.parentNode) {
      radioGroup.parentNode.insertBefore(wrapper, radioGroup.nextSibling);
    }
  }

  // Pre-select the current relationship type if editing an existing relationship
  if (datum && !datum._new_rel_data) {
    const mainPerson = state.chart.store.getMainDatum();
    const relType = getRelationshipType(datum, mainPerson, state.spousalRels);
    const select = form.querySelector(SELECTORS.relationshipTypeSelect);
    if (select) select.value = relType;
  }
}

function renameYearLabels(form) {
  setFieldLabel(form, 'birthday', 'Year of birth');
  setFieldLabel(form, 'death', 'Year of death');
}

function setFieldLabel(form, fieldName, labelText) {
  const input = form.querySelector(`input[name="${fieldName}"]`);
  if (!input) return;

  const label = form.querySelector(`label[for="${input.id}"]`) ||
    input.closest('.f3-form-field')?.querySelector('label');

  if (label) label.textContent = labelText;
}

/**
 * REQUIREMENT #2: Apply default gender if this is the very first person.
 */
function applyDefaultGenderIfNeeded(form) {
  // This logic runs if the tree is loaded with 0 members.
  if (state.members.length > 0) return;

  const maleRadio = form.querySelector('input[name="gender"][type="radio"][value="M"]');
  const genderText = form.querySelector('input[name="gender"][type="text"]');
  
  if (maleRadio && !maleRadio.checked) {
    maleRadio.checked = true;
    maleRadio.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (genderText) genderText.value = FIRST_PERSON_DEFAULT_GENDER;
}

function validateYearFields(form) {
  const birthdayInput = form.querySelector('input[name="birthday"]');
  const deathInput = form.querySelector('input[name="death"]');

  if (birthdayInput && birthdayInput.value) {
    const year = birthdayInput.value.trim();
    if (!/^\d{4}$/.test(year)) {
      alert('Year of birth must be exactly 4 digits (e.g., 1990)');
      birthdayInput.focus();
      return false;
    }
    const yearNum = Number.parseInt(year, 10);
    if (yearNum < 1000 || yearNum > 9999) {
      alert('Year of birth must be between 1000 and 9999');
      birthdayInput.focus();
      return false;
    }
  }

  if (deathInput && deathInput.value) {
    const year = deathInput.value.trim();
    if (!/^\d{4}$/.test(year)) {
      alert('Year of death must be exactly 4 digits (e.g., 2020)');
      deathInput.focus();
      return false;
    }
    const yearNum = Number.parseInt(year, 10);
    if (yearNum < 1000 || yearNum > 9999) {
      alert('Year of death must be between 1000 and 9999');
      deathInput.focus();
      return false;
    }

    if (birthdayInput && birthdayInput.value) {
      const birthYear = Number.parseInt(birthdayInput.value, 10);
      if (yearNum < birthYear) {
        alert('Year of death cannot be before year of birth');
        deathInput.focus();
        return false;
      }
    }
  }

  return true;
}

// -----------------------------------------------------------------------------
// Persistence (Scheduled from .setOnSubmit and .setOnDelete)
// -----------------------------------------------------------------------------

function scheduleSave() {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => syncToDatabase(), 1000);
}

async function syncToDatabase() {
  if (state.isSaving) return;
  state.isSaving = true;
  console.log('Syncing to database...');

  try {
    const chartData = state.chart.store.getData();
    const chartIds = new Set(chartData.map(item => item.id));
    const dbIds = new Set(state.members.map(member => member.id));

    const newIds = [...chartIds].filter(id => !dbIds.has(id));
    const deletedIds = [...dbIds].filter(id => !chartIds.has(id));
    const existingIds = [...chartIds].filter(id => dbIds.has(id));

    // 1. Delete members
    for (const id of deletedIds) {
      // Must delete relationships first due to foreign key constraints
      const relatedParents = state.parentChildRels.filter(rel => rel.parent_id === id || rel.child_id === id);
      const relatedSpouses = state.spousalRels.filter(rel => rel.person1_id === id || rel.person2_id === id);

      for (const rel of relatedParents) {
        await deleteParentChildRelationship(rel.parent_id, rel.child_id);
      }
      for (const rel of relatedSpouses) {
        await deleteSpousalRelationship(rel.person1_id, rel.person2_id);
      }

      await deleteFamilyMember(id);
    }

    // 2. Create new members
    for (const id of newIds) {
      const person = chartData.find(datum => datum.id === id);
      if (!person) continue;

      await createFamilyMember({
        id,
        tree_id: state.treeId,
        first_name: person.data['first name'] || '',
        last_name: person.data['last name'] || '',
        birthday: person.data['birthday'] ? Number.parseInt(person.data['birthday'], 10) : null,
        death: person.data['death'] ? Number.parseInt(person.data['death'], 10) : null,
        gender: person.data['gender'] || null,
        is_main: false // We don't track 'is_main' this way anymore
      });
    }

    // 3. Update existing members
    for (const id of existingIds) {
      const chartPerson = chartData.find(datum => datum.id === id);
      const dbPerson = state.members.find(member => member.id === id);
      if (!chartPerson || !dbPerson) continue;

      const updates = {
        first_name: chartPerson.data['first name'] || '',
        last_name: chartPerson.data['last name'] || '',
        birthday: chartPerson.data['birthday'] ? Number.parseInt(chartPerson.data['birthday'], 10) : null,
        death: chartPerson.data['death'] ? Number.parseInt(chartPerson.data['death'], 10) : null,
        gender: chartPerson.data['gender'] || null
      };

      const changed =
        updates.first_name !== dbPerson.first_name ||
        updates.last_name !== dbPerson.last_name ||
        updates.birthday !== dbPerson.birthday ||
        updates.death !== dbPerson.death ||
        updates.gender !== dbPerson.gender;

      if (changed) {
        await updateFamilyMember(id, updates);
      }
    }

    // 4. Reload members from DB (to have correct state for relationship sync)
    const membersResult = await getFamilyMembers(state.treeId);
    if (membersResult.success) state.members = membersResult.data;

    // 5. Sync relationships
    await syncRelationships(chartData);

    // 6. Reload relationships from DB
    const pcResult = await getParentChildRelationships(state.treeId);
    if (pcResult.success) state.parentChildRels = pcResult.data;

    const spResult = await getSpousalRelationships(state.treeId);
    if (spResult.success) state.spousalRels = spResult.data;

  } catch (error) {
    console.error('Sync error:', error);
  } finally {
    state.isSaving = false;
    console.log('Sync complete.');
  }
}

async function syncRelationships(chartData) {
  const targetParentChild = [];
  const targetSpousal = [];
  const chartSpousalRels = new Map(); // Store rel types

  for (const person of chartData) {
    // Use the 'parents' array from the new library format
    const { parents, spouses } = person.rels || {};

    if (parents) {
      for (const parentId of parents) {
        targetParentChild.push({ parent_id: parentId, child_id: person.id });
      }
    }

    if (spouses) {
      for (const spouseId of spouses) {
        if (person.id < spouseId) {
          const key = `${person.id}-${spouseId}`;
          targetSpousal.push({ p1: person.id, p2: spouseId });
          
          // Determine relationship type
          let relType = 'married'; // Default
          if (window.lastRelationshipType) {
            relType = window.lastRelationshipType;
            window.lastRelationshipType = null; // Consume it
          } else {
            // Check existing DB state
            relType = getRelationshipType(person, { id: spouseId }, state.spousalRels);
          }
          chartSpousalRels.set(key, relType);
        }
      }
    }
  }

  // Sync Parent-Child Relationships
  const dbParentChild = new Set(state.parentChildRels.map(rel => `${rel.parent_id}-${rel.child_id}`));
  const chartParentChild = new Set(targetParentChild.map(rel => `${rel.parent_id}-${rel.child_id}`));

  // Create new PC rels
  for (const rel of targetParentChild) {
    if (!dbParentChild.has(`${rel.parent_id}-${rel.child_id}`)) {
      await createParentChildRelationship(state.treeId, rel.parent_id, rel.child_id);
    }
  }

  // Delete old PC rels
  for (const rel of state.parentChildRels) {
    if (!chartParentChild.has(`${rel.parent_id}-${rel.child_id}`)) {
      await deleteParentChildRelationship(rel.parent_id, rel.child_id);
    }
  }

  // Sync Spousal Relationships
  const dbSpousal = new Map(state.spousalRels.map(rel => {
    const key = rel.person1_id < rel.person2_id ? `${rel.person1_id}-${rel.person2_id}` : `${rel.person2_id}-${rel.person1_id}`;
    return [key, rel];
  }));
  const chartSpousal = new Set(targetSpousal.map(rel => `${rel.p1}-${rel.p2}`));

  // Create new / update existing Spousal rels
  for (const rel of targetSpousal) {
    const key = `${rel.p1}-${rel.p2}`;
    const chartRelType = chartSpousalRels.get(key) || 'married';
    const dbRel = dbSpousal.get(key);

    if (!dbRel) {
      // Create new
      await createSpousalRelationship(state.treeId, rel.p1, rel.p2, chartRelType);
    } else if (dbRel.relationship_type !== chartRelType) {
      // Update existing
      await updateSpousalRelationship(dbRel.id, chartRelType);
    }
  }

  // Delete old Spousal rels
  for (const [key, dbRel] of dbSpousal.entries()) {
    if (!chartSpousal.has(key)) {
      await deleteSpousalRelationship(dbRel.person1_id, dbRel.person2_id);
    }
  }
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function handleCopyTreeCode() {
  if (!state.treeCode) return;

  navigator.clipboard.writeText(state.treeCode);
  const btn = document.getElementById('copyCodeBtn');
  if (!btn) return;

  const original = btn.textContent;
  btn.textContent = '✓';
  setTimeout(() => {
    btn.textContent = original;
  }, 2000);
}

function toggleLoading(show) {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  overlay.classList.toggle('hidden', !show);
}
