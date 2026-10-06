import {
  LIMITS, validateConfig, validateSchedule, analyzeSchedule, evaluateProof,
  compareMetrics, parseNames, defaultNames, getSizeOptions, getAutomaticGroupCounts, normalizeFixedGroups,
} from './grouping.js?v=colors-1';
import { quickTypeSizes, createQuickTypePlan, normalizeTypeLabels } from './type-editor.js?v=colors-1';

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
let fixedDraft = [];
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
function hasFixed(result) { return Boolean(result.config.fixedGroups?.length); }
function fixedGroupIndex(id, result) { return (result.config.fixedGroups ?? []).findIndex(group => group.includes(id)); }
function objectiveMinimum(result) { return hasFixed(result) ? result.metrics.rotatingMinimumTeammates : result.metrics.minimumTeammates; }
function nameOf(id) { return state.names[id - 1] || `${id}号`; }
function displayName(id) {
  return state.names.slice(0, state.config.people).filter(name => name === nameOf(id)).length > 1
    ? `${nameOf(id)}（${id}号）` : nameOf(id);
}
function ensureNames(people) {
  for (let i = state.names.length; i < people; i++) state.names.push(`${i + 1}号`);
}
function draftPeople() { return Number($('#people-input').value); }
function preferredSize() { return $('#size-input').value.trim() === '' ? null : Number($('#size-input').value); }
function validPeople(people) { return Number.isInteger(people) && people >= LIMITS.minPeople && people <= LIMITS.maxPeople; }
function typeMode() { return $('input[name="type-mode"]:checked').value; }
function typeOf(id, result = currentResult()) { return result?.config.types?.[id - 1] ?? '未分类'; }
function showTypes(result) { return result.config.typeMode !== 'off' || result.config.types.some(type => type !== '未分类'); }
function typeRelation(id, result) { return typeOf(id, result) === typeOf(state.person, result) ? 'same' : 'different'; }
function typeRelationText(id, result) { return `类型 ${typeOf(id, result)}，与当前同学${typeRelation(id, result) === 'same' ? '同类型' : '不同类型'}`; }
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
    const draft = { people: draftPeople(), rounds: Number($('#rounds-input').value), groupCounts: roundDraft, typeMode: typeMode(), preferredSize: preferredSize() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, ...state, typeDraft, fixedDraft, draft, results: savedResults }));
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
      try { fixedDraft = normalizeFixedGroups(saved.fixedDraft ?? config.fixedGroups ?? [], LIMITS.maxPeople); }
      catch { fixedDraft = (config.fixedGroups ?? []).map(group => [...group]); }
      const draft = saved.draft;
      if (draft && validPeople(draft.people) && Number.isInteger(draft.rounds) && draft.rounds >= 1 && draft.rounds <= LIMITS.maxRounds && Object.hasOwn(typeTitles, draft.typeMode) && Array.isArray(draft.groupCounts) && draft.groupCounts.length <= LIMITS.maxRounds && draft.groupCounts.every(count => count === null || Number.isInteger(count))) restoredDraft = { ...draft, preferredSize: Number.isFinite(draft.preferredSize) ? draft.preferredSize : null };
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
  const same = a.people === b.people && a.rounds === b.rounds && JSON.stringify(a.groupCounts) === JSON.stringify(b.groupCounts)
    && (a.typeMode ?? 'off') === (b.typeMode ?? 'off')
    && JSON.stringify(a.fixedGroups ?? []) === JSON.stringify(b.fixedGroups ?? [])
    && ((a.typeMode ?? 'off') === 'off' || JSON.stringify(a.types) === JSON.stringify(b.types));
  if (!same) return false;
  return a.groupCounts.every(count => count !== null) || JSON.stringify(getAutomaticGroupCounts(a)) === JSON.stringify(getAutomaticGroupCounts(b));
}
function sizeDescription(sizes) {
  const counts = new Map();
  sizes.forEach(size => counts.set(size, (counts.get(size) ?? 0) + 1));
  if (counts.size === 1) return `每组 ${sizes[0]} 人`;
  return [...counts].sort(([a], [b]) => b - a).map(([size, count]) => `${count} 组 ${size} 人`).join(' + ');
}
function sizeSettingDescription(config) {
  if (config.preferredSize == null) return '每组人数不限';
  return `期望每组 ${config.preferredSize} 人${config.groupCounts.some(count => count !== null) ? '（手动组数优先）' : ''}`;
}
function renderSizePolicy(people, target, options = null) {
  snapshotDraft();
  const rounds = Number($('#rounds-input').value);
  const validRounds = Number.isInteger(rounds) && rounds >= 1 && rounds <= LIMITS.maxRounds;
  const validTarget = target === null || Number.isInteger(target) && target >= 2 && target <= LIMITS.maxPeople;
  const fields = [...document.querySelectorAll('[data-round-input]')];
  const manual = [], invalid = [];
  fields.forEach((input, index) => {
    const filled = input.value.trim() !== '';
    const count = Number(input.value);
    const inRange = Number.isInteger(count) && count >= 3 && count <= Math.floor(people / 2);
    const feasible = inRange && (!options || options.some(option => option.groupCount === count));
    const policy = filled ? feasible && validPeople(people) ? 'manual' : 'invalid' : 'auto';
    if (filled && index < rounds) manual.push(index + 1);
    if (policy === 'invalid' && index < rounds) invalid.push(index + 1);
    input.parentElement.dataset.policy = policy;
    input.setAttribute('aria-invalid', String(policy === 'invalid'));
    $(`#round-policy-${index}`).textContent = policy === 'manual' ? `${count} 组优先 · 不采用期望人数`
      : policy === 'invalid' ? !validPeople(people) ? '请先填写有效总人数' : inRange ? '组数与类型或固定小组不兼容' : `请填 3–${Math.floor(people / 2)} 的整数`
      : !validTarget ? '自动 · 请修正期望人数' : target === null ? '自动选择组数 · 人数不限' : `按期望 ${target} 人 / 组`;
  });
  const autoCount = validRounds ? rounds - manual.length : 0;
  const allManual = validRounds && manual.length === rounds && !invalid.length;
  const status = $('#size-policy-status');
  status.dataset.policy = !validPeople(people) || !validRounds || !validTarget || invalid.length ? 'invalid' : allManual ? 'manual' : manual.length ? 'mixed' : 'auto';
  status.textContent = !validPeople(people) ? '请先填写有效总人数' : !validRounds ? '请先填写有效作业次数'
    : !validTarget ? '期望人数需调整' : invalid.length ? `作业 ${invalid.join('、')} 的组数需调整`
    : allManual ? '全部已指定组数 · 期望人数不生效'
    : manual.length ? `混用 · ${manual.length} 次指定组数 / ${autoCount} 次自动`
    : target === null ? `全部 ${rounds} 次自动 · 人数不限` : `全部 ${rounds} 次按期望人数`;
  $('#round-policy-summary').textContent = !validRounds ? '请先填写有效作业次数' : invalid.length ? `${invalid.length} 次输入待调整`
    : manual.length ? `${manual.length} 次已指定 · 优先于期望人数` : '可选 · 仅覆盖对应作业';
  $('#size-override-notice').hidden = !manual.length;
  $('#size-override').textContent = !validRounds ? `请先将作业次数设为 1–${LIMITS.maxRounds} 的整数，再确认各次安排；已填写的组数暂时保留。`
    : !validPeople(people) ? '请先填写有效总人数，再确认各次组数；已填写的组数暂时保留。'
    : !validTarget ? '请将期望人数设为 2–300 的整数，或清空为不限；已填写的组数保持。'
    : invalid.length ? `作业 ${invalid.join('、')} 的组数需修正后才能求解。可清空对应输入，恢复按期望人数安排。`
    : allManual ? '期望人数与推荐暂不影响当前安排。清空某次组数，仅让该次恢复自动；也可将全部作业改为自动。'
    : `作业 ${manual.join('、')} 优先采用指定组数；其余 ${autoCount} 次${target === null ? '自动选择组数' : '按期望人数安排'}。点击推荐不会覆盖已指定的组数。`;
  $('#auto-all-rounds').hidden = !manual.length;
  $('#auto-all-rounds').disabled = Boolean(activeJob);
  return { manual, allManual, invalid, autoCount };
}
function renderSizeSettings() {
  const container = $('#size-options'); container.replaceChildren();
  const preview = $('#size-preview');
  const people = draftPeople();
  const target = preferredSize();
  renderSizePolicy(people, target);
  $('#clear-size').disabled = Boolean(activeJob) || target === null;
  if (!validPeople(people)) { preview.textContent = '填写 6–300 人后，会自动推荐均匀分组。'; return; }
  ensureTypes(people);
  const base = { people, rounds: 1, typeMode: typeMode(), types: typeDraft.slice(0, people), preferredSize: target, fixedGroups: fixedDraft };
  let options;
  try { options = getSizeOptions(base); }
  catch (error) {
    preview.textContent = error.message;
    $('#size-policy-status').textContent = '当前设置需要调整';
    $('#size-policy-status').dataset.policy = 'invalid';
    if (target === null || Number.isInteger(target) && target >= 2 && target <= LIMITS.maxPeople) {
      $('#round-policy-summary').textContent = '请先调整类型或固定小组';
      document.querySelectorAll('[data-round-input]').forEach((input, index) => {
        input.parentElement.dataset.policy = 'pending';
        input.removeAttribute('aria-invalid');
        $(`#round-policy-${index}`).textContent = '类型或固定小组待调整 · 暂无可行安排';
      });
      $('#size-override-notice').hidden = false;
      $('#size-override').textContent = '当前类型或固定小组设置下没有可行分组。请按上方提示调整；改为自动也需要满足这些规则。';
    }
    return;
  }
  const { allManual, invalid, autoCount } = renderSizePolicy(people, target, options);
  const candidates = new Map();
  // 按真实候选组数去重；点击只改变期望值，保留逐次手动组数。
  for (const value of [...new Set([target, 4, 3, 5, 6, 2].filter(value => value !== null))]) {
    const candidateConfig = { ...base, preferredSize: value };
    const counts = getAutomaticGroupCounts(candidateConfig);
    const key = counts.join(',');
    const choices = getSizeOptions(candidateConfig).filter(option => counts.includes(option.groupCount));
    const previous = candidates.get(key);
    if (!previous || (previous.value !== target && choices[0].distance < previous.choices[0].distance)) candidates.set(key, { value, choices });
  }
  [...candidates.values()].sort((a, b) => Number(b.value === target) - Number(a.value === target) || Math.abs(a.value - 4) - Math.abs(b.value - 4)).slice(0, 4).sort((a, b) => a.value - b.value).forEach(({ value, choices }) => {
    const button = node('button', 'size-recommendation'); button.type = 'button';
    button.setAttribute('aria-pressed', String(target === value));
    button.disabled = Boolean(activeJob);
    button.append(node('strong', '', `期望 ${value} 人 / 组`));
    choices.forEach(option => button.append(node('span', '', `${option.groupCount} 组 · ${sizeDescription(option.sizes)}`)));
    button.addEventListener('click', () => {
      $('#size-input').value = value; $('#config-error').textContent = '';
      renderSizeSettings(); save();
    });
    container.append(button);
  });
  if (invalid.length && autoCount === 0) {
    preview.textContent = '各次作业均已填写组数，请先修正标记的输入；期望人数只用于组数留空的作业。';
  } else if (allManual) {
    preview.textContent = '所有作业都已指定组数，当前期望人数不会改变分组规模；将某次组数留空后才会应用。';
  } else if (target === null) {
    preview.textContent = '当前不限制每组人数，自动作业会搜索所有合法组数。点击推荐或填写期望人数，可以控制小组规模。';
  } else {
    const allowed = getAutomaticGroupCounts(base);
    const chosen = options.filter(option => allowed.includes(option.groupCount));
    preview.textContent = `自动作业最接近 ${target} 人 / 组的安排：${chosen.map(option => `${option.groupCount} 组（${sizeDescription(option.sizes)}）`).join(' 或 ')}。${chosen.length > 1 ? '同样接近，可在这些安排中优化新队友。' : '先满足这个规模，再优化新队友。'}${chosen.some(option => option.distance > 1) ? '受当前人数、至少 3 组和类型规则限制，实际人数与期望有差距。' : ''}`;
  }

}
function updateLockButtons() {
  document.querySelectorAll('[data-lock-group]').forEach(button => {
    const group = button.dataset.lockGroup.split(',').map(Number);
    const already = fixedDraft.some(fixed => fixed.length === group.length && group.every(id => fixed.includes(id)));
    button.textContent = already ? '已加入固定设置' : '固定这组';
    button.disabled = already || Boolean(activeJob) || currentResult()?.config.people !== draftPeople();
    button.title = currentResult()?.config.people !== draftPeople() ? '总人数已更改，请重新求解或在上方编辑固定小组。' : '加入固定设置，重新求解后各次都保持这组成员。';
  });
}
function renderFixedSettings() {
  const people = draftPeople();
  $('#edit-fixed').disabled = !validPeople(people) || Boolean(activeJob);
  const summary = $('#fixed-summary'); summary.replaceChildren();
  fixedDraft.forEach((group, index) => {
    const item = node('div', 'fixed-summary-item');
    item.append(node('strong', '', `固定组 ${index + 1} · ${group.length} 人`), node('span', '', group.map(id => `${nameOf(id)}${id > people ? '（超出总人数）' : ''}`).join('、')));
    summary.append(item);
  });
  const note = $('#fixed-draft-note');
  note.classList.remove('input-error');
  try {
    if (!validPeople(people)) throw new Error('先填写有效的总人数；已有固定小组暂时保留。');
    normalizeFixedGroups(fixedDraft, people);
    const changed = JSON.stringify(fixedDraft) !== JSON.stringify(state.config.fixedGroups ?? []);
    note.textContent = changed && currentResult() ? '固定设置待应用。重新求解后更新；下方仍显示上次结果。'
      : fixedDraft.length ? `共固定 ${fixedDraft.flat().length} 人，其余 ${people - fixedDraft.flat().length} 人参与轮换。` : '当前所有人参与轮换。也可以在下方结果中点击「固定这组」。';
  } catch (error) { note.textContent = `${error.message} 请编辑固定小组或恢复总人数，已有设置没有被删除。`; note.classList.add('input-error'); }
  updateLockButtons();
}
function lockResultGroup(group) {
  if (activeJob || currentResult()?.config.people !== draftPeople()) return;
  if (fixedDraft.some(fixed => fixed.length === group.length && group.every(id => fixed.includes(id)))) return;
  const overlap = fixedDraft.flat().filter(id => group.includes(id));
  if (overlap.length) { announce(`${overlap.map(nameOf).join('、')} 已属于其他固定组。请先在「编辑固定小组」中调整，原设置保持不变。`); return; }
  try {
    fixedDraft = normalizeFixedGroups([...fixedDraft, group], draftPeople());
    renderTypeSettings(); $('#config-error').textContent = '';
    save('已加入固定设置。重新求解后，这组在每次作业都保持原成员。');
  } catch (error) { announce(error.message); }
}
function renderTypeSettings() {
  renderSizeSettings();
  renderFixedSettings();
  const people = draftPeople();
  const valid = validPeople(people);
  const mode = typeMode();
  $('#edit-types').disabled = !valid || Boolean(activeJob);
  $('#type-policy-hint').textContent = {
    off: '只考虑新队友，不使用类型限制。类型标签可以提前保存。',
    mix: '把每种类型均匀分散到轮换小组，让同类型尽量分开，再优化新队友。固定组保留原成员。',
    within: '轮换小组只含相同类型；固定组保留原成员。所有小组仍保持人数差至多 1。',
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
    const hint = node('small'); hint.id = `round-policy-${i}`;
    input.setAttribute('aria-describedby', hint.id);
    label.append(input, hint); container.append(label);
  }
  $('#group-range').textContent = Number.isInteger(people) && people >= LIMITS.minPeople && people <= LIMITS.maxPeople
    ? `每次总组数（包含固定组）为 3–${maximum} 组；实际还须满足类型与固定小组设置。` : '每次至少 3 组、每组至少 2 人，总人数至少为 6。';
}
function fillSettings() {
  const settings = restoredDraft ?? state.config;
  $('#people-input').value = settings.people;
  $('#rounds-input').value = settings.rounds;
  $('#size-input').value = settings.preferredSize ?? '';
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
  return validateConfig({ people, rounds, groupCounts: Array.from({ length: Number.isInteger(rounds) && rounds > 0 && rounds <= LIMITS.maxRounds ? rounds : 0 }, (_, i) => roundDraft[i] ?? null), typeMode: typeMode(), types: typeDraft.slice(0, people), preferredSize: preferredSize(), fixedGroups: fixedDraft, objective: state.objective, seed });
}
function setBusy(busy) {
  $('#solve-button').disabled = busy;
  $('#edit-names').disabled = busy;
  $('#edit-types').disabled = busy || !validPeople(draftPeople());
  $('#edit-fixed').disabled = busy || !validPeople(draftPeople());
  updateLockButtons();
  $('#cancel-button').hidden = !busy;
  $('#solve-progress').hidden = !busy;
  document.querySelectorAll('#settings-form input, #settings-form select').forEach(input => { input.disabled = busy; });
  document.querySelectorAll('.size-recommendation').forEach(button => { button.disabled = busy; });
  $('#clear-size').disabled = busy || preferredSize() === null;
  $('#auto-all-rounds').disabled = busy;
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
      if (hasFixed(result) && result.metrics.rotatingPeople === 0) minimum.append(node('small', '', '全部固定 · 无需轮换'));
      else minimum.append(node('small', '', hasFixed(result) ? '轮换者至少' : '每人至少'), node('strong', '', String(objectiveMinimum(result))), node('small', '', '位'));
      const pairs = node('span');
      pairs.append(node('small', '', '不同搭档'), node('strong', '', String(result.metrics.uniquePairs)), node('small', '', '对'));
      numbers.append(minimum, pairs);
      $(`#${goal}-quality`).textContent = resultQuality(result);
    } else {
      numbers.textContent = '等待求解';
      $(`#${goal}-quality`).textContent = '';
    }
  }
  if (Object.keys(state.results).length) {
    $('#result-context').textContent = `当前结果：${state.config.people} 人 · ${state.config.rounds} 次作业 · ${sizeSettingDescription(state.config)} · ${typeTitles[state.config.typeMode ?? 'off']}${state.config.fixedGroups?.length ? ` · 固定 ${state.config.fixedGroups.length} 组` : ''}`;
  }
  const { fair, coverage } = state.results;
  $('#comparison-note').textContent = fair && coverage && fair.metrics.uniquePairs === coverage.metrics.uniquePairs && objectiveMinimum(fair) === objectiveMinimum(coverage)
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
      if (showTypes(result)) {
        button.append(node('span', 'chip-type', typeOf(id, result)));
        button.setAttribute('aria-label', `查看 ${displayName(id)}（${typeOf(id, result)}）的合作情况`);
      }
      button.addEventListener('click', () => { state.person = id; renderPerson(); save(); });
      people.append(button);
    });
    section.append(heading, people);
    if (showTypes(result)) section.append(node('p', 'group-types', typeCounts(group.map(id => typeOf(id, result))).map(([type, count]) => `${type} ${count} 人`).join(' · ')));
    const fixedIndex = fixedGroupIndex(group[0], result);
    if (fixedIndex >= 0) {
      section.dataset.fixed = 'true';
      section.append(node('p', 'fixed-group-badge', `固定组 ${fixedIndex + 1} · 不换人`));
    } else {
      const lock = node('button', 'lock-group', '固定这组'); lock.type = 'button';
      lock.dataset.lockGroup = group.join(',');
      lock.setAttribute('aria-label', `固定作业 ${state.round + 1} 第 ${index + 1} 组`);
      lock.addEventListener('click', () => lockResultGroup(group));
      section.append(lock);
    }
    container.append(section);
  });
  updateLockButtons();
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
  const eligible = person.eligibleTeammates;
  const fixedIndex = fixedGroupIndex(state.person, result);
  const scope = fixedIndex >= 0 ? '固定组伙伴' : hasFixed(result) ? `可合作的${within ? '同类型' : ''}轮换同学` : `${within ? '同类型' : '其他'}同学`;
  $('#person-total').textContent = `/ ${eligible} 位${scope}`;
  $('#person-fixed-note').hidden = !hasFixed(result);
  $('#person-fixed-note').textContent = fixedIndex >= 0 ? `固定组 ${fixedIndex + 1} · 每次保持原组，不与组外同学交换。` : '参与轮换 · 可合作范围不包含固定组成员。';
  const typed = showTypes(result);
  $('#person-type').hidden = !typed;
  $('#person-type').textContent = `类型：${typeOf(state.person, result)}`;
  $('#type-legend').hidden = !typed;
  $('#type-reference').textContent = `边框以当前同学 ${displayName(state.person)}（${typeOf(state.person, result)}）为参照；颜色仍表示新旧队友。`;
  $('#person-bar').style.width = `${eligible ? person.uniqueCount / eligible * 100 : 0}%`;
  $('#person-caption').textContent = person.uniqueCount === eligible ? fixedIndex >= 0 ? '固定组内伙伴已全部合作，后续保持原组。' : `已经和每一位${scope}合作。` : `可合作范围内还有 ${eligible - person.uniqueCount} 位同学尚未合作。`;
  $('#mate-title').textContent = `作业 ${state.round + 1} · 第 ${thisRound.groupIndex + 1} 组 · ${thisRound.newTeammates.length} 位新队友`;
  const mates = $('#mate-list'); mates.replaceChildren();
  thisRound.teammates.forEach(id => {
    const button = node('button', 'person-chip', displayName(id)); button.type = 'button';
    button.dataset.relation = thisRound.newTeammates.includes(id) ? 'fresh' : 'known';
    button.dataset.typeRelation = typed ? typeRelation(id, result) : '';
    if (typed) button.append(node('span', 'chip-type', typeOf(id, result)));
    button.setAttribute('aria-label', `${displayName(id)}，${thisRound.newTeammates.includes(id) ? '本次新队友' : '之前已合作'}${typed ? `，${typeRelationText(id, result)}` : ''}，查看合作情况`);
    button.addEventListener('click', () => { state.person = id; renderPerson(); save(); $('#person-select').focus({ preventScroll:true }); });
    mates.append(button);
  });
  document.querySelectorAll('#groups [data-person]').forEach(button => {
    const id = Number(button.dataset.person);
    button.setAttribute('aria-pressed', String(id === state.person));
    button.dataset.relation = thisRound.newTeammates.includes(id) ? 'fresh' : thisRound.teammates.includes(id) ? 'known' : '';
    button.dataset.typeRelation = typed ? typeRelation(id, result) : '';
    const relation = id === state.person ? '当前同学' : thisRound.newTeammates.includes(id) ? '本次新队友' : thisRound.teammates.includes(id) ? '本次曾合作队友' : '本次其他组同学';
    button.setAttribute('aria-label', `${displayName(id)}，${relation}${typed ? `，${typeRelationText(id, result)}` : ''}，查看合作情况`);
  });
  const history = $('#person-history'); history.replaceChildren();
  person.rounds.forEach(round => {
    const item = node('li');
    item.append(node('strong', '', `作业 ${round.roundIndex + 1} · 第 ${round.groupIndex + 1} 组 · 新认识 ${round.newTeammates.length} 位`), document.createTextNode(round.teammates.map(displayName).join('、')));
    history.append(item);
  });
  const seen = new Set([state.person, ...person.teammates]);
  const unmet = person.eligibleTeammateIds.filter(id => !seen.has(id));
  $('#unmet-title').textContent = `可合作但尚未合作（${unmet.length}）`;
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
  const fixed = hasFixed(result);
  const minimum = fixed ? m.rotatingMinimumTeammates : m.minimumTeammates;
  const maximum = fixed ? m.rotatingMaximumTeammates : m.maximumTeammates;
  $('#teammate-stat').hidden = fixed && !m.rotatingPeople;
  $('#teammate-label').textContent = fixed ? '轮换成员认识' : '每人认识';
  $('#teammate-range').textContent = minimum === maximum ? String(minimum) : `${minimum}–${maximum}`;
  const within = result.config.typeMode === 'within';
  const denominator = fixed || within ? m.eligiblePairs : m.possiblePairs;
  $('#coverage-label').textContent = fixed ? '可安排范围覆盖' : within ? '同类型内覆盖' : '全班覆盖';
  $('#coverage-value').textContent = `${m.uniquePairs}/${denominator} 对（${(m.uniquePairs / denominator * 100).toFixed(1)}%）`;
  $('#type-result-note').hidden = !showTypes(result);
  $('#type-result-note').textContent = within
    ? fixed ? '轮换成员只在同类型内组队；固定组可以跨类型，始终保留原成员。' : `只在同类型内计算可合作范围。全班实际覆盖 ${m.uniquePairs}/${m.possiblePairs} 对（${(m.coverage * 100).toFixed(1)}%）；不同类型之间不安排合作。`
    : result.config.typeMode === 'mix' ? '每种类型在轮换小组的人数差至多 1，再尽量增加新队友；固定组保留原成员。部分搭档可能因类型均匀分散的要求而无法同组。'
    : '本方案不使用类型限制；标签与实虚线仅用于查看人员类型。';
  $('#fixed-result-note').hidden = !fixed;
  $('#fixed-result-note').textContent = fixed ? `固定 ${m.fixedGroupCount} 组 / ${m.fixedPeople} 人；${m.rotatingPeople ? `其余 ${m.rotatingPeople} 人轮换，公平目标优先照顾轮换成员。轮换范围覆盖 ${m.rotatingUniquePairs}/${m.rotatingEligiblePairs} 对。` : '全部固定，无需轮换。'}固定组重复 ${m.fixedRepeatMeetings} 对次，轮换成员重复 ${m.rotatingRepeatMeetings} 对次。全班实际覆盖 ${m.uniquePairs}/${m.possiblePairs} 对（${(m.coverage * 100).toFixed(1)}%）。` : '';
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
        const config = { ...candidate.config, types: [...job.config.types], preferredSize: job.config.preferredSize, objective:goal };
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
  save();
  let config;
  try { config = readConfig(); } catch (error) { $('#config-error').textContent = error.message; return; }
  if (typeof Worker === 'undefined') { $('#config-error').textContent = '当前浏览器不支持后台求解，请使用较新的浏览器打开。'; return; }
  const job = { id:++nextJobId, config, results:{}, errors:[], workers:[], finished:new Set(), started:Date.now() };
  activeJob = job;
  setBusy(true);
  $('#progress-text').textContent = `正在为 ${config.people} 人、${config.rounds} 次作业比较两种目标；下方保留上次结果。`;
  for (const goal of objectives) {
    try {
      const worker = new Worker(new URL('./solver-worker.js?v=colors-1', import.meta.url), { type:'module' });
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
  const lines = [`Groupme · ${state.config.people} 人 / ${state.config.rounds} 次作业`, `目标：${titles[state.objective]}`, `小组规模：${sizeSettingDescription(result.config)}`, `类型方式：${typeTitles[result.config.typeMode]}`, resultQuality(result), ''];
  const rosterName = id => !showTypes(result) ? displayName(id) : `${displayName(id)}【${typeOf(id, result)}】`;
  if (hasFixed(result)) {
    lines.push('固定组从第一轮起保留原成员，已计入每次总组数；类型规则只作用于其余轮换成员。');
    result.config.fixedGroups.forEach((group, index) => lines.push(`固定组 ${index + 1}：${group.map(rosterName).join('、')}`));
    lines.push('');
  }
  result.assignments.forEach((groups, round) => {
    lines.push(`作业 ${round+1}（${groups.length} 组）`);
    groups.forEach((group, index) => {
      const fixedIndex = fixedGroupIndex(group[0], result);
      lines.push(`第 ${index+1} 组${fixedIndex >= 0 ? `（固定组 ${fixedIndex + 1} · 不换人）` : ''}：${group.map(rosterName).join('、')}`);
    }); lines.push('');
  });
  const m = result.metrics;
  lines.push(`每人认识 ${m.minimumTeammates}–${m.maximumTeammates} 位不同同学；${hasFixed(result) ? `可安排范围 ${m.uniquePairs}/${m.eligiblePairs} 对；` : result.config.typeMode === 'within' ? `同类型内 ${m.uniquePairs}/${m.eligiblePairs} 对；` : ''}全班 ${m.uniquePairs}/${m.possiblePairs} 对不同搭档；重复碰面 ${m.repeatMeetings} 对次。`);
  if (hasFixed(result)) lines.push(`${m.rotatingPeople ? `轮换 ${m.rotatingPeople} 人，每人认识 ${m.rotatingMinimumTeammates}–${m.rotatingMaximumTeammates} 位；轮换范围 ${m.rotatingUniquePairs}/${m.rotatingEligiblePairs} 对。` : '全部固定，无需轮换。'}固定组重复 ${m.fixedRepeatMeetings} 对次；轮换成员重复 ${m.rotatingRepeatMeetings} 对次。公平目标只比较轮换成员。`);
  if (result.config.typeMode === 'mix') lines.push('每种类型在轮换小组的人数差至多 1；覆盖比例不代表全部搭档均能在此限制下同组。');
  if (result.config.typeMode === 'off' && showTypes(result)) lines.push('类型标签仅供查看，本方案未使用类型限制。');
  return lines.join('\n');
}

$('#people-input').addEventListener('input', () => { renderRoundInputs(); renderTypeSettings(); });
$('#rounds-input').addEventListener('input', () => { renderRoundInputs(); renderSizeSettings(); });
$('#size-input').addEventListener('input', () => { $('#config-error').textContent = ''; renderSizeSettings(); });
$('#round-inputs').addEventListener('input', renderSizeSettings);
$('#clear-size').addEventListener('click', () => { $('#size-input').value = ''; $('#config-error').textContent = ''; renderSizeSettings(); save(); });
$('#auto-all-rounds').addEventListener('click', () => {
  document.querySelectorAll('[data-round-input]').forEach(input => { input.value = ''; });
  snapshotDraft(); renderSizeSettings(); $('#config-error').textContent = '';
  save('各次组数已改为自动。重新求解后应用当前期望人数。');
});
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
    renderResults(); renderFixedSettings(); namesDialog.close(); save('姓名已更新，分组位置保持不变。');
  } catch (error) { $('#names-error').textContent=error.message; $('#names-input').setAttribute('aria-invalid','true'); $('#names-input').focus(); }
});

const fixedDialog = $('#fixed-dialog');
let fixedEditorPeople = 0;
let fixedEditorGroups = [];
let fixedSelection = new Set();
function renderFixedPicker() {
  const container = $('#fixed-picker'); container.replaceChildren();
  const used = new Set(fixedEditorGroups.flat());
  const query = $('#fixed-search').value.trim().toLocaleLowerCase();
  let visible = 0;
  for (let id = 1; id <= fixedEditorPeople; id++) {
    if (used.has(id) || query && !`${id} ${nameOf(id)}`.toLocaleLowerCase().includes(query)) continue;
    const button = node('button', 'fixed-person', nameOf(id)); button.type = 'button';
    button.dataset.fixedPerson = String(id);
    button.setAttribute('aria-label', `选择 ${id} 号 ${nameOf(id)}`);
    button.setAttribute('aria-pressed', String(fixedSelection.has(id)));
    if (nameOf(id) !== `${id}号`) button.append(node('small', '', `${id}号`));
    button.addEventListener('click', () => {
      if (fixedSelection.has(id)) fixedSelection.delete(id); else fixedSelection.add(id);
      button.setAttribute('aria-pressed', String(fixedSelection.has(id))); updateFixedSelection();
    });
    container.append(button); visible++;
  }
  if (!visible) container.append(node('p', 'small-note', used.size === fixedEditorPeople ? '所有同学都已加入固定组。' : '没有匹配的未固定同学。'));
  updateFixedSelection();
}
function updateFixedSelection() {
  const count = fixedSelection.size;
  $('#add-fixed-selection').disabled = count < 2;
  $('#add-fixed-selection').textContent = count ? `将所选 ${count} 人固定为一组` : '选择至少 2 位同学';
  $('#clear-fixed-selection').disabled = !count;
  $('#fixed-error').textContent = '';
}
function renderFixedEditor() {
  const container = $('#fixed-editor-groups'); container.replaceChildren();
  fixedEditorGroups.forEach((group, index) => {
    const row = node('div', 'fixed-editor-group');
    const detail = node('div');
    detail.append(node('strong', '', `固定组 ${index + 1} · ${group.length} 人`), node('p', '', group.map(id => `${id}号 ${nameOf(id)}${id > fixedEditorPeople ? '（超出总人数）' : ''}`).join('、')));
    const remove = node('button', 'button button-plain', '移除'); remove.type = 'button';
    remove.setAttribute('aria-label', `移除固定组 ${index + 1}`);
    remove.addEventListener('click', () => { fixedEditorGroups.splice(index, 1); renderFixedEditor(); });
    row.append(detail, remove); container.append(row);
  });
  if (!fixedEditorGroups.length) container.append(node('p', 'small-note', '还没有固定小组。'));
  $('#fixed-bulk').value = fixedEditorGroups.map(group => group.join(', ')).join('\n');
  renderFixedPicker();
  const count = fixedEditorGroups.flat().length;
  $('#fixed-editor-summary').textContent = `当前列表：${fixedEditorGroups.length} 个固定组，${count} 位固定成员。未加入固定组的同学继续轮换。`;
  try { normalizeFixedGroups(fixedEditorGroups, fixedEditorPeople); }
  catch (error) { $('#fixed-error').textContent = error.message; }
}
$('#edit-fixed').addEventListener('click', () => {
  if (activeJob || !validPeople(draftPeople())) return;
  fixedEditorPeople = draftPeople(); fixedEditorGroups = fixedDraft.map(group => [...group]); fixedSelection = new Set();
  $('#fixed-search').value = ''; $('.bulk-fixed').open = false;
  $('#fixed-bulk').maxLength = LIMITS.maxPeople * 8;
  renderFixedEditor(); fixedDialog.showModal();
});
$('#close-fixed').addEventListener('click', () => fixedDialog.close());
$('#fixed-search').addEventListener('input', renderFixedPicker);
$('#fixed-search').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
$('#clear-fixed-selection').addEventListener('click', () => { fixedSelection.clear(); renderFixedPicker(); });
$('#add-fixed-selection').addEventListener('click', () => {
  try {
    fixedEditorGroups = normalizeFixedGroups([...fixedEditorGroups, [...fixedSelection]], fixedEditorPeople);
    fixedSelection.clear(); renderFixedEditor();
  } catch (error) { $('#fixed-error').textContent = error.message; }
});
$('#apply-fixed-bulk').addEventListener('click', () => {
  try {
    const lines = $('#fixed-bulk').value.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
    const groups = lines.map((line, index) => {
      const ids = line.split(/[,，\s]+/).filter(Boolean);
      if (ids.some(id => !/^[1-9]\d*$/.test(id))) throw new Error(`第 ${index + 1} 行请只填写正整数编号，用逗号或空格分隔。`);
      return ids.map(Number);
    });
    fixedEditorGroups = normalizeFixedGroups(groups, fixedEditorPeople);
    fixedSelection.clear(); renderFixedEditor();
  } catch (error) { $('#fixed-error').textContent = error.message; }
});
$('#fixed-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    if (fixedSelection.size) throw new Error('请先将所选成员加入固定组，或点击「取消选择」，再保存。');
    if ($('#fixed-bulk').value !== fixedEditorGroups.map(group => group.join(', ')).join('\n')) throw new Error('批量编号尚未填入列表，请先点击「填入固定组列表」，或关闭并重新编辑。');
    fixedDraft = normalizeFixedGroups(fixedEditorGroups, fixedEditorPeople);
    fixedDialog.close(); renderTypeSettings(); $('#config-error').textContent = '';
    save('固定小组已保存。重新求解后应用到分组；下方原有结果保持不变。');
  } catch (error) { $('#fixed-error').textContent = error.message; }
});

const typesDialog = $('#types-dialog');
let typesEditorPeople = 0;
let editorCatalog = [];
let quickCategoryCount = 2;
let quickLabels = [];
function editorTypeFields() { return [...document.querySelectorAll('[data-type-id]')]; }
function updateEditorSummary() {
  const types = editorTypeFields().map(input => input.value);
  $('#type-editor-summary').textContent = `当前列表：${typeCounts(types).map(([label, count]) => `${label} ${count} 人`).join(' · ')}`;
  $('#types-bulk').value = types.join('\n');
  $('#types-error').textContent = '';
}
function setEditorTypes(types) {
  editorCatalog = [...new Set([...editorCatalog, ...types, '未分类'])];
  editorTypeFields().forEach((select, index) => {
    select.replaceChildren(...editorCatalog.map(label => {
      const option = node('option', '', label); option.value = label; return option;
    }));
    select.value = types[index];
  });
  updateEditorSummary();
}
function readQuickPlan() {
  return createQuickTypePlan(typesEditorPeople,
    [...document.querySelectorAll('[data-quick-label]')].map(input => input.value),
    [...document.querySelectorAll('[data-quick-size]')].map(input => input.value.trim() === '' ? NaN : Number(input.value)));
}
function updateQuickPreview() {
  const preview = $('#quick-type-preview');
  try {
    const plan = readQuickPlan();
    $('#quick-type-remainder').textContent = `${plan.sizes.at(-1)} 人`;
    preview.textContent = `预览：${plan.ranges.map(({ label, count, start, end }) => `${label} ${count} 人（${start === end ? start : `${start}–${end}`}号）`).join('；')}。点击应用后填入列表。`;
    preview.classList.remove('input-error');
    $('#apply-quick-types').disabled = false;
  } catch (error) {
    $('#quick-type-remainder').textContent = '—';
    preview.textContent = error.message;
    preview.classList.add('input-error');
    $('#apply-quick-types').disabled = true;
  }
}
function renderQuickFields() {
  document.querySelectorAll('[data-quick-count]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.quickCount) === quickCategoryCount)));
  const sizes = quickTypeSizes(typesEditorPeople, quickCategoryCount);
  const fields = $('#quick-type-fields'); fields.replaceChildren();
  for (let i = 0; i < quickCategoryCount; i++) {
    const card = node('div', 'quick-type-card');
    const label = node('label', '', `第 ${i + 1} 类名称`);
    const input = node('input'); input.type = 'text'; input.maxLength = 40;
    input.value = quickLabels[i]; input.dataset.quickLabel = String(i);
    input.addEventListener('input', () => { quickLabels[i] = input.value; updateQuickPreview(); });
    label.append(input); card.append(label);
    if (i < quickCategoryCount - 1) {
      const countLabel = node('label', '', `第 ${i + 1} 类人数`);
      const count = node('input'); count.type = 'number'; count.min = '1'; count.max = String(typesEditorPeople - quickCategoryCount + 1); count.step = '1';
      count.value = sizes[i]; count.dataset.quickSize = String(i);
      count.addEventListener('input', updateQuickPreview);
      countLabel.append(count); card.append(countLabel);
    } else {
      const remainder = node('div', 'quick-type-remaining', '剩余人数（自动）');
      const value = node('output'); value.id = 'quick-type-remainder'; value.setAttribute('aria-label', `第 ${i + 1} 类剩余人数`);
      remainder.append(value); card.append(remainder);
    }
    fields.append(card);
  }
  updateQuickPreview();
}
$('#edit-types').addEventListener('click', () => {
  typesEditorPeople = draftPeople();
  if (!validPeople(typesEditorPeople) || activeJob) return;
  ensureTypes(typesEditorPeople);
  $('#types-title').textContent = `${typesEditorPeople} 位同学的类型`;
  $('#types-hint').textContent = '可快捷划分，再逐人调整。标签按编号绑定；保存后重新求解才会应用到结果，关闭则放弃本次编辑。';
  $('#types-error').textContent = '';
  $('#type-editor-status').textContent = '';
  $('#new-type-label').value = '';
  $('.bulk-types').open = false;
  editorCatalog = [...new Set(typeDraft.slice(0, typesEditorPeople))];
  quickLabels = editorCatalog.filter(label => label !== '未分类').slice(0, 3);
  for (const label of ['类型 A', '类型 B', '类型 C']) if (quickLabels.length < 3 && !quickLabels.includes(label)) quickLabels.push(label);
  quickCategoryCount = 2;
  const rows = $('#type-rows'); rows.replaceChildren();
  for (let id = 1; id <= typesEditorPeople; id++) {
    const row = node('label', 'type-row');
    const person = node('span', 'type-row-person');
    person.append(node('small', '', String(id).padStart(2, '0')), node('span', '', nameOf(id)));
    const select = node('select'); select.dataset.typeId = String(id);
    select.setAttribute('aria-label', `${id} 号同学 ${nameOf(id)} 的类型`);
    select.addEventListener('change', () => { updateEditorSummary(); $('#type-editor-status').textContent = ''; });
    row.append(person, select); rows.append(row);
  }
  $('#types-bulk').maxLength = typesEditorPeople * 42;
  setEditorTypes(typeDraft.slice(0, typesEditorPeople));
  renderQuickFields(); typesDialog.showModal();
});
$('#close-types').addEventListener('click', () => typesDialog.close());
document.querySelectorAll('[data-quick-count]').forEach(button => button.addEventListener('click', () => {
  quickCategoryCount = Number(button.dataset.quickCount); renderQuickFields();
}));
$('#balance-quick-types').addEventListener('click', renderQuickFields);
$('#apply-quick-types').addEventListener('click', () => {
  try {
    const plan = readQuickPlan(); setEditorTypes(plan.types);
    $('#type-editor-status').textContent = `已按编号填入 ${quickCategoryCount} 类，可继续逐人调整；点击「保存类型设置」后保留。`;
  } catch (error) { $('#types-error').textContent = error.message; }
});
function addEditorLabel() {
  try {
    const value = $('#new-type-label').value.trim();
    if (!value) throw new Error('请先填写新类型的名称。');
    const [label] = normalizeTypeLabels([value]);
    if (editorCatalog.includes(label)) throw new Error('这个类型已经在下拉选项中，可以直接选择。');
    editorCatalog.push(label);
    setEditorTypes(editorTypeFields().map(select => select.value));
    $('#new-type-label').value = '';
    $('#type-editor-status').textContent = `已添加“${label}”，可在下方任意同学的下拉菜单中选择。`;
  } catch (error) { $('#types-error').textContent = error.message; }
}
$('#add-type-label').addEventListener('click', addEditorLabel);
$('#new-type-label').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addEditorLabel(); } });
$('#quick-type-fields').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); if (!$('#apply-quick-types').disabled) $('#apply-quick-types').click(); } });
$('#apply-type-bulk').addEventListener('click', () => {
  try {
    let lines = $('#types-bulk').value.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === typesEditorPeople + 1 && lines.at(-1) === '') lines.pop();
    if (lines.length !== typesEditorPeople) throw new Error(`请按编号填写恰好 ${typesEditorPeople} 行，当前为 ${lines.length} 行；空行也占一位。`);
    setEditorTypes(normalizeTypeLabels(lines));
    $('#type-editor-status').textContent = '已填入列表，可继续逐人调整；保存后保留。';
  } catch (error) { $('#types-error').textContent = error.message; }
});
$('#types-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const types = normalizeTypeLabels(editorTypeFields().map(input => input.value));
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
