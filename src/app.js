import { PLANS, DEFAULT_NAMES, createAssignment, analyzeAssignment, getTeammates, shuffleOrder, parseNames } from './grouping.js';

const $ = selector => document.querySelector(selector);
const STORAGE_KEY = 'groupme.v1';
const originalOrder = Array.from({ length: 14 }, (_, i) => i + 1);
const state = { plan: 'four', names: [...DEFAULT_NAMES], order: [...originalOrder], person: 1 };
let assignment;
let statusTimer;

function announce(message) {
  clearTimeout(statusTimer);
  $('#status').textContent = message;
  statusTimer = setTimeout(() => { $('#status').textContent = ''; }, 7000);
}

function save(message = '') {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (message) announce(message);
  } catch {
    announce(`${message ? message + ' ' : ''}当前浏览器无法保存设置，刷新后会丢失；本次仍可正常分组和复制。`);
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || !PLANS.some(plan => plan.id === saved.plan) || !Array.isArray(saved.order) || !Array.isArray(saved.names) || saved.names.length !== 14 || saved.names.some(name => typeof name !== 'string')) throw new Error('invalid state');
    const names = parseNames(saved.names.join('\n'));
    createAssignment(saved.plan, saved.order);
    if (!Number.isInteger(saved.person) || saved.person < 1 || saved.person > 14) throw new Error('invalid person');
    Object.assign(state, { plan: saved.plan, names, order: saved.order, person: saved.person });
  } catch { announce('上次的设置无法读取，已使用默认编号；你可以重新填写姓名。'); }
}

const nameOf = id => state.names[id - 1];
const displayName = id => state.names.filter(name => name === nameOf(id)).length > 1 ? `${nameOf(id)}（${id}号）` : nameOf(id);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function label(main, detail, extra = '') {
  const element = node('div', `matrix-label ${extra}`);
  element.append(node('span', '', main), node('small', '', detail));
  return element;
}

function renderMatrix() {
  const matrix = $('#matrix');
  matrix.replaceChildren();
  matrix.style.gridTemplateColumns = `32px repeat(${assignment.second.length}, minmax(0, 1fr))`;
  matrix.append(label('作业一', '按行 →', 'corner'));
  assignment.second.forEach((group, index) => matrix.append(label(`B${index + 1}`, `${group.length} 人`, 'column')));
  assignment.first.forEach((group, row) => {
    matrix.append(label(`A${row + 1}`, `${group.length} 人`));
    assignment.second.forEach((column, col) => {
      const person = group.find(id => column.includes(id));
      if (person === undefined) {
        const empty = node('div', 'empty-cell', '·');
        empty.setAttribute('aria-label', `A${row + 1} 与 B${col + 1} 没有共同成员`);
        matrix.append(empty);
        return;
      }
      const button = node('button', 'person-cell');
      button.type = 'button';
      button.dataset.person = person;
      button.setAttribute('aria-label', `${displayName(person)}，作业一 A${row + 1} 组，作业二 B${col + 1} 组，查看队友`);
      button.title = displayName(person);
      button.append(node('span', 'cell-name', nameOf(person)));
      if (nameOf(person) !== DEFAULT_NAMES[person - 1]) button.append(node('span', 'cell-number', String(person).padStart(2, '0')));
      button.addEventListener('click', () => { state.person = person; renderPerson(); save(); });
      matrix.append(button);
    });
  });
}

function renderPerson(announceSelection = true) {
  const mates = getTeammates(assignment, state.person);
  $('#person-number').textContent = String(state.person).padStart(2, '0');
  $('#person-title').textContent = nameOf(state.person);
  $('#person-summary').replaceChildren(document.createTextNode('两次合作，认识 '), node('strong', '', String(mates.uniqueCount)), document.createTextNode(' 位不同队友。'));
  $('#first-group').textContent = `A${mates.firstGroup + 1} 组`;
  $('#second-group').textContent = `B${mates.secondGroup + 1} 组`;
  for (const round of ['first', 'second']) {
    const container = $(`#${round}-mates`);
    container.replaceChildren();
    mates[round].forEach(id => {
      const button = node('button', 'mate', displayName(id));
      button.type = 'button';
      button.setAttribute('aria-label', `查看 ${displayName(id)} 的队友`);
      button.addEventListener('click', () => {
        state.person = id;
        renderPerson();
        save();
        // 点击队友后，将焦点转到对应同学，避免重建名单导致焦点丢失。
        $(`#matrix [data-person="${id}"]`).focus({ preventScroll: true });
      });
      container.append(button);
    });
  }
  document.querySelectorAll('.person-cell').forEach(button => {
    const id = Number(button.dataset.person);
    button.setAttribute('aria-pressed', String(id === state.person));
    button.dataset.relation = id === state.person ? 'self' : mates.first.includes(id) ? 'first' : mates.second.includes(id) ? 'second' : 'none';
  });
  if (announceSelection) $('#selection-announcement').textContent = `${displayName(state.person)}，共 ${mates.uniqueCount} 位不同队友。作业一：${mates.first.map(displayName).join('、')}。作业二：${mates.second.map(displayName).join('、')}。`;
}

function renderRosters() {
  for (const round of ['first', 'second']) {
    const container = $(`#${round}-roster`);
    container.replaceChildren();
    $(`#${round}-sizes`).textContent = assignment[round].map(group => group.length).join(' + ') + ' 人';
    assignment[round].forEach((group, index) => {
      const row = node('div', 'roster-row');
      const members = node('div', 'roster-people');
      group.forEach(id => members.append(node('span', '', displayName(id))));
      row.append(node('span', 'roster-tag', `${round === 'first' ? 'A' : 'B'}${index + 1}`), members);
      container.append(row);
    });
  }
}

function render() {
  assignment = createAssignment(state.plan, state.order);
  const metrics = analyzeAssignment(assignment);
  document.querySelectorAll('[data-plan]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.plan === state.plan)));
  $('#repeat-count').textContent = metrics.repeatedPairs;
  $('#pair-count').textContent = metrics.uniquePairs;
  const sizes = groups => groups.map(group => group.length).join(' + ');
  const recommendation = state.plan === 'four' ? '这三种方案中，不同搭档最多。' : '所有人两次作业的队友都不重复。';
  $('#plan-note').textContent = `${sizes(assignment.first)} → ${sizes(assignment.second)} 人 · ${recommendation}`;
  $('#distribution').textContent = '当前方案的不同队友数：' + metrics.distribution.map(({ people, teammates }) => `${people} 人各有 ${teammates} 位`).join('；') + '。';
  renderMatrix();
  renderPerson(false);
  renderRosters();
}

function rosterText() {
  const lines = ['Groupme · 14 人 / 两次作业', ''];
  for (const [round, title, prefix] of [['first', '作业一', 'A'], ['second', '作业二', 'B']]) {
    lines.push(title);
    assignment[round].forEach((group, i) => lines.push(`${prefix}${i + 1}：${group.map(displayName).join('、')}`));
    lines.push('');
  }
  const metrics = analyzeAssignment(assignment);
  lines.push(`重复搭档 ${metrics.repeatedPairs} 对 · 不同搭档 ${metrics.uniquePairs} 对`);
  return lines.join('\n');
}

document.querySelectorAll('[data-plan]').forEach(button => button.addEventListener('click', () => {
  state.plan = button.dataset.plan;
  render();
  save(`已切换为 ${PLANS.find(plan => plan.id === state.plan).label}，队友零重复。`);
}));

$('#shuffle').addEventListener('click', () => {
  const next = shuffleOrder(state.order);
  if (next.every((id, i) => id === state.order[i])) [next[0], next[1]] = [next[1], next[0]];
  state.order = next;
  render();
  save('已重新打散。当前这两次作业，仍然零重复队友。');
});

const namesDialog = $('#names-dialog');
function updateNamesCount() {
  $('#names-count').textContent = `${$('#names-input').value.split(/\r?\n/).filter(line => line.trim()).length} / 14 位`;
}
$('#edit-names').addEventListener('click', () => {
  $('#names-input').value = state.names.join('\n');
  $('#names-error').textContent = '';
  $('#names-input').removeAttribute('aria-invalid');
  updateNamesCount();
  namesDialog.showModal();
});
$('#close-names').addEventListener('click', () => namesDialog.close());
$('#names-input').addEventListener('input', () => {
  updateNamesCount();
  $('#names-error').textContent = '';
  $('#names-input').removeAttribute('aria-invalid');
});
$('#restore-numbers').addEventListener('click', () => {
  $('#names-input').value = DEFAULT_NAMES.join('\n');
  $('#names-error').textContent = '';
  $('#names-input').removeAttribute('aria-invalid');
  updateNamesCount();
});
$('#names-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const nextNames = parseNames($('#names-input').value);
    state.names = nextNames;
    render();
    namesDialog.close();
    save('姓名已更新，分组位置保持不变。');
  } catch (error) {
    $('#names-error').textContent = error.message;
    $('#names-input').setAttribute('aria-invalid', 'true');
    $('#names-input').focus();
  }
});

$('#copy-rosters').addEventListener('click', async () => {
  const text = rosterText();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    announce('分组名单已复制，可以粘贴到群聊或文档。');
  } catch {
    $('#copy-text').value = text;
    $('#copy-dialog').showModal();
    $('#copy-text').focus();
    $('#copy-text').select();
  }
});
$('#close-copy').addEventListener('click', () => $('#copy-dialog').close());

restore();
render();
