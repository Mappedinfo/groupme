const PERSON_COUNT = 14;
const PERSON_IDS = Object.freeze(Array.from({ length: PERSON_COUNT }, (_, i) => i + 1));

function freezePlan(plan) {
  for (const round of [plan.first, plan.second]) {
    round.forEach(Object.freeze);
    Object.freeze(round);
  }
  return Object.freeze(plan);
}

export const PLANS = Object.freeze([
  {
    id: 'four',
    label: '4 组 → 4 组',
    first: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11], [12, 13, 14]],
    second: [[1, 5, 9, 12], [2, 6, 10, 13], [3, 7, 11], [4, 8, 14]],
  },
  {
    id: 'mixed',
    label: '4 组 → 5 组',
    first: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11], [12, 13, 14]],
    second: [[1, 5, 9], [2, 6, 12], [3, 10, 13], [7, 11, 14], [4, 8]],
  },
  {
    id: 'five',
    label: '5 组 → 5 组',
    first: [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14]],
    second: [[1, 4, 7], [2, 10, 13], [5, 8, 11], [9, 12, 14], [3, 6]],
  },
].map(freezePlan));

export const DEFAULT_NAMES = Object.freeze(PERSON_IDS.map((id) => `${id}号`));

function validateOrder(order) {
  if (!Array.isArray(order) || order.length !== PERSON_COUNT
      || !Array.from(order).every((id) => Number.isInteger(id) && id >= 1 && id <= PERSON_COUNT)
      || new Set(order).size !== PERSON_COUNT) {
    throw new Error('人员顺序必须恰好包含 1 至 14 号，每人出现一次。');
  }
}

function validateAssignment(assignment) {
  if (!assignment || typeof assignment !== 'object') {
    throw new Error('请提供包含两次作业的有效分组。');
  }
  for (const [key, label] of [['first', '第一次'], ['second', '第二次']]) {
    const round = assignment[key];
    if (!Array.isArray(round) || round.length === 0
        || Array.from(round).some((group) => !Array.isArray(group) || group.length === 0)) {
      throw new Error(`${label}作业必须包含非空分组。`);
    }
    validateOrder(round.flatMap((group) => Array.from(group)));
  }
}

export function createAssignment(planId, order = PERSON_IDS) {
  const plan = PLANS.find((entry) => entry.id === planId);
  if (!plan) throw new Error('请选择有效的分组方案。');
  validateOrder(order);
  const mapRound = (round) => round.map((group) => group.map((id) => order[id - 1]));
  return { first: mapRound(plan.first), second: mapRound(plan.second) };
}

function pairsInRound(round) {
  const pairs = new Set();
  for (const group of round) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        pairs.add(`${Math.min(group[i], group[j])}:${Math.max(group[i], group[j])}`);
      }
    }
  }
  return pairs;
}

function teammatesFor(assignment, personId) {
  const firstGroup = assignment.first.findIndex((group) => group.includes(personId));
  const secondGroup = assignment.second.findIndex((group) => group.includes(personId));
  const first = assignment.first[firstGroup].filter((id) => id !== personId);
  const second = assignment.second[secondGroup].filter((id) => id !== personId);
  return { first, second, uniqueCount: new Set([...first, ...second]).size, firstGroup, secondGroup };
}

export function analyzeAssignment(assignment) {
  validateAssignment(assignment);
  const firstPairs = pairsInRound(assignment.first);
  const secondPairs = pairsInRound(assignment.second);
  const repeatedPairs = [...firstPairs].filter((pair) => secondPairs.has(pair)).length;
  const uniquePairs = new Set([...firstPairs, ...secondPairs]).size;
  const counts = new Map();
  for (const id of PERSON_IDS) {
    const { uniqueCount } = teammatesFor(assignment, id);
    counts.set(uniqueCount, (counts.get(uniqueCount) ?? 0) + 1);
  }
  const distribution = [...counts]
    .sort(([a], [b]) => b - a)
    .map(([teammates, people]) => ({ teammates, people }));
  return { repeatedPairs, uniquePairs, distribution, averageTeammates: (uniquePairs * 2) / PERSON_COUNT };
}

export function getTeammates(assignment, personId) {
  validateAssignment(assignment);
  if (!Number.isInteger(personId) || personId < 1 || personId > PERSON_COUNT) {
    throw new Error('请选择 1 至 14 号中的一位同学。');
  }
  return teammatesFor(assignment, personId);
}

export function shuffleOrder(order, random = Math.random) {
  validateOrder(order);
  if (typeof random !== 'function') throw new Error('随机来源必须是函数。');
  const shuffled = [...order];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new Error('随机来源必须返回 0 至 1 之间且不含 1 的数值。');
    }
    const j = Math.floor(sample * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function parseNames(text) {
  if (typeof text !== 'string') throw new Error('请按每行一人的格式输入姓名。');
  const names = text.split(/\r\n?|\n/u).map((name) => name.trim()).filter(Boolean);
  if (names.length !== PERSON_COUNT) {
    throw new Error(`请填写恰好 14 位同学，当前为 ${names.length} 位。`);
  }
  const tooLong = names.findIndex((name) => Array.from(name).length > 20);
  if (tooLong !== -1) throw new Error(`第 ${tooLong + 1} 位同学的姓名不能超过 20 个字符。`);
  return names;
}
