import {
  LIMITS, validateConfig, validateSchedule, analyzeSchedule, evaluateProof,
  compareMetrics, parseNames, defaultNames, getSizeOptions, getAutomaticGroupCounts, normalizeFixedGroups,
} from './grouping.js?v=i18n-1';
import { quickTypeSizes, createQuickTypePlan, normalizeTypeLabels } from './type-editor.js?v=i18n-1';
import { t, getLanguage, setLanguage, errorText, proofText, localizeType, localizeName, applyPageTranslations } from './i18n.js?v=i18n-1';
import { appMessages } from './app-messages.js?v=i18n-1';

const $ = selector => document.querySelector(selector);
const objectives = ['fair', 'coverage'];
const titles = { get fair() { return t('app.goal.fair'); }, get coverage() { return t('app.goal.coverage'); } };
const typeTitles = { get off() { return t('app.type.off'); }, get mix() { return t('app.type.mix'); }, get within() { return t('app.type.within'); } };
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
const messageBindings = new Map();
const messageValue = value => typeof value === 'function' ? value() : value;
const joinList = values => values.join(t('app.listSeparator'));
const typeLabel = (id, result) => localizeType(typeOf(id, result));
function setMessage(selector, value) {
  const text = messageValue(value);
  $(selector).textContent = text;
  messageBindings.set(selector, { value, text });
}
function setError(selector, error) { setMessage(selector, () => errorText(error)); }
function uiError(key, params = {}) {
  const interpolate = text => text.replace(/\{([\w]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
  const error = new Error(interpolate(appMessages[key].zh));
  error.messageEn = interpolate(appMessages[key].en);
  return error;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function announce(message) {
  clearTimeout(statusTimer);
  setMessage('#status', message);
  statusTimer = setTimeout(() => { $('#status').textContent = ''; }, 10000);
}
function currentResult() { return state.results[state.objective]; }
function hasFixed(result) { return Boolean(result.config.fixedGroups?.length); }
function fixedGroupIndex(id, result) { return (result.config.fixedGroups ?? []).findIndex(group => group.includes(id)); }
function objectiveMinimum(result) { return hasFixed(result) ? result.metrics.rotatingMinimumTeammates : result.metrics.minimumTeammates; }
function rawNameOf(id) { return state.names[id - 1] || `${id}号`; }
function nameOf(id) { return localizeName(rawNameOf(id), id); }
function displayName(id) {
  return state.names.slice(0, state.config.people).filter(name => name === rawNameOf(id)).length > 1
    ? t('app.nameWithId', { name: nameOf(id), id }) : nameOf(id);
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
function typeRelationText(id, result) { return t(typeRelation(id, result) === 'same' ? 'app.typeRelation.same' : 'app.typeRelation.different', { type: typeLabel(id, result) }); }
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
  } catch { announce(() => `${message ? messageValue(message) + ' ' : ''}${t('app.storageUnavailable')}`); }
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
          announce(() => t('app.migrated'));
        }
      }
    }
  } catch { announce(() => t('app.restoreFailed')); }
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
  if (counts.size === 1) return t('app.size.each', { size: sizes[0] });
  return [...counts].sort(([a], [b]) => b - a).map(([size, count]) => t('app.size.composition', { count, size })).join(' + ');
}
function sizeSettingDescription(config) {
  if (config.preferredSize == null) return t('app.size.unrestricted');
  return t('app.size.preferred', { size: config.preferredSize }) + (config.groupCounts.some(count => count !== null) ? t('app.size.manualSuffix') : '');
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
    $(`#round-policy-${index}`).textContent = policy === 'manual' ? t('app.size.manualRound', { count })
      : policy === 'invalid' ? !validPeople(people) ? t('app.input.validPeople') : inRange ? t('app.size.incompatible') : t('app.size.countRange', { maximum: Math.floor(people / 2) })
      : !validTarget ? t('app.size.autoInvalid') : target === null ? t('app.size.autoUnrestricted') : t('app.size.autoPreferred', { target });
  });
  const autoCount = validRounds ? rounds - manual.length : 0;
  const allManual = validRounds && manual.length === rounds && !invalid.length;
  const status = $('#size-policy-status');
  status.dataset.policy = !validPeople(people) || !validRounds || !validTarget || invalid.length ? 'invalid' : allManual ? 'manual' : manual.length ? 'mixed' : 'auto';
  status.textContent = !validPeople(people) ? t('app.input.validPeople') : !validRounds ? t('app.input.validRounds')
    : !validTarget ? t('app.size.invalidPreferred') : invalid.length ? t('app.size.invalidRounds', { rounds: joinList(invalid) })
    : allManual ? t('app.size.allManual')
    : manual.length ? t('app.size.mixed', { manual: manual.length, auto: autoCount })
    : target === null ? t('app.size.allAutoUnrestricted', { rounds }) : t('app.size.allAutoPreferred', { rounds });
  $('#round-policy-summary').textContent = !validRounds ? t('app.input.validRounds') : invalid.length ? t('app.size.invalidCount', { count: invalid.length })
    : manual.length ? t('app.size.manualCount', { count: manual.length }) : t('app.size.optionalOverride');
  $('#size-override-notice').hidden = !manual.length;
  $('#size-override').textContent = !validRounds ? t('app.size.overrideInvalidRounds', { maximum: LIMITS.maxRounds })
    : !validPeople(people) ? t('app.size.overrideInvalidPeople')
    : !validTarget ? t('app.size.overrideInvalidPreferred')
    : invalid.length ? t('app.size.overrideInvalidCounts', { rounds: joinList(invalid) })
    : allManual ? t('app.size.overrideAllManual')
    : t(target === null ? 'app.size.overrideMixedUnrestricted' : 'app.size.overrideMixedPreferred', { rounds: joinList(manual), auto: autoCount });
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
  if (!validPeople(people)) { preview.textContent = t('app.size.enterPeople'); return; }
  ensureTypes(people);
  const base = { people, rounds: 1, typeMode: typeMode(), types: typeDraft.slice(0, people), preferredSize: target, fixedGroups: fixedDraft };
  let options;
  try { options = getSizeOptions(base); }
  catch (error) {
    preview.textContent = errorText(error);
    $('#size-policy-status').textContent = t('app.size.adjustSettings');
    $('#size-policy-status').dataset.policy = 'invalid';
    if (target === null || Number.isInteger(target) && target >= 2 && target <= LIMITS.maxPeople) {
      $('#round-policy-summary').textContent = t('app.size.adjustTypesFixed');
      document.querySelectorAll('[data-round-input]').forEach((input, index) => {
        input.parentElement.dataset.policy = 'pending';
        input.removeAttribute('aria-invalid');
        $(`#round-policy-${index}`).textContent = t('app.size.noFeasibleRound');
      });
      $('#size-override-notice').hidden = false;
      $('#size-override').textContent = t('app.size.noFeasibleOverride');
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
    button.append(node('strong', '', t('app.size.recommend', { value })));
    choices.forEach(option => button.append(node('span', '', t('app.size.option', { count: option.groupCount, sizes: sizeDescription(option.sizes) }))));
    button.addEventListener('click', () => {
      $('#size-input').value = value; $('#config-error').textContent = '';
      renderSizeSettings(); save();
    });
    container.append(button);
  });
  if (invalid.length && autoCount === 0) {
    preview.textContent = t('app.size.previewInvalidManual');
  } else if (allManual) {
    preview.textContent = t('app.size.previewAllManual');
  } else if (target === null) {
    preview.textContent = t('app.size.previewUnrestricted');
  } else {
    const allowed = getAutomaticGroupCounts(base);
    const chosen = options.filter(option => allowed.includes(option.groupCount));
    preview.textContent = t('app.size.previewPreferred', { target, options: chosen.map(option => t('app.size.optionDetail', { count: option.groupCount, sizes: sizeDescription(option.sizes) })).join(t('app.or')) })
      + t(chosen.length > 1 ? 'app.size.previewTied' : 'app.size.previewOne')
      + (chosen.some(option => option.distance > 1) ? t('app.size.previewGap') : '');
  }

}
function updateLockButtons() {
  document.querySelectorAll('[data-lock-group]').forEach(button => {
    const group = button.dataset.lockGroup.split(',').map(Number);
    const already = fixedDraft.some(fixed => fixed.length === group.length && group.every(id => fixed.includes(id)));
    button.textContent = t(already ? 'app.fixed.alreadyAdded' : 'app.fixed.lockGroup');
    button.disabled = already || Boolean(activeJob) || currentResult()?.config.people !== draftPeople();
    button.title = t(currentResult()?.config.people !== draftPeople() ? 'app.fixed.peopleChanged' : 'app.fixed.lockHint');
  });
}
function renderFixedSettings() {
  const people = draftPeople();
  $('#edit-fixed').disabled = !validPeople(people) || Boolean(activeJob);
  const summary = $('#fixed-summary'); summary.replaceChildren();
  fixedDraft.forEach((group, index) => {
    const item = node('div', 'fixed-summary-item');
    item.append(node('strong', '', t('app.fixed.groupSize', { index: index + 1, count: group.length })), node('span', '', joinList(group.map(id => `${nameOf(id)}${id > people ? t('app.fixed.outOfRange') : ''}`))));
    summary.append(item);
  });
  const note = $('#fixed-draft-note');
  note.classList.remove('input-error');
  try {
    if (!validPeople(people)) throw uiError('app.fixed.invalidPeople');
    normalizeFixedGroups(fixedDraft, people);
    const changed = JSON.stringify(fixedDraft) !== JSON.stringify(state.config.fixedGroups ?? []);
    note.textContent = changed && currentResult() ? t('app.fixed.pending')
      : fixedDraft.length ? t('app.fixed.summary', { fixed: fixedDraft.flat().length, rotating: people - fixedDraft.flat().length }) : t('app.fixed.none');
  } catch (error) { note.textContent = `${errorText(error)} ${t('app.fixed.adjustPreserved')}`; note.classList.add('input-error'); }
  updateLockButtons();
}
function lockResultGroup(group) {
  if (activeJob || currentResult()?.config.people !== draftPeople()) return;
  if (fixedDraft.some(fixed => fixed.length === group.length && group.every(id => fixed.includes(id)))) return;
  const overlap = fixedDraft.flat().filter(id => group.includes(id));
  if (overlap.length) { announce(() => t('app.fixed.overlap', { names: joinList(overlap.map(nameOf)) })); return; }
  try {
    fixedDraft = normalizeFixedGroups([...fixedDraft, group], draftPeople());
    renderTypeSettings(); $('#config-error').textContent = '';
    save(() => t('app.fixed.added'));
  } catch (error) { announce(() => errorText(error)); }
}
function renderTypeSettings() {
  renderSizeSettings();
  renderFixedSettings();
  const people = draftPeople();
  const valid = validPeople(people);
  const mode = typeMode();
  $('#edit-types').disabled = !valid || Boolean(activeJob);
  $('#type-policy-hint').textContent = t(`app.type.hint.${mode}`);
  const summary = $('#type-summary');
  summary.replaceChildren();
  if (!valid) { $('#type-draft-note').textContent = t('app.type.invalidPeople'); return; }
  ensureTypes(people);
  const counts = typeCounts(typeDraft.slice(0, people));
  counts.forEach(([type, count]) => summary.append(node('span', 'type-badge', t('app.type.badge', { type: localizeType(type), count }))));
  const changed = state.config.people !== people || (state.config.typeMode ?? 'off') !== mode || JSON.stringify(state.config.types ?? Array(state.config.people).fill('未分类')) !== JSON.stringify(typeDraft.slice(0, people));
  $('#type-draft-note').textContent = counts.length === 1 && mode !== 'off'
    ? t('app.type.allSame', { type: localizeType(counts[0][0]) }) + (changed ? t('app.type.solveToApply') : '')
    : changed && currentResult() ? t('app.type.pending')
    : t('app.type.exampleHint');
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
    const label = node('label');
    const caption = node('span', '', t('app.assignment', { number: i + 1 })); caption.dataset.roundLabel = String(i); label.append(caption);
    const input = node('input');
    input.type = 'number'; input.min = '3'; input.max = String(maximum); input.step = '1';
    input.placeholder = t('app.automatic'); input.dataset.roundInput = String(i); input.setAttribute('aria-label', t('app.roundCountAria', { number: i + 1 }));
    input.value = roundDraft[i] ?? '';
    const hint = node('small'); hint.id = `round-policy-${i}`;
    input.setAttribute('aria-describedby', hint.id);
    label.append(input, hint); container.append(label);
  }
  updateRoundInputLanguage();
}
function updateRoundInputLanguage() {
  document.querySelectorAll('[data-round-input]').forEach(input => {
    const number = Number(input.dataset.roundInput) + 1;
    input.placeholder = t('app.automatic');
    input.setAttribute('aria-label', t('app.roundCountAria', { number }));
    input.parentElement.querySelector('[data-round-label]').textContent = t('app.assignment', { number });
  });
  const people = draftPeople();
  $('#group-range').textContent = validPeople(people) ? t('app.groupRange', { maximum: Math.floor(people / 2) }) : t('app.groupMinimum');
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
function resultQuality(result) { return t(result.proof.optimal ? 'app.result.proven' : 'app.result.bestFound'); }
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
      if (hasFixed(result) && result.metrics.rotatingPeople === 0) minimum.append(node('small', '', t('app.result.allFixed')));
      else minimum.append(node('small', '', t(hasFixed(result) ? 'app.result.rotatingMinimum' : 'app.result.minimum')), node('strong', '', String(objectiveMinimum(result))), node('small', '', t('app.peopleUnit')));
      const pairs = node('span');
      pairs.append(node('small', '', t('app.result.uniquePairs')), node('strong', '', String(result.metrics.uniquePairs)), node('small', '', t('app.pairsUnit')));
      numbers.append(minimum, pairs);
      $(`#${goal}-quality`).textContent = resultQuality(result);
    } else {
      numbers.textContent = t('app.result.waiting');
      $(`#${goal}-quality`).textContent = '';
    }
  }
  if (Object.keys(state.results).length) {
    $('#result-context').textContent = t('app.result.context', { people: state.config.people, rounds: state.config.rounds, size: sizeSettingDescription(state.config), type: typeTitles[state.config.typeMode ?? 'off'] }) + (state.config.fixedGroups?.length ? t('app.result.fixedSuffix', { count: state.config.fixedGroups.length }) : '');
  }
  const { fair, coverage } = state.results;
  $('#comparison-note').textContent = fair && coverage && fair.metrics.uniquePairs === coverage.metrics.uniquePairs && objectiveMinimum(fair) === objectiveMinimum(coverage)
    ? t('app.result.sameMetrics')
    : t('app.result.compareHint');
}
function renderRound() {
  const result = currentResult();
  if (!result) return;
  const current = result.assignments[state.round];
  const metrics = result.metrics.rounds[state.round];
  const sizes = [...new Set(current.map(group => group.length))].sort((a,b) => a-b);
  $('#round-summary').textContent = t('app.round.summary', { groups: current.length, sizes: sizes.join('–'), pairs: metrics.uniqueNewPairs });
  const container = $('#groups');
  container.replaceChildren();
  current.forEach((group, index) => {
    const section = node('section', 'group');
    section.setAttribute('aria-label', t('app.round.groupAria', { round: state.round + 1, group: index + 1 }));
    const heading = node('div', 'group-heading');
    heading.append(node('strong', '', t('app.group', { number: index + 1 })), node('span', '', t('app.peopleCount', { count: group.length })));
    const people = node('div', 'group-people');
    group.forEach(id => {
      const button = node('button', 'person-chip', nameOf(id));
      button.type = 'button'; button.dataset.person = String(id);
      button.setAttribute('aria-label', t('app.person.inspect', { name: displayName(id) }));
      button.title = displayName(id);
      if (rawNameOf(id) !== `${id}号`) button.append(node('small', '', String(id)));
      if (showTypes(result)) {
        button.append(node('span', 'chip-type', typeLabel(id, result)));
        button.setAttribute('aria-label', t('app.person.inspectTyped', { name: displayName(id), type: typeLabel(id, result) }));
      }
      button.addEventListener('click', () => { state.person = id; renderPerson(); save(); });
      people.append(button);
    });
    section.append(heading, people);
    if (showTypes(result)) section.append(node('p', 'group-types', typeCounts(group.map(id => typeOf(id, result))).map(([type, count]) => t('app.type.count', { type: localizeType(type), count })).join(' · ')));
    const fixedIndex = fixedGroupIndex(group[0], result);
    if (fixedIndex >= 0) {
      section.dataset.fixed = 'true';
      section.append(node('p', 'fixed-group-badge', t('app.fixed.unchanged', { index: fixedIndex + 1 })));
    } else {
      const lock = node('button', 'lock-group', t('app.fixed.lockGroup')); lock.type = 'button';
      lock.dataset.lockGroup = group.join(',');
      lock.setAttribute('aria-label', t('app.fixed.lockAria', { round: state.round + 1, group: index + 1 }));
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
  const scope = t(fixedIndex >= 0 ? 'app.scope.fixed' : hasFixed(result) ? within ? 'app.scope.rotatingWithin' : 'app.scope.rotating' : within ? 'app.scope.within' : 'app.scope.class');
  $('#person-total').textContent = t('app.person.total', { count: eligible, scope });
  $('#person-fixed-note').hidden = !hasFixed(result);
  $('#person-fixed-note').textContent = fixedIndex >= 0 ? t('app.person.fixedNote', { index: fixedIndex + 1 }) : t('app.person.rotatingNote');
  const typed = showTypes(result);
  $('#person-type').hidden = !typed;
  $('#person-type').textContent = t('app.person.type', { type: typeLabel(state.person, result) });
  $('#type-legend').hidden = !typed;
  $('#type-reference').textContent = t('app.person.typeReference', { name: displayName(state.person), type: typeLabel(state.person, result) });
  $('#person-bar').style.width = `${eligible ? person.uniqueCount / eligible * 100 : 0}%`;
  $('#person-caption').textContent = person.uniqueCount === eligible ? fixedIndex >= 0 ? t('app.person.fixedComplete') : t('app.person.complete', { scope }) : t('app.person.remaining', { count: eligible - person.uniqueCount });
  $('#mate-title').textContent = t('app.person.roundTitle', { round: state.round + 1, group: thisRound.groupIndex + 1, count: thisRound.newTeammates.length });
  const mates = $('#mate-list'); mates.replaceChildren();
  thisRound.teammates.forEach(id => {
    const button = node('button', 'person-chip', displayName(id)); button.type = 'button';
    button.dataset.relation = thisRound.newTeammates.includes(id) ? 'fresh' : 'known';
    button.dataset.typeRelation = typed ? typeRelation(id, result) : '';
    if (typed) button.append(node('span', 'chip-type', typeLabel(id, result)));
    button.setAttribute('aria-label', t('app.person.relationAria', { name: displayName(id), relation: t(thisRound.newTeammates.includes(id) ? 'app.relation.fresh' : 'app.relation.previous'), type: typed ? t('app.ariaSeparator') + typeRelationText(id, result) : '' }));
    button.addEventListener('click', () => { state.person = id; renderPerson(); save(); $('#person-select').focus({ preventScroll:true }); });
    mates.append(button);
  });
  document.querySelectorAll('#groups [data-person]').forEach(button => {
    const id = Number(button.dataset.person);
    button.setAttribute('aria-pressed', String(id === state.person));
    button.dataset.relation = thisRound.newTeammates.includes(id) ? 'fresh' : thisRound.teammates.includes(id) ? 'known' : '';
    button.dataset.typeRelation = typed ? typeRelation(id, result) : '';
    const relation = t(id === state.person ? 'app.relation.selected' : thisRound.newTeammates.includes(id) ? 'app.relation.fresh' : thisRound.teammates.includes(id) ? 'app.relation.known' : 'app.relation.other');
    button.setAttribute('aria-label', t('app.person.relationAria', { name: displayName(id), relation, type: typed ? t('app.ariaSeparator') + typeRelationText(id, result) : '' }));
  });
  const history = $('#person-history'); history.replaceChildren();
  person.rounds.forEach(round => {
    const item = node('li');
    item.append(node('strong', '', t('app.person.history', { round: round.roundIndex + 1, group: round.groupIndex + 1, count: round.newTeammates.length })), document.createTextNode(joinList(round.teammates.map(displayName))));
    history.append(item);
  });
  const seen = new Set([state.person, ...person.teammates]);
  const unmet = person.eligibleTeammateIds.filter(id => !seen.has(id));
  $('#unmet-title').textContent = t('app.person.unmetTitle', { count: unmet.length });
  $('#unmet-list').textContent = unmet.length ? joinList(unmet.map(displayName)) : t('app.person.noneUnmet');
  if (shouldAnnounce) setMessage('#selection-announcement', () => t('app.person.announcement', { name: displayName(state.person), count: person.uniqueCount, round: state.round + 1, fresh: thisRound.newTeammates.length }));
}
function renderResults() {
  renderComparison();
  const result = currentResult();
  $('#results').hidden = !result;
  if (!result) return;
  state.person = Math.min(state.person, state.config.people);
  state.round = Math.min(state.round, state.config.rounds - 1);
  const m = result.metrics;
  $('#result-detail').textContent = t('app.result.detail', { title: titles[state.objective], people: state.config.people, rounds: state.config.rounds, type: typeTitles[result.config.typeMode] });
  const fixed = hasFixed(result);
  const minimum = fixed ? m.rotatingMinimumTeammates : m.minimumTeammates;
  const maximum = fixed ? m.rotatingMaximumTeammates : m.maximumTeammates;
  $('#teammate-stat').hidden = fixed && !m.rotatingPeople;
  $('#teammate-label').textContent = t(fixed ? 'app.result.rotatingRange' : 'app.result.range');
  $('#teammate-range').textContent = minimum === maximum ? String(minimum) : `${minimum}–${maximum}`;
  const within = result.config.typeMode === 'within';
  const denominator = fixed || within ? m.eligiblePairs : m.possiblePairs;
  $('#coverage-label').textContent = t(fixed ? 'app.result.eligibleCoverage' : within ? 'app.result.withinCoverage' : 'app.result.classCoverage');
  $('#coverage-value').textContent = t('app.result.coverageValue', { pairs: m.uniquePairs, denominator, percent: (m.uniquePairs / denominator * 100).toFixed(1) });
  $('#type-result-note').hidden = !showTypes(result);
  $('#type-result-note').textContent = within
    ? fixed ? t('app.result.withinFixedNote') : t('app.result.withinNote', { pairs: m.uniquePairs, possible: m.possiblePairs, percent: (m.coverage * 100).toFixed(1) })
    : t(result.config.typeMode === 'mix' ? 'app.result.mixNote' : 'app.result.offNote');
  $('#fixed-result-note').hidden = !fixed;
  $('#fixed-result-note').textContent = fixed ? t('app.result.fixedNote', { groups: m.fixedGroupCount, people: m.fixedPeople,
    rotating: m.rotatingPeople ? t('app.result.rotatingNote', { people: m.rotatingPeople, pairs: m.rotatingUniquePairs, eligible: m.rotatingEligiblePairs }) : t('app.result.noRotation'),
    fixedRepeats: m.fixedRepeatMeetings, rotatingRepeats: m.rotatingRepeatMeetings, pairs: m.uniquePairs, possible: m.possiblePairs, percent: (m.coverage * 100).toFixed(1) }) : '';
  $('#repeat-count').textContent = m.repeatMeetings;
  const select = $('#round-select'); select.replaceChildren();
  result.assignments.forEach((groups, i) => { const option = node('option', '', t('app.round.option', { number: i + 1, groups: groups.length })); option.value = String(i); select.append(option); });
  select.value = String(state.round);
  const personSelect = $('#person-select'); personSelect.replaceChildren();
  for (let id = 1; id <= state.config.people; id++) { const option = node('option', '', displayName(id)); option.value = String(id); personSelect.append(option); }
  $('#proof-description').textContent = `${resultQuality(result)}${t('app.sentenceSeparator')}${proofText(result.proof)}`;
  $('#search-description').textContent = t('app.result.search', { counts: result.assignments.map(groups=>groups.length).join(' / '), iterations: result.search.iterations });
  renderRound();
}
function settleJob(job) {
  if (activeJob !== job || !objectives.every(goal => job.finished.has(goal))) return;
  job.workers.forEach(worker => worker.terminate());
  clearTimeout(job.watchdog);
  activeJob = null;
  setBusy(false);
  const successful = objectives.filter(goal => job.results[goal]);
  if (!successful.length) { announce(() => t('app.job.failed', { errors: job.errors.map(messageValue).join(t('app.errorSeparator')) || t('app.retry') })); return; }
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
  save(() => job.errors.length ? t('app.job.partial', { errors: job.errors.map(messageValue).join(t('app.errorSeparator')) }) : t('app.job.complete'));
}
function startSolve() {
  if (activeJob) return;
  $('#config-error').textContent = '';
  save();
  let config;
  try { config = readConfig(); } catch (error) { setError('#config-error', error); return; }
  if (typeof Worker === 'undefined') { setMessage('#config-error', () => t('app.job.noWorker')); return; }
  const job = { id:++nextJobId, config, results:{}, errors:[], workers:[], finished:new Set(), started:Date.now() };
  activeJob = job;
  setBusy(true);
  setMessage('#progress-text', () => t('app.job.progress', { people: config.people, rounds: config.rounds }));
  for (const goal of objectives) {
    try {
      const worker = new Worker(new URL('./solver-worker.js?v=i18n-1', import.meta.url), { type:'module' });
      job.workers.push(worker);
      worker.onmessage = ({ data }) => {
        if (activeJob !== job || data.requestId !== `${job.id}-${goal}` || job.finished.has(goal)) return;
        if (data.type === 'result') {
          try {
            validateSchedule(data.result.assignments, config.people, { ...config, objective:goal });
            job.results[goal] = data.result;
          } catch (error) { job.errors.push(() => t('app.job.validationFailed', { goal: titles[goal], error: errorText(error) })); }
          job.finished.add(goal); worker.terminate();
          setMessage('#progress-text', () => t('app.job.oneComplete', { goal: titles[goal] }));
          settleJob(job);
        } else if (data.type === 'error') {
          job.errors.push(() => t('app.job.goalError', { goal: titles[goal], error: errorText(data) })); job.finished.add(goal); worker.terminate(); settleJob(job);
        }
      };
      worker.onerror = event => {
        if (activeJob !== job || job.finished.has(goal)) return;
        event.preventDefault(); job.errors.push(() => t('app.job.workerFailed', { goal: titles[goal] })); job.finished.add(goal); worker.terminate(); settleJob(job);
      };
      worker.postMessage({ type:'solve', requestId:`${job.id}-${goal}`, config:{ ...config, objective:goal }, timeBudgetMs:TIME_BUDGET });
    } catch (error) { job.errors.push(() => t('app.job.goalError', { goal: titles[goal], error: errorText(error) })); job.finished.add(goal); }
  }
  job.watchdog = setTimeout(() => {
    if (activeJob !== job) return;
    objectives.forEach(goal => { if (!job.finished.has(goal)) { job.finished.add(goal); job.errors.push(() => t('app.job.timeout', { goal: titles[goal] })); } });
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
  announce(() => t('app.job.cancelled'));
}
function rosterText() {
  const result = currentResult();
  const lines = [t('app.roster.heading', { people: state.config.people, rounds: state.config.rounds }), t('app.roster.objective', { goal: titles[state.objective] }), t('app.roster.size', { size: sizeSettingDescription(result.config) }), t('app.roster.type', { type: typeTitles[result.config.typeMode] }), resultQuality(result), ''];
  const rosterName = id => !showTypes(result) ? displayName(id) : t('app.roster.typedName', { name: displayName(id), type: typeLabel(id, result) });
  if (hasFixed(result)) {
    lines.push(t('app.roster.fixedRule'));
    result.config.fixedGroups.forEach((group, index) => lines.push(t('app.roster.fixedGroup', { index: index + 1, names: joinList(group.map(rosterName)) })));
    lines.push('');
  }
  result.assignments.forEach((groups, round) => {
    lines.push(t('app.roster.assignment', { round: round + 1, groups: groups.length }));
    groups.forEach((group, index) => {
      const fixedIndex = fixedGroupIndex(group[0], result);
      lines.push(t('app.roster.groupLine', { group: index + 1, fixed: fixedIndex >= 0 ? t('app.roster.fixedSuffix', { index: fixedIndex + 1 }) : '', names: joinList(group.map(rosterName)) }));
    }); lines.push('');
  });
  const m = result.metrics;
  lines.push(t('app.roster.statistics', { minimum: m.minimumTeammates, maximum: m.maximumTeammates, scope: hasFixed(result) ? t('app.roster.eligible', { pairs: m.uniquePairs, eligible: m.eligiblePairs }) : result.config.typeMode === 'within' ? t('app.roster.within', { pairs: m.uniquePairs, eligible: m.eligiblePairs }) : '', pairs: m.uniquePairs, possible: m.possiblePairs, repeats: m.repeatMeetings }));
  if (hasFixed(result)) lines.push((m.rotatingPeople ? t('app.roster.rotating', { people: m.rotatingPeople, minimum: m.rotatingMinimumTeammates, maximum: m.rotatingMaximumTeammates, pairs: m.rotatingUniquePairs, eligible: m.rotatingEligiblePairs }) : t('app.result.noRotation')) + t('app.roster.fixedStatistics', { fixedRepeats: m.fixedRepeatMeetings, rotatingRepeats: m.rotatingRepeatMeetings }));
  if (result.config.typeMode === 'mix') lines.push(t('app.roster.mixNote'));
  if (result.config.typeMode === 'off' && showTypes(result)) lines.push(t('app.roster.offNote'));
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
  save(() => t('app.size.changedToAuto'));
});
$('#settings-form').addEventListener('change', () => { renderTypeSettings(); save(); });
document.querySelectorAll('input[name="type-mode"]').forEach(input => input.addEventListener('change', () => { $('#config-error').textContent = ''; }));
$('#settings-form').addEventListener('submit', event => { event.preventDefault(); startSolve(); });
$('#cancel-button').addEventListener('click', cancelSolve);
for (const goal of objectives) $(`#${goal}-card`).addEventListener('click', () => { if (!state.results[goal]) return; state.objective = goal; renderResults(); save(); });
$('#round-select').addEventListener('change', () => { state.round = Number($('#round-select').value); renderRound(); save(); });
$('#person-select').addEventListener('change', () => { state.person = Number($('#person-select').value); renderPerson(); save(); });

const namesDialog = $('#names-dialog');
let namesEditorDefaults = new Map();
function updateNamesCount() { $('#names-count').textContent = t('app.names.count', { count: $('#names-input').value.split(/\r\n?|\n/).filter(line=>line.trim()).length, people: state.config.people }); }
function fillNamesEditor(names) {
  namesEditorDefaults = new Map();
  $('#names-input').value = names.map((name, index) => {
    const shown = localizeName(name, index + 1);
    if (name === `${index + 1}号`) namesEditorDefaults.set(index, shown);
    return shown;
  }).join('\n');
}
function translateNamesDialog() {
  $('#names-title').textContent = t('app.names.title', { people: state.config.people });
  $('#names-hint').textContent = t('app.names.hint');
  updateNamesCount();
}
$('#edit-names').addEventListener('click', () => {
  fillNamesEditor(state.names.slice(0, state.config.people));
  $('#names-input').maxLength = state.config.people * 42;
  translateNamesDialog();
  $('#names-error').textContent = ''; $('#names-input').removeAttribute('aria-invalid'); updateNamesCount(); namesDialog.showModal();
});
$('#close-names').addEventListener('click', () => namesDialog.close());
$('#names-input').addEventListener('input', () => { updateNamesCount(); $('#names-error').textContent=''; $('#names-input').removeAttribute('aria-invalid'); });
$('#restore-numbers').addEventListener('click', () => { fillNamesEditor(defaultNames(state.config.people)); $('#names-error').textContent=''; $('#names-input').removeAttribute('aria-invalid'); updateNamesCount(); });
$('#names-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const names = parseNames($('#names-input').value, state.config.people).map((name, index) => namesEditorDefaults.get(index) === name ? `${index + 1}号` : name);
    state.names = [...names, ...state.names.slice(state.config.people)];
    renderResults(); renderFixedSettings(); namesDialog.close(); save(() => t('app.names.saved'));
  } catch (error) { setError('#names-error', error); $('#names-input').setAttribute('aria-invalid','true'); $('#names-input').focus(); }
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
    button.setAttribute('aria-label', t('app.fixed.selectPerson', { id, name: nameOf(id) }));
    button.setAttribute('aria-pressed', String(fixedSelection.has(id)));
    if (rawNameOf(id) !== `${id}号`) button.append(node('small', '', t('app.personId', { id })));
    button.addEventListener('click', () => {
      if (fixedSelection.has(id)) fixedSelection.delete(id); else fixedSelection.add(id);
      button.setAttribute('aria-pressed', String(fixedSelection.has(id))); updateFixedSelection();
    });
    container.append(button); visible++;
  }
  if (!visible) container.append(node('p', 'small-note', t(used.size === fixedEditorPeople ? 'app.fixed.everyoneAdded' : 'app.fixed.noMatches')));
  updateFixedSelection();
}
function updateFixedSelection() {
  const count = fixedSelection.size;
  $('#add-fixed-selection').disabled = count < 2;
  $('#add-fixed-selection').textContent = count ? t('app.fixed.addSelection', { count }) : t('app.fixed.selectMinimum');
  $('#clear-fixed-selection').disabled = !count;
  $('#fixed-error').textContent = '';
}
function renderFixedEditor() {
  const container = $('#fixed-editor-groups'); container.replaceChildren();
  fixedEditorGroups.forEach((group, index) => {
    const row = node('div', 'fixed-editor-group');
    const detail = node('div');
    detail.append(node('strong', '', t('app.fixed.groupSize', { index: index + 1, count: group.length })), node('p', '', joinList(group.map(id => `${t('app.personId', { id })} ${nameOf(id)}${id > fixedEditorPeople ? t('app.fixed.outOfRange') : ''}`))));
    const remove = node('button', 'button button-plain', t('app.remove')); remove.type = 'button';
    remove.setAttribute('aria-label', t('app.fixed.removeAria', { index: index + 1 }));
    remove.addEventListener('click', () => { fixedEditorGroups.splice(index, 1); renderFixedEditor(); });
    row.append(detail, remove); container.append(row);
  });
  if (!fixedEditorGroups.length) container.append(node('p', 'small-note', t('app.fixed.emptyEditor')));
  $('#fixed-bulk').value = fixedEditorGroups.map(group => group.join(', ')).join('\n');
  renderFixedPicker();
  const count = fixedEditorGroups.flat().length;
  $('#fixed-editor-summary').textContent = t('app.fixed.editorSummary', { groups: fixedEditorGroups.length, people: count });
  try { normalizeFixedGroups(fixedEditorGroups, fixedEditorPeople); }
  catch (error) { setError('#fixed-error', error); }
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
  } catch (error) { setError('#fixed-error', error); }
});
$('#apply-fixed-bulk').addEventListener('click', () => {
  try {
    const lines = $('#fixed-bulk').value.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
    const groups = lines.map((line, index) => {
      const ids = line.split(/[,，\s]+/).filter(Boolean);
      if (ids.some(id => !/^[1-9]\d*$/.test(id))) throw uiError('app.fixed.invalidBulkLine', { line: index + 1 });
      return ids.map(Number);
    });
    fixedEditorGroups = normalizeFixedGroups(groups, fixedEditorPeople);
    fixedSelection.clear(); renderFixedEditor();
  } catch (error) { setError('#fixed-error', error); }
});
$('#fixed-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    if (fixedSelection.size) throw uiError('app.fixed.unappliedSelection');
    if ($('#fixed-bulk').value !== fixedEditorGroups.map(group => group.join(', ')).join('\n')) throw uiError('app.fixed.unappliedBulk');
    fixedDraft = normalizeFixedGroups(fixedEditorGroups, fixedEditorPeople);
    fixedDialog.close(); renderTypeSettings(); $('#config-error').textContent = '';
    save(() => t('app.fixed.saved'));
  } catch (error) { setError('#fixed-error', error); }
});

const typesDialog = $('#types-dialog');
let typesEditorPeople = 0;
let editorCatalog = [];
let quickCategoryCount = 2;
let quickLabels = [];
function editorTypeFields() { return [...document.querySelectorAll('[data-type-id]')]; }
function updateEditorSummary(synchronize = true) {
  const types = editorTypeFields().map(input => input.value);
  $('#type-editor-summary').textContent = t('app.typeEditor.summary', { types: typeCounts(types).map(([label, count]) => t('app.type.count', { type: localizeType(label), count })).join(' · ') });
  if (synchronize) { $('#types-bulk').value = types.join('\n'); $('#types-error').textContent = ''; }
}
function setEditorTypes(types) {
  editorCatalog = [...new Set([...editorCatalog, ...types, '未分类'])];
  editorTypeFields().forEach((select, index) => {
    select.replaceChildren(...editorCatalog.map(label => {
      const option = node('option', '', localizeType(label)); option.value = label; return option;
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
    $('#quick-type-remainder').textContent = t('app.peopleCount', { count: plan.sizes.at(-1) });
    preview.textContent = t('app.quick.preview', { ranges: plan.ranges.map(({ label, count, start, end }) => t('app.quick.range', { label: localizeType(label), count, range: start === end ? start : `${start}–${end}` })).join(t('app.errorSeparator')) });
    preview.classList.remove('input-error');
    $('#apply-quick-types').disabled = false;
  } catch (error) {
    $('#quick-type-remainder').textContent = '—';
    preview.textContent = errorText(error);
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
    const label = node('label', '', t('app.quick.categoryName', { number: i + 1 }));
    const input = node('input'); input.type = 'text'; input.maxLength = 40;
    input.value = quickLabels[i]; input.dataset.quickLabel = String(i);
    input.addEventListener('input', () => { quickLabels[i] = input.value; updateQuickPreview(); });
    label.append(input); card.append(label);
    if (i < quickCategoryCount - 1) {
      const countLabel = node('label', '', t('app.quick.categorySize', { number: i + 1 }));
      const count = node('input'); count.type = 'number'; count.min = '1'; count.max = String(typesEditorPeople - quickCategoryCount + 1); count.step = '1';
      count.value = sizes[i]; count.dataset.quickSize = String(i);
      count.addEventListener('input', updateQuickPreview);
      countLabel.append(count); card.append(countLabel);
    } else {
      const remainder = node('div', 'quick-type-remaining', t('app.quick.remaining'));
      const value = node('output'); value.id = 'quick-type-remainder'; value.setAttribute('aria-label', t('app.quick.remainingAria', { number: i + 1 }));
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
  $('#types-title').textContent = t('app.typeEditor.title', { people: typesEditorPeople });
  $('#types-hint').textContent = t('app.typeEditor.hint');
  $('#types-error').textContent = '';
  $('#type-editor-status').textContent = '';
  $('#new-type-label').value = '';
  $('.bulk-types').open = false;
  editorCatalog = [...new Set(typeDraft.slice(0, typesEditorPeople))];
  quickLabels = editorCatalog.filter(label => label !== '未分类').slice(0, 3);
  for (const letter of ['A', 'B', 'C']) { const label = t('app.quick.defaultName', { letter }); if (quickLabels.length < 3 && !quickLabels.includes(label)) quickLabels.push(label); }
  quickCategoryCount = 2;
  const rows = $('#type-rows'); rows.replaceChildren();
  for (let id = 1; id <= typesEditorPeople; id++) {
    const row = node('label', 'type-row');
    const person = node('span', 'type-row-person');
    person.append(node('small', '', String(id).padStart(2, '0')), node('span', '', nameOf(id)));
    const select = node('select'); select.dataset.typeId = String(id);
    select.setAttribute('aria-label', t('app.typeEditor.personAria', { id, name: nameOf(id) }));
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
    const count = quickCategoryCount;
    setMessage('#type-editor-status', () => t('app.quick.applied', { count }));
  } catch (error) { setError('#types-error', error); }
});
function addEditorLabel() {
  try {
    const value = $('#new-type-label').value.trim();
    if (!value) throw uiError('app.typeEditor.enterLabel');
    const [label] = normalizeTypeLabels([value]);
    if (editorCatalog.includes(label)) throw uiError('app.typeEditor.duplicateLabel');
    editorCatalog.push(label);
    setEditorTypes(editorTypeFields().map(select => select.value));
    $('#new-type-label').value = '';
    setMessage('#type-editor-status', () => t('app.typeEditor.added', { label: localizeType(label) }));
  } catch (error) { setError('#types-error', error); }
}
$('#add-type-label').addEventListener('click', addEditorLabel);
$('#new-type-label').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addEditorLabel(); } });
$('#quick-type-fields').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); if (!$('#apply-quick-types').disabled) $('#apply-quick-types').click(); } });
$('#apply-type-bulk').addEventListener('click', () => {
  try {
    let lines = $('#types-bulk').value.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === typesEditorPeople + 1 && lines.at(-1) === '') lines.pop();
    if (lines.length !== typesEditorPeople) throw uiError('app.typeEditor.bulkCount', { people: typesEditorPeople, count: lines.length });
    setEditorTypes(normalizeTypeLabels(lines));
    setMessage('#type-editor-status', () => t('app.typeEditor.bulkApplied'));
  } catch (error) { setError('#types-error', error); }
});
$('#types-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const types = normalizeTypeLabels(editorTypeFields().map(input => input.value));
    typeDraft = [...types, ...typeDraft.slice(typesEditorPeople)];
    typesDialog.close(); renderTypeSettings(); $('#config-error').textContent = '';
    save(() => t('app.typeEditor.saved'));
  } catch (error) { setError('#types-error', error); }
});
$('#copy-rosters').addEventListener('click', async () => {
  const text = rosterText();
  try { if (!navigator.clipboard?.writeText) throw new Error('unavailable'); await navigator.clipboard.writeText(text); announce(() => t('app.roster.copied')); }
  catch { $('#copy-text').value=text; $('#copy-dialog').showModal(); $('#copy-text').focus(); $('#copy-text').select(); }
});
$('#close-copy').addEventListener('click', () => $('#copy-dialog').close());

function translateTypesDialog() {
  $('#types-title').textContent = t('app.typeEditor.title', { people: typesEditorPeople });
  $('#types-hint').textContent = t('app.typeEditor.hint');
  for (const select of editorTypeFields()) {
    const id = Number(select.dataset.typeId);
    select.setAttribute('aria-label', t('app.typeEditor.personAria', { id, name: nameOf(id) }));
    select.closest('.type-row').querySelector('.type-row-person span').textContent = nameOf(id);
    for (const option of select.options) option.textContent = localizeType(option.value);
  }
  updateEditorSummary(false);
  for (const input of document.querySelectorAll('[data-quick-label]')) {
    input.parentElement.firstChild.textContent = t('app.quick.categoryName', { number: Number(input.dataset.quickLabel) + 1 });
  }
  for (const input of document.querySelectorAll('[data-quick-size]')) {
    input.parentElement.firstChild.textContent = t('app.quick.categorySize', { number: Number(input.dataset.quickSize) + 1 });
  }
  $('.quick-type-remaining').firstChild.textContent = t('app.quick.remaining');
  $('#quick-type-remainder').setAttribute('aria-label', t('app.quick.remainingAria', { number: quickCategoryCount }));
  updateQuickPreview();
}
function refreshLanguage() {
  // 只重译仍在显示的消息，输入操作可能已经清除了旧提示。
  const visibleMessages = [...messageBindings].filter(([selector, binding]) => $(selector)?.textContent === binding.text);
  messageBindings.clear();
  applyPageTranslations();
  updateRoundInputLanguage();
  renderTypeSettings();
  renderResults();
  if (namesDialog.open) translateNamesDialog();
  if (typesDialog.open) translateTypesDialog();
  if (fixedDialog.open) {
    const bulkInput = $('#fixed-bulk');
    const bulkDraft = bulkInput.value;
    const selection = [bulkInput.selectionStart, bulkInput.selectionEnd, bulkInput.selectionDirection];
    const focusedPerson = document.activeElement?.dataset.fixedPerson;
    renderFixedEditor();
    bulkInput.value = bulkDraft;
    bulkInput.setSelectionRange(...selection);
    if (focusedPerson) document.querySelector(`[data-fixed-person="${focusedPerson}"]`)?.focus();
  }
  if ($('#copy-dialog').open) $('#copy-text').value = rosterText();
  for (const [selector, { value }] of visibleMessages) setMessage(selector, value);
}
$('#language-select').addEventListener('change', event => {
  if (setLanguage(event.target.value)) refreshLanguage();
});

applyPageTranslations();
$('#language-select').value = getLanguage();
restore();
fillSettings();
renderResults();
if (!currentResult()) startSolve();
