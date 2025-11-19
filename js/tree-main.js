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
  form: '#familyForm',
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
    window.f3Chart = state.chart
  } else {
    state.chart.updateData(chartData)
    
    // Ensure we have a valid main ID to display
    const currentMainId = state.chart.store.getMainId()
    const currentMainExists = chartData.find(d => d.id === currentMainId)
    
    if (!currentMainId || !currentMainExists) {
      const bestMainId = findYoungestDescendantId(state.members, state.parentChildRels) || findMainPersonId(state.members)
      if (bestMainId) state.chart.updateMainId(bestMainId)
    }
    
    state.chart.updateTree({ initial: false })
  }
}

function createChart(chartData) {
  const chart = window.f3.createChart('#FamilyChart', chartData)
    .setTransitionTime(1000)
    .setCardXSpacing(250)
    .setCardYSpacing(150)

  chart.setAfterUpdate(() => {
    updateRelationshipStyles();
  });

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
      },
      (d) => {
        const spouseRels = d.data['spouse_rels'];
        if (!spouseRels) return '';
        const relationshipStrings = [];
        Object.entries(spouseRels).forEach(([spouseId, type]) => {
          const spouse = state.members.find(m => m.id === spouseId);
          if (spouse && type) {
            const spouseName = `${spouse.first_name || ''} ${spouse.last_name || ''}`.trim();
            const typeCap = type.charAt(0).toUpperCase() + type.slice(1);
            relationshipStrings.push(`${typeCap} to ${spouseName}`);
          }
        });
        if (relationshipStrings.length === 0) return '';
        return `<div style="font-size: 10px; font-style: italic; margin-top: 5px; opacity: 0.9; line-height: 1.2;">${relationshipStrings.join('<br>')}</div>`;
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
        setTimeout(() => configureForm(form, form_creator.datum_id), 0);
      }
    })
    .setOnSubmit(async (e, datum, applyChanges, postSubmit) => {
      e.preventDefault(); 
      const form = e.target;
      
      if (!validateYearFields(form)) return;

      // Update Relationship Types Logic (Optimistic Update)
      const relSelects = form.querySelectorAll('.relationship-type-select-existing');
      const currentChartData = state.chart.store.getData();
      const currentDatum = currentChartData.find(d => d.id === datum.id);

      for (const select of relSelects) {
        const relId = select.dataset.relId;
        const spouseId = select.dataset.spouseId;
        const newType = select.value;
        
        if (currentDatum) {
          if (!currentDatum.data.spouse_rels) currentDatum.data.spouse_rels = {};
          currentDatum.data.spouse_rels[spouseId] = newType;
        }
        const spouseDatum = currentChartData.find(d => d.id === spouseId);
        if (spouseDatum) {
          if (!spouseDatum.data.spouse_rels) spouseDatum.data.spouse_rels = {};
          spouseDatum.data.spouse_rels[datum.id] = newType;
        }

        if (relId && relId !== 'undefined' && relId !== 'null') {
          const dbRel = state.spousalRels.find(r => r.id === relId);
          if (dbRel && dbRel.relationship_type !== newType) {
            dbRel.relationship_type = newType; 
            await updateSpousalRelationship(relId, newType);
          }
        } else {
          const existingRel = state.spousalRels.find(r => 
            (r.person1_id === datum.id && r.person2_id === spouseId) ||
            (r.person1_id === spouseId && r.person2_id === datum.id)
          );
          if (existingRel && existingRel.relationship_type !== newType) {
            existingRel.relationship_type = newType;
            await updateSpousalRelationship(existingRel.id, newType);
          }
        }
      }
      
      const newRelSelect = form.querySelector('.relationship-type-selector-new select');
      if (newRelSelect) {
        window.lastRelationshipType = newRelSelect.value;
      }

      applyChanges(); 
      postSubmit();   

      // FIX #3: Force form to stay on the new member
      // The 'datum' here is the member being added/edited.
      // We find it in the store to get the latest reference, then focus it.
      const freshData = state.chart.store.getData();
      const newDatum = freshData.find(d => d.id === datum.id);
      
      if (newDatum && !newDatum.to_add) {
        // Only switch focus if it's a real member (not a placeholder)
        setTimeout(() => {
          state.chart.updateMainId(newDatum.id);
          state.editApi.open(newDatum);
          state.chart.updateTree({ initial: false });
        }, 50); // Small delay to allow library animations to settle
      }

      scheduleSave(); 
    })
    .setOnDelete((datum, deletePerson, postSubmit) => {
      const id = datum.id;
      const store = state.chart.store;

      // 1. Run the library's standard delete function
      deletePerson();
      
      // 2. Remove artifacts converted to "Unknown"
      const data = store.getData();
      const index = data.findIndex(d => d.id === id);

      if (index !== -1) {
        const node = data[index];
        if (node.unknown || node.data.unknown) {
          console.log('Removing artifact converted to Unknown:', id);
          
          data.forEach(d => {
            if (d.rels.parents) d.rels.parents = d.rels.parents.filter(pId => pId !== id);
            if (d.rels.children) d.rels.children = d.rels.children.filter(cId => cId !== id);
            if (d.rels.spouses) d.rels.spouses = d.rels.spouses.filter(sId => sId !== id);
          });

          data.splice(index, 1);
        }
      }

      // 3. Handle Main Person deletion logic
      if (store.getMainId() === id) {
         const newMain = data.length > 0 ? data[0].id : null;
         if (newMain) store.updateMainId(newMain);
      }
      
      // 4. Update UI immediately
      store.updateTree({ initial: false });
      
      // 5. Trigger DB Sync
      postSubmit({ delete: true }); 
      scheduleSave(); 

      // 6. FIX #2: Trigger 'Show Full Tree' logic after deletion to reset view
      setTimeout(() => handleShowFullTree(), 100);
    });

  applyAddButtonLabels(state.editApi);

  f3Card.setOnCardClick((e, d) => {
    if (d.data._new_rel_data) {
      state.editApi.open(d.data);
      return;
    }
    state.editApi.open(d.data);
    state.editApi.addRelative(d.data);
    f3Card.onCardClickDefault(e, d);
  });

  // Use youngest descendant as initial view to show most of tree
  const bestId = findYoungestDescendantId(state.members, state.parentChildRels) || findMainPersonId(state.members);
  if (bestId) chart.updateMainId(bestId);

  chart.updateTree({ initial: true });

  return chart;
}

function updateRelationshipStyles() {
  const svg = d3.select('#FamilyChart').select('svg.main_svg');
  const linksGroup = svg.select('.links_view');
  
  let markerGroup = linksGroup.select('.relationship-markers');
  if (markerGroup.empty()) {
    markerGroup = linksGroup.append('g').attr('class', 'relationship-markers');
  }

  const links = linksGroup.selectAll('path.link');
  const divorcedLinksData = [];

  links.each(function(d) {
    const linkEl = d3.select(this);
    linkEl.classed('link-married link-partner link-divorced link-separated', false);

    let relType = 'married';
    const sourceId = d.source.data ? d.source.data.id : d.source.id;
    const targetId = d.target.data ? d.target.data.id : d.target.id;
    
    if (sourceId && targetId) {
      const rel = state.spousalRels.find(r => 
        (r.person1_id === sourceId && r.person2_id === targetId) ||
        (r.person1_id === targetId && r.person2_id === sourceId)
      );

      if (rel) {
        relType = rel.relationship_type;
      } else {
        const sourcePerson = state.chart.store.getData().find(p => p.id === sourceId);
        if (sourcePerson && sourcePerson.data.spouse_rels && sourcePerson.data.spouse_rels[targetId]) {
          relType = sourcePerson.data.spouse_rels[targetId];
        }
      }
    }

    if (relType === 'partner') linkEl.classed('link-partner', true);
    else if (relType === 'separated') linkEl.classed('link-separated', true);
    else if (relType === 'divorced') {
      linkEl.classed('link-divorced', true);
      divorcedLinksData.push({ 
        pathNode: this, 
        id: `marker-${sourceId}-${targetId}` 
      });
    } else {
      linkEl.classed('link-married', true);
    }
  });

  const markers = markerGroup.selectAll('.divorce-marker')
    .data(divorcedLinksData, d => d.id);

  markers.exit().remove();

  const markersEnter = markers.enter()
    .append('path')
    .attr('class', 'divorce-marker');

  markers.merge(markersEnter).each(function(d) {
    const pathNode = d.pathNode;
    const totalLength = pathNode.getTotalLength();
    
    if (totalLength > 0) {
      const point = pathNode.getPointAtLength(totalLength / 2);
      const size = 6;
      const dPath = `M ${point.x - size} ${point.y + size} L ${point.x + size} ${point.y - size}`;
      d3.select(this).attr('d', dPath);
    }
  });
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
  }
}

// -----------------------------------------------------------------------------
// Form preparation & validation
// -----------------------------------------------------------------------------

function configureForm(form, datumId) {
  if (!form || form.dataset.prepared) return;

  configureFormInputs(form);
  configureGenderField(form);
  hideRemoveRelationship(form);
  ensureRelationshipTypeSelector(form, datumId);
  renameYearLabels(form);
  applyDefaultGenderIfNeeded(form);

  form.dataset.prepared = 'true';
}

function configureFormInputs(form) {
  const submitButton = form.querySelector('button[type="submit"]');
  const inputs = form.querySelectorAll('input, select');

  inputs.forEach(input => {
    if (submitButton) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          if (event.target.tagName === 'TEXTAREA') return; 
          event.preventDefault();
          submitButton.click();
        }
      });
    }

    const name = input.getAttribute('name');
    if (name === 'birthday' || name === 'death') {
      input.type = 'text';
      input.maxLength = 4;
      input.placeholder = 'YYYY';
      input.pattern = '[0-9]{4}';
      input.addEventListener('input', (event) => {
        event.target.value = event.target.value.replace(/[^0-9]/g, '');
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

function ensureRelationshipTypeSelector(form, datumId) {
  const chartData = state.chart.store.getData();
  const datum = chartData.find(d => d.id === datumId);
  
  if (!datum) return;

  const titleEl = form.querySelector('.f3-form-title');
  const titleText = titleEl ? titleEl.textContent : '';
  
  const anchorElement = form.querySelector('.f3-form-buttons');
  if (!anchorElement?.parentNode) return;

  const isPartnerForm = /partner|spouse/i.test(titleText);
  if (isPartnerForm && datum._new_rel_data) {
    if (!form.querySelector('.relationship-type-selector-new')) {
      const originPerson = chartData.find(p => p.id === datum._new_rel_data.rel_id);
      const originName = (originPerson?.data['first name'] || '').trim() || 'Relative';
      const label = `${originName} and this person are`;

      const wrapper = createRelationshipDropdown(
        'relationship-type-selector-new', 
        'relationship_type', 
        label, 
        'married', 
        null,
        null
      );
      anchorElement.parentNode.insertBefore(wrapper, anchorElement);
      configureFormInputs(form); 
    }
  }

  const spouseIds = datum.rels?.spouses || [];
  if (spouseIds.length === 0 || datum._new_rel_data) return;

  spouseIds.forEach(spouseId => {
    const spouse = chartData.find(m => m.id === spouseId);
    if (!spouse || spouse._new_rel_data) return;

    const pairId = datum.id < spouseId ? `${datum.id}_${spouseId}` : `${spouseId}_${datum.id}`;
    const selectorName = `rel_type_${pairId}`; 
    
    if (form.querySelector(`select[name="${selectorName}"]`)) return;

    const rel = state.spousalRels.find(r =>
      (r.person1_id === datum.id && r.person2_id === spouseId) ||
      (r.person1_id === spouseId && r.person2_id === datum.id)
    );
    
    let currentType = 'married';
    if (datum.data.spouse_rels && datum.data.spouse_rels[spouseId]) {
      currentType = datum.data.spouse_rels[spouseId];
    } else if (rel) {
      currentType = rel.relationship_type;
    }

    const personAName = `${datum.data['first name'] || ''} ${datum.data['last name'] || ''}`.trim() || 'Unknown';
    const personBName = `${spouse.data['first name'] || ''} ${spouse.data['last name'] || ''}`.trim() || 'Unknown';
    
    const label = `${personAName} and ${personBName} are`;
    
    const wrapper = createRelationshipDropdown(
      `relationship-type-selector-existing`,
      selectorName,
      label,
      currentType,
      spouseId,
      rel ? rel.id : null
    );
    
    anchorElement.parentNode.insertBefore(wrapper, anchorElement);
  });
  
  configureFormInputs(form); 
}

function createRelationshipDropdown(wrapperClass, name, label, currentType, spouseId, relId) {
  const wrapper = document.createElement('div');
  wrapper.className = `f3-form-field ${wrapperClass}`;
  
  const select = document.createElement('select');
  select.name = name;
  select.className = 'relationship-type-select relationship-type-select-existing'; 
  if (spouseId) select.setAttribute('data-spouse-id', spouseId);
  if (relId) select.setAttribute('data-rel-id', relId);

  const options = ['married', 'partner', 'divorced', 'separated'];
  options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt;
    option.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
    if (opt === currentType) option.selected = true;
    select.appendChild(option);
  });

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  wrapper.appendChild(labelEl);
  wrapper.appendChild(select);
  
  return wrapper;
}

function renameYearLabels(form) {
  setFieldLabel(form, 'birthday', 'Year of birth');
  setFieldLabel(form, 'death', 'Year of death');
}

function setFieldLabel(form, fieldName, labelText) {
  const input = form.querySelector(`input[name="${fieldName}"]`);
  if (input) {
    const label = form.querySelector(`label[for="${input.id}"]`) ||
      input.closest('.f3-form-field')?.querySelector('label');
    if (label) label.textContent = labelText;
  }
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

  const validate = (input, name) => {
    if (!input || !input.value) return true;
    const year = input.value.trim();
    if (!/^\d{4}$/.test(year)) {
      alert(`${name} must be exactly 4 digits`);
      input.focus();
      return false;
    }
    const yearNum = parseInt(year, 10);
    if (yearNum < 1000 || yearNum > 9999) {
      alert(`${name} must be between 1000 and 9999`);
      input.focus();
      return false;
    }
    return true;
  };

  if (!validate(birthdayInput, 'Year of birth')) return false;
  if (!validate(deathInput, 'Year of death')) return false;

  if (birthdayInput && birthdayInput.value && deathInput && deathInput.value) {
    if (parseInt(deathInput.value, 10) < parseInt(birthdayInput.value, 10)) {
      alert('Year of death cannot be before year of birth');
      deathInput.focus();
      return false;
    }
  }
  return true;
}

// -----------------------------------------------------------------------------
// Persistence
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
    // FIX #3: Filter out "Unknown", placeholders, AND nameless cards
    const chartData = state.chart.store.getData().filter(d => {
      if (d.unknown || d.data.unknown || d.to_add) return false;
      
      // Prevent saving empty "ghost" records
      const fName = (d.data['first name'] || '').trim();
      const lName = (d.data['last name'] || '').trim();
      if (!fName && !lName) return false;

      return true;
    });

    const chartIds = new Set(chartData.map(item => item.id));
    const dbIds = new Set(state.members.map(member => member.id));

    const newIds = [...chartIds].filter(id => !dbIds.has(id));
    const deletedIds = [...dbIds].filter(id => !chartIds.has(id));
    const existingIds = [...chartIds].filter(id => dbIds.has(id));

    // 2. Delete members
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

    // 3. Create new members
    for (const id of newIds) {
      const person = chartData.find(datum => datum.id === id);
      if (!person) continue;

      await createFamilyMember({
        id,
        tree_id: state.treeId,
        first_name: person.data['first name'] || '',
        last_name: person.data['last name'] || '',
        birthday: person.data['birthday'] ? parseInt(person.data['birthday'], 10) : null,
        death: person.data['death'] ? parseInt(person.data['death'], 10) : null,
        gender: person.data['gender'] || null,
        is_main: false
      });
    }

    // 4. Update existing members
    for (const id of existingIds) {
      const chartPerson = chartData.find(datum => datum.id === id);
      const dbPerson = state.members.find(member => member.id === id);
      if (!chartPerson || !dbPerson) continue;

      const updates = {
        first_name: chartPerson.data['first name'] || '',
        last_name: chartPerson.data['last name'] || '',
        birthday: chartPerson.data['birthday'] ? parseInt(chartPerson.data['birthday'], 10) : null,
        death: chartPerson.data['death'] ? parseInt(chartPerson.data['death'], 10) : null,
        gender: chartPerson.data['gender'] || null
      };

      const changed =
        updates.first_name !== dbPerson.first_name ||
        updates.last_name !== dbPerson.last_name ||
        updates.birthday !== dbPerson.birthday ||
        updates.death !== dbPerson.death ||
        updates.gender !== dbPerson.gender;

      if (changed) await updateFamilyMember(id, updates);
    }

    // 5. Reload members from DB
    const membersResult = await getFamilyMembers(state.treeId);
    if (membersResult.success) state.members = membersResult.data;

    // 6. Sync relationships
    await syncRelationships(chartData);

    // 7. Reload relationships from DB
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
  const chartSpousalRels = new Map();
  const validIds = new Set(chartData.map(d => d.id));

  for (const person of chartData) {
    const { parents, spouses } = person.rels || {};

    if (parents) {
      for (const parentId of parents) {
        if (parentId && validIds.has(parentId) && validIds.has(person.id)) {
          targetParentChild.push({ parent_id: parentId, child_id: person.id });
        }
      }
    }

    if (spouses) {
      for (const spouseId of spouses) {
        if (!spouseId || !validIds.has(spouseId)) continue;
        
        const key = person.id < spouseId ? `${person.id}-${spouseId}` : `${spouseId}-${person.id}`;
        
        if (!chartSpousalRels.has(key)) {
          let relType = 'married';
          
          const personSpouseRel = person.data.spouse_rels ? person.data.spouse_rels[spouseId] : null;
          
          if (personSpouseRel) {
            relType = personSpouseRel;
          } else if (window.lastRelationshipType) {
            relType = window.lastRelationshipType;
            window.lastRelationshipType = null; 
          } else {
            const existingRel = state.spousalRels.find(r => 
              (r.person1_id === person.id && r.person2_id === spouseId) ||
              (r.person1_id === spouseId && r.person2_id === person.id)
            );
            if (existingRel) relType = existingRel.relationship_type;
          }
          
          chartSpousalRels.set(key, { p1: person.id, p2: spouseId, type: relType });
        }
      }
    }
  }

  // Sync Parent-Child
  const dbParentChild = new Set(state.parentChildRels.map(rel => `${rel.parent_id}-${rel.child_id}`));
  const chartParentChildIds = new Set(targetParentChild.map(rel => `${rel.parent_id}-${rel.child_id}`));

  for (const rel of targetParentChild) {
    if (!dbParentChild.has(`${rel.parent_id}-${rel.child_id}`)) {
      await createParentChildRelationship(state.treeId, rel.parent_id, rel.child_id);
    }
  }

  for (const rel of state.parentChildRels) {
    if (!chartParentChildIds.has(`${rel.parent_id}-${rel.child_id}`)) {
      await deleteParentChildRelationship(rel.parent_id, rel.child_id);
    }
  }

  // Sync Spousal
  const dbSpousal = new Map(state.spousalRels.map(rel => {
    const key = rel.person1_id < rel.person2_id ? `${rel.person1_id}-${rel.person2_id}` : `${rel.person2_id}-${rel.person1_id}`;
    return [key, rel];
  }));

  for (const [key, chartRel] of chartSpousalRels.entries()) {
    const dbRel = dbSpousal.get(key);
    const p1Id = chartRel.p1 < chartRel.p2 ? chartRel.p1 : chartRel.p2;
    const p2Id = chartRel.p1 < chartRel.p2 ? chartRel.p2 : chartRel.p1;

    if (!dbRel) {
      await createSpousalRelationship(state.treeId, p1Id, p2Id, chartRel.type);
    } else if (dbRel.relationship_type !== chartRel.type) {
      await updateSpousalRelationship(dbRel.id, chartRel.type);
    }
  }

  for (const [key, dbRel] of dbSpousal.entries()) {
    if (!chartSpousalRels.has(key)) {
      await deleteSpousalRelationship(dbRel.person1_id, dbRel.person2_id);
    }
  }
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function handleShowFullTree() {
  if (!state.chart || !state.editApi) return;
  
  if (state.editApi.isAddingRelative()) {
    state.editApi.addRelativeInstance.is_active = false;
    state.chart.store.state.one_level_rels = false;
    state.editApi.addRelativeInstance.cleanUp();
  }
  state.editApi.closeForm();
  
  // FIX #2: Set main_id to the youngest generation person (highest depth)
  // This ensures maximum ancestry visibility
  const youngestId = findYoungestDescendantId(state.members, state.parentChildRels);
  
  if (youngestId) {
    state.chart.updateMainId(youngestId);
  } else {
    // Fallback to root if no hierarchy found
    const rootId = findMainPersonId(state.members);
    if (rootId) state.chart.updateMainId(rootId);
  }

  state.chart.updateTree({ tree_position: 'fit', transition_time: 750 });
}

/**
 * Algorithm to find the person in the youngest generation (lowest in the tree)
 * This helps show the full tree by rendering from bottom-up ancestry.
 */
function findYoungestDescendantId(members, relationships) {
  if (!members || members.length === 0) return null;

  const depths = {};
  members.forEach(m => depths[m.id] = 0);

  // Propagate depths downwards (max 100 iterations to prevent infinite loops)
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 100) {
    changed = false;
    relationships.forEach(rel => {
      const pDepth = depths[rel.parent_id] || 0;
      const cDepth = depths[rel.child_id] || 0;
      if (pDepth + 1 > cDepth) {
        depths[rel.child_id] = pDepth + 1;
        changed = true;
      }
    });
    iterations++;
  }

  // Find ID with max depth
  let maxD = -1;
  let maxId = null;
  for (const id in depths) {
    if (depths[id] > maxD) {
      maxD = depths[id];
      maxId = id;
    }
  }
  return maxId;
}

function handleCopyTreeCode() {
  if (!state.treeCode) return;
  navigator.clipboard.writeText(state.treeCode);
  const btn = document.getElementById('copyCodeBtn');
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = original; }, 2000);
}

function toggleLoading(show) {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  overlay.classList.toggle('hidden', !show);
}
