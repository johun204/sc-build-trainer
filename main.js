/* SC 빌드오더 연습기 - 엔진 + UI */

let S = null; // 현재 게임 상태
let boSteps = []; // 선택된 빌드오더의 진행 상태
let tickTimer = null;
const PROTOSS_WARP_INTERRUPT = 1.5; // 프로토스 일꾼: 건물 워프 시작 후 복귀까지 걸리는 짧은 시간(초)

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toast(msg, ms) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms || 1600);
}

// ---------- 일꾼 개체 ----------
function makeWorker() {
  return {
    id: S.nextWorkerId++,
    job: 'mineral', // 'mineral' | 'gas' | 'building' | 'scout'
    patchIndex: 0,
    state: 'toResource', // toResource | waiting | gathering | toBase | building | scouting
    stateStartAt: S.time,
    stateEndAt: S.time,
    buildTypeId: null,
    buildInstId: null,
  };
}
function workersByJob(job) { return S.workers.filter(w => w.job === job); }
function totalPatches() { return PATCHES_PER_BASE * completedCount(S.race.mainBuildingId); }
function patchLoad(i) { return S.workers.filter(w => w.job === 'mineral' && w.patchIndex === i).length; }
function assignToPatch(w) {
  const n = totalPatches();
  let best = 0, bestLoad = Infinity;
  for (let i = 0; i < n; i++) { const l = patchLoad(i); if (l < bestLoad) { bestLoad = l; best = i; } }
  w.job = 'mineral';
  w.patchIndex = best;
  w.buildTypeId = null; w.buildInstId = null;
  w.state = 'toResource';
  w.stateStartAt = S.time;
  w.stateEndAt = S.time + travelOneWaySec(S.raceId);
}
function gasCapacity() { return gasBuildingCount() * GAS_CAP_PER_BUILDING; }
function assignToGas(w) {
  w.job = 'gas';
  w.patchIndex = null;
  w.buildTypeId = null; w.buildInstId = null;
  w.state = 'toResource';
  w.stateStartAt = S.time;
  w.stateEndAt = S.time + gasTravelOneWaySec();
}
function pickAvailableWorker() {
  return S.workers.find(w => w.job === 'mineral') || S.workers.find(w => w.job === 'gas') || null;
}
// 저그의 레어/하이브 변태(consumesWorker:false)만 예외 - 드론이 아니라 기존 건물 자체가 변태하므로 일꾼이 전혀 필요 없음
function buildingNeedsWorker(b) { return !(S && S.raceId === 'zerg' && b.consumesWorker === false); }

// ---------- 상태 생성 ----------
function initState(raceId) {
  const race = RACES[raceId];
  const s = {
    raceId, race,
    time: 0,
    minerals: race.startMinerals,
    gas: race.startGas,
    supplyUsed: race.startSupplyUsed,
    supplyCap: race.startSupplyCap,
    buildingsByType: {},
    unitCounts: {},
    zergLarva: raceId === 'zerg' ? { count: 3, timer: 0 } : null,
    zergActiveMorphs: [],
    workers: [],
    nextWorkerId: 1,
    selectedBuildingType: race.mainBuildingId,
    log: [],
    speed: 1,
    nextInstId: 1,
  };
  s.buildingsByType[race.mainBuildingId] = [{ id: s.nextInstId++, status: 'ready', startAt: 0, doneAt: 0, queue: [], active: null }];
  S = s; // assignToPatch 등 헬퍼가 전역 S를 참조하므로 미리 연결
  for (let i = 0; i < race.startWorkers; i++) {
    const w = makeWorker();
    assignToPatch(w);
    s.workers.push(w);
  }
  return s;
}

// ---------- 조회 헬퍼 ----------
function instancesOf(typeId) { return S.buildingsByType[typeId] || []; }
function readyInstances(typeId) { return instancesOf(typeId).filter(i => i.status === 'ready'); }
function constructingInstances(typeId) { return instancesOf(typeId).filter(i => i.status === 'constructing'); }
function completedCount(typeId) { return readyInstances(typeId).length; }
function prereqMet(list) { return (list || []).every(id => completedCount(id) > 0); }
function totalWorkers() { return S.workers.length; }
function mineralWorkerCount() { return workersByJob('mineral').length; }
function gasWorkerCount() { return workersByJob('gas').length; }
function gasBuildingCount() { return completedCount(S.race.gasBuildingId); }
function effectiveGasWorkers() { return Math.min(gasWorkerCount(), gasCapacity()); }
function patches() { return totalPatches(); }

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
  const needsWorker = buildingNeedsWorker(b);
  const builder = needsWorker ? pickAvailableWorker() : null;
  if (needsWorker && !builder) { toast('일꾼이 없습니다'); return; }

  S.minerals -= b.mineral;
  S.gas -= b.gas;
  if (!S.buildingsByType[typeId]) S.buildingsByType[typeId] = [];
  const inst = { id: S.nextInstId++, status: 'constructing', startAt: S.time, doneAt: S.time + b.time, queue: [], active: null };
  S.buildingsByType[typeId].push(inst);

  if (S.raceId === 'zerg' && b.consumesWorker) {
    S.workers.splice(S.workers.indexOf(builder), 1); // 드론이 건물로 변태 - 완전히 소모
  } else if (needsWorker) {
    builder.job = 'building';
    builder.buildTypeId = typeId;
    builder.buildInstId = inst.id;
    builder.state = 'building';
    builder.stateStartAt = S.time;
    builder.stateEndAt = S.raceId === 'protoss' ? S.time + PROTOSS_WARP_INTERRUPT : inst.doneAt;
  } // 레어/하이브 변태: 일꾼 관여 없음, 건물 자체 타이머로만 진행

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
  if (S.raceId === 'zerg' && b.consumesWorker) {
    const w = makeWorker();
    assignToPatch(w);
    S.workers.push(w);
  } else {
    const builder = S.workers.find(w => w.job === 'building' && w.buildInstId === instId);
    if (builder) assignToPatch(builder);
  }
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

function setGasWorkerCount(n) {
  const gasList = workersByJob('gas');
  const mineralList = workersByJob('mineral');
  const available = gasList.length + mineralList.length;
  n = Math.max(0, Math.min(n, available));
  if (n > gasList.length) {
    let need = n - gasList.length;
    for (const w of mineralList) {
      if (need <= 0) break;
      assignToGas(w);
      need--;
    }
  } else if (n < gasList.length) {
    let excess = gasList.length - n;
    for (const w of gasList) {
      if (excess <= 0) break;
      assignToPatch(w);
      excess--;
    }
  }
  renderAll();
}

function sendScout() {
  const w = pickAvailableWorker();
  if (!w) { toast('보낼 수 있는 일꾼이 없습니다'); return; }
  w.job = 'scout';
  w.patchIndex = null;
  w.state = 'scouting';
  logAction(`일꾼 1기 정찰 파견 — ${fmtTime(S.time)}`);
  renderAll();
}
function recallScout() {
  const w = S.workers.slice().reverse().find(w => w.job === 'scout');
  if (!w) return;
  assignToPatch(w);
  logAction(`정찰 일꾼 복귀 — ${fmtTime(S.time)}`);
  renderAll();
}

function selectBuildingType(typeId) {
  S.selectedBuildingType = typeId;
  renderProductionPanel();
  renderBaseView();
}

// ---------- 일꾼 틱 (미네랄/가스 왕복 상태기계) ----------
function startGathering(w, actionSec) {
  w.state = 'gathering';
  w.stateStartAt = S.time;
  w.stateEndAt = S.time + actionSec;
}

function tickMineralWorker(w) {
  if (w.state === 'toResource') {
    if (S.time >= w.stateEndAt) {
      const load = patchLoad(w.patchIndex);
      const waitSec = patchWaitSec(S.raceId, load);
      if (waitSec <= 0) startGathering(w, mineActionSec());
      else { w.state = 'waiting'; w.stateStartAt = S.time; w.stateEndAt = S.time + waitSec; }
    }
  } else if (w.state === 'waiting') {
    if (S.time >= w.stateEndAt) startGathering(w, mineActionSec());
  } else if (w.state === 'gathering') {
    if (S.time >= w.stateEndAt) {
      w.state = 'toBase'; w.stateStartAt = S.time; w.stateEndAt = S.time + travelOneWaySec(S.raceId);
    }
  } else if (w.state === 'toBase') {
    if (S.time >= w.stateEndAt) {
      S.minerals += MINERALS_PER_TRIP;
      w.state = 'toResource'; w.stateStartAt = S.time; w.stateEndAt = S.time + travelOneWaySec(S.raceId);
    }
  }
}

function tickGasWorker(w) {
  const rank = workersByJob('gas').indexOf(w);
  const active = rank >= 0 && rank < gasCapacity();
  if (w.state === 'toResource') {
    if (S.time >= w.stateEndAt) {
      if (active) startGathering(w, gasActionSec());
      else { w.state = 'waiting'; w.stateStartAt = S.time; }
    }
  } else if (w.state === 'waiting') {
    if (active) startGathering(w, gasActionSec());
  } else if (w.state === 'gathering') {
    if (S.time >= w.stateEndAt) {
      w.state = 'toBase'; w.stateStartAt = S.time; w.stateEndAt = S.time + gasTravelOneWaySec();
    }
  } else if (w.state === 'toBase') {
    if (S.time >= w.stateEndAt) {
      S.gas += MINERALS_PER_TRIP;
      w.state = 'toResource'; w.stateStartAt = S.time; w.stateEndAt = S.time + gasTravelOneWaySec();
    }
  }
}

function tickWorker(w) {
  if (w.job === 'building') {
    if (S.raceId === 'protoss' && S.time >= w.stateEndAt) assignToPatch(w);
    return; // 테란은 건물 완공 시점에 별도로 복귀 처리, 저그는 이미 제거됨
  }
  if (w.job === 'mineral') tickMineralWorker(w);
  else if (w.job === 'gas') tickGasWorker(w);
  // scout: 이동 없음 (정찰 중, 복귀 버튼으로만 귀환)
}

// ---------- 틱 ----------
function tick(dt) {
  if (dt <= 0) return;
  S.time += dt;

  S.workers.forEach(tickWorker);

  // 건물 완공 + 생산 가능 건물의 유닛 큐 처리
  Object.entries(S.buildingsByType).forEach(([typeId, list]) => {
    const b = S.race.buildings[typeId];
    list.forEach(inst => {
      if (inst.status === 'constructing' && inst.doneAt <= S.time) {
        inst.status = 'ready';
        S.supplyCap += b.supply || 0;
        if (S.raceId === 'terran') {
          const builder = S.workers.find(w => w.job === 'building' && w.buildInstId === inst.id);
          if (builder) assignToPatch(builder);
        }
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

  checkNextStepAlert();
  renderAll();
}

function onUnitComplete(unitId) {
  const u = S.race.units[unitId];
  if (unitId === S.race.workerUnit) {
    const w = makeWorker();
    assignToPatch(w);
    S.workers.push(w);
  } else {
    S.unitCounts[unitId] = (S.unitCounts[unitId] || 0) + (u.count || 1);
  }
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

// 다음 단계의 트리거 조건이 이미 충족됐는데 아직 실행하지 않았다면 알림(1회만)
function checkNextStepAlert() {
  const bo = currentBuildOrder();
  if (!bo) return;
  const idx = boSteps.findIndex(s => !s.done);
  if (idx === -1) return;
  const st = boSteps[idx];
  if (st.notified) return;
  const t = bo.steps[idx].trigger;
  const supplyOk = t.supply == null || S.supplyUsed >= t.supply;
  const timeOk = t.time == null || S.time >= t.time;
  const mineralsOk = t.minerals == null || S.minerals >= t.minerals;
  if (!(supplyOk && timeOk && mineralsOk)) return;
  st.notified = true;
  const step = bo.steps[idx];
  const actionName = (step.action.kind === 'train' ? S.race.units[step.action.id] : S.race.buildings[step.action.id])?.name || step.action.id;
  toast(`▶ 다음 할 일: ${actionName}${step.note ? ' — ' + step.note : ''}`, 3000);
}

// ---------- 렌더링 ----------
function renderTop() {
  const mRate = mineralRatePerSec(S.raceId, mineralWorkerCount(), patches());
  const gRate = gasRatePerSec(effectiveGasWorkers());
  document.getElementById('rMinerals').textContent = Math.floor(S.minerals);
  document.getElementById('rMineralRate').textContent = `+${mRate.toFixed(1)}/초`;
  document.getElementById('rGas').textContent = Math.floor(S.gas);
  document.getElementById('rGasRate').textContent = `+${gRate.toFixed(1)}/초`;
  const supplyEl = document.getElementById('rSupply');
  supplyEl.textContent = `${S.supplyUsed}/${S.supplyCap}`;
  supplyEl.classList.toggle('over', S.supplyUsed >= S.supplyCap);
  document.getElementById('rWorkers').textContent = totalWorkers();
  document.getElementById('rTime').textContent = fmtTime(S.time);

  const gw = gasWorkerCount();
  document.getElementById('gasCount').textContent = gw;
  const eff = effectiveGasWorkers();
  const waste = gw - eff;
  const gasInfoEl = document.getElementById('gasInfo');
  gasInfoEl.textContent = waste > 0 ? `(포화 ${eff} / 대기 ${waste} — 건물당 3기가 최적)` : `(포화 ${gasCapacity()})`;
  gasInfoEl.classList.toggle('warn', waste > 0);

  const scoutCount = workersByJob('scout').length;
  const scoutBtn = document.getElementById('scoutBtn');
  const recallBtn = document.getElementById('recallScoutBtn');
  scoutBtn.disabled = !pickAvailableWorker();
  recallBtn.style.display = scoutCount > 0 ? '' : 'none';
  recallBtn.textContent = `정찰 복귀 (${scoutCount})`;
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
  const clickable = !!b.produces && completedCount(typeId) > 0;
  const selected = S.selectedBuildingType === typeId;
  const cls = [posClass, 'icon', `race-${S.raceId}`, iconSizeClass(typeId), clickable ? 'clickable' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
  const attr = clickable ? `data-select="${typeId}"` : '';
  return `<div class="${cls}" ${attr} title="${b.name}"><span>${shortLabel(b.name)}</span>${extra || ''}</div>`;
}

const BV_PATCH_POS = []; // 패치(0~7) 화면 위치(%) 캐시
for (let i = 0; i < PATCHES_PER_BASE; i++) BV_PATCH_POS.push({ x: 12 + i * (76 / (PATCHES_PER_BASE - 1)), y: 14 });
const BV_BASE_POS = { x: 50, y: 62 };
const BV_GAS_POS = { x: 88, y: 80 };

function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
function clamp01(t) { return Math.max(0, Math.min(1, t)); }

function workerScenePos(w) {
  if (w.job === 'mineral') {
    const target = BV_PATCH_POS[w.patchIndex % PATCHES_PER_BASE];
    if (w.state === 'toResource') return lerp(BV_BASE_POS, target, clamp01((S.time - w.stateStartAt) / (w.stateEndAt - w.stateStartAt)));
    if (w.state === 'toBase') return lerp(target, BV_BASE_POS, clamp01((S.time - w.stateStartAt) / (w.stateEndAt - w.stateStartAt)));
    return target; // waiting / gathering
  }
  if (w.job === 'gas') {
    if (w.state === 'toResource') return lerp(BV_BASE_POS, BV_GAS_POS, clamp01((S.time - w.stateStartAt) / (w.stateEndAt - w.stateStartAt)));
    if (w.state === 'toBase') return lerp(BV_GAS_POS, BV_BASE_POS, clamp01((S.time - w.stateStartAt) / (w.stateEndAt - w.stateStartAt)));
    return BV_GAS_POS;
  }
  return null;
}

function renderBaseView() {
  const scene = document.getElementById('bvScene');
  const gasBuilt = gasBuildingCount() > 0;

  let html = buildingIconHtml(S.race.mainBuildingId, '', 'bv-base');
  html += `<div class="bv-patches">${'<div class="bv-patch"></div>'.repeat(PATCHES_PER_BASE)}</div>`;
  if (gasBuilt) html += `<div class="bv-gas">가스</div>`;

  S.workers.forEach(w => {
    const pos = workerScenePos(w);
    if (!pos) return;
    const cls = ['bv-worker', w.job, w.state === 'gathering' ? 'gathering' : '', w.state === 'waiting' ? 'waiting' : '', w.state === 'toBase' ? 'carrying' : ''].join(' ');
    html += `<div class="${cls}" style="left:${pos.x}%; top:${pos.y}%"></div>`;
  });

  const buildingCount = workersByJob('building').length;
  const scoutCount = workersByJob('scout').length;
  if (buildingCount) html += `<div class="bv-badge bv-badge-build">건설 중 ${buildingCount}</div>`;
  if (scoutCount) html += `<div class="bv-badge bv-badge-scout">정찰 중 ${scoutCount}</div>`;

  scene.innerHTML = html;

  const gallery = document.getElementById('bvGallery');
  const others = Object.entries(S.race.buildings).filter(([id]) => id !== S.race.mainBuildingId && instancesOf(id).length > 0);
  gallery.innerHTML = others.map(([id, b]) => {
    const ready = completedCount(id);
    const constructing = constructingInstances(id);
    let extra = '';
    if (ready > 1) extra += `<b class="bv-count">${ready}</b>`;
    if (constructing.length) {
      const inst = constructing[0];
      const remain = Math.max(0, Math.ceil(inst.doneAt - S.time));
      extra += `<div class="bv-pct">${remain}초</div><button class="bv-cancel" data-cancel-type="${id}" data-cancel-id="${inst.id}" title="건설 취소">×</button>`;
      if (constructing.length > 1) extra += `<b class="bv-count2">+${constructing.length - 1}</b>`;
    }
    return buildingIconHtml(id, extra);
  }).join('') || '<p class="hint">건설된 건물이 없습니다</p>';
}

function renderUnitStatus() {
  const el = document.getElementById('unitStatus');
  const rows = [`<div class="unit-tile"><div class="icon race-${S.raceId} size-unit"><span>${shortLabel(S.race.workerName)}</span></div><span class="uname">${S.race.workerName}</span><span class="ucount">${totalWorkers()}</span></div>`];
  Object.entries(S.unitCounts).filter(([, c]) => c > 0).forEach(([id, c]) => {
    const u = S.race.units[id];
    rows.push(`<div class="unit-tile"><div class="icon race-${S.raceId} size-unit"><span>${shortLabel(u.name)}</span></div><span class="uname">${u.name}</span><span class="ucount">${c}</span></div>`);
  });
  el.innerHTML = rows.join('');
}

function renderLog() {
  const el = document.getElementById('logList');
  el.innerHTML = S.log.slice(-30).map(l => `<li><b>${fmtTime(l.t)}</b> ${l.text}</li>`).reverse().join('');
}

function renderBuildOrder() {
  const bo = currentBuildOrder();
  const listEl = document.getElementById('boList');
  const descEl = document.getElementById('boDesc');
  const tipEl = document.getElementById('boTip');
  if (!bo) { listEl.innerHTML = ''; descEl.textContent = ''; tipEl.textContent = ''; return; }
  descEl.textContent = bo.desc;
  tipEl.textContent = bo.tip ? `💡 ${bo.tip}` : '';
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
    const ok = prereqMet(b.prereq) && affordable(b.mineral, b.gas) && (!buildingNeedsWorker(b) || !!pickAvailableWorker());
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

  if (S.raceId === 'zerg') {
    const hatchCount = completedCount('hatchery');
    const units = Object.entries(S.race.units).map(([id, u]) => unitButtonHtml(id, u, true)).join('');
    const morphs = S.zergActiveMorphs.map(m => {
      const u = S.race.units[m.unitId];
      return `<div class="queue-row"><span>${u.name}</span><div class="pbar"><div class="pbar-fill" style="width:${pctOf(m.startAt, m.doneAt)}%"></div></div></div>`;
    }).join('') || '<p class="hint">생산중인 유닛 없음</p>';
    el.innerHTML = `<div class="larva-info">라바 ${S.zergLarva.count}/${hatchCount * LARVA_CAP_PER_HATCH}</div><div class="cmd-grid">${units}</div><h3>생산 진행</h3><div class="queue-list">${morphs}</div>`;
    return;
  }

  const typeId = S.selectedBuildingType;
  if (!typeId || completedCount(typeId) <= 0) {
    el.innerHTML = '<p class="hint">위 베이스 뷰에서 생산할 건물을 클릭하세요</p>';
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
  renderUnitStatus();
  renderBuildGrid();
  renderProductionPanel();
}

// ---------- 셀렉트 박스 / 시작화면 ----------
function populateRaceSelect() {
  const sel = document.getElementById('raceSelect');
  sel.innerHTML = Object.values(RACES).map(r => `<option value="${r.id}">${r.name}</option>`).join('');
}
function populateBoSelect() {
  const sel = document.getElementById('boSelect');
  sel.innerHTML = BUILD_ORDERS[S.raceId].map(b => `<option value="${b.id}">[${b.level}] ${b.name}</option>`).join('');
}

function resetGame(raceId, boId) {
  S = initState(raceId);
  populateBoSelect();
  if (boId) document.getElementById('boSelect').value = boId;
  const bo = currentBuildOrder();
  boSteps = bo ? bo.steps.map(() => ({ done: false })) : [];
  renderAll();
  renderBuildOrder();
  renderLog();
}

// ---------- 시작화면 ----------
let startSelectedRace = null;
function renderStartRaceGrid() {
  const el = document.getElementById('startRaceGrid');
  el.innerHTML = Object.values(RACES).map(r => `
    <button class="start-race-btn ${startSelectedRace === r.id ? 'active' : ''}" data-race="${r.id}">
      <div class="icon race-${r.id} size-main"><span>${r.name.slice(0, 2)}</span></div>
      <span>${r.name}</span>
    </button>`).join('');
}
function renderStartBoList() {
  const el = document.getElementById('startBoList');
  if (!startSelectedRace) { el.innerHTML = ''; return; }
  el.innerHTML = BUILD_ORDERS[startSelectedRace].map(bo => `
    <label class="start-bo-item">
      <input type="radio" name="startBo" value="${bo.id}">
      <span class="start-bo-name">[${bo.level}] ${bo.name}</span>
      <span class="start-bo-desc">${bo.desc}</span>
    </label>`).join('');
}
function wireStartScreen() {
  document.getElementById('startRaceGrid').addEventListener('click', e => {
    const btn = e.target.closest('[data-race]');
    if (!btn) return;
    startSelectedRace = btn.dataset.race;
    renderStartRaceGrid();
    renderStartBoList();
    document.getElementById('startBoStep').style.display = '';
    document.getElementById('startGoBtn').disabled = true;
  });
  document.getElementById('startBoList').addEventListener('change', () => {
    document.getElementById('startGoBtn').disabled = false;
  });
  document.getElementById('startGoBtn').addEventListener('click', () => {
    const checked = document.querySelector('input[name="startBo"]:checked');
    if (!startSelectedRace || !checked) return;
    resetGame(startSelectedRace, checked.value);
    document.getElementById('raceSelect').value = startSelectedRace;
    document.getElementById('startScreen').style.display = 'none';
    document.getElementById('app').style.display = '';
  });
  document.getElementById('menuBtn').addEventListener('click', () => {
    document.getElementById('app').style.display = 'none';
    document.getElementById('startScreen').style.display = '';
  });
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

  document.getElementById('gasMinus').addEventListener('click', () => setGasWorkerCount(gasWorkerCount() - 1));
  document.getElementById('gasPlus').addEventListener('click', () => setGasWorkerCount(gasWorkerCount() + 1));
  document.getElementById('scoutBtn').addEventListener('click', sendScout);
  document.getElementById('recallScoutBtn').addEventListener('click', recallScout);

  document.getElementById('buildGrid').addEventListener('click', e => {
    const btn = e.target.closest('[data-build]');
    if (btn) doBuild(btn.dataset.build);
  });
  document.getElementById('prodPanel').addEventListener('click', e => {
    const btn = e.target.closest('[data-train]');
    if (btn) doTrain(btn.dataset.train);
  });
  const wrap = document.getElementById('baseviewWrap');
  wrap.addEventListener('click', e => {
    const cancelBtn = e.target.closest('[data-cancel-type]');
    if (cancelBtn) { cancelBuild(cancelBtn.dataset.cancelType, Number(cancelBtn.dataset.cancelId)); return; }
    const btn = e.target.closest('[data-select]');
    if (btn) selectBuildingType(btn.dataset.select);
  });
  window.addEventListener('scroll', () => wrap.classList.toggle('compact', window.scrollY > 16), { passive: true });

  const setTopbarH = () => document.documentElement.style.setProperty('--topbar-h', document.querySelector('.topbar').offsetHeight + 'px');
  setTopbarH();
  window.addEventListener('resize', setTopbarH);
}

// ---------- 게임 루프 ----------
function startLoop() {
  let last = performance.now();
  tickTimer = setInterval(() => {
    const now = performance.now();
    const realDt = (now - last) / 1000;
    last = now;
    if (document.getElementById('app').style.display !== 'none') tick(realDt * S.speed);
  }, 200);
}

// ---------- 초기화 ----------
function boot() {
  populateRaceSelect();
  renderStartRaceGrid();
  wireStartScreen();
  const savedRace = localStorage.getItem('sc-bo-race');
  if (savedRace && RACES[savedRace]) {
    startSelectedRace = savedRace;
    renderStartRaceGrid();
    renderStartBoList();
    document.getElementById('startBoStep').style.display = '';
  }
  wireEvents();
  startLoop();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
