const STORAGE_KEY = 'knitting_scarf_counter_v1';

const STITCH_STYLES = {
  garter: {
    name: 'Vroubkový žerzej (Garter)',
    odd: 'Lichá řada (Líc): Všechna oka hladce.',
    even: 'Sudá řada (Rub): Všechna oka hladce. (Nekroutí se, ideální na šály.)'
  },
  stockinette: {
    name: 'Lícový žerzej (Stockinette)',
    odd: 'Lichá řada (Líc): Všechna oka hladce.',
    even: 'Sudá řada (Rub): Všechna oka obrace.'
  },
  rib1x1: {
    name: 'Pružný vzor 1×1 (Ribbing)',
    odd: 'Lichá řada: Opakovat *1 hladce, 1 obrace*.',
    even: 'Sudá řada: Plést oka tak, jak se jeví (hladké hladce, obrace obrace).'
  },
  rib2x2: {
    name: 'Pružný vzor 2×2 (Ribbing)',
    odd: 'Lichá řada: Opakovat *2 hladce, 2 obrace*.',
    even: 'Sudá řada: Plést oka tak, jak se jeví (2 hladce, 2 obrace).'
  },
  seed: {
    name: 'Rýžový / perličkový vzor',
    odd: 'Lichá řada: Opakovat *1 hladce, 1 obrace*.',
    even: 'Sudá řada: Střídat – nad hladkým obrace, nad obrace hladce.'
  },
  brioche: {
    name: 'Patentový vzor (Brioche)',
    odd: 'Lichá řada: *1 hladce, 1 oko sejmout s nahozením*.',
    even: 'Sudá řada: *Sejmuté oko s nahozením splést hladce, 1 sejmout s nahozením*.'
  }
};

function createEmptyState() {
  return {
    activeProjectId: null,
    projects: []
  };
}

let state = loadState();
let wakeLock = null;
let deferredInstallPrompt = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyState();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.projects)) return createEmptyState();
    return parsed;
  } catch {
    return createEmptyState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getActiveProject() {
  if (!state.projects.length) return null;
  return state.projects.find(p => p.id === state.activeProjectId) || state.projects[0];
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getContrastText(hex) {
  const clean = (hex || '#ffffff').replace('#', '');
  const r = parseInt(clean.substr(0, 2), 16) || 255;
  const g = parseInt(clean.substr(2, 2), 16) || 255;
  const b = parseInt(clean.substr(4, 2), 16) || 255;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 145 ? '#1f2421' : '#ffffff';
}

function openNewProjectModal(isFirstProject = false) {
  const styleSel = document.getElementById('newProjStyle');
  styleSel.innerHTML = Object.entries(STITCH_STYLES)
    .map(([key, val]) => `<option value="${key}">${val.name}</option>`)
    .join('');

  document.getElementById('newProjectModalTitle').textContent = isFirstProject
    ? 'Vytvořit první šálu'
    : 'Nová šála';
  document.getElementById('cancelNewProjBtn').classList.toggle('hidden', isFirstProject);

  updateNewProjPreview();
  const dialog = document.getElementById('newProjectDialog');
  if (!dialog.open) {
    dialog.showModal();
  }
}

function resolveColorForRow(project, rowNum) {
  const effectiveRow = Math.max(1, rowNum);
  const findColor = (id) => project.palette.find(c => c.id === id) || { name: 'Neznámá barva', hex: '#999999' };

  if (!project.rules || project.rules.length === 0) {
    const fallback = project.palette[0] || { name: 'Výchozí příze', hex: '#d97746' };
    return {
      color: fallback,
      rowInStripe: effectiveRow,
      stripeTotal: project.targetRows || effectiveRow,
      nextColor: null,
      rowsUntilChange: null,
      outOfBounds: false
    };
  }

  let cursor = 0;

  for (let rIdx = 0; rIdx < project.rules.length; rIdx++) {
    const rule = project.rules[rIdx];

    if (rule.type === 'solid') {
      const len = Math.max(1, Number(rule.rows) || 1);
      if (effectiveRow <= cursor + len) {
        const rowInStripe = effectiveRow - cursor;
        const rowsUntilChange = len - rowInStripe + 1;
        const nextColor = getFirstColorOfNextRule(project, rIdx);
        return {
          color: findColor(rule.colorId),
          rowInStripe,
          stripeTotal: len,
          nextColor,
          rowsUntilChange,
          outOfBounds: false
        };
      }
      cursor += len;
    } else if (rule.type === 'sequence' && rule.steps && rule.steps.length > 0) {
      const cycleRows = rule.steps.reduce((acc, s) => acc + Math.max(1, Number(s.rows) || 1), 0);
      const totalRuleRows = rule.repeatUntilEnd
        ? Math.max(project.targetRows || 1000, effectiveRow + cycleRows)
        : cycleRows * Math.max(1, Number(rule.repeatCount) || 1);

      if (effectiveRow <= cursor + totalRuleRows) {
        const offsetInRule = effectiveRow - cursor - 1;
        const cycleIndex = Math.floor(offsetInRule / cycleRows);
        let offsetInCycle = offsetInRule % cycleRows;

        for (let sIdx = 0; sIdx < rule.steps.length; sIdx++) {
          const step = rule.steps[sIdx];
          const stepLen = Math.max(1, Number(step.rows) || 1);
          if (offsetInCycle < stepLen) {
            const rowInStripe = offsetInCycle + 1;
            const rowsUntilChange = stepLen - offsetInCycle;

            let nextColor = null;
            if (sIdx + 1 < rule.steps.length) {
              nextColor = findColor(rule.steps[sIdx + 1].colorId);
            } else {
              const maxCycles = rule.repeatUntilEnd ? Infinity : Math.max(1, Number(rule.repeatCount) || 1);
              if (cycleIndex + 1 < maxCycles) {
                nextColor = findColor(rule.steps[0].colorId);
              } else {
                nextColor = getFirstColorOfNextRule(project, rIdx);
              }
            }

            return {
              color: findColor(step.colorId),
              rowInStripe,
              stripeTotal: stepLen,
              nextColor,
              rowsUntilChange,
              outOfBounds: false
            };
          }
          offsetInCycle -= stepLen;
        }
      }
      cursor += totalRuleRows;
    }
  }

  const lastColor = project.palette[project.palette.length - 1] || { name: 'Konec vzoru', hex: '#888888' };
  return {
    color: lastColor,
    rowInStripe: effectiveRow - cursor,
    stripeTotal: null,
    nextColor: null,
    rowsUntilChange: null,
    outOfBounds: true
  };
}

function getFirstColorOfNextRule(project, currentRuleIdx) {
  const findColor = (id) => project.palette.find(c => c.id === id) || null;
  for (let i = currentRuleIdx + 1; i < project.rules.length; i++) {
    const next = project.rules[i];
    if (next.type === 'solid') return findColor(next.colorId);
    if (next.type === 'sequence' && next.steps && next.steps.length > 0) {
      return findColor(next.steps[0].colorId);
    }
  }
  return null;
}

function buildVisualSegments(project) {
  const target = Math.max(1, Number(project.targetRows) || 100);
  const findHex = (id) => (project.palette.find(c => c.id === id) || { hex: '#b8b0a4' }).hex;
  const segments = [];
  let filled = 0;

  for (const rule of project.rules || []) {
    if (filled >= target) break;
    if (rule.type === 'solid') {
      const len = Math.min(target - filled, Math.max(1, Number(rule.rows) || 1));
      segments.push({ hex: findHex(rule.colorId), rows: len });
      filled += len;
    } else if (rule.type === 'sequence' && rule.steps && rule.steps.length > 0) {
      const maxReps = rule.repeatUntilEnd ? 999 : Math.max(1, Number(rule.repeatCount) || 1);
      for (let r = 0; r < maxReps && filled < target; r++) {
        for (const step of rule.steps) {
          if (filled >= target) break;
          const len = Math.min(target - filled, Math.max(1, Number(step.rows) || 1));
          segments.push({ hex: findHex(step.colorId), rows: len });
          filled += len;
        }
      }
    }
  }

  if (filled < target) {
    segments.push({ hex: '#d5cec2', rows: target - filled });
  }
  return { segments, total: target };
}

function renderAll() {
  const project = getActiveProject();
  const isEmpty = !project;

  document.getElementById('emptyStateView').classList.toggle('hidden', !isEmpty);
  document.getElementById('mainContent').classList.toggle('hidden', isEmpty);
  document.getElementById('bottomNav').classList.toggle('hidden', isEmpty);
  document.getElementById('projectSelect').disabled = isEmpty;

  renderProjectSelector();

  if (isEmpty) {
    return;
  }

  renderCounterTab(project);
  renderColorsTab(project);
  renderSettingsTab(project);
}

function renderProjectSelector() {
  const select = document.getElementById('projectSelect');
  if (!state.projects.length) {
    select.innerHTML = `<option value="">Žádná rozpracovaná šála</option>`;
    return;
  }
  select.innerHTML = state.projects
    .map(p => `<option value="${escapeHtml(p.id)}" ${p.id === state.activeProjectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
    .join('');
}

function renderCounterTab(project) {
  const row = Number(project.currentRow) || 0;
  const displayRowForRules = row === 0 ? 1 : row;

  const colorInfo = resolveColorForRow(project, displayRowForRules);
  const banner = document.getElementById('activeColorCard');
  const swatch = document.getElementById('activeColorSwatch');
  const nameEl = document.getElementById('activeColorName');
  const badgeEl = document.getElementById('stripeProgressBadge');
  const nextHintEl = document.getElementById('nextColorHint');

  const bgHex = colorInfo.color.hex;
  banner.style.backgroundColor = bgHex;
  banner.style.color = getContrastText(bgHex);
  swatch.style.backgroundColor = bgHex;

  nameEl.textContent = row === 0
    ? `Připraveno: ${colorInfo.color.name}`
    : colorInfo.color.name;

  if (colorInfo.outOfBounds) {
    badgeEl.textContent = 'Mimo definovaná pravidla';
    nextHintEl.textContent = 'Přidejte další pravidlo barev';
  } else {
    badgeEl.textContent = row === 0
      ? `Začátek (pruh ${colorInfo.stripeTotal} řad)`
      : `Řada ${colorInfo.rowInStripe} z ${colorInfo.stripeTotal} v pruhu`;

    if (colorInfo.nextColor && colorInfo.rowsUntilChange !== null) {
      const rem = row === 0 ? colorInfo.stripeTotal : colorInfo.rowsUntilChange - 1;
      nextHintEl.textContent = rem === 0
        ? `Příští řada: ${colorInfo.nextColor.name}`
        : `Za ${rem} ř.: ${colorInfo.nextColor.name}`;
    } else {
      nextHintEl.textContent = 'Poslední barevný blok';
    }
  }

  const styleObj = STITCH_STYLES[project.stitchStyle] || STITCH_STYLES.garter;
  const nextRowToKnit = row === 0 ? 1 : row;
  const isOdd = nextRowToKnit % 2 === 1;

  document.getElementById('stitchStyleTitle').textContent = styleObj.name;
  document.getElementById('rowSideBadge').textContent = isOdd ? 'Lichá řada • Líc' : 'Sudá řada • Rub';
  document.getElementById('stitchRowInstruction').textContent = isOdd ? styleObj.odd : styleObj.even;

  const mapEl = document.getElementById('scarfColorMap');
  const { segments, total } = buildVisualSegments(project);
  const progressPct = Math.min(100, Math.round((row / total) * 100));
  document.getElementById('scarfMapPercent').textContent = `${progressPct} % (${row} / ${total} ř.)`;

  mapEl.innerHTML = segments
    .map(seg => `<div class="scarf-map-segment" style="width:${(seg.rows / total) * 100}%;background:${seg.hex}"></div>`)
    .join('') + `<div class="scarf-map-marker" style="left:${progressPct}%"></div>`;

  const gSts = Math.max(1, Number(project.gaugeStitches) || 20);
  const gRows = Math.max(1, Number(project.gaugeRows) || 26);
  const castOn = Math.max(1, Number(project.castOnStitches) || 50);
  const targetRows = Math.max(1, Number(project.targetRows) || Math.round((project.targetLengthCm / 10) * gRows));

  const currentLengthCm = ((row / gRows) * 10).toFixed(1);
  const expectedTotalLengthCm = ((targetRows / gRows) * 10).toFixed(0);
  const actualWidthCm = ((castOn / gSts) * 10).toFixed(1);
  const remainingRows = Math.max(0, targetRows - row);
  const totalStitchesKnitted = (row * castOn).toLocaleString('cs-CZ');

  document.getElementById('estLengthVal').textContent = `${currentLengthCm} / ${expectedTotalLengthCm} cm`;
  document.getElementById('remainingRowsVal').textContent = remainingRows === 0 ? 'Hotovo! 🎉' : `${remainingRows} řad`;
  document.getElementById('widthInfoVal').textContent = `${castOn} ok (~${actualWidthCm} cm)`;
  document.getElementById('totalStitchesVal').textContent = `${totalStitchesKnitted} ok`;

  document.getElementById('currentRowNumber').textContent = row;
}

function renderColorsTab(project) {
  const paletteEl = document.getElementById('paletteList');
  paletteEl.innerHTML = project.palette
    .map(c => `
      <div class="palette-chip">
        <span class="chip-color" style="background:${c.hex}"></span>
        <span>${escapeHtml(c.name)}</span>
        ${project.palette.length > 1 ? `<button class="chip-del" data-del-color="${c.id}" title="Odebrat barvu">✕</button>` : ''}
      </div>
    `)
    .join('');

  const rulesEl = document.getElementById('rulesList');
  if (!project.rules || project.rules.length === 0) {
    rulesEl.innerHTML = `<p class="helper-text">Zatím nejsou nastavena žádná barevná pravidla.</p>`;
    return;
  }

  let startRow = 1;
  rulesEl.innerHTML = project.rules
    .map((rule, idx) => {
      const findColor = (id) => project.palette.find(c => c.id === id) || { name: 'Barva', hex: '#888' };
      let rangeText = '';
      let descText = '';
      let pillsHtml = '';

      if (rule.type === 'solid') {
        const len = Math.max(1, Number(rule.rows) || 1);
        const endRow = startRow + len - 1;
        const col = findColor(rule.colorId);
        rangeText = `Řady ${startRow} – ${endRow} (${len} ř.)`;
        descText = `Jedna barva: ${escapeHtml(col.name)}`;
        pillsHtml = `<span class="mini-stripe-pill"><span class="chip-color" style="background:${col.hex}"></span>${len}× ${escapeHtml(col.name)}</span>`;
        startRow = endRow + 1;
      } else {
        const cycleRows = rule.steps.reduce((acc, s) => acc + Math.max(1, Number(s.rows) || 1), 0);
        if (rule.repeatUntilEnd) {
          rangeText = `Od řady ${startRow} až do konce šály`;
          descText = `Sekvence (${cycleRows} ř.) opakovat do konce`;
        } else {
          const reps = Math.max(1, Number(rule.repeatCount) || 1);
          const totalLen = cycleRows * reps;
          const endRow = startRow + totalLen - 1;
          rangeText = `Řady ${startRow} – ${endRow} (${reps}× sekvence)`;
          descText = `Sekvenci opakovat ${reps}×`;
          startRow = endRow + 1;
        }
        pillsHtml = rule.steps
          .map(s => {
            const col = findColor(s.colorId);
            return `<span class="mini-stripe-pill"><span class="chip-color" style="background:${col.hex}"></span>${s.rows}× ${escapeHtml(col.name)}</span>`;
          })
          .join('');
      }

      return `
        <div class="rule-item">
          <div>
            <div class="rule-range">${rangeText}</div>
            <div class="rule-desc">${descText}</div>
            <div class="rule-swatches">${pillsHtml}</div>
          </div>
          <div class="rule-actions">
            ${idx > 0 ? `<button class="btn-tiny" data-move-rule="${idx}" data-dir="-1" title="Posunout nahoru">↑</button>` : ''}
            ${idx < project.rules.length - 1 ? `<button class="btn-tiny" data-move-rule="${idx}" data-dir="1" title="Posunout dolů">↓</button>` : ''}
            <button class="btn-tiny" data-del-rule="${idx}" title="Smazat pravidlo">🗑</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderSettingsTab(project) {
  const styleSelect = document.getElementById('editStitchStyle');
  styleSelect.innerHTML = Object.entries(STITCH_STYLES)
    .map(([key, val]) => `<option value="${key}" ${project.stitchStyle === key ? 'selected' : ''}>${val.name}</option>`)
    .join('');

  document.getElementById('editName').value = project.name;
  document.getElementById('editNeedles').value = project.needleSize || '';
  document.getElementById('editYarnWeight').value = project.yarnWeight || 'Worsted / Aran (střední)';
  document.getElementById('editGaugeStitches').value = project.gaugeStitches;
  document.getElementById('editGaugeRows').value = project.gaugeRows;
  document.getElementById('editTargetWidth').value = project.targetWidthCm;
  document.getElementById('editTargetLength').value = project.targetLengthCm;
  document.getElementById('editCastOn').value = project.castOnStitches;
  document.getElementById('editTargetRows').value = project.targetRows;
  updateEditGaugeHint();
}

function updateEditGaugeHint() {
  const gSts = Math.max(1, Number(document.getElementById('editGaugeStitches').value) || 20);
  const gRows = Math.max(1, Number(document.getElementById('editGaugeRows').value) || 26);
  const width = Math.max(1, Number(document.getElementById('editTargetWidth').value) || 25);
  const length = Math.max(1, Number(document.getElementById('editTargetLength').value) || 170);

  const recStitches = Math.round((width / 10) * gSts);
  const recRows = Math.round((length / 10) * gRows);
  document.getElementById('gaugeCalcHint').textContent =
    `Podle zkušebního vzorku odpovídá ${width} × ${length} cm přesně ${recStitches} nahozeným okům a ${recRows} řadám.`;
}

function bindEvents() {
  document.getElementById('projectSelect').addEventListener('change', (e) => {
    state.activeProjectId = e.target.value;
    saveState();
    renderAll();
  });

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  document.getElementById('incrementBtn').addEventListener('click', () => {
    const project = getActiveProject();
    if (!project) return;
    project.currentRow = (Number(project.currentRow) || 0) + 1;
    if (navigator.vibrate) navigator.vibrate(25);
    saveState();
    renderCounterTab(project);
  });

  document.getElementById('decrementBtn').addEventListener('click', () => {
    const project = getActiveProject();
    if (!project) return;
    project.currentRow = Math.max(0, (Number(project.currentRow) || 0) - 1);
    if (navigator.vibrate) navigator.vibrate(15);
    saveState();
    renderCounterTab(project);
  });

  document.getElementById('resetRowBtn').addEventListener('click', () => {
    const project = getActiveProject();
    if (!project || project.currentRow === 0) return;
    if (confirm('Opravdu vynulovat počitadlo řádků na 0?')) {
      project.currentRow = 0;
      saveState();
      renderCounterTab(project);
    }
  });

  document.getElementById('manualRowBtn').addEventListener('click', () => {
    const project = getActiveProject();
    if (!project) return;
    document.getElementById('manualRowInput').value = project.currentRow;
    document.getElementById('manualRowDialog').showModal();
  });

  document.getElementById('manualRowForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const project = getActiveProject();
    if (!project) return;
    const val = Math.max(0, parseInt(document.getElementById('manualRowInput').value, 10) || 0);
    project.currentRow = val;
    saveState();
    renderCounterTab(project);
    document.getElementById('manualRowDialog').close();
  });

  document.querySelectorAll('[data-close-dialog]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.closeDialog).close();
    });
  });

  // Wake Lock
  document.getElementById('wakeLockBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!('wakeLock' in navigator)) {
      alert('Váš prohlížeč nepodporuje zámek zhasínání displeje.');
      return;
    }
    try {
      if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
        btn.classList.remove('active-lock');
        btn.setAttribute('aria-pressed', 'false');
      } else {
        wakeLock = await navigator.wakeLock.request('screen');
        btn.classList.add('active-lock');
        btn.setAttribute('aria-pressed', 'true');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
          btn.classList.remove('active-lock');
        });
      }
    } catch {
      alert('Nepodařilo se aktivovat stálé podsvícení displeje.');
    }
  });

  // PWA Instalace přes tlačítko v horní liště (Chrome / Edge / Android)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById('installAppBtn').classList.remove('hidden');
  });

  document.getElementById('installAppBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('installAppBtn').classList.add('hidden');
  });

  // Paleta barev
  document.getElementById('addColorForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const project = getActiveProject();
    if (!project) return;
    const hex = document.getElementById('newColorHex').value;
    const nameInput = document.getElementById('newColorName');
    const name = nameInput.value.trim();
    if (!name) return;

    project.palette.push({ id: 'col_' + Date.now(), name, hex });
    nameInput.value = '';
    saveState();
    renderAll();
  });

  document.getElementById('paletteList').addEventListener('click', (e) => {
    const delId = e.target.dataset.delColor;
    if (!delId) return;
    const project = getActiveProject();
    if (!project || project.palette.length <= 1) return;
    project.palette = project.palette.filter(c => c.id !== delId);
    saveState();
    renderAll();
  });

  // Barevná pravidla
  document.getElementById('openRuleModalBtn').addEventListener('click', () => {
    const project = getActiveProject();
    if (!project) return;
    const solidSelect = document.getElementById('solidColorSelect');
    solidSelect.innerHTML = project.palette
      .map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
      .join('');

    const stepsContainer = document.getElementById('seqStepsContainer');
    stepsContainer.innerHTML = '';
    addSequenceStepRow(project, project.palette[0]?.id, 2);
    if (project.palette[1]) {
      addSequenceStepRow(project, project.palette[1].id, 2);
    }

    document.getElementById('ruleDialog').showModal();
  });

  document.getElementById('ruleTypeSelect').addEventListener('change', (e) => {
    const isSolid = e.target.value === 'solid';
    document.getElementById('solidRuleFields').classList.toggle('hidden', !isSolid);
    document.getElementById('sequenceRuleFields').classList.toggle('hidden', isSolid);
  });

  document.getElementById('seqRepeatInfinite').addEventListener('change', (e) => {
    document.getElementById('seqRepeatCountWrap').classList.toggle('hidden', e.target.checked);
  });

  document.getElementById('addSeqStepBtn').addEventListener('click', () => {
    const project = getActiveProject();
    if (!project) return;
    addSequenceStepRow(project, project.palette[0]?.id, 2);
  });

  document.getElementById('ruleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const project = getActiveProject();
    if (!project) return;
    const type = document.getElementById('ruleTypeSelect').value;

    if (type === 'solid') {
      const colorId = document.getElementById('solidColorSelect').value;
      const rows = Math.max(1, parseInt(document.getElementById('solidRowsInput').value, 10) || 1);
      project.rules.push({ id: 'rule_' + Date.now(), type: 'solid', colorId, rows });
    } else {
      const stepEls = Array.from(document.querySelectorAll('.seq-step-row'));
      const steps = stepEls.map(el => ({
        colorId: el.querySelector('.step-color').value,
        rows: Math.max(1, parseInt(el.querySelector('.step-rows').value, 10) || 1)
      }));
      if (steps.length === 0) return;

      const repeatUntilEnd = document.getElementById('seqRepeatInfinite').checked;
      const repeatCount = Math.max(1, parseInt(document.getElementById('seqRepeatCount').value, 10) || 1);

      project.rules.push({
        id: 'rule_' + Date.now(),
        type: 'sequence',
        steps,
        repeatCount,
        repeatUntilEnd
      });
    }

    saveState();
    renderAll();
    document.getElementById('ruleDialog').close();
  });

  document.getElementById('rulesList').addEventListener('click', (e) => {
    const project = getActiveProject();
    if (!project) return;
    const delIdx = e.target.dataset.delRule;
    if (delIdx !== undefined) {
      project.rules.splice(Number(delIdx), 1);
      saveState();
      renderAll();
      return;
    }

    const moveIdx = e.target.dataset.moveRule;
    if (moveIdx !== undefined) {
      const idx = Number(moveIdx);
      const dir = Number(e.target.dataset.dir);
      const targetIdx = idx + dir;
      if (targetIdx >= 0 && targetIdx < project.rules.length) {
        const temp = project.rules[idx];
        project.rules[idx] = project.rules[targetIdx];
        project.rules[targetIdx] = temp;
        saveState();
        renderAll();
      }
    }
  });

  // Přepočet Gauge v nastavení
  ['editGaugeStitches', 'editTargetWidth'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      const gSts = Math.max(1, Number(document.getElementById('editGaugeStitches').value) || 20);
      const width = Math.max(1, Number(document.getElementById('editTargetWidth').value) || 25);
      document.getElementById('editCastOn').value = Math.round((width / 10) * gSts);
      updateEditGaugeHint();
    });
  });

  ['editGaugeRows', 'editTargetLength'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      const gRows = Math.max(1, Number(document.getElementById('editGaugeRows').value) || 26);
      const length = Math.max(1, Number(document.getElementById('editTargetLength').value) || 170);
      document.getElementById('editTargetRows').value = Math.round((length / 10) * gRows);
      updateEditGaugeHint();
    });
  });

  document.getElementById('editProjectForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const project = getActiveProject();
    if (!project) return;
    project.name = document.getElementById('editName').value.trim() || 'Šála';
    project.needleSize = document.getElementById('editNeedles').value.trim();
    project.yarnWeight = document.getElementById('editYarnWeight').value;
    project.stitchStyle = document.getElementById('editStitchStyle').value;
    project.gaugeStitches = Math.max(1, Number(document.getElementById('editGaugeStitches').value) || 20);
    project.gaugeRows = Math.max(1, Number(document.getElementById('editGaugeRows').value) || 26);
    project.targetWidthCm = Math.max(1, Number(document.getElementById('editTargetWidth').value) || 25);
    project.targetLengthCm = Math.max(1, Number(document.getElementById('editTargetLength').value) || 170);
    project.castOnStitches = Math.max(1, parseInt(document.getElementById('editCastOn').value, 10) || 50);
    project.targetRows = Math.max(1, parseInt(document.getElementById('editTargetRows').value, 10) || 440);

    saveState();
    renderAll();
    alert('Parametry šály byly uloženy.');
  });

  document.getElementById('deleteProjectBtn').addEventListener('click', () => {
    const project = getActiveProject();
    if (!project) return;
    if (confirm(`Opravdu smazat šálu „${project.name}“?`)) {
      state.projects = state.projects.filter(p => p.id !== project.id);
      state.activeProjectId = state.projects[0]?.id || null;
      saveState();
      renderAll();
      if (!state.projects.length) {
        openNewProjectModal(true);
      }
    }
  });

  // Tlačítka pro vytvoření nové šály
  document.getElementById('newProjectBtn').addEventListener('click', () => {
    openNewProjectModal(state.projects.length === 0);
  });

  document.getElementById('emptyCreateBtn').addEventListener('click', () => {
    openNewProjectModal(true);
  });

  ['newProjGaugeSts', 'newProjGaugeRows', 'newProjWidth', 'newProjLength'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateNewProjPreview);
  });

  document.getElementById('newProjectForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const gSts = Math.max(1, Number(document.getElementById('newProjGaugeSts').value) || 20);
    const gRows = Math.max(1, Number(document.getElementById('newProjGaugeRows').value) || 26);
    const width = Math.max(5, Number(document.getElementById('newProjWidth').value) || 25);
    const length = Math.max(20, Number(document.getElementById('newProjLength').value) || 180);

    const newId = 'proj_' + Date.now();
    const defaultColorId = 'col_' + Date.now();

    state.projects.push({
      id: newId,
      name: document.getElementById('newProjName').value.trim() || 'Nová šála',
      needleSize: document.getElementById('newProjNeedles').value.trim() || '4.5 mm',
      yarnWeight: document.getElementById('newProjYarn').value,
      stitchStyle: document.getElementById('newProjStyle').value,
      gaugeStitches: gSts,
      gaugeRows: gRows,
      targetWidthCm: width,
      targetLengthCm: length,
      castOnStitches: Math.round((width / 10) * gSts),
      targetRows: Math.round((length / 10) * gRows),
      currentRow: 0,
      palette: [{ id: defaultColorId, name: 'Základní příze', hex: '#d97746' }],
      rules: []
    });

    state.activeProjectId = newId;
    saveState();
    renderAll();
    document.getElementById('newProjectDialog').close();
    e.target.reset();
  });
}

function updateNewProjPreview() {
  const gSts = Math.max(1, Number(document.getElementById('newProjGaugeSts').value) || 20);
  const gRows = Math.max(1, Number(document.getElementById('newProjGaugeRows').value) || 26);
  const width = Math.max(1, Number(document.getElementById('newProjWidth').value) || 25);
  const length = Math.max(1, Number(document.getElementById('newProjLength').value) || 180);

  const castOn = Math.round((width / 10) * gSts);
  const rows = Math.round((length / 10) * gRows);
  document.getElementById('newProjPreviewCalc').textContent =
    `Výpočet podle Gauge: nahodit ${castOn} ok • cílový počet ${rows} řad.`;
}

function addSequenceStepRow(project, selectedColorId, defaultRows = 2) {
  const container = document.getElementById('seqStepsContainer');
  const rowEl = document.createElement('div');
  rowEl.className = 'seq-step-row';

  const options = project.palette
    .map(c => `<option value="${c.id}" ${c.id === selectedColorId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
    .join('');

  rowEl.innerHTML = `
    <select class="step-color">${options}</select>
    <input type="number" class="step-rows" min="1" max="500" value="${defaultRows}" title="Počet řádků" />
    <button type="button" class="btn-tiny remove-step" title="Odebrat krok">✕</button>
  `;

  rowEl.querySelector('.remove-step').addEventListener('click', () => {
    if (container.children.length > 1) rowEl.remove();
  });

  container.appendChild(rowEl);
}

// Registrace Service Workeru
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(err => {
      console.warn('Registrace Service Workeru selhala:', err);
    });
  });
}

bindEvents();
renderAll();

// Pokud při prvním spuštění není žádná šála, rovnou otevři dialog pro vytvoření
if (state.projects.length === 0) {
  openNewProjectModal(true);
}