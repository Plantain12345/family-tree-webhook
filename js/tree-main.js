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
    .setShowSiblingsOfMain(true) 

  chart.setAfterUpdate(() => {
    try {
      updateRelationshipStyles();
    } catch (e) {
      console.warn('Error updating relationship styles:', e);
    }
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
    .setOnCardUpdate(function(d) {
      const cardInner = this.querySelector('.card-inner');
      if (d.data.data.is_god_node) {
        cardInner.classList.add('god-mode-card');
      }
      if (d.data.data.is_spacer) {
        cardInner.classList.add('spacer-card');
      }
    });

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

      // Update Relationship Types
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

      setTimeout(() => {
        const freshData = state.chart.store.getData();
        const newDatum = freshData.find(d => d.id === datum.id);
        
        if (newDatum && !newDatum.to_add && !newDatum.data.to_add) {
           state.chart.updateMainId(newDatum.id);
           state.editApi.open(newDatum);
           state.chart.updateTree({ initial: false });
        }
      }, 100);

      scheduleSave(); 
    })
    .setOnDelete((datum, deletePerson, postSubmit) => {
      const id = datum.id;
      const store = state.chart.store;

      deletePerson();
      
      const data = store.getData();
      const index = data.findIndex(d => d.id === id);

      if (index !== -1) {
        const node = data[index];
        if (node.unknown || node.data.unknown) {
          data.forEach(d => {
            if (d.rels.parents) d.rels.parents = d.rels.parents.filter(pId => pId !== id);
            if (d.rels.children) d.rels.children = d.rels.children.filter(cId => cId !== id);
            if (d.rels.spouses) d.rels.spouses = d.rels.spouses.filter(sId => sId !== id);
          });
          data.splice(index, 1);
        }
      }

      if (store.getMainId() === id) {
         const newMain = data.length > 0 ? data[0].id : null;
         if (newMain) store.updateMainId(newMain);
      }
      
      store.updateTree({ initial: false });
      postSubmit({ delete: true }); 
      scheduleSave(); 

      setTimeout(() => handleShowFullTree(), 100);
    });

  applyAddButtonLabels(state.editApi);

  f3Card.setOnCardClick((e, d) => {
    if (d.data.id === 'GOD_NODE_TEMP') return;

    const storeData = state.chart.store.getData();
    const isGodMode = storeData.some(node => node.id === 'GOD_NODE_TEMP');

    if (isGodMode) {
      const cleanChartData = transformDatabaseToFamilyChart(
        state.members, 
        state.parentChildRels, 
        state.spousalRels
      );
      state.chart.updateData(cleanChartData);
    }

    const currentDatum = state.chart.store.getDatum(d.data.id);
    
    if (currentDatum && currentDatum._new_rel_data) {
      state.editApi.open(currentDatum);
      return;
    }
    
    if (currentDatum) {
        state.editApi.open(currentDatum);
        state.editApi.addRelative(currentDatum);
        f3Card.onCardClickDefault(e, d);
    }
  });

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
    
    linkEl.style('opacity', 1).style('pointer-events', 'auto');

    const srcId = d.source.data ? d.source.data.id : d.source.id;
    const tgtId = d.target.data ? d.target.data.id : d.target.id;
    
    const srcIsGodOrSpacer = (d.source.data && (d.source.data.data.is_god_node || d.source.data.data.is_spacer));
    const tgtIsGodOrSpacer = (d.target.data && (d.target.data.data.is_god_node || d.target.data.data.is_spacer));

    const isHidden = 
        srcId === 'GOD_NODE_TEMP' || 
        tgtId === 'GOD_NODE_TEMP' ||
        srcIsGodOrSpacer ||
        tgtIsGodOrSpacer;

    if (isHidden) {
        linkEl.style('opacity', 0).style('pointer-events', 'none');
        return;
    }

    linkEl.classed('link-married link-partner link-divorced link-separated', false);

    let relType = 'married';
    if (srcId && tgtId) {
      const rel = state.spousalRels.find(r => 
        (r.person1_id === srcId && r.person2_id === tgtId) ||
        (r.person1_id === tgtId && r.person2_id === srcId)
      );

      if (rel) {
        relType = rel.relationship_type;
      } else {
        const sourcePerson = state.chart.store.getData().find(p => p.id === srcId);
        if (sourcePerson && sourcePerson.data.spouse_rels && sourcePerson.data.spouse_rels[tgtId]) {
          relType = sourcePerson.data.spouse_rels[tgtId];
        }
      }
    }

    if (relType === 'partner') linkEl.classed('link-partner', true);
    else if (relType === 'separated') linkEl.classed('link-separated', true);
    else if (relType === 'divorced') {
      linkEl.classed('link-divorced', true);
      divorcedLinksData.push({ 
        pathNode: this, 
        id: `marker-${srcId}-${tgtId}` 
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
    try {
        const totalLength = pathNode.getTotalLength();
        if (totalLength > 0) {
        const point = pathNode.getPointAtLength(totalLength / 2);
        const size = 6;
        const dPath = `M ${point.x - size} ${point.y + size} L ${point.x + size} ${point.y - size}`;
        d3.select(this).attr('d', dPath);
        }
    } catch(e) {}
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
    const chartData = state.chart.store.getData().filter(d => {
      if (d.unknown || d.data.unknown || d.to_add) return false;
      if (d.id === 'GOD_NODE_TEMP' || d.data.is_god_node || d.data.is_spacer) return false; 
      
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

    for (const id of newIds) {
      const person = chartData.find(datum => datum.id === id);
      if (!person || person.unknown || person.data.unknown) continue; 

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

    const membersResult = await getFamilyMembers(state.treeId);
    if (membersResult.success) state.members = membersResult.data;

    await syncRelationships(chartData);

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
// Full Tree & God Mode Logic (Corrected)
// -----------------------------------------------------------------------------

function handleShowFullTree() {
  if (!state.chart || !state.editApi) return;
  
  if (state.editApi.isAddingRelative()) {
    state.editApi.addRelativeInstance.is_active = false;
    state.chart.store.state.one_level_rels = false;
    state.editApi.addRelativeInstance.cleanUp();
  }
  state.editApi.closeForm();

  const rawData = state.chart.store.getData();
  const cleanMembers = rawData.filter(d => 
    d.id !== 'GOD_NODE_TEMP' && 
    !d.data.is_god_node && 
    !d.data.is_spacer
  ).map(d => {
    const newRels = { 
      parents: [...(d.rels.parents || [])], 
      children: [...(d.rels.children || [])], 
      spouses: [...(d.rels.spouses || [])] 
    };
    
    newRels.parents = newRels.parents.filter(pid => !pid.startsWith('GOD') && !pid.startsWith('SPACER'));
    newRels.children = newRels.children.filter(cid => !cid.startsWith('GOD') && !cid.startsWith('SPACER'));
    
    return { ...d, rels: newRels };
  });
  
  const { levelMap, minLevel } = calculateStructuralLevels(cleanMembers);
  const fullTreeData = buildStrictTreeData(cleanMembers, levelMap, minLevel);

  state.chart.updateData(fullTreeData);
  state.chart.updateMainId('GOD_NODE_TEMP');
  state.chart.updateTree({ tree_position: 'main_to_middle', transition_time: 750 });
}

function calculateStructuralLevels(members) {
  const levelMap = new Map();
  const queue = [];
  const visited = new Set();

  const getMember = (id) => members.find(m => m.id === id);
  const startNode = members[0];

  if (!startNode) return { levelMap, minLevel: 0 };

  queue.push({ id: startNode.id, level: 0 });
  levelMap.set(startNode.id, 0);
  visited.add(startNode.id);

  let minLevel = 0;

  while (queue.length > 0) {
    const { id, level } = queue.shift();
    if (level < minLevel) minLevel = level;

    const m = getMember(id);
    if (!m) continue;

    if (m.rels.parents) {
      m.rels.parents.forEach(pid => {
        if (!visited.has(pid)) {
          visited.add(pid);
          levelMap.set(pid, level - 1);
          queue.push({ id: pid, level: level - 1 });
        }
      });
    }

    if (m.rels.children) {
      m.rels.children.forEach(cid => {
        if (!visited.has(cid)) {
          visited.add(cid);
          levelMap.set(cid, level + 1);
          queue.push({ id: cid, level: level + 1 });
        }
      });
    }

    if (m.rels.spouses) {
      m.rels.spouses.forEach(sid => {
        if (!visited.has(sid)) {
          visited.add(sid);
          levelMap.set(sid, level);
          queue.push({ id: sid, level: level });
        }
      });
    }
  }

  members.forEach(m => {
    if (!visited.has(m.id)) levelMap.set(m.id, 0);
  });

  return { levelMap, minLevel };
}

/**
 * STRICT TREE BUILDER (CORRECTED for Spouse Roots)
 */
function buildStrictTreeData(members, levelMap, globalMinLevel) {
  const godId = 'GOD_NODE_TEMP';
  const godNode = {
    id: godId,
    data: { "first name": "Full", "last name": "Tree", "gender": "M", "is_god_node": true },
    rels: { parents: [], spouses: [], children: [] }
  };

  const outputNodes = [godNode];
  const processedIds = new Set([godId]);

  // 1. Identify Potential Roots
  let potentialRoots = members.filter(m => {
    return (!m.rels.parents || m.rels.parents.length === 0);
  });

  // 2. CLUSTER ROOTS BY MARRIAGE (If both spouses are roots, pick one)
  const distinctRoots = [];
  const visitedRootIds = new Set();

  potentialRoots.forEach(root => {
    if (visitedRootIds.has(root.id)) return;

    const spouseIds = root.rels.spouses || [];
    // Find spouses that are ALSO in the potentialRoots list
    const spouseRoots = potentialRoots.filter(r => spouseIds.includes(r.id));

    if (spouseRoots.length > 0) {
      // We have a couple/cluster of roots. Pick ONE anchor.
      const cluster = [root, ...spouseRoots];
      
      // Sort: Males first (convention), then ID
      cluster.sort((a, b) => {
        if (a.data.gender === 'M' && b.data.gender !== 'M') return -1;
        if (b.data.gender === 'M' && a.data.gender !== 'M') return 1;
        return a.id.localeCompare(b.id);
      });

      const anchor = cluster[0];
      distinctRoots.push(anchor);
      
      // Mark all as processed so we don't add them as separate roots
      cluster.forEach(c => visitedRootIds.add(c.id));
      
      // Add the non-anchor spouses to outputNodes so they exist, but don't attach to God
      cluster.forEach(c => {
        if (c.id !== anchor.id) {
           outputNodes.push(c); 
           processedIds.add(c.id);
        }
      });

    } else {
      // Check if this root has a spouse who HAS PARENTS (is not a root)
      // If so, do NOT add this root to God. They will be pulled in by their spouse.
      const hasSpouseWithParents = spouseIds.some(sId => {
          const spouse = members.find(m => m.id === sId);
          return spouse && spouse.rels.parents && spouse.rels.parents.length > 0;
      });

      if (!hasSpouseWithParents) {
        distinctRoots.push(root);
      } else {
        // Just make sure they are in outputNodes
        if (!processedIds.has(root.id)) {
             outputNodes.push(root);
             processedIds.add(root.id);
        }
      }
      visitedRootIds.add(root.id);
    }
  });

  const queue = [];

  // 3. Build Tree from Distinct Roots
  distinctRoots.forEach(root => {
    const myLevel = levelMap.get(root.id) || 0;
    const spacersNeeded = myLevel - globalMinLevel;
    
    let parentId = godId;

    for (let i = 0; i < spacersNeeded; i++) {
      const spacerId = `SPACER_${root.id}_${i}`;
      const spacerNode = {
        id: spacerId,
        data: { "first name": "", "gender": "M", "is_spacer": true },
        rels: {
          parents: [parentId],
          spouses: [],
          children: [] 
        }
      };
      
      const prevNode = outputNodes.find(n => n.id === parentId);
      if (!prevNode.rels.children) prevNode.rels.children = [];
      prevNode.rels.children.push(spacerId);
      
      outputNodes.push(spacerNode);
      processedIds.add(spacerId);
      parentId = spacerId;
    }

    const visualParent = outputNodes.find(n => n.id === parentId);
    if (!visualParent.rels.children) visualParent.rels.children = [];
    visualParent.rels.children.push(root.id);
    
    const rootCopy = { ...root, rels: { ...root.rels, parents: [parentId] } };
    outputNodes.push(rootCopy);
    processedIds.add(root.id);
    
    queue.push(rootCopy);
  });

  // 4. Traverse Down
  while (queue.length > 0) {
    const parent = queue.shift();
    
    if (parent.rels.children && parent.rels.children.length > 0) {
      const originalChildrenIds = parent.rels.children;
      parent.rels.children = []; 

      originalChildrenIds.forEach(childId => {
        if (processedIds.has(childId)) {
          // Just link in visual data
          parent.rels.children.push(childId);
          return;
        }

        const childNode = members.find(m => m.id === childId);
        if (!childNode) return;

        const childCopy = { ...childNode, rels: { ...childNode.rels, parents: [parent.id] } };
        
        outputNodes.push(childCopy);
        processedIds.add(childId);
        queue.push(childCopy);
        
        parent.rels.children.push(childId);
      });
    }
  }
  
  // 5. Catch-all for disconnected spouses/islands
  members.forEach(m => {
      if (!processedIds.has(m.id)) {
          outputNodes.push(m);
      }
  });
  
  return outputNodes;
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function findYoungestDescendantId(members, relationships) {
  if (!members || members.length === 0) return null;

  const depths = {};
  members.forEach(m => depths[m.id] = 0);

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
