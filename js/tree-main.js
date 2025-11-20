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
      if (d.data.data.is_god_node) cardInner.classList.add('god-mode-card');
      if (d.data.data.is_spacer) cardInner.classList.add('spacer-card');
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
            await updateSpousalRelationship(relId, newType);
          }
        } else {
          const existingRel = state.spousalRels.find(r => 
            (r.person1_id === datum.id && r.person2_id === spouseId) ||
            (r.person1_id === spouseId && r.person2_id === datum.id)
          );
          if (existingRel && existingRel.relationship_type !== newType) {
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
    if (currentDatum) {
        state.editApi.open(currentDatum);
        if (!currentDatum._new_rel_data) {
            state.editApi.addRelative(currentDatum);
        }
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

    if (srcId === 'GOD_NODE_TEMP' || tgtId === 'GOD_NODE_TEMP' || srcIsGodOrSpacer || tgtIsGodOrSpacer) {
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
  const markersEnter = markers.enter().append('path').attr('class', 'divorce-marker');
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
// Form configuration helpers
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
      const wrapper = createRelationshipDropdown('relationship-type-selector-new', 'relationship_type', `${originName} and this person are`, 'married', null, null);
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
    if (datum.data.spouse_rels && datum.data.spouse_rels[spouseId]) currentType = datum.data.spouse_rels[spouseId];
    else if (rel) currentType = rel.relationship_type;

    const personAName = `${datum.data['first name'] || ''} ${datum.data['last name'] || ''}`.trim() || 'Unknown';
    const personBName = `${spouse.data['first name'] || ''} ${spouse.data['last name'] || ''}`.trim() || 'Unknown';
    const wrapper = createRelationshipDropdown(`relationship-type-selector-existing`, selectorName, `${personAName} and ${personBName} are`, currentType, spouseId, rel ? rel.id : null);
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

  ['married', 'partner', 'divorced', 'separated'].forEach(opt => {
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
    const label = form.querySelector(`label[for="${input.id}"]`) || input.closest('.f3-form-field')?.querySelector('label');
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
    if (!/^\d{4}$/.test(input.value.trim())) {
      alert(`${name} must be exactly 4 digits`);
      input.focus();
      return false;
    }
    return true;
  };
  if (!validate(birthdayInput, 'Year of birth')) return false;
  if (!validate(deathInput, 'Year of death')) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Full Tree & God Mode Logic (Strict De-duplication)
// -----------------------------------------------------------------------------

function handleShowFullTree() {
  if (!state.chart || !state.editApi) return;
  
  if (state.editApi.isAddingRelative()) {
    state.editApi.addRelativeInstance.is_active = false;
    state.chart.store.state.one_level_rels = false;
    state.editApi.addRelativeInstance.cleanUp();
  }
  state.editApi.closeForm();

  // 1. Sanitize & Prepare Data (From DB source, not Chart state)
  // This ensures no artifacts (Spacers/Gods) from previous runs are included
  const sourceMembers = transformDatabaseToFamilyChart(
    state.members,
    state.parentChildRels,
    state.spousalRels
  );

  // 2. Calculate Generations
  const { levelMap, minLevel } = calculateStructuralLevels(sourceMembers);

  // 3. Build Non-Duplicating Tree
  const fullTreeData = buildStrictTreeData(sourceMembers, levelMap, minLevel);

  state.chart.updateData(fullTreeData);
  state.chart.updateMainId('GOD_NODE_TEMP');
  state.chart.updateTree({ tree_position: 'main_to_middle', transition_time: 750 });
}

function calculateStructuralLevels(members) {
  const levelMap = new Map();
  const queue = [];
  const visited = new Set();

  const startNode = members[0];
  if (!startNode) return { levelMap, minLevel: 0 };

  queue.push({ id: startNode.id, level: 0 });
  levelMap.set(startNode.id, 0);
  visited.add(startNode.id);

  let minLevel = 0;

  while (queue.length > 0) {
    const { id, level } = queue.shift();
    if (level < minLevel) minLevel = level;
    const m = members.find(x => x.id === id);
    if (!m) continue;

    if (m.rels.parents) m.rels.parents.forEach(pid => {
      if (!visited.has(pid)) {
        visited.add(pid);
        levelMap.set(pid, level - 1);
        queue.push({ id: pid, level: level - 1 });
      }
    });
    if (m.rels.children) m.rels.children.forEach(cid => {
      if (!visited.has(cid)) {
        visited.add(cid);
        levelMap.set(cid, level + 1);
        queue.push({ id: cid, level: level + 1 });
      }
    });
    if (m.rels.spouses) m.rels.spouses.forEach(sid => {
      if (!visited.has(sid)) {
        visited.add(sid);
        levelMap.set(sid, level);
        queue.push({ id: sid, level: level });
      }
    });
  }

  members.forEach(m => { if (!visited.has(m.id)) levelMap.set(m.id, 0); });

  return { levelMap, minLevel };
}

/**
 * Strict Tree Builder: Uses Map to ensure ZERO duplicates
 */
function buildStrictTreeData(members, levelMap, globalMinLevel) {
  const godId = 'GOD_NODE_TEMP';
  const godNode = {
    id: godId,
    data: { "first name": "Full", "last name": "Tree", "gender": "M", "is_god_node": true },
    rels: { parents: [], spouses: [], children: [] }
  };

  // Map used to ensure uniqueness. Key = ID, Value = Node Object
  const outputNodesMap = new Map();
  outputNodesMap.set(godId, godNode);

  // 1. Find Roots (No parents)
  let roots = members.filter(m => !m.rels.parents || m.rels.parents.length === 0);

  // Sort roots to process main branches first
  roots.sort((a, b) => (b.rels.children?.length || 0) - (a.rels.children?.length || 0));

  const queue = [];

  // 2. Process Roots
  roots.forEach(root => {
    if (outputNodesMap.has(root.id)) return; // Already added (via spouse maybe)

    // Spouse check: If spouse already processed, skip adding this root to God
    // (They will appear next to spouse automatically)
    const spouseIds = root.rels.spouses || [];
    const spouseProcessed = spouseIds.some(sid => outputNodesMap.has(sid));

    if (spouseProcessed) {
        if (!outputNodesMap.has(root.id)) {
            // Add to map, but don't link to God
            outputNodesMap.set(root.id, root);
        }
        return; 
    }

    // Add Spacers
    const myLevel = levelMap.get(root.id) || 0;
    const spacersNeeded = myLevel - globalMinLevel;
    let parentId = godId;

    for (let i = 0; i < spacersNeeded; i++) {
      const spacerId = `SPACER_${root.id}_${i}`;
      if (!outputNodesMap.has(spacerId)) {
          const spacerNode = {
            id: spacerId,
            data: { "first name": "", "gender": "M", "is_spacer": true },
            rels: { parents: [parentId], spouses: [], children: [] }
          };
          const prevNode = outputNodesMap.get(parentId);
          if (prevNode) {
             if (!prevNode.rels.children) prevNode.rels.children = [];
             prevNode.rels.children.push(spacerId);
          }
          outputNodesMap.set(spacerId, spacerNode);
      }
      parentId = spacerId;
    }

    // Link Root to God/Spacer
    const visualParent = outputNodesMap.get(parentId);
    if (visualParent) {
        if (!visualParent.rels.children) visualParent.rels.children = [];
        visualParent.rels.children.push(root.id);
    }

    // Overwrite parents to enforce single-parentage in visual tree
    const rootCopy = { ...root, rels: { ...root.rels, parents: [parentId] } };
    outputNodesMap.set(root.id, rootCopy);
    queue.push(rootCopy);
  });

  // 3. BFS Down (Processing children)
  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent.rels.children) continue;

    const realChildrenIds = parent.rels.children;
    // Clean parent's visual children list to rebuild it strictly
    parent.rels.children = []; 

    realChildrenIds.forEach(childId => {
      if (outputNodesMap.has(childId)) {
        // Child already in tree (via other parent). 
        // Do NOT add again. Visual compromise: Only shows under first parent processed.
        // We do NOT link them to this parent to avoid D3 duplicate ID error.
        return; 
      }

      const childNode = members.find(m => m.id === childId);
      if (!childNode) return;

      // Point child to this parent ONLY
      const childCopy = { ...childNode, rels: { ...childNode.rels, parents: [parent.id] } };
      
      outputNodesMap.set(childId, childCopy);
      queue.push(childCopy);
      
      // Visual Link
      parent.rels.children.push(childId);
    });
  }

  // 4. Sweep for disconnected members (floating spouses, etc)
  members.forEach(m => {
      if (!outputNodesMap.has(m.id)) {
          outputNodesMap.set(m.id, m);
      }
  });

  return Array.from(outputNodesMap.values());
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
