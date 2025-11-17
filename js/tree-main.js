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
  updateSpousalRelationship
} from './supabase-client.js'

import {
  transformDatabaseToFamilyChart,
  findMainPersonId,
  getRelationshipType
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
  form: '#familyForm',
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
  document.getElementById('showFullTreeBtn')?.addEventListener('click', handleShowFullTree);

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

  const f3Card = chart
    .setCardHtml()
    .setCardDisplay([
      ['first name', 'last name'],
      // Date Range
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
    .setEditFirst(true) 
    .setOnFormCreation((props) => {
      const { cont, form_creator } = props; 
      const form = cont.querySelector('form');
      if (form) {
        form.id = SELECTORS.form.substring(1);
        configureForm(form, form_creator.datum_id); // Pass datum_id
      }
    })
    .setOnSubmit(async (e, datum, applyChanges, postSubmit) => {
      e.preventDefault(); 
      const form = e.target;
      
      if (!validateYearFields(form)) return;

      // Handle relationship type updates BEFORE submitting
      const relSelects = form.querySelectorAll('.relationship-type-select-existing');
      for (const select of relSelects) {
        const relId = select.dataset.relId;
        const newType = select.value;
        const dbRel = state.spousalRels.find(r => r.id === relId);
        
        if (dbRel && dbRel.relationship_type !== newType) {
          console.log(`Updating relationship ${relId} to ${newType}`);
          await updateSpousalRelationship(relId, newType);
        }
      }
      
      // Handle new relationship type
      const newRelSelect = form.querySelector('.relationship-type-selector-new select');
      if (newRelSelect) {
        window.lastRelationshipType = newRelSelect.value;
      }

      applyChanges(); 
      postSubmit();   
      scheduleSave(); 
    })
    .setOnDelete((datum, deletePerson, postSubmit) => {
      deletePerson(); 
      postSubmit({ delete: true }); 
      scheduleSave(); 
    });

  applyAddButtonLabels(state.editApi);

  f3Card.setOnCardClick((e, d) => {
    // When clicking a "Add Partner/Parent/Child" card
    if (d.data._new_rel_data) {
      state.editApi.open(d.data);
      return;
    }

    // When clicking a real person
    state.editApi.open(d.data);
    state.editApi.addRelative(d.data);
    f3Card.onCardClickDefault(e, d);
  });

  const mainId = findMainPersonId(state.members);
  if (mainId) chart.updateMainId(mainId);

  chart.updateTree({ initial: true });

  return chart;
}

function applyAddButtonLabels(editApi) {
  if (!editApi) return;

  if (typeof editApi.setAddRelLabels === 'function') {
    editApi.setAddRelLabels({
      father: ADD_LABELS.parent,
      mother: ADD_LABELS.parent,
      son: ADD_LABELS.child,
      daughter: ADD_LABELS.child,
      spouse: ADD_LABELS.partner
    });
  } else {
    // Fallbacks
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

function configureForm(form, datumId) {
  if (!form || form.dataset.prepared) return;

  configureFormInputs(form); // Adds "Enter-to-Submit"
  configureGenderField(form);
  hideRemoveRelationship(form);
  
  ensureRelationshipTypeSelector(form, datumId); // Adds dropdowns for new and existing
  
  renameYearLabels(form);
  applyDefaultGenderIfNeeded(form);

  form.dataset.prepared = 'true';
}

/**
 * Configures all inputs (text, select) for "Enter-to-Submit"
 * and sets up specific logic for year inputs.
 */
function configureFormInputs(form) {
  const submitButton = form.querySelector('button[type="submit"]');
  const inputs = form.querySelectorAll('input, select');

  inputs.forEach(input => {
    // 1. "Enter-to-Submit" logic
    if (submitButton) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          if (event.target.tagName === 'TEXTAREA') return; 
          event.preventDefault();
          submitButton.click();
        }
      });
    }

    // 2. Specific logic for year inputs
    const name = input.getAttribute('name');
    if (name === 'birthday' || name === 'death') {
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
    }
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
  const removeBtn = form.querySelector('.f3-remove-relative-btn');
  if (removeBtn) removeBtn.style.display = 'none';
}

/**
 * Handles adding relationship dropdowns for both
 * NEW partners (e.g., "John and this person are [Married]")
 * and EXISTING partners (e.g., "John and Jane are [Married]")
 */
function ensureRelationshipTypeSelector(form, datumId) {
  // Get data from the chart's store to ensure consistency
  const chartData = state.chart.store.getData();
  const datum = chartData.find(d => d.id === datumId);
  
  if (!datum) {
    console.error("Datum not found in ensureRelationshipTypeSelector:", datumId);
    return;
  }

  const title = form.querySelector('.f3-form-title');
  if (!title) return;
  
  const anchorElement = form.querySelector('.f3-form-buttons');
  if (!anchorElement?.parentNode) {
    console.error("Form anchor .f3-form-buttons not found");
    return; 
  }

  // --- Logic for NEW partners (Adding a new spouse) ---
  const isPartnerForm = /partner|spouse/i.test(title.textContent);
  if (isPartnerForm && datum._new_rel_data) {
    if (!form.querySelector('.relationship-type-selector-new')) {
      
      // Find the name of the person we're adding a partner TO (Person A)
      const originPerson = chartData.find(p => p.id === datum._new_rel_data.rel_id);
      const originName = (originPerson?.data['first name'] || '').trim() || 'Relative';
      
      // Format: "[Person A] and [Person B] are"
      // Since Person B is being created, we use "this person"
      const label = `${originName} and this person are`;

      const wrapper = createRelationshipDropdown(
        'relationship-type-selector-new', 
        'relationship_type', 
        label, 
        null
      );
      anchorElement.parentNode.insertBefore(wrapper, anchorElement);
      configureFormInputs(form); 
    }
  }

  // --- Logic for EXISTING partners (Editing existing person) ---
  const spouseIds = datum.rels?.spouses || [];
  if (spouseIds.length === 0 || datum._new_rel_data) {
    return; 
  }

  spouseIds.forEach(spouseId => {
    // Find the spouse (Person B) in the chart data
    const spouse = chartData.find(m => m.id === spouseId);
    if (!spouse || spouse._new_rel_data) return;

    // Find the specific relationship record from DB state
    const rel = state.spousalRels.find(r =>
      (r.person1_id === datum.id && r.person2_id === spouseId) ||
      (r.person1_id === spouseId && r.person2_id === datum.id)
    );
    
    if (!rel) return; 

    const selectorClass = `relationship-type-selector-existing`;
    const selectorId = `rel_type_${rel.id}`; 
    
    if (form.querySelector(`select[name="${selectorId}"]`)) return;

    // Get names for the label
    const personAName = `${datum.data['first name'] || ''} ${datum.data['last name'] || ''}`.trim() || 'Unknown';
    const personBName = `${spouse.data['first name'] || ''} ${spouse.data['last name'] || ''}`.trim() || 'Unknown';
    
    // Format: "[Person A] and [Person B] are"
    const label = `${personAName} and ${personBName} are`;
    
    const wrapper = createRelationshipDropdown(
      selectorClass,
      selectorId,
      label,
      rel
    );
    
    const select = wrapper.querySelector('select');
    if (select) {
      select.setAttribute('data-spouse-id', spouseId);
      select.setAttribute('data-rel-id', rel.id); 
    }
    
    anchorElement.parentNode.insertBefore(wrapper, anchorElement);
  });
  
  configureFormInputs(form); 
}

/**
 * Helper function to create the HTML for a relationship dropdown
 */
function createRelationshipDropdown(wrapperClass, name, label, dbRel) {
  const currentType = dbRel ? dbRel.relationship_type : 'married';
  
  const wrapper = document.createElement('div');
  wrapper.className = `f3-form-field ${wrapperClass}`;
  wrapper.innerHTML = `
    <label>${label}</label>
    <select name="${name}" class="relationship-type-select">
      <option value="married" ${currentType === 'married' ? 'selected' : ''}>Married</option>
      <option value="partner" ${currentType === 'partner' ? 'selected' : ''}>Partner</option>
      <option value="divorced" ${currentType === 'divorced' ? 'selected' : ''}>Divorced</option>
      <option value="separated" ${currentType === 'separated' ? 'selected' : ''}>Separated</option>
    </select>
  `;
  return wrapper;
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

function applyDefaultGenderIfNeeded(form) {
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
    if (year && !/^\d{4}$/.test(year)) {
      alert('Year of birth must be exactly 4 digits (e.g., 1990)');
      birthdayInput.focus();
      return false;
    }
    if(year) {
      const yearNum = Number.parseInt(year, 10);
      if (yearNum < 1000 || yearNum > 9999) {
        alert('Year of birth must be between 1000 and 9999');
        birthdayInput.focus();
        return false;
      }
    }
  }

  if (deathInput && deathInput.value) {
    const year = deathInput.value.trim();
    if (year && !/^\d{4}$/.test(year)) {
      alert('Year of death must be exactly 4 digits (e.g., 2020)');
      deathInput.focus();
      return false;
    }
    
    if(year) {
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
        is_main: false
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
        death: chartPerson.data['death'] ? Number.parseInt(chartPerson.data['death'], 10) : null, // Fixed bug here
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

    // 4. Reload members from DB
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
  const chartSpousalRels = new Map(); // Use Map to store rel types

  for (const person of chartData) {
    const { parents, spouses } = person.rels || {};

    if (parents) {
      for (const parentId of parents) {
        if (parentId) { // Ensure parentId is not null/undefined
          targetParentChild.push({ parent_id: parentId, child_id: person.id });
        }
      }
    }

    if (spouses) {
      for (const spouseId of spouses) {
        if (!spouseId) continue; // Skip null/undefined spouse IDs
        
        // Create a consistent key
        const key = person.id < spouseId ? `${person.id}-${spouseId}` : `${spouseId}-${person.id}`;
        
        if (!chartSpousalRels.has(key)) {
          // Determine relationship type
          let relType = 'married'; // Default
          if (window.lastRelationshipType) {
            relType = window.lastRelationshipType;
            window.lastRelationshipType = null; // Consume it
          } else {
            // Check existing DB state
            const existingRel = state.spousalRels.find(r => 
              (r.person1_id === person.id && r.person2_id === spouseId) ||
              (r.person1_id === spouseId && r.person2_id === person.id)
            );
            if (existingRel) {
              relType = existingRel.relationship_type;
            }
          }
          chartSpousalRels.set(key, { p1: person.id, p2: spouseId, type: relType });
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

  // Create new / update existing Spousal rels
  for (const [key, chartRel] of chartSpousalRels.entries()) {
    const dbRel = dbSpousal.get(key);
    
    // Ensure p1 and p2 are ordered consistently for DB
    const p1Id = chartRel.p1 < chartRel.p2 ? chartRel.p1 : chartRel.p2;
    const p2Id = chartRel.p1 < chartRel.p2 ? chartRel.p2 : chartRel.p1;

    if (!dbRel) {
      // Create new
      await createSpousalRelationship(state.treeId, p1Id, p2Id, chartRel.type);
    } else if (dbRel.relationship_type !== chartRel.type) {
      // Update existing
      await updateSpousalRelationship(dbRel.id, chartRel.type);
    }
  }

  // Delete old Spousal rels
  for (const [key, dbRel] of dbSpousal.entries()) {
    if (!chartSpousalRels.has(key)) {
      await deleteSpousalRelationship(dbRel.person1_id, dbRel.person2_id);
    }
  }
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Handles the click event for the "Show Full Tree" button.
 */
function handleShowFullTree() {
  if (!state.chart || !state.editApi) return;
  console.log('Showing full tree...');

  // 1. Check if "add relative" mode is active and cancel it
  if (state.editApi.isAddingRelative()) {
    // Manually perform the "cancel" logic
    state.editApi.addRelativeInstance.is_active = false;
    state.chart.store.state.one_level_rels = false;
    state.editApi.addRelativeInstance.cleanUp();
  }

  // 2. Close the form
  state.editApi.closeForm();

  // 3. Re-fit the tree to show everything
  // Using 'fit' and a transition time provides a smooth "zoom out" effect.
  state.chart.updateTree({ tree_position: 'fit', transition_time: 750 });
}


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
