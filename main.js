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
    workers: race.startWorkers,
    gasWorkers: 0,
    supplyUsed: race.startSupplyUsed,
    supplyCap: race.startSupplyCap,
    buildings: { [race.mainBuildingId]: { completed: 1, inProgress: [] } },
    production: {},
    zergActive: [],
    larva: raceId === 'zerg' ? { count: 3, timer: 0 } : null,
    log: [],
    speed: 1,
  };
  Object.entries(race.buildings).forEach(([id, b]) => {
    if (b.produces) s.production[id] = { queue: [], active: [] };
  });
  return s;
}

function getBuilding(typeId) {
  if (!S.buildings[typeId]) S.buildings[typeId] = { completed: 0, inProgress: [] };
  return S.buildings[typeId];
}
function completedCount(typeId) { return S.buildings[typeId]?.completed || 0; }
function prereqMet(list) { return (list || []).every(id => completedCount(id) > 0); }

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
  if (b.consumesWorker && S.workers <= 0) { toast('일꾼이 없습니다'); return; }
  S.minerals -= b.mineral;
  S.gas -= b.gas;
  if (b.consumesWorker) {
    S.workers -= 1;
    if (S.gasWorkers > S.workers) S.gasWorkers = S.workers;
  }
  getBuilding(typeId).inProgress.push({ doneAt: S.time + b.time });
  logAction(`${b.name} ${b.isAddon ? '건설(애드온)' : '착공'} — ${fmtTime(S.time)}`);
  checkBuildOrderStep({ kind: 'build', id: typeId });
  renderAll();
}

function doTrain(unitId) {
  const u = S.race.units[unitId];
  if (!u) return;
  if (!prereqMet(u.prereq)) { toast('테크(선행 건물)가 부족합니다'); return; }
  if (S.minerals < u.mineral || S.gas < u.gas) { toast('자원이 부족합니다'); return; }
  const supplyCost = Math.max(0, u.supply);
  if (S.supplyUsed + supplyCost > S.supplyCap) { toast('서플라이(인구수)가 부족합니다'); return; }

  if (S.raceId === 'zerg') {
    if (S.larva.count <= 0) { toast('라바가 없습니다'); return; }
    S.larva.count -= 1;
    S.zergActive.push({ unitId, doneAt: S.time + u.time });
  } else {
    const bcount = completedCount(u.from);
    if (bcount <= 0) { toast('생산 건물이 없습니다'); return; }
    const prod = S.production[u.from];
    if (prod.queue.length + prod.active.length >= bcount * 5) { toast('생산 대기열이 가득 찼습니다'); return; }
    prod.queue.push({ unitId });
  }
  S.minerals -= u.mineral;
  S.gas -= u.gas;
  S.supplyUsed += supplyCost;
  logAction(`${u.name} 생산 시작 — ${fmtTime(S.time)}`);
  checkBuildOrderStep({ kind: 'train', id: unitId });
  renderAll();
}

function setGasWorkers(n) {
  const gasBuiltCount = completedCount(S.race.gasBuildingId);
  const max = Math.min(S.workers, gasBuiltCount * 3);
  S.gasWorkers = Math.max(0, Math.min(n, max));
  renderTop();
}

// ---------- 틱 ----------
function tick(dt) {
  if (dt <= 0) return;
  S.time += dt;

  const mineralWorkers = Math.max(0, S.workers - S.gasWorkers);
  const gasOk = completedCount(S.race.gasBuildingId) > 0;
  if (!gasOk && S.gasWorkers > 0) S.gasWorkers = 0;
  S.minerals += mineralWorkers * GATHER_RATE_PER_WORKER * dt;
  if (gasOk) S.gas += S.gasWorkers * GATHER_RATE_PER_WORKER * dt;

  // 건물 완공 처리
  Object.entries(S.buildings).forEach(([typeId, rec]) => {
    const b = S.race.buildings[typeId];
    rec.inProgress = rec.inProgress.filter(item => {
      if (item.doneAt <= S.time) {
        rec.completed += 1;
        S.supplyCap += b.supply || 0;
        return false;
      }
      return true;
    });
  });

  // 유닛 생산 (테란/프로토스: 건물별 큐)
  if (S.raceId !== 'zerg') {
    Object.entries(S.production).forEach(([typeId, prod]) => {
      const cap = completedCount(typeId);
      prod.active = prod.active.filter(item => {
        if (item.doneAt <= S.time) {
          onUnitComplete(item.unitId);
          return false;
        }
        return true;
      });
      while (prod.active.length < cap && prod.queue.length > 0) {
        const item = prod.queue.shift();
        item.doneAt = S.time + S.race.units[item.unitId].time;
        prod.active.push(item);
      }
    });
  } else {
    // 저그 라바
    const hatchCount = completedCount('hatchery');
    const cap = hatchCount * LARVA_CAP_PER_HATCH;
    S.larva.timer += dt;
    while (S.larva.timer >= LARVA_SPAWN_INTERVAL) {
      S.larva.timer -= LARVA_SPAWN_INTERVAL;
      S.larva.count = Math.min(cap, S.larva.count + 1);
    }
    if (S.larva.count > cap) S.larva.count = cap;
    S.zergActive = S.zergActive.filter(item => {
      if (item.doneAt <= S.time) { onUnitComplete(item.unitId); return false; }
      return true;
    });
  }

  renderAll();
}

function onUnitComplete(unitId) {
  const u = S.race.units[unitId];
  if (unitId === 'scv' || unitId === 'probe' || unitId === 'drone') {
    S.workers += 1;
  }
  if (u.supply < 0) { // 오버로드 등: 완공 시 서플라이 제공
    S.supplyCap += -u.supply;
  }
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
  document.getElementById('rMinerals').textContent = Math.floor(S.minerals);
  document.getElementById('rGas').textContent = Math.floor(S.gas);
  const supplyEl = document.getElementById('rSupply');
  supplyEl.textContent = `${S.supplyUsed}/${S.supplyCap}`;
  supplyEl.classList.toggle('over', S.supplyUsed >= S.supplyCap);
  document.getElementById('rWorkers').textContent = S.workers;
  document.getElementById('rTime').textContent = fmtTime(S.time);
  document.getElementById('gasCount').textContent = S.gasWorkers;
}

function renderBuildingStatus() {
  const el = document.getElementById('buildingStatus');
  const rows = Object.entries(S.race.buildings).filter(([id]) => completedCount(id) > 0 || (S.buildings[id]?.inProgress.length));
  el.innerHTML = rows.map(([id, b]) => {
    const rec = S.buildings[id] || { completed: 0, inProgress: [] };
    const progressTxt = rec.inProgress.length ? ` (건설중 x${rec.inProgress.length})` : '';
    return `<div class="info-row"><span class="bldname">${b.name}</span><span class="bldcount">${rec.completed}<span class="bldprog">${progressTxt}</span></span></div>`;
  }).join('') || '<div class="info-row"><span class="bldname">-</span></div>';

  if (S.raceId === 'zerg') {
    const hatchCount = completedCount('hatchery');
    el.innerHTML += `<div class="info-row"><span class="bldname">라바</span><span class="bldcount">${S.larva.count}/${hatchCount * LARVA_CAP_PER_HATCH}</span></div>`;
  }
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

function renderCommandCard() {
  const buildEl = document.getElementById('buildGrid');
  buildEl.innerHTML = Object.entries(S.race.buildings).map(([id, b]) => {
    const ok = prereqMet(b.prereq) && affordable(b.mineral, b.gas);
    return `<button class="cmdbtn ${b.isAddon ? 'addon' : ''}" data-build="${id}" ${ok ? '' : 'disabled'}>
      <span>${b.name}</span>
      <span class="cost">${b.mineral}${b.gas ? '/' + b.gas : ''}${b.supply ? ' Su+' + b.supply : ''}</span>
    </button>`;
  }).join('');

  const unitEl = document.getElementById('unitGrid');
  unitEl.innerHTML = Object.entries(S.race.units).map(([id, u]) => {
    const ok = prereqMet(u.prereq) && affordable(u.mineral, u.gas) && (S.supplyUsed + Math.max(0, u.supply) <= S.supplyCap);
    return `<button class="cmdbtn" data-train="${id}" ${ok ? '' : 'disabled'}>
      <span>${u.name}</span>
      <span class="cost">${u.mineral}${u.gas ? '/' + u.gas : ''}</span>
    </button>`;
  }).join('');

  const gasBuilt = completedCount(S.race.gasBuildingId) > 0;
  document.getElementById('gasRow').style.opacity = gasBuilt ? 1 : .4;
}

function renderAll() {
  renderTop();
  renderBuildingStatus();
  renderCommandCard();
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
  document.getElementById('unitGrid').addEventListener('click', e => {
    const btn = e.target.closest('[data-train]');
    if (btn) doTrain(btn.dataset.train);
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
