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
    // --- GOD MODE STYLE HANDLER ---
    .setOnCardUpdate(function(d) {
      const cardInner = this.querySelector('.card-inner');
      
      // Hide God Node
      if (d.data.data.is_god_node) {
        cardInner.classList.add('god-mode-card');
      }
      
      // Hide Spacer Nodes
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
      
      // Trigger full tree view after delete
      setTimeout(() => handleShowFullTree(), 100);
    });

  applyAddButtonLabels(state.editApi);

  // --- GOD MODE CLICK HANDLER ---
  f3Card.setOnCardClick((e, d) => {
    // 1. Prevent clicking the God Node itself
    if (d.data.id === 'GOD_NODE_TEMP') return;

    // 2. Check if we need to exit God Mode
    const storeData = state.chart.store.getData();
    const isGodMode = storeData.some(node => node.id === 'GOD_NODE_TEMP');

    if (isGodMode) {
      // Reload clean data to exit God Mode
      const cleanChartData = transformDatabaseToFamilyChart(
        state.members, 
        state.parentChildRels, 
        state.spousalRels
      );
      state.chart.updateData(cleanChartData);
      // We do NOT need to reload state.members from DB here, we use the local cache
      // This effectively "wipes" the God Node from memory
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
    
    // --- GOD MODE: Hide Spiderweb Lines ---
    linkEl.style('opacity', 1).style('pointer-events', 'auto'); // Reset

    const srcId = d.source.data ? d.source.data.id : d.source.id;
    const tgtId = d.target.data ? d.target.data.id : d.target.id;
    
    // Check for God/Spacer flags in data
    const srcIsGodOrSpacer = (d.source.data && (d.source.data.data.is_god_node || d.source.data.data.is_spacer));
    const tgtIsGodOrSpacer = (d.target.data && (d.target.data.data.is_god_node || d.target.data.data.is_spacer));

    // Also check IDs directly just in case
    const isHidden = 
        srcId === 'GOD_NODE_TEMP' || 
        tgtId === 'GOD_NODE_TEMP' ||
        srcIsGodOrSpacer ||
        tgtIsGodOrSpacer;

    if (isHidden) {
        linkEl.style('opacity', 0).style('pointer-events', 'none');
        return;
    }
    // -------------------------------------

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
// Full Tree & God Mode Logic (Corrected for Duplication)
// -----------------------------------------------------------------------------

function handleShowFullTree() {
  if (!state.chart || !state.editApi) return;
  
  if (state.editApi.isAddingRelative()) {
    state.editApi.addRelativeInstance.is_active = false;
    state.chart.store.state.one_level_rels = false;
    state.editApi.addRelativeInstance.cleanUp();
  }
  state.editApi.closeForm();

  // 1. SANITIZE & PREPARE DATA
  // We must filter out any existing God/Spacer nodes from the store
  // This prevents the "x3" duplication issue on repeated clicks
  const rawData = state.chart.store.getData();
  const cleanMembers = rawData.filter(d => 
    d.id !== 'GOD_NODE_TEMP' && 
    !d.data.is_god_node && 
    !d.data.is_spacer
  ).map(d => {
    // Deep copy relationship arrays to avoid mutating store
    const newRels = { 
      parents: [...(d.rels.parents || [])], 
      children: [...(d.rels.children || [])], 
      spouses: [...(d.rels.spouses || [])] 
    };
    
    // Remove links to God/Spacers from relationship arrays
    newRels.parents = newRels.parents.filter(pid => !pid.startsWith('GOD') && !pid.startsWith('SPACER'));
    newRels.children = newRels.children.filter(cid => !cid.startsWith('GOD') && !cid.startsWith('SPACER'));
    
    return { ...d, rels: newRels };
  });
  
  // 2. Calculate Structural Levels
  const { levelMap, minLevel } = calculateStructuralLevels(cleanMembers);

  // 3. Build Strict Tree (De-duplicated)
  const fullTreeData = buildStrictTreeData(cleanMembers, levelMap, minLevel);

  // 4. Render
  state.chart.updateData(fullTreeData);
  state.chart.updateMainId('GOD_NODE_TEMP');
  state.chart.updateTree({ tree_position: 'main_to_middle', transition_time: 750 });
}

/**
 * Calculate Structural Levels
 */
function calculateStructuralLevels(members) {
  const levelMap = new Map();
  const queue = [];
  const visited = new Set();

  const getMember = (id) => members.find(m => m.id === id);

  // We need a valid start node. The God Node doesn't exist yet, so pick the first real member.
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

    // Parent = Level - 1
    if (m.rels.parents) {
      m.rels.parents.forEach(pid => {
        if (!visited.has(pid)) {
          visited.add(pid);
          levelMap.set(pid, level - 1);
          queue.push({ id: pid, level: level - 1 });
        }
      });
    }

    // Child = Level + 1
    if (m.rels.children) {
      m.rels.children.forEach(cid => {
        if (!visited.has(cid)) {
          visited.add(cid);
          levelMap.set(cid, level + 1);
          queue.push({ id: cid, level: level + 1 });
        }
      });
    }

    // Spouse = Level 0 (Same)
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

  // Handle disconnected islands (assign them to 0 if not visited)
  members.forEach(m => {
    if (!visited.has(m.id)) levelMap.set(m.id, 0);
  });

  return { levelMap, minLevel };
}

/**
 * Strict Tree Builder with Spouse De-duplication
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

  // Identify Roots (anyone with no parents)
  let roots = members.filter(m => {
    if (!m.rels.parents || m.rels.parents.length === 0) return true;
    return false;
  });

  // CLUSTER SPOUSE ROOTS
  const rootsToAttach = [];
  const processedRoots = new Set();

  roots.forEach(root => {
    if (processedRoots.has(root.id)) return;

    // Check for spouse roots
    const spouseRoots = (root.rels.spouses || [])
      .map(sId => roots.find(r => r.id === sId))
      .filter(s => s !== undefined);

    if (spouseRoots.length > 0) {
      // Cluster found: Pick one anchor
      const cluster = [root, ...spouseRoots];
      cluster.sort((a, b) => a.id.localeCompare(b.id)); // Consistent sorting
      
      const anchor = cluster[0];
      rootsToAttach.push(anchor);
      
      cluster.forEach(c => processedRoots.add(c.id));
      
      // Add others to output but NOT attached to God (they float next to spouse)
      cluster.forEach(c => {
        if (c.id !== anchor.id) {
           outputNodes.push(c); 
           processedIds.add(c.id);
        }
      });

    } else {
      rootsToAttach.push(root);
      processedRoots.add(root.id);
    }
  });

  const queue = [];

  // Attach Anchors to God
  rootsToAttach.forEach(root => {
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
      if (prevNode.rels.children) prevNode.rels.children.push(spacerId);
      
      outputNodes.push(spacerNode);
      processedIds.add(spacerId);
      parentId = spacerId;
    }

    const visualParent = outputNodes.find(n => n.id === parentId);
    if (visualParent.rels.children) visualParent.rels.children.push(root.id);
    
    const rootCopy = { ...root, rels: { ...root.rels, parents: [parentId] } };
    outputNodes.push(rootCopy);
    processedIds.add(root.id);
    
    queue.push(rootCopy);
  });

  // Traverse Down
  while (queue.length > 0) {
    const parent = queue.shift();
    
    if (parent.rels.children) {
      const originalChildren = parent.rels.children;
      parent.rels.children = []; 

      originalChildren.forEach(childId => {
        if (processedIds.has(childId)) {
          // Already added via another path. Do NOT add again.
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
  
  // Double check: Add anyone we missed (e.g. disconnected islands not reachable from main group)
  members.forEach(m => {
      if (!processedIds.has(m.id)) {
          // These are true orphans or disconnected spouses. Add them to God directly as fallback.
           // We treat them as roots essentially.
           if (!m.data.is_god_node && !m.data.is_spacer) {
               // Just add to output, don't link to God to avoid spiderweb mess if not needed
               // Or link to God if you want them visible.
               // Let's skip linking for now to avoid mess, they likely lack connections.
               outputNodes.push(m);
           }
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
