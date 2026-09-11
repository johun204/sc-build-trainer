/* SC 빌드오더 연습기 - 엔진 + UI */

let S = null; // 현재 게임 상태
let boSteps = []; // 선택된 빌드오더의 진행 상태
let tickTimer = null;

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1600);
}

// ---------- 상태 생성 ----------
function initState(raceId) {
  const race = RACES[raceId];
  const s = {
    raceId, race,
    time: 0,
    minerals: race.startMinerals,
    gas: race.startGas,
    gasWorkers: 0,
    supplyUsed: race.startSupplyUsed,
    supplyCap: race.startSupplyCap,
    buildingsByType: {},
    unitCounts: { [race.workerUnit]: race.startWorkers },
    zergLarva: raceId === 'zerg' ? { count: 3, timer: 0 } : null,
    zergActiveMorphs: [],
    mineralCarriers: [],
    gasCarriers: [],
    selectedBuildingType: race.mainBuildingId,
    log: [],
    speed: 1,
    nextInstId: 1,
  };
  s.buildingsByType[race.mainBuildingId] = [{ id: s.nextInstId++, status: 'ready', startAt: 0, doneAt: 0, queue: [], active: null }];
  return s;
}

// ---------- 조회 헬퍼 ----------
function instancesOf(typeId) { return S.buildingsByType[typeId] || []; }
function readyInstances(typeId) { return instancesOf(typeId).filter(i => i.status === 'ready'); }
function constructingInstances(typeId) { return instancesOf(typeId).filter(i => i.status === 'constructing'); }
function completedCount(typeId) { return readyInstances(typeId).length; }
function prereqMet(list) { return (list || []).every(id => completedCount(id) > 0); }
function totalWorkers() { return S.unitCounts[S.race.workerUnit] || 0; }
function mineralWorkers() { return Math.max(0, totalWorkers() - S.gasWorkers); }
function gasBuildingCount() { return completedCount(S.race.gasBuildingId); }
function effectiveGasWorkers() { return Math.min(S.gasWorkers, gasBuildingCount() * GAS_CAP_PER_BUILDING); }
function patches() { return PATCHES_PER_BASE * completedCount(S.race.mainBuildingId); }

function logAction(text) {
  S.log.push({ t: S.time, text });
  if (S.log.length > 60) S.log.shift();
  renderLog();
}

// ---------- 액션 ----------
function doBuild(typeId) {
  const b = S.race.buildings[typeId];
  if (!b) return;
  if (!prereqMet(b.prereq)) { toast('선행 건물이 필요합니다'); return; }
  if (S.minerals < b.mineral || S.gas < b.gas) { toast('자원이 부족합니다'); return; }
  if (b.consumesWorker && totalWorkers() <= 0) { toast('일꾼이 없습니다'); return; }
  S.minerals -= b.mineral;
  S.gas -= b.gas;
  if (b.consumesWorker) {
    S.unitCounts[S.race.workerUnit] -= 1;
    if (S.gasWorkers > totalWorkers()) S.gasWorkers = totalWorkers();
  }
  if (!S.buildingsByType[typeId]) S.buildingsByType[typeId] = [];
  S.buildingsByType[typeId].push({ id: S.nextInstId++, status: 'constructing', startAt: S.time, doneAt: S.time + b.time, queue: [], active: null });
  logAction(`${b.name} ${b.isAddon ? '건설(애드온)' : '착공'} — ${fmtTime(S.time)}`);
  checkBuildOrderStep({ kind: 'build', id: typeId });
  renderAll();
}

function cancelBuild(typeId, instId) {
  const list = S.buildingsByType[typeId] || [];
  const idx = list.findIndex(i => i.id === instId && i.status === 'constructing');
  if (idx === -1) return;
  const b = S.race.buildings[typeId];
  S.minerals += b.mineral;
  S.gas += b.gas;
  if (b.consumesWorker) S.unitCounts[S.race.workerUnit] = (S.unitCounts[S.race.workerUnit] || 0) + 1;
  list.splice(idx, 1);
  logAction(`${b.name} 건설 취소 (자원 환불) — ${fmtTime(S.time)}`);
  renderAll();
}

function doTrain(unitId) {
  const u = S.race.units[unitId];
  if (!u) return;
  if (!prereqMet(u.prereq)) { toast('테크(선행 건물)가 부족합니다'); return; }
  if (S.minerals < u.mineral || S.gas < u.gas) { toast('자원이 부족합니다'); return; }
  if (S.supplyUsed + u.supply > S.supplyCap) { toast('서플라이(인구수)가 부족합니다'); return; }

  if (S.raceId === 'zerg') {
    if (S.zergLarva.count <= 0) { toast('라바가 없습니다'); return; }
    S.zergLarva.count -= 1;
    S.zergActiveMorphs.push({ unitId, startAt: S.time, doneAt: S.time + u.time });
  } else {
    const list = readyInstances(u.from);
    if (list.length === 0) { toast('생산 건물이 없습니다'); return; }
    let best = null, bestLoad = Infinity;
    list.forEach(inst => {
      const load = inst.queue.length + (inst.active ? 1 : 0);
      if (load < 5 && load < bestLoad) { best = inst; bestLoad = load; }
    });
    if (!best) { toast('생산 대기열이 가득 찼습니다 (건물당 최대 5)'); return; }
    best.queue.push({ unitId });
  }
  S.minerals -= u.mineral;
  S.gas -= u.gas;
  S.supplyUsed += u.supply;
  logAction(`${u.name} 생산 시작 — ${fmtTime(S.time)}`);
  checkBuildOrderStep({ kind: 'train', id: unitId });
  renderAll();
}

function setGasWorkers(n) {
  S.gasWorkers = Math.max(0, Math.min(n, totalWorkers()));
  renderAll();
}

function selectBuildingType(typeId) {
  S.selectedBuildingType = typeId;
  renderProductionPanel();
  renderBuildingStatus();
}

// ---------- 채집: 일꾼 개체별 타이머로 8단위(1회 왕복분) 자원 전달 ----------
function resizeCarriers(list, targetCount) {
  while (list.length < targetCount) list.push({ nextAt: S.time + 0.4 + Math.random() * 1.6 });
  while (list.length > targetCount) list.pop();
}

function runCarriers(list, cycleTime, resourceKey) {
  if (cycleTime <= 0 || !isFinite(cycleTime)) return;
  list.forEach(c => {
    let guard = 0;
    while (S.time >= c.nextAt && guard < 50) {
      S[resourceKey] += MINERALS_PER_TRIP;
      c.nextAt += cycleTime;
      guard++;
    }
  });
}

// ---------- 틱 ----------
function tick(dt) {
  if (dt <= 0) return;
  S.time += dt;

  const mw = mineralWorkers();
  resizeCarriers(S.mineralCarriers, mw);
  const mRatePerWorker = mw > 0 ? mineralRatePerSec(S.raceId, mw, patches()) / mw : 0;
  runCarriers(S.mineralCarriers, mRatePerWorker > 0 ? MINERALS_PER_TRIP / mRatePerWorker : 0, 'minerals');

  const gw = effectiveGasWorkers();
  resizeCarriers(S.gasCarriers, gw);
  const gRatePerWorker = GAS_PER_MIN_PER_WORKER / 60;
  runCarriers(S.gasCarriers, MINERALS_PER_TRIP / gRatePerWorker, 'gas');

  // 건물 완공 + 생산 가능 건물의 유닛 큐 처리
  Object.entries(S.buildingsByType).forEach(([typeId, list]) => {
    const b = S.race.buildings[typeId];
    list.forEach(inst => {
      if (inst.status === 'constructing' && inst.doneAt <= S.time) {
        inst.status = 'ready';
        S.supplyCap += b.supply || 0;
      }
      if (inst.status === 'ready' && b.produces) {
        if (inst.active && inst.active.doneAt <= S.time) {
          onUnitComplete(inst.active.unitId);
          inst.active = null;
        }
        if (!inst.active && inst.queue.length > 0) {
          const item = inst.queue.shift();
          inst.active = { unitId: item.unitId, startAt: S.time, doneAt: S.time + S.race.units[item.unitId].time };
        }
      }
    });
  });

  if (S.raceId === 'zerg') {
    const cap = completedCount('hatchery') * LARVA_CAP_PER_HATCH;
    S.zergLarva.timer += dt;
    while (S.zergLarva.timer >= LARVA_SPAWN_INTERVAL) {
      S.zergLarva.timer -= LARVA_SPAWN_INTERVAL;
      S.zergLarva.count = Math.min(cap, S.zergLarva.count + 1);
    }
    if (S.zergLarva.count > cap) S.zergLarva.count = cap;
    S.zergActiveMorphs = S.zergActiveMorphs.filter(item => {
      if (item.doneAt <= S.time) { onUnitComplete(item.unitId); return false; }
      return true;
    });
  }

  renderAll();
}

function onUnitComplete(unitId) {
  const u = S.race.units[unitId];
  S.unitCounts[unitId] = (S.unitCounts[unitId] || 0) + (u.count || 1);
  if (u.supplyProvide) S.supplyCap += u.supplyProvide;
}

// ---------- 빌드오더 체크 ----------
function currentBuildOrder() {
  const id = document.getElementById('boSelect').value;
  return BUILD_ORDERS[S.raceId].find(b => b.id === id);
}

function checkBuildOrderStep(action) {
  const bo = currentBuildOrder();
  if (!bo) return;
  const idx = boSteps.findIndex((st, i) => !st.done && bo.steps[i].action.kind === action.kind && bo.steps[i].action.id === action.id);
  if (idx === -1) return;
  const trig = bo.steps[idx].trigger;
  const deltaSupply = trig.supply != null ? (S.supplyUsed - trig.supply) : null;
  const deltaTime = trig.time != null ? (S.time - trig.time) : null;
  boSteps[idx] = { done: true, actualTime: S.time, actualSupply: S.supplyUsed, deltaSupply, deltaTime };
  renderBuildOrder();
}

// ---------- 렌더링 ----------
function renderTop() {
  const mRate = mineralRatePerSec(S.raceId, mineralWorkers(), patches());
  const gRate = gasBuildingCount() > 0 ? gasRatePerSec(effectiveGasWorkers()) : 0;
  document.getElementById('rMinerals').textContent = Math.floor(S.minerals);
  document.getElementById('rMineralRate').textContent = `+${mRate.toFixed(1)}/초`;
  document.getElementById('rGas').textContent = Math.floor(S.gas);
  document.getElementById('rGasRate').textContent = `+${gRate.toFixed(1)}/초`;
  const supplyEl = document.getElementById('rSupply');
  supplyEl.textContent = `${S.supplyUsed}/${S.supplyCap}`;
  supplyEl.classList.toggle('over', S.supplyUsed >= S.supplyCap);
  document.getElementById('rWorkers').textContent = totalWorkers();
  document.getElementById('rTime').textContent = fmtTime(S.time);

  document.getElementById('gasCount').textContent = S.gasWorkers;
  const eff = effectiveGasWorkers();
  const waste = S.gasWorkers - eff;
  const gasInfoEl = document.getElementById('gasInfo');
  gasInfoEl.textContent = waste > 0 ? `(포화 ${eff} / 유휴 대기 ${waste} — 가스 건물당 3기가 최적)` : `(포화 ${gasBuildingCount() * GAS_CAP_PER_BUILDING})`;
  gasInfoEl.classList.toggle('warn', waste > 0);
}

function pctOf(startAt, doneAt) {
  if (doneAt <= startAt) return 100;
  return Math.max(0, Math.min(100, Math.round((S.time - startAt) / (doneAt - startAt) * 100)));
}

// ---------- 그래픽 리소스 (건물/유닛 아이콘 + 베이스 뷰) ----------
function shortLabel(name) { return name.replace(/\s*\(.*\)/, '').slice(0, 2); }
function iconSizeClass(typeId) {
  if (typeId === S.race.mainBuildingId) return 'size-main';
  if (S.race.buildings[typeId].isAddon) return 'size-addon';
  return 'size-normal';
}
function buildingIconHtml(typeId, extra, posClass) {
  const b = S.race.buildings[typeId];
  return `<div class="${posClass || ''} icon race-${S.raceId} ${iconSizeClass(typeId)}" title="${b.name}"><span>${shortLabel(b.name)}</span>${extra || ''}</div>`;
}

function renderBaseView() {
  const scene = document.getElementById('bvScene');
  const gasBuilt = gasBuildingCount() > 0;
  const mw = mineralWorkers();
  const gw = effectiveGasWorkers();
  const mRatePerWorker = mw > 0 ? mineralRatePerSec(S.raceId, mw, patches()) / mw : 0;
  const mCycle = mRatePerWorker > 0 ? MINERALS_PER_TRIP / mRatePerWorker : 4;
  const gCycle = MINERALS_PER_TRIP / (GAS_PER_MIN_PER_WORKER / 60);

  let html = buildingIconHtml(S.race.mainBuildingId, '', 'bv-base');
  html += `<div class="bv-patches">${'<div class="bv-patch"></div>'.repeat(PATCHES_PER_BASE)}</div>`;
  if (gasBuilt) html += `<div class="bv-gas">가스</div>`;

  for (let i = 0; i < mw; i++) {
    const dx = -30 + (i % PATCHES_PER_BASE) * 8;
    const delay = -((i / mw) * mCycle).toFixed(2);
    html += `<div class="bv-worker mineral" style="--dx:${dx}px; animation-duration:${mCycle.toFixed(2)}s; animation-delay:${delay}s"></div>`;
  }
  for (let i = 0; i < gw; i++) {
    const delay = -((i / gw) * gCycle).toFixed(2);
    html += `<div class="bv-worker gas" style="animation-duration:${gCycle.toFixed(2)}s; animation-delay:${delay}s"></div>`;
  }
  scene.innerHTML = html;

  const gallery = document.getElementById('bvGallery');
  const others = Object.entries(S.race.buildings).filter(([id]) => id !== S.race.mainBuildingId && instancesOf(id).length > 0);
  gallery.innerHTML = others.map(([id, b]) => {
    const ready = completedCount(id);
    const constructing = constructingInstances(id);
    let extra = '';
    if (ready > 1) extra += `<b class="bv-count">${ready}</b>`;
    if (constructing.length) extra += `<div class="bv-pct">${pctOf(constructing[0].startAt, constructing[0].doneAt)}%</div>`;
    return buildingIconHtml(id, extra);
  }).join('') || '<p class="hint">건설된 건물이 없습니다</p>';
}

function renderBuildingStatus() {
  const el = document.getElementById('buildingStatus');
  const entries = Object.entries(S.race.buildings).filter(([id]) => instancesOf(id).length > 0);
  el.innerHTML = entries.map(([id, b]) => {
    const ready = completedCount(id);
    const constructing = constructingInstances(id);
    const rows = constructing.map(inst => `
      <div class="bld-progress-row">
        <div class="pbar mini"><div class="pbar-fill" style="width:${pctOf(inst.startAt, inst.doneAt)}%"></div></div>
        <span class="bld-remain">${Math.max(0, Math.ceil(inst.doneAt - S.time))}초 남음</span>
        <button class="cancelbtn" data-cancel-type="${id}" data-cancel-id="${inst.id}">취소</button>
      </div>`).join('');
    const clickable = !!b.produces && ready > 0;
    const selected = S.selectedBuildingType === id;
    return `<div class="bld-card ${clickable ? 'clickable' : ''} ${selected ? 'selected' : ''}" ${clickable ? `data-select="${id}"` : ''}>
      <div class="bld-head"><span>${b.name}</span><span class="bldcount">${ready}${constructing.length ? ` (건설중 x${constructing.length})` : ''}</span></div>
      ${rows}
    </div>`;
  }).join('') || '<p class="hint">아직 건설된 건물이 없습니다</p>';
}

function renderUnitStatus() {
  const el = document.getElementById('unitStatus');
  const entries = Object.entries(S.unitCounts).filter(([, c]) => c > 0);
  el.innerHTML = entries.map(([id, c]) => {
    const u = S.race.units[id];
    return `<div class="unit-tile"><div class="icon race-${S.raceId} size-unit"><span>${shortLabel(u.name)}</span></div><span class="uname">${u.name}</span><span class="ucount">${c}</span></div>`;
  }).join('') || '<p class="hint">-</p>';
}

function renderLog() {
  const el = document.getElementById('logList');
  el.innerHTML = S.log.slice(-30).map(l => `<li><b>${fmtTime(l.t)}</b> ${l.text}</li>`).reverse().join('');
}

function renderBuildOrder() {
  const bo = currentBuildOrder();
  const listEl = document.getElementById('boList');
  const descEl = document.getElementById('boDesc');
  if (!bo) { listEl.innerHTML = ''; descEl.textContent = ''; return; }
  descEl.textContent = bo.desc;
  const firstPendingIdx = boSteps.findIndex(s => !s.done);
  listEl.innerHTML = bo.steps.map((step, i) => {
    const st = boSteps[i];
    const trigParts = [];
    if (step.trigger.supply != null) trigParts.push(`인구 ${step.trigger.supply}`);
    if (step.trigger.time != null) trigParts.push(fmtTime(step.trigger.time));
    if (step.trigger.minerals != null) trigParts.push(`미네랄 ${step.trigger.minerals}+`);
    const actionName = (step.action.kind === 'train' ? S.race.units[step.action.id] : S.race.buildings[step.action.id])?.name || step.action.id;
    let deltaHtml = '';
    if (st.done) {
      const bits = [];
      if (st.deltaSupply != null) bits.push(`인구 ${st.deltaSupply > 0 ? '+' : ''}${st.deltaSupply}`);
      if (st.deltaTime != null) bits.push(`시간 ${st.deltaTime > 0 ? '+' : ''}${Math.round(st.deltaTime)}초`);
      const good = st.deltaSupply == null || Math.abs(st.deltaSupply) <= 1;
      deltaHtml = `<span class="delta ${good ? 'good' : 'bad'}">실행: ${fmtTime(st.actualTime)} (${bits.join(', ') || '완료'})</span>`;
    }
    const cls = ['bo-step', st.done ? 'done' : '', (!st.done && i === firstPendingIdx) ? 'next' : ''].join(' ').trim();
    return `<li class="${cls}"><span class="trig">${trigParts.join(' / ')}</span>${actionName}<span class="note">${step.note || ''}</span>${deltaHtml}</li>`;
  }).join('');
}

function affordable(mineral, gas) { return S.minerals >= mineral && S.gas >= gas; }

function renderBuildGrid() {
  const buildEl = document.getElementById('buildGrid');
  buildEl.innerHTML = Object.entries(S.race.buildings).map(([id, b]) => {
    const ok = prereqMet(b.prereq) && affordable(b.mineral, b.gas);
    return `<button class="cmdbtn ${b.isAddon ? 'addon' : ''}" data-build="${id}" ${ok ? '' : 'disabled'}>
      <span>${b.name}</span>
      <span class="cost">${b.mineral}${b.gas ? '/' + b.gas : ''}${b.supply ? ' Su+' + b.supply : ''}</span>
    </button>`;
  }).join('');
}

function unitButtonHtml(id, u, requireLarva) {
  const ok = prereqMet(u.prereq) && affordable(u.mineral, u.gas) && (S.supplyUsed + u.supply <= S.supplyCap) && (!requireLarva || S.zergLarva.count > 0);
  return `<button class="cmdbtn" data-train="${id}" ${ok ? '' : 'disabled'}>
    <span>${u.name}</span>
    <span class="cost">${u.mineral}${u.gas ? '/' + u.gas : ''}</span>
  </button>`;
}

function renderProductionPanel() {
  const el = document.getElementById('prodPanel');
  const tabsEl = document.getElementById('prodTabs');

  if (S.raceId === 'zerg') {
    tabsEl.innerHTML = '';
    tabsEl.style.display = 'none';
    const hatchCount = completedCount('hatchery');
    const units = Object.entries(S.race.units).map(([id, u]) => unitButtonHtml(id, u, true)).join('');
    const morphs = S.zergActiveMorphs.map(m => {
      const u = S.race.units[m.unitId];
      return `<div class="queue-row"><span>${u.name}</span><div class="pbar"><div class="pbar-fill" style="width:${pctOf(m.startAt, m.doneAt)}%"></div></div></div>`;
    }).join('') || '<p class="hint">생산중인 유닛 없음</p>';
    el.innerHTML = `<div class="larva-info">라바 ${S.zergLarva.count}/${hatchCount * LARVA_CAP_PER_HATCH}</div><div class="cmd-grid">${units}</div><h3>생산 진행</h3><div class="queue-list">${morphs}</div>`;
    return;
  }

  tabsEl.style.display = '';
  const producerTypes = Object.entries(S.race.buildings).filter(([id, b]) => b.produces && completedCount(id) > 0);
  tabsEl.innerHTML = producerTypes.map(([id, b]) => `<button class="tabbtn ${S.selectedBuildingType === id ? 'active' : ''}" data-select="${id}">${b.name} (${completedCount(id)})</button>`).join('');

  const typeId = S.selectedBuildingType;
  if (!typeId || completedCount(typeId) <= 0) {
    el.innerHTML = '<p class="hint">위에서 생산할 건물을 선택하세요</p>';
    return;
  }
  const b = S.race.buildings[typeId];
  const units = b.produces.map(uid => unitButtonHtml(uid, S.race.units[uid], false)).join('');
  const rows = readyInstances(typeId).map((inst, i) => {
    if (inst.active) {
      const u = S.race.units[inst.active.unitId];
      const dots = inst.queue.length ? `<span class="qdots">대기 ${inst.queue.length}</span>` : '';
      return `<div class="queue-row"><span>#${i + 1} ${u.name}</span><div class="pbar"><div class="pbar-fill" style="width:${pctOf(inst.active.startAt, inst.active.doneAt)}%"></div></div>${dots}</div>`;
    }
    return `<div class="queue-row idle"><span>#${i + 1} 대기중(유휴)</span></div>`;
  }).join('');
  el.innerHTML = `<div class="cmd-grid">${units}</div><h3>${b.name} 생산 현황</h3><div class="queue-list">${rows}</div>`;
}

function renderAll() {
  renderTop();
  renderBaseView();
  renderBuildingStatus();
  renderUnitStatus();
  renderBuildGrid();
  renderProductionPanel();
}

// ---------- 셀렉트 박스 ----------
function populateRaceSelect() {
  const sel = document.getElementById('raceSelect');
  sel.innerHTML = Object.values(RACES).map(r => `<option value="${r.id}">${r.name}</option>`).join('');
}
function populateBoSelect() {
  const sel = document.getElementById('boSelect');
  sel.innerHTML = BUILD_ORDERS[S.raceId].map(b => `<option value="${b.id}">[${b.level}] ${b.name}</option>`).join('');
}

function resetGame(raceId) {
  S = initState(raceId);
  populateBoSelect();
  const bo = currentBuildOrder();
  boSteps = bo ? bo.steps.map(() => ({ done: false })) : [];
  renderAll();
  renderBuildOrder();
  renderLog();
}

// ---------- 이벤트 ----------
function wireEvents() {
  document.getElementById('raceSelect').addEventListener('change', e => {
    localStorage.setItem('sc-bo-race', e.target.value);
    resetGame(e.target.value);
  });
  document.getElementById('boSelect').addEventListener('change', () => {
    const bo = currentBuildOrder();
    boSteps = bo ? bo.steps.map(() => ({ done: false })) : [];
    renderBuildOrder();
  });
  document.getElementById('resetBtn').addEventListener('click', () => resetGame(S.raceId));

  document.getElementById('speedGroup').addEventListener('click', e => {
    const btn = e.target.closest('.spdbtn');
    if (!btn) return;
    S.speed = Number(btn.dataset.speed);
    document.querySelectorAll('.spdbtn').forEach(b => b.classList.toggle('active', b === btn));
  });

  document.getElementById('gasMinus').addEventListener('click', () => setGasWorkers(S.gasWorkers - 1));
  document.getElementById('gasPlus').addEventListener('click', () => setGasWorkers(S.gasWorkers + 1));

  document.getElementById('buildGrid').addEventListener('click', e => {
    const btn = e.target.closest('[data-build]');
    if (btn) doBuild(btn.dataset.build);
  });
  document.getElementById('prodPanel').addEventListener('click', e => {
    const btn = e.target.closest('[data-train]');
    if (btn) doTrain(btn.dataset.train);
  });
  document.getElementById('prodTabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-select]');
    if (btn) selectBuildingType(btn.dataset.select);
  });
  document.getElementById('buildingStatus').addEventListener('click', e => {
    const cancelBtn = e.target.closest('[data-cancel-type]');
    if (cancelBtn) { cancelBuild(cancelBtn.dataset.cancelType, Number(cancelBtn.dataset.cancelId)); return; }
    const btn = e.target.closest('[data-select]');
    if (btn) selectBuildingType(btn.dataset.select);
  });
}

// ---------- 게임 루프 ----------
function startLoop() {
  let last = performance.now();
  tickTimer = setInterval(() => {
    const now = performance.now();
    const realDt = (now - last) / 1000;
    last = now;
    tick(realDt * S.speed);
  }, 200);
}

// ---------- 초기화 ----------
function boot() {
  populateRaceSelect();
  const savedRace = localStorage.getItem('sc-bo-race') || 'terran';
  document.getElementById('raceSelect').value = savedRace;
  resetGame(savedRace);
  wireEvents();
  startLoop();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
