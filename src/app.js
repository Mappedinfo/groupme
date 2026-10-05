import {
  LIMITS, validateConfig, validateSchedule, analyzeSchedule, evaluateProof,
  compareMetrics, parseNames, defaultNames,
} from './grouping.js?v=types-1';

const $ = selector => document.querySelector(selector);
const objectives = ['fair', 'coverage'];
const titles = { fair: '机会均衡', coverage: '整体覆盖' };
const typeTitles = { off: '不区分类型', mix: '不同类型混合', within: '同类型内组队' };
const STORAGE_KEY = 'groupme.v2';
const TIME_BUDGET = 4000;
const state = {
  config: { people: 14, rounds: 3, groupCounts: [null, null, null], seed: 1 },
  names: defaultNames(14), results: {}, objective: 'fair', person: 1, round: 0,
};
let activeJob = null;
let nextJobId = 0;
let roundDraft = [...state.config.groupCounts];
let typeDraft = Array(14).fill('未分类');
let restoredDraft = null;
let statusTimer;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function announce(message) {
  clearTimeout(statusTimer);
  $('#status').textContent = message;
  statusTimer = setTimeout(() => { $('#status').textContent = ''; }, 10000);
}
function currentResult() { return state.results[state.objective]; }
function nameOf(id) { return state.names[id - 1] || `${id}号`; }
function displayName(id) {
  return state.names.slice(0, state.config.people).filter(name => name === nameOf(id)).length > 1
    ? `${nameOf(id)}（${id}号）` : nameOf(id);
}
function ensureNames(people) {
  for (let i = state.names.length; i < people; i++) state.names.push(`${i + 1}号`);
}
function draftPeople() { return Number($('#people-input').value); }
function validPeople(people) { return Number.isInteger(people) && people >= LIMITS.minPeople && people <= LIMITS.maxPeople; }
function typeMode() { return $('input[name="type-mode"]:checked').value; }
function typeOf(id, result = currentResult()) { return result?.config.types?.[id - 1] ?? '未分类'; }
function typeCounts(types) {
  const counts = new Map();
  types.forEach(type => counts.set(type, (counts.get(type) ?? 0) + 1));
  return [...counts];
}
function ensureTypes(people) {
  for (let i = typeDraft.length; i < people; i++) typeDraft.push('未分类');
}
function save(message = '') {
  try {
    const savedResults = {};
    for (const goal of objectives) {
      const result = state.results[goal];
      if (result) savedResults[goal] = { config: result.config, assignments: result.assignments, search: result.search };
    }
    snapshotDraft();
    const draft = { people: draftPeople(), rounds: Number($('#rounds-input').value), groupCounts: roundDraft, typeMode: typeMode() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, ...state, typeDraft, draft, results: savedResults }));
    if (message) announce(message);
  } catch { announce(`${message ? message + ' ' : ''}浏览器无法保存设置，刷新后可能丢失；本次仍可使用和复制。`); }
}
function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved?.version !== 2 || !objectives.includes(saved.objective)) throw new Error('invalid saved state');
      const config = validateConfig({ ...saved.config, objective: saved.objective });
      if (!Array.isArray(saved.names) || saved.names.length < config.people || saved.names.length > LIMITS.maxPeople || saved.names.some(name => typeof name !== 'string' || !name.trim() || /[\r\n]/.test(name) || [...name].length > 20)) throw new Error('invalid names');
      const results = {};
      for (const goal of objectives) {
        const rawResult = saved.results?.[goal];
        if (!rawResult) continue;
        const resultConfig = validateConfig({ ...rawResult.config, objective: goal });
        if (!sameSettings(config, resultConfig)) throw new Error('inconsistent saved result');
        validateSchedule(rawResult.assignments, config.people, resultConfig);
        results[goal] = { config: resultConfig, assignments: rawResult.assignments,
          metrics: analyzeSchedule(rawResult.assignments, config.people, resultConfig),
          proof: evaluateProof(rawResult.assignments, resultConfig),
          search: { seed: resultConfig.seed, iterations: Number.isInteger(rawResult.search?.iterations) && rawResult.search.iterations >= 0 ? rawResult.search.iterations : 0, elapsedMs: Number.isFinite(rawResult.search?.elapsedMs) ? rawResult.search.elapsedMs : 0 },
        };
      }
      Object.assign(state, { config, names: saved.names, results, objective: saved.objective,
        person: Number.isInteger(saved.person) && saved.person >= 1 && saved.person <= config.people ? saved.person : 1,
        round: Number.isInteger(saved.round) && saved.round >= 0 && saved.round < config.rounds ? saved.round : 0,
      });
      typeDraft = Array.isArray(saved.typeDraft) && saved.typeDraft.length <= LIMITS.maxPeople && saved.typeDraft.every(type => typeof type === 'string' && !/[\r\n]/.test(type) && [...type].length <= 20)
        ? saved.typeDraft.map(type => type.trim() || '未分类') : [...config.types];
      const draft = saved.draft;
      if (draft && validPeople(draft.people) && Number.isInteger(draft.rounds) && draft.rounds >= 1 && draft.rounds <= LIMITS.maxRounds && Object.hasOwn(typeTitles, draft.typeMode) && Array.isArray(draft.groupCounts) && draft.groupCounts.length <= LIMITS.maxRounds && draft.groupCounts.every(count => count === null || Number.isInteger(count))) restoredDraft = draft;
      if (!state.results[state.objective]) state.objective = results.fair ? 'fair' : 'coverage';
      if (!Object.keys(results).length) state.objective = 'fair';
      return;
    }
    // 旧版保存的姓名与组数可继续使用，不沿用固定模板或旧版最优性表述。
    const oldRaw = localStorage.getItem('groupme.v1');
    if (oldRaw) {
      const old = JSON.parse(oldRaw);
      if (Array.isArray(old.names) && old.names.every(name => typeof name === 'string')) {
        const names = parseNames(old.names.join('\n'), 14);
        const oldCounts = { four: [4, 4], mixed: [4, 5], five: [5, 5] };
        if (oldCounts[old.plan]) {
          state.names = names;
          state.config = { people: 14, rounds: 2, groupCounts: oldCounts[old.plan], seed: 1 };
          announce('已保留原有姓名和组数，正在为新工具计算方案。');
        }
      }
    }
  } catch { announce('保存的设置无法读取，已恢复默认设置，可以重新填写姓名。'); }
}
function sameSettings(a, b) {
  return a.people === b.people && a.rounds === b.rounds && JSON.stringify(a.groupCounts) === JSON.stringify(b.groupCounts)
    && (a.typeMode ?? 'off') === (b.typeMode ?? 'off')
    && ((a.typeMode ?? 'off') === 'off' || JSON.stringify(a.types) === JSON.stringify(b.types));
}
function renderTypeSettings() {
  const people = draftPeople();
  const valid = validPeople(people);
  const mode = typeMode();
  $('#edit-types').disabled = !valid || Boolean(activeJob);
  $('#type-policy-hint').textContent = {
    off: '只考虑新队友，不使用类型限制。类型标签可以提前保存。',
    mix: '把每种类型均匀分散到各组，让同类型尽量分开，再优化新队友。',
    within: '每组只含相同类型；所有小组仍保持人数差至多 1。无法兼顾时会提示调整。',
  }[mode];
  const summary = $('#type-summary');
  summary.replaceChildren();
  if (!valid) { $('#type-draft-note').textContent = '先填写有效的总人数，再编辑对应同学的类型。'; return; }
  ensureTypes(people);
  const counts = typeCounts(typeDraft.slice(0, people));
  counts.forEach(([type, count]) => summary.append(node('span', 'type-badge', `${type} · ${count} 人`)));
  const changed = state.config.people !== people || (state.config.typeMode ?? 'off') !== mode || JSON.stringify(state.config.types ?? Array(state.config.people).fill('未分类')) !== JSON.stringify(typeDraft.slice(0, people));
  $('#type-draft-note').textContent = counts.length === 1 && mode !== 'off'
    ? `当前所有人都是“${counts[0][0]}”。编辑为不同标签后，类型才会影响分组。${changed ? '重新求解后生效。' : ''}`
    : changed && currentResult() ? '类型设置待应用，点击「求解并比较两种方案」后更新；下方仍显示上次结果。'
    : '标签可自由填写，例如基础、进阶、熟练。空白归为“未分类”，也作为一种类型。';
}
function snapshotDraft() {
  const fields = document.querySelectorAll('[data-round-input]');
  fields.forEach((input, index) => { roundDraft[index] = input.value.trim() === '' ? null : Number(input.value); });
}
function renderRoundInputs() {
  snapshotDraft();
  const people = Number($('#people-input').value);
  const rounds = Number($('#rounds-input').value);
  if (!Number.isInteger(rounds) || rounds < LIMITS.minRounds || rounds > LIMITS.maxRounds) return;
  const container = $('#round-inputs');
  container.replaceChildren();
  const maximum = Math.floor(people / 2);
  for (let i = 0; i < rounds; i++) {
    const label = node('label', '', `作业 ${i + 1}`);
    const input = node('input');
    input.type = 'number'; input.min = '3'; input.max = String(maximum); input.step = '1';
    input.placeholder = '自动'; input.dataset.roundInput = String(i); input.setAttribute('aria-label', `作业 ${i + 1} 的组数，留空自动`);
    input.value = roundDraft[i] ?? '';
    label.append(input); container.append(label);
  }
  $('#group-range').textContent = Number.isInteger(people) && people >= LIMITS.minPeople && people <= LIMITS.maxPeople
    ? `当前每次可以分为 3–${maximum} 组；没有额外组数上限。` : '每次至少 3 组、每组至少 2 人，总人数至少为 6。';
}
function fillSettings() {
  const settings = restoredDraft ?? state.config;
  $('#people-input').value = settings.people;
  $('#rounds-input').value = settings.rounds;
  $('#round-inputs').replaceChildren();
  roundDraft = [...settings.groupCounts];
  renderRoundInputs();
  $('#round-settings').open = settings.groupCounts.some(count => count !== null);
  $(`input[name="type-mode"][value="${settings.typeMode ?? 'off'}"]`).checked = true;
  ensureTypes(settings.people);
  renderTypeSettings();
}
function readConfig() {
  snapshotDraft();
  const people = Number($('#people-input').value);
  const rounds = Number($('#rounds-input').value);
  const seed = globalThis.crypto?.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0] : Date.now() >>> 0;
  if (validPeople(people)) ensureTypes(people);
  return validateConfig({ people, rounds, groupCounts: Array.from({ length: Number.isInteger(rounds) && rounds > 0 && rounds <= LIMITS.maxRounds ? rounds : 0 }, (_, i) => roundDraft[i] ?? null), typeMode: typeMode(), types: typeDraft.slice(0, people), objective: state.objective, seed });
}
function setBusy(busy) {
  $('#solve-button').disabled = busy;
  $('#edit-names').disabled = busy;
  $('#edit-types').disabled = busy || !validPeople(draftPeople());
  $('#cancel-button').hidden = !busy;
  $('#solve-progress').hidden = !busy;
  document.querySelectorAll('#settings-form input, #settings-form select').forEach(input => { input.disabled = busy; });
  $('#settings').setAttribute('aria-busy', String(busy));
}
function resultQuality(result) { return result.proof.optimal ? '已证明覆盖目标最优' : '本次找到的最好方案 · 未证明全局最优'; }
function renderComparison() {
  for (const goal of objectives) {
    const result = state.results[goal];
    const card = $(`#${goal}-card`);
    card.disabled = !result;
    card.setAttribute('aria-pressed', String(state.objective === goal));
    const numbers = $(`#${goal}-numbers`);
    numbers.replaceChildren();
    if (result) {
      const minimum = node('span');
      minimum.append(node('strong', '', String(result.metrics.minimumTeammates)), node('small', '', '每人至少认识 / 位'));
      const pairs = node('span');
      pairs.append(node('strong', '', String(result.metrics.uniquePairs)), node('small', '', '不同搭档 / 对'));
      numbers.append(minimum, pairs);
      $(`#${goal}-quality`).textContent = resultQuality(result);
    } else {
      numbers.textContent = '等待求解';
      $(`#${goal}-quality`).textContent = '';
    }
  }
  if (Object.keys(state.results).length) {
    $('#result-context').textContent = `当前结果：${state.config.people} 人 · ${state.config.rounds} 次作业 · ${typeTitles[state.config.typeMode ?? 'off']} · 两种方案使用相同约束`;
  }
  const { fair, coverage } = state.results;
  $('#comparison-note').textContent = fair && coverage && fair.metrics.uniquePairs === coverage.metrics.uniquePairs && fair.metrics.minimumTeammates === coverage.metrics.minimumTeammates
    ? '两种目标在最低个人覆盖和全班搭档总数上达到相同结果；具体名单可能不同。'
    : '点击其中一种目标查看完整安排；比较最低个人覆盖和全班搭档总数。';
}
function renderRound() {
  const result = currentResult();
  if (!result) return;
  const current = result.assignments[state.round];
  const metrics = result.metrics.rounds[state.round];
  const sizes = [...new Set(current.map(group => group.length))].sort((a,b) => a-b);
  $('#round-summary').textContent = `${current.length} 组 · 每组 ${sizes.join('–')} 人 · 这次新增 ${metrics.uniqueNewPairs} 对搭档`;
  const container = $('#groups');
  container.replaceChildren();
  current.forEach((group, index) => {
    const section = node('section', 'group');
    section.setAttribute('aria-label', `作业 ${state.round + 1} 第 ${index + 1} 组`);
    const heading = node('div', 'group-heading');
    heading.append(node('strong', '', `第 ${index + 1} 组`), node('span', '', `${group.length} 人`));
    const people = node('div', 'group-people');
    group.forEach(id => {
      const button = node('button', 'person-chip', nameOf(id));
      button.type = 'button'; button.dataset.person = String(id);
      button.setAttribute('aria-label', `查看 ${displayName(id)} 的合作情况`);
      button.title = displayName(id);
      if (nameOf(id) !== `${id}号`) button.append(node('small', '', String(id)));
      if (result.config.typeMode !== 'off') {
        button.append(node('span', 'chip-type', typeOf(id, result)));
        button.setAttribute('aria-label', `查看 ${displayName(id)}（${typeOf(id, result)}）的合作情况`);
      }
      button.addEventListener('click', () => { state.person = id; renderPerson(); save(); });
      people.append(button);
    });
    section.append(heading, people);
    if (result.config.typeMode !== 'off') section.append(node('p', 'group-types', typeCounts(group.map(id => typeOf(id, result))).map(([type, count]) => `${type} ${count} 人`).join(' · ')));
    container.append(section);
  });
  renderPerson(false);
}
function renderPerson(shouldAnnounce = true) {
  const result = currentResult();
  if (!result) return;
  const person = result.metrics.people.find(entry => entry.id === state.person);
  const thisRound = person.rounds[state.round];
  $('#person-select').value = String(state.person);
  $('#person-count').textContent = String(person.uniqueCount);
  const within = result.config.typeMode === 'within';
  const eligible = within ? person.eligibleTeammates : state.config.people - 1;
  $('#person-total').textContent = `/ ${eligible} 位${within ? '同类型' : '其他'}同学`;
  $('#person-type').hidden = result.config.typeMode === 'off';
  $('#person-type').textContent = `类型：${typeOf(state.person, result)}`;
  $('#person-bar').style.width = `${eligible ? person.uniqueCount / eligible * 100 : 0}%`;
  $('#person-caption').textContent = person.uniqueCount === eligible ? `已经和每一位${within ? '同类型' : '其他'}同学合作。` : `还有 ${eligible - person.uniqueCount} 位${within ? '同类型' : ''}同学尚未合作。`;
  $('#mate-title').textContent = `作业 ${state.round + 1} · 第 ${thisRound.groupIndex + 1} 组 · ${thisRound.newTeammates.length} 位新队友`;
  const mates = $('#mate-list'); mates.replaceChildren();
  thisRound.teammates.forEach(id => {
    const button = node('button', 'person-chip', displayName(id)); button.type = 'button';
    button.dataset.relation = thisRound.newTeammates.includes(id) ? 'fresh' : 'known';
    button.setAttribute('aria-label', `${displayName(id)}，${thisRound.newTeammates.includes(id) ? '本次新队友' : '之前已合作'}，查看合作情况`);
    button.addEventListener('click', () => { state.person = id; renderPerson(); save(); $('#person-select').focus({ preventScroll:true }); });
    mates.append(button);
  });
  document.querySelectorAll('#groups [data-person]').forEach(button => {
    const id = Number(button.dataset.person);
    button.setAttribute('aria-pressed', String(id === state.person));
    button.dataset.relation = thisRound.newTeammates.includes(id) ? 'fresh' : thisRound.teammates.includes(id) ? 'known' : '';
  });
  const history = $('#person-history'); history.replaceChildren();
  person.rounds.forEach(round => {
    const item = node('li');
    item.append(node('strong', '', `作业 ${round.roundIndex + 1} · 第 ${round.groupIndex + 1} 组 · 新认识 ${round.newTeammates.length} 位`), document.createTextNode(round.teammates.map(displayName).join('、')));
    history.append(item);
  });
  const seen = new Set([state.person, ...person.teammates]);
  const unmet = Array.from({ length:state.config.people }, (_,i)=>i+1).filter(id=>!seen.has(id) && (!within || typeOf(id, result) === typeOf(state.person, result)));
  $('#unmet-title').textContent = `尚未合作的${within ? '同类型' : ''}同学（${unmet.length}）`;
  $('#unmet-list').textContent = unmet.length ? unmet.map(displayName).join('、') : '已经全部认识。';
  if (shouldAnnounce) $('#selection-announcement').textContent = `${displayName(state.person)}，共认识 ${person.uniqueCount} 位不同同学，作业 ${state.round + 1} 有 ${thisRound.newTeammates.length} 位新队友。`;
}
function renderResults() {
  renderComparison();
  const result = currentResult();
  $('#results').hidden = !result;
  if (!result) return;
  state.person = Math.min(state.person, state.config.people);
  state.round = Math.min(state.round, state.config.rounds - 1);
  const m = result.metrics;
  $('#result-detail').textContent = `${titles[state.objective]} · ${state.config.people} 人 / ${state.config.rounds} 次作业 · ${typeTitles[result.config.typeMode]}`;
  $('#teammate-range').textContent = m.minimumTeammates === m.maximumTeammates ? String(m.minimumTeammates) : `${m.minimumTeammates}–${m.maximumTeammates}`;
  const within = result.config.typeMode === 'within';
  const denominator = within ? m.eligiblePairs : m.possiblePairs;
  $('#coverage-label').textContent = within ? '同类型内覆盖' : '全班覆盖';
  $('#coverage-value').textContent = `${m.uniquePairs}/${denominator} 对（${(m.uniquePairs / denominator * 100).toFixed(1)}%）`;
  $('#type-result-note').hidden = result.config.typeMode === 'off';
  $('#type-result-note').textContent = within
    ? `只在同类型内计算可合作范围。全班实际覆盖 ${m.uniquePairs}/${m.possiblePairs} 对（${(m.coverage * 100).toFixed(1)}%）；不同类型之间不安排合作。`
    : '每种类型在各组的人数差至多 1，再尽量增加新队友。部分搭档可能因类型均匀分散的要求而无法同组。';
  $('#repeat-count').textContent = m.repeatMeetings;
  const select = $('#round-select'); select.replaceChildren();
  result.assignments.forEach((groups, i) => { const option = node('option', '', `作业 ${i+1} · ${groups.length} 组`); option.value = String(i); select.append(option); });
  select.value = String(state.round);
  const personSelect = $('#person-select'); personSelect.replaceChildren();
  for (let id = 1; id <= state.config.people; id++) { const option = node('option', '', displayName(id)); option.value = String(id); personSelect.append(option); }
  $('#proof-description').textContent = `${resultQuality(result)}。${result.proof.reason}`;
  $('#search-description').textContent = `本方案组数：${result.assignments.map(groups=>groups.length).join(' / ')}。本次搜索尝试 ${result.search.iterations} 次调整。未证明最优时，可以再次求解；在同样约束下会保留每种目标已找到的更好方案。`;
  renderRound();
}
function settleJob(job) {
  if (activeJob !== job || !objectives.every(goal => job.finished.has(goal))) return;
  job.workers.forEach(worker => worker.terminate());
  clearTimeout(job.watchdog);
  activeJob = null;
  setBusy(false);
  const successful = objectives.filter(goal => job.results[goal]);
  if (!successful.length) { announce(`求解未完成：${job.errors.join('；') || '请重试'}。原方案已保留。`); return; }
  const same = sameSettings(state.config, job.config);
  const next = {};
  // 两种搜索都提供可行候选；分别按目标择优，避免单次随机搜索造成无意义的支配劣解。
  // 先合并所有候选；某个解即使不改善自身搜索目标，也可能改善另一个目标。
  const candidates = [
    ...(same ? Object.values(state.results) : []),
    ...Object.values(job.results),
  ].filter(Boolean);
  for (const goal of objectives) {
    for (const candidate of candidates) {
      if (!next[goal] || compareMetrics(candidate.metrics, next[goal].metrics, goal) > 0) {
        const config = { ...candidate.config, types: [...job.config.types], objective:goal };
        next[goal] = { ...candidate, config, proof:evaluateProof(candidate.assignments, config) };
      }
    }
  }
  state.config = job.config;
  state.results = next;
  ensureNames(state.config.people);
  if (!state.results[state.objective]) state.objective = successful[0];
  state.person = Math.min(state.person, state.config.people);
  state.round = Math.min(state.round, state.config.rounds - 1);
  renderResults();
  renderTypeSettings();
  save(job.errors.length ? `已有可行方案；部分搜索未完成：${job.errors.join('；')}。` : '两种目标已求解，可以切换比较。');
}
function startSolve() {
  if (activeJob) return;
  $('#config-error').textContent = '';
  let config;
  try { config = readConfig(); } catch (error) { $('#config-error').textContent = error.message; return; }
  if (typeof Worker === 'undefined') { $('#config-error').textContent = '当前浏览器不支持后台求解，请使用较新的浏览器打开。'; return; }
  const job = { id:++nextJobId, config, results:{}, errors:[], workers:[], finished:new Set(), started:Date.now() };
  activeJob = job;
  setBusy(true);
  $('#progress-text').textContent = `正在为 ${config.people} 人、${config.rounds} 次作业比较两种目标；下方保留上次结果。`;
  for (const goal of objectives) {
    try {
      const worker = new Worker(new URL('./solver-worker.js?v=types-1', import.meta.url), { type:'module' });
      job.workers.push(worker);
      worker.onmessage = ({ data }) => {
        if (activeJob !== job || data.requestId !== `${job.id}-${goal}` || job.finished.has(goal)) return;
        if (data.type === 'result') {
          try {
            validateSchedule(data.result.assignments, config.people, { ...config, objective:goal });
            job.results[goal] = data.result;
          } catch (error) { job.errors.push(`${titles[goal]}：结果校验失败（${error.message}）`); }
          job.finished.add(goal); worker.terminate();
          $('#progress-text').textContent = `${titles[goal]}已完成，正在等待另一种目标…`;
          settleJob(job);
        } else if (data.type === 'error') {
          job.errors.push(`${titles[goal]}：${data.message}`); job.finished.add(goal); worker.terminate(); settleJob(job);
        }
      };
      worker.onerror = event => {
        if (activeJob !== job || job.finished.has(goal)) return;
        event.preventDefault(); job.errors.push(`${titles[goal]}：后台求解未能运行，请重试`); job.finished.add(goal); worker.terminate(); settleJob(job);
      };
      worker.postMessage({ type:'solve', requestId:`${job.id}-${goal}`, config:{ ...config, objective:goal }, timeBudgetMs:TIME_BUDGET });
    } catch (error) { job.errors.push(`${titles[goal]}：${error.message}`); job.finished.add(goal); }
  }
  job.watchdog = setTimeout(() => {
    if (activeJob !== job) return;
    objectives.forEach(goal => { if (!job.finished.has(goal)) { job.finished.add(goal); job.errors.push(`${titles[goal]}：超时，请缩小规模或重试`); } });
    settleJob(job);
  }, 30000);
  settleJob(job);
}
function cancelSolve() {
  if (!activeJob) return;
  const job = activeJob;
  job.workers.forEach(worker=>worker.terminate());
  clearTimeout(job.watchdog);
  activeJob = null;
  setBusy(false);
  announce('已停止求解，原有方案与姓名保持不变。');
}
function rosterText() {
  const result = currentResult();
  const lines = [`Groupme · ${state.config.people} 人 / ${state.config.rounds} 次作业`, `目标：${titles[state.objective]}`, `类型方式：${typeTitles[result.config.typeMode]}`, resultQuality(result), ''];
  const rosterName = id => result.config.typeMode === 'off' ? displayName(id) : `${displayName(id)}【${typeOf(id, result)}】`;
  result.assignments.forEach((groups, round) => {
    lines.push(`作业 ${round+1}（${groups.length} 组）`);
    groups.forEach((group, index)=>lines.push(`第 ${index+1} 组：${group.map(rosterName).join('、')}`)); lines.push('');
  });
  const m = result.metrics;
  lines.push(`每人认识 ${m.minimumTeammates}–${m.maximumTeammates} 位不同同学；${result.config.typeMode === 'within' ? `同类型内 ${m.uniquePairs}/${m.eligiblePairs} 对；` : ''}全班 ${m.uniquePairs}/${m.possiblePairs} 对不同搭档；重复碰面 ${m.repeatMeetings} 对次。`);
  if (result.config.typeMode === 'mix') lines.push('每种类型在各组的人数差至多 1；全班覆盖比例不代表全部搭档均能在此限制下同组。');
  return lines.join('\n');
}

$('#people-input').addEventListener('input', () => { renderRoundInputs(); renderTypeSettings(); });
$('#rounds-input').addEventListener('input', renderRoundInputs);
$('#settings-form').addEventListener('change', () => { renderTypeSettings(); save(); });
document.querySelectorAll('input[name="type-mode"]').forEach(input => input.addEventListener('change', () => { $('#config-error').textContent = ''; }));
$('#settings-form').addEventListener('submit', event => { event.preventDefault(); startSolve(); });
$('#cancel-button').addEventListener('click', cancelSolve);
for (const goal of objectives) $(`#${goal}-card`).addEventListener('click', () => { if (!state.results[goal]) return; state.objective = goal; renderResults(); save(); });
$('#round-select').addEventListener('change', () => { state.round = Number($('#round-select').value); renderRound(); save(); });
$('#person-select').addEventListener('change', () => { state.person = Number($('#person-select').value); renderPerson(); save(); });

const namesDialog = $('#names-dialog');
function updateNamesCount() { $('#names-count').textContent = `${$('#names-input').value.split(/\r\n?|\n/).filter(line=>line.trim()).length} / ${state.config.people} 位`; }
$('#edit-names').addEventListener('click', () => {
  $('#names-input').value = state.names.slice(0,state.config.people).join('\n');
  $('#names-input').maxLength = state.config.people * 42;
  $('#names-title').textContent = `填写这 ${state.config.people} 位同学的姓名`;
  $('#names-hint').textContent = '对应当前显示的分组。每行一位；只保存在你的浏览器中。';
  $('#names-error').textContent = ''; $('#names-input').removeAttribute('aria-invalid'); updateNamesCount(); namesDialog.showModal();
});
$('#close-names').addEventListener('click', () => namesDialog.close());
$('#names-input').addEventListener('input', () => { updateNamesCount(); $('#names-error').textContent=''; $('#names-input').removeAttribute('aria-invalid'); });
$('#restore-numbers').addEventListener('click', () => { $('#names-input').value = defaultNames(state.config.people).join('\n'); $('#names-error').textContent=''; $('#names-input').removeAttribute('aria-invalid'); updateNamesCount(); });
$('#names-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const names = parseNames($('#names-input').value, state.config.people);
    state.names = [...names, ...state.names.slice(state.config.people)];
    renderResults(); namesDialog.close(); save('姓名已更新，分组位置保持不变。');
  } catch (error) { $('#names-error').textContent=error.message; $('#names-input').setAttribute('aria-invalid','true'); $('#names-input').focus(); }
});

const typesDialog = $('#types-dialog');
let typesEditorPeople = 0;
function normalizeTypes(values) {
  return values.map((value, index) => {
    const type = value.trim() || '未分类';
    if ([...type].length > 20) throw new Error(`${index + 1} 号同学的类型不能超过 20 个字符。`);
    return type;
  });
}
function editorTypeFields() { return [...document.querySelectorAll('[data-type-id]')]; }
function updateTypeSuggestions() {
  $('#type-suggestions').replaceChildren(...[...new Set(editorTypeFields().map(input => input.value.trim()).filter(Boolean))].map(value => {
    const option = node('option'); option.value = value; return option;
  }));
}
$('#edit-types').addEventListener('click', () => {
  typesEditorPeople = draftPeople();
  if (!validPeople(typesEditorPeople) || activeJob) return;
  ensureTypes(typesEditorPeople);
  $('#types-title').textContent = `${typesEditorPeople} 位同学的类型`;
  $('#types-hint').textContent = '对应上方待求解的总人数。标签按编号与同学绑定；保存后重新求解才会应用到分组。';
  $('#types-error').textContent = '';
  const rows = $('#type-rows'); rows.replaceChildren();
  for (let id = 1; id <= typesEditorPeople; id++) {
    const row = node('label', 'type-row');
    const person = node('span', 'type-row-person');
    person.append(node('small', '', String(id).padStart(2, '0')), node('span', '', nameOf(id)));
    const input = node('input');
    input.type = 'text'; input.value = typeDraft[id - 1] === '未分类' ? '' : typeDraft[id - 1]; input.placeholder = '未分类';
    input.dataset.typeId = String(id); input.maxLength = 40; input.setAttribute('list', 'type-suggestions');
    input.setAttribute('aria-label', `${id} 号同学 ${nameOf(id)} 的类型`);
    input.addEventListener('change', updateTypeSuggestions);
    row.append(person, input); rows.append(row);
  }
  $('#types-bulk').value = typeDraft.slice(0, typesEditorPeople).join('\n');
  $('#types-bulk').maxLength = typesEditorPeople * 42;
  updateTypeSuggestions(); typesDialog.showModal();
});
$('#close-types').addEventListener('click', () => typesDialog.close());
$('#apply-type-bulk').addEventListener('click', () => {
  try {
    let lines = $('#types-bulk').value.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === typesEditorPeople + 1 && lines.at(-1) === '') lines.pop();
    if (lines.length !== typesEditorPeople) throw new Error(`请按编号填写恰好 ${typesEditorPeople} 行，当前为 ${lines.length} 行；空行也占一位。`);
    const types = normalizeTypes(lines);
    editorTypeFields().forEach((input, i) => { input.value = types[i] === '未分类' ? '' : types[i]; });
    updateTypeSuggestions(); $('#types-error').textContent = '';
  } catch (error) { $('#types-error').textContent = error.message; }
});
$('#types-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const types = normalizeTypes(editorTypeFields().map(input => input.value));
    typeDraft = [...types, ...typeDraft.slice(typesEditorPeople)];
    typesDialog.close(); renderTypeSettings(); $('#config-error').textContent = '';
    save('类型设置已保存。重新求解后应用到分组。');
  } catch (error) { $('#types-error').textContent = error.message; }
});
$('#copy-rosters').addEventListener('click', async () => {
  const text = rosterText();
  try { if (!navigator.clipboard?.writeText) throw new Error('unavailable'); await navigator.clipboard.writeText(text); announce('已复制当前目标的全部作业名单。'); }
  catch { $('#copy-text').value=text; $('#copy-dialog').showModal(); $('#copy-text').focus(); $('#copy-text').select(); }
});
$('#close-copy').addEventListener('click', () => $('#copy-dialog').close());

restore();
fillSettings();
renderResults();
if (!currentResult()) startSolve();
