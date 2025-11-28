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
  createMemberData
} from './tree-data.js'

import { setupRealtimeSync } from './tree-sync.js'

const d3 = window.d3;

const FIRST_PERSON_DEFAULT_GENDER = 'M'

const ADD_LABELS = {
  father: 'Add Father',
  mother: 'Add Mother',
  son: 'Add Son',
  daughter: 'Add Daughter',
  spouse: 'Add Partner' 
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

    const nameEl = document.querySelector('#treeName span:last-child');
    if (nameEl) nameEl.textContent = tree.tree_name;
    
    document.getElementById('treeCodeDisplay').textContent = tree.tree_code

    await loadTreeData()
    setupRealtimeSync(state.treeId, () => {
      // Only reload if we aren't currently editing/saving to prevent jumps
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

    refreshChartUI();
  } catch (error) {
    console.error('Load error:', error)
  }
}

// -----------------------------------------------------------------------------
// Chart Logic
// -----------------------------------------------------------------------------

function refreshChartUI() {
  const chartData = transformDatabaseToFamilyChart(
    state.members,
    state.parentChildRels,
    state.spousalRels
  );
  
  const safeData = sanitizeChartData(chartData);

  if (!state.chart) {
    state.chart = createChart(safeData)
    window.f3Chart = state.chart
  } else {
    state.chart.updateData(safeData)
    
    // Ensure main ID is valid
    const currentMainId = state.chart.store.getMainId()
    const currentMainExists = safeData.find(d => d.id === currentMainId)
    
    if (!currentMainId || !currentMainExists) {
      const bestMainId = findYoungestDescendantId(state.members, state.parentChildRels) || findMainPersonId(state.members)
      if (bestMainId) state.chart.updateMainId(bestMainId)
    }
    
    state.chart.updateTree({ initial: false })
  }
}

function cleanupGhostNodes() {
  if (!state.chart || !state.chart.store) return;
  const data = state.chart.store.getData();
  
  let hasChanges = false;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i]._new_rel_data || data[i].to_add) {
      const ghostId = data[i].id;
      data.forEach(d => {
        if (d.rels.spouses) d.rels.spouses = d.rels.spouses.filter(id => id !== ghostId);
        if (d.rels.children) d.rels.children = d.rels.children.filter(id => id !== ghostId);
        if (d.rels.parents) d.rels.parents = d.rels.parents.filter(id => id !== ghostId);
      });
      data.splice(i, 1);
      hasChanges = true;
    }
  }
  if (hasChanges) {
    state.chart.updateData(data);
  }
}

function sanitizeChartData(chartData) {
  if (!Array.isArray(chartData)) return [];
  // Basic filter for valid objects
  const cleanData = chartData.filter(d => d && d.id && d.rels);

  // Ensure 2-parent logic is consistent for family-chart
  cleanData.forEach(child => {
    if (!child.rels) return;
    const parents = child.rels.parents || [];
    
    if (child.rels.father && !parents.includes(child.rels.father)) parents.push(child.rels.father);
    if (child.rels.mother && !parents.includes(child.rels.mother)) parents.push(child.rels.mother);

    // If a child has 2 parents, ensure those parents are marked as spouses
    if (parents.length === 2) {
      const p1Id = parents[0];
      const p2Id = parents[1];
      const p1 = cleanData.find(d => d.id === p1Id);
      const p2 = cleanData.find(d => d.id === p2Id);

      if (p1 && p2 && p1.rels && p2.rels) {
        if (!p1.rels.spouses) p1.rels.spouses = [];
        if (!p2.rels.spouses) p2.rels.spouses = [];

        if (!p1.rels.spouses.includes(p2Id)) {
          p1.rels.spouses.push(p2Id);
          p2.rels.spouses.push(p1Id);
        }
      }
    }
  });
  return cleanData;
}

function createChart(chartData) {
  const chart = window.f3.createChart('#FamilyChart', chartData)
    .setTransitionTime(1000)
    .setCardXSpacing(250)
    .setCardYSpacing(150)
    .setShowSiblingsOfMain(true)
    .setSingleParentEmptyCard(true, { label: 'Unknown' })

  state.chart = chart;

  chart.setAfterUpdate(() => {
    try {
      updateRelationshipStyles();
    } catch (e) {}
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
            let preposition = (type === 'divorced' || type === 'separated') ? "from" : "to";
            relationshipStrings.push(`${typeCap} ${preposition} ${spouseName}`);
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
      
      try {
        state.isSaving = true;
        const form = e.target;
        const formData = new FormData(form);
        const formProps = Object.fromEntries(formData);
        
        if (!validateYearFields(form)) return;

        const existingMember = state.members.find(m => m.id === datum.id);
        let memberId = datum.id;
        let newlyCreatedRelPersonId = null;

        if (!existingMember) {
          // --- CREATE NEW MEMBER ---
          console.log('Creating new member in Supabase...');
          const memberData = createMemberData(state.treeId, formProps);
          memberData.gender = formProps.gender || datum.data.gender;

          const res = await createFamilyMember(memberData);
          if (res.success) {
            memberId = res.data.id;
            datum.id = memberId; 
            
            // Immediately push to state to prevent race conditions or missing data
            state.members.push(res.data);

            // CASE 1: Standard "Add Relative" Button
            if (datum._new_rel_data) {
              const relType = datum._new_rel_data.rel_type;
              const relatedId = datum._new_rel_data.rel_id;
              newlyCreatedRelPersonId = relatedId;
              
              if (relType === 'spouse') {
                const relSelect = form.querySelector('.relationship-type-select-existing'); 
                const type = relSelect ? relSelect.value : 'married';
                
                const relRes = await createSpousalRelationship(state.treeId, relatedId, memberId, type);
                if(relRes.success && relRes.data) state.spousalRels.push(relRes.data);

              } else if (relType === 'son' || relType === 'daughter') {
                const pcRes1 = await createParentChildRelationship(state.treeId, relatedId, memberId);
                if(pcRes1.success && pcRes1.data) state.parentChildRels.push(pcRes1.data);

                if (datum._new_rel_data.other_parent_id) {
                  const pcRes2 = await createParentChildRelationship(state.treeId, datum._new_rel_data.other_parent_id, memberId);
                  if(pcRes2.success && pcRes2.data) state.parentChildRels.push(pcRes2.data);
                }
              } else if (relType === 'father' || relType === 'mother') {
                const pcRes = await createParentChildRelationship(state.treeId, memberId, relatedId); 
                if(pcRes.success && pcRes.data) state.parentChildRels.push(pcRes.data);
              }
            } 
            // CASE 2: "Unknown" / Placeholder Card (Fix for Issue #2)
            else {
              console.log("Resolving Unknown/Placeholder member...");
              
              // If we are editing an "Unknown" card, it won't have _new_rel_data.
              // We must infer relationships from the temporary card's existing links.
              
              // Link as parent to existing children
              if (datum.rels.children && datum.rels.children.length > 0) {
                for (const childId of datum.rels.children) {
                  // Ensure childId is a real DB ID (simple check: length > 10)
                  if (childId && childId.length > 10) {
                    const pcRes = await createParentChildRelationship(state.treeId, memberId, childId);
                    if (pcRes.success && pcRes.data) state.parentChildRels.push(pcRes.data);
                  }
                }
              }

              // Link as spouse to existing spouses
              if (datum.rels.spouses && datum.rels.spouses.length > 0) {
                for (const spouseId of datum.rels.spouses) {
                  if (spouseId && spouseId.length > 10) {
                    const spRes = await createSpousalRelationship(state.treeId, memberId, spouseId, 'married');
                    if (spRes.success && spRes.data) state.spousalRels.push(spRes.data);
                  }
                }
              }
            }
          }
        } else {
          // --- UPDATE EXISTING MEMBER ---
          const updates = {
            first_name: formProps['first name'],
            last_name: formProps['last name'],
            birthday: formProps['birthday'] || null,
            death: formProps['death'] || null,
            gender: formProps['gender']
          };
          await updateFamilyMember(memberId, updates);
          
          const memIndex = state.members.findIndex(m => m.id === memberId);
          if (memIndex >= 0) state.members[memIndex] = { ...state.members[memIndex], ...updates };
        }

        // --- HANDLE RELATIONSHIPS (Existing) ---
        const relSelects = form.querySelectorAll('.relationship-type-select-existing');
        for (const select of relSelects) {
          const relId = select.dataset.relId;
          const spouseId = select.dataset.spouseId;
          const newType = select.value;
          
          if (spouseId === newlyCreatedRelPersonId && !existingMember) continue;

          if (!datum.data.spouse_rels) datum.data.spouse_rels = {};
          datum.data.spouse_rels[spouseId] = newType;

          if (relId && relId !== 'undefined' && relId !== 'null') {
            const dbRel = state.spousalRels.find(r => r.id === relId);
            if (dbRel && dbRel.relationship_type !== newType) {
              await updateSpousalRelationship(relId, newType);
              if(dbRel) dbRel.relationship_type = newType;
            }
          } else if (existingMember && spouseId) {
            const existingRel = state.spousalRels.find(r => 
              (r.person1_id === memberId && r.person2_id === spouseId) ||
              (r.person1_id === spouseId && r.person2_id === memberId)
            );
            if (existingRel && existingRel.relationship_type !== newType) {
              await updateSpousalRelationship(existingRel.id, newType);
              existingRel.relationship_type = newType;
            }
          }
        }

        applyChanges(); 
        postSubmit();   

        // Force UI Refresh with new state
        refreshChartUI();
        
        // Attempt to switch view to the new/updated person
        // We use a small timeout to let D3 calculation finish
        setTimeout(() => {
          const treeData = state.chart.store.getData();
          // Verify the node actually exists in the processed tree data
          const freshDatum = treeData.find(d => d.id === memberId);
          
          if (freshDatum) {
             state.chart.updateMainId(freshDatum.id);
             state.editApi.open(freshDatum);
             state.chart.updateTree({ initial: false });
          } else {
            console.warn("New member created but not found in tree topology yet.");
          }
        }, 100);

      } catch (err) {
        console.error("Save failed", err);
        alert("Failed to save changes. Please try again.");
      } finally {
        state.isSaving = false;
      }
    })
    .setOnDelete(async (datum, deletePerson, postSubmit) => {
      if(!confirm("Are you sure you want to delete this person?")) return;
      
      try {
        state.isSaving = true;
        const id = datum.id;

        // Check if person has dependents
        const hasChildren = state.parentChildRels.some(r => r.parent_id === id);
        const hasSpouses = state.spousalRels.some(r => r.person1_id === id || r.person2_id === id);

        if (hasChildren || hasSpouses) {
          // Soft delete logic: Replace with "Unknown" to preserve tree structure
          const updates = {
            first_name: "Unknown",
            last_name: "",
            birthday: null,
            death: null
          };
          
          await updateFamilyMember(id, updates);
          
          const memIndex = state.members.findIndex(m => m.id === id);
          if (memIndex >= 0) state.members[memIndex] = { ...state.members[memIndex], ...updates };
          
          state.editApi.closeForm();
          refreshChartUI();
          
        } else {
          // Hard delete
          await deleteFamilyMember(id);
          deletePerson();
          
          state.members = state.members.filter(m => m.id !== id);
          state.parentChildRels = state.parentChildRels.filter(r => r.parent_id !== id && r.child_id !== id);
          state.spousalRels = state.spousalRels.filter(r => r.person1_id !== id && r.person2_id !== id);

          const store = state.chart.store;
          const data = store.getData();
          
          if (store.getMainId() === id) {
             const newMain = data.length > 0 ? data[0].id : null;
             if (newMain) store.updateMainId(newMain);
          }
          
          store.updateTree({ initial: false });
          postSubmit({ delete: true }); 
        }
      } catch (err) {
        console.error("Delete failed", err);
      } finally {
        state.isSaving = false;
      }
    });

  applyAddButtonLabels(state.editApi);

  f3Card.setOnCardClick((e, d) => {
    if (d.data.id === 'GOD_NODE_TEMP') return;

    if (!d.data._new_rel_data && !d.data.to_add) {
      cleanupGhostNodes();
    }

    const storeData = state.chart.store.getData();
    const isGodMode = storeData.some(node => node.id === 'GOD_NODE_TEMP');

    if (isGodMode) {
      refreshChartUI();
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
  if (!state.chart || !state.chart.store) return;

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

    if (!d.source.data || !d.target.data) return;

    const srcId = d.source.data.id;
    const tgtId = d.target.data.id;
    const srcIsGodOrSpacer = (d.source.data.data.is_god_node || d.source.data.data.is_spacer);
    const tgtIsGodOrSpacer = (d.target.data.data.is_god_node || d.target.data.data.is_spacer);

    if (srcId === 'GOD_NODE_TEMP' || tgtId === 'GOD_NODE_TEMP' || srcIsGodOrSpacer || tgtIsGodOrSpacer) {
        linkEl.style('opacity', 0).style('pointer-events', 'none');
        return;
    }

    linkEl.classed('link-married link-partner link-divorced link-separated', false);

    let relType = 'married';
    
    if (d.spouse) {
        const deltaX = Math.abs(d.target.x - d.source.x);
        const nodeSeparation = 250; 
        
        if (deltaX > nodeSeparation * 1.5) {
            const sourceX = d.source.x;
            const targetX = d.target.x;
            const sourceY = d.source.y;
            const targetY = d.target.y;
            
            const direction = targetX > sourceX ? 1 : -1;
            const shift = nodeSeparation * 0.5 * direction;
            const safeX = targetX - shift; 

            const path = d3.path();
            path.moveTo(sourceX, sourceY);
            path.lineTo(safeX, sourceY);
            path.lineTo(safeX, targetY);
            path.lineTo(targetX, targetY);
            
            linkEl.attr('d', path.toString());
        }
    }

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
    editApi.setAddRelLabels(ADD_LABELS);
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

  const sourceMembers = transformDatabaseToFamilyChart(
    state.members,
    state.parentChildRels,
    state.spousalRels
  );

  const { levelMap, minLevel } = calculateStructuralLevels(sourceMembers);
  const fullTreeData = buildStrictTreeData(sourceMembers, levelMap, minLevel);

  state.chart.updateData(sanitizeChartData(fullTreeData));
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

function buildStrictTreeData(members, levelMap, globalMinLevel) {
  const godId = 'GOD_NODE_TEMP';
  const godNode = {
    id: godId,
    data: { "first name": "Full", "last name": "Tree", "gender": "M", "is_god_node": true },
    rels: { parents: [], spouses: [], children: [] }
  };

  const outputNodesMap = new Map();
  outputNodesMap.set(godId, godNode);

  let roots = members.filter(m => !m.rels.parents || m.rels.parents.length === 0);
  roots.sort((a, b) => (b.rels.children?.length || 0) - (a.rels.children?.length || 0));

  const queue = [];

  roots.forEach(root => {
    if (outputNodesMap.has(root.id)) return; 

    const spouseIds = root.rels.spouses || [];
    const spouseProcessed = spouseIds.some(sid => outputNodesMap.has(sid));

    if (spouseProcessed) {
        if (!outputNodesMap.has(root.id)) {
            outputNodesMap.set(root.id, root);
        }
        return; 
    }

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

    const visualParent = outputNodesMap.get(parentId);
    if (visualParent) {
        if (!visualParent.rels.children) visualParent.rels.children = [];
        visualParent.rels.children.push(root.id);
    }

    const rootCopy = { ...root, rels: { ...root.rels, parents: [parentId] } };
    outputNodesMap.set(root.id, rootCopy);
    queue.push(rootCopy);
  });

  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent.rels.children) continue;

    const realChildrenIds = parent.rels.children;
    parent.rels.children = []; 

    realChildrenIds.forEach(childId => {
      if (outputNodesMap.has(childId)) {
        return; 
      }

      const childNode = members.find(m => m.id === childId);
      if (!childNode) return;

      const childCopy = { ...childNode, rels: { ...childNode.rels, parents: [parent.id] } };
      
      outputNodesMap.set(childId, childCopy);
      queue.push(childCopy);
      
      parent.rels.children.push(childId);
    });
  }

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
