import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, balancedSizes, validateConfig, validateSchedule, solveSchedule,
  analyzeSchedule, compareMetrics, getPersonSummary, defaultNames, parseNames, evaluateProof,
  feasibleGroupCounts, getSizeOptions, getAutomaticGroupCounts,
} from '../src/grouping.js';

const ids = (n) => Array.from({ length: n }, (_, index) => index + 1);
const configFor = (people, groupCounts, objective = 'fair', seed = 12345) => ({
  people, rounds: groupCounts.length, groupCounts, objective, seed,
});
const searchOptions = { timeBudgetMs: 10_000, maxIterations: 1800 };

// Independent accounting: application helpers do not derive these values.
function inspect(rounds, n) {
  const counts = new Map();
  const neighbors = Array.from({ length: n }, () => new Set());
  const details = [];
  for (const round of rounds) {
    let newPairs = 0;
    let meetings = 0;
    for (const group of round) for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const [a, b] = [group[i], group[j]].sort((x, y) => x - y);
        const key = `${a}:${b}`;
        if (!counts.has(key)) newPairs += 1;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        neighbors[a - 1].add(b);
        neighbors[b - 1].add(a);
        meetings += 1;
      }
    }
    details.push({ newPairs, meetings });
  }
  const degrees = neighbors.map((others) => others.size);
  return {
    uniquePairs: counts.size,
    repeatedPairs: [...counts.values()].filter((count) => count > 1).length,
    repeatMeetings: [...counts.values()].reduce((sum, count) => sum + count - 1, 0),
    minimumTeammates: Math.min(...degrees), maximumTeammates: Math.max(...degrees),
    sumSquaredTeammates: degrees.reduce((sum, count) => sum + count ** 2, 0),
    neighbors, degrees, rounds: details,
  };
}

function assertSchedule(result, input) {
  assert.equal(result.assignments.length, input.rounds);
  for (const [index, round] of result.assignments.entries()) {
    assert.deepEqual(round.flat().sort((a, b) => a - b), ids(input.people));
    assert.ok(round.length >= 3 && round.length <= Math.floor(input.people / 2));
    if (input.groupCounts[index] !== null) assert.equal(round.length, input.groupCounts[index]);
    const sizes = round.map((group) => group.length);
    assert.ok(Math.min(...sizes) >= 2);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
    assert.ok(new Set(sizes).size <= 2);
  }
  assert.equal(validateSchedule(result.assignments, input.people, result.config), true);
  const independent = inspect(result.assignments, input.people);
  for (const key of [
    'uniquePairs', 'repeatedPairs', 'repeatMeetings', 'minimumTeammates',
    'maximumTeammates', 'sumSquaredTeammates',
  ]) assert.equal(result.metrics[key], independent[key], key);
  assert.equal(result.metrics.possiblePairs, input.people * (input.people - 1) / 2);
  assert.equal(result.metrics.coverage, independent.uniquePairs / result.metrics.possiblePairs);
  assert.equal(result.metrics.averageTeammates, independent.uniquePairs * 2 / input.people);
  assert.ok(result.proof.uniquePairsUpperBound >= independent.uniquePairs);
  assert.ok(result.proof.minTeammatesUpperBound >= independent.minimumTeammates);
  assert.ok(Number.isFinite(result.search.elapsedMs) && result.search.elapsedMs >= 0);
  assert.ok(Number.isInteger(result.search.iterations) && result.search.iterations >= 0);
  return independent;
}

function score(metrics, objective) {
  return objective === 'fair'
    ? [metrics.minimumTeammates, metrics.uniquePairs, -metrics.sumSquaredTeammates]
    : [metrics.uniquePairs, metrics.minimumTeammates, -metrics.sumSquaredTeammates];
}

function compareVectors(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function* combinations(items, size, start = 0, current = []) {
  if (size === 0) { yield current; return; }
  for (let index = start; index <= items.length - size; index += 1) {
    yield* combinations(items, size - 1, index + 1, [...current, items[index]]);
  }
}

const partitionsCache = new Map();
function partitions(n, k) {
  const key = `${n}:${k}`;
  if (partitionsCache.has(key)) return partitionsCache.get(key);
  const groups = [];
  const q = Math.floor(n / k);
  const sizes = Array.from({ length: k }, (_, index) => q + Number(index < n % k));
  function visit(remaining, pending, chosen) {
    if (remaining.length === 0) { groups.push(chosen); return; }
    // Choosing the group of the smallest unused person removes only group-label
    // permutations, retaining every distinct partition, including both sizes.
    for (const size of new Set(pending)) {
      for (const others of combinations(remaining.slice(1), size - 1)) {
        const group = [remaining[0], ...others];
        const members = new Set(group);
        const nextSizes = pending.slice();
        nextSizes.splice(nextSizes.indexOf(size), 1);
        visit(remaining.filter((id) => !members.has(id)), nextSizes, [...chosen, group]);
      }
    }
  }
  visit(ids(n), sizes, []);
  const encoded = groups.map((round) => {
    const masks = Array(n).fill(0);
    for (const group of round) for (const a of group) for (const b of group) {
      if (a !== b) masks[a - 1] |= 1 << (b - 1);
    }
    return { round, masks };
  });
  partitionsCache.set(key, encoded);
  return encoded;
}

// Fixing a canonical first partition is sound: identities impose no constraints.
function exhaustiveBest(n, groupCounts, objective) {
  assert.ok(n <= 9, 'The independent bit-mask reference is for small N only.');
  const popcounts = Array.from({ length: 1 << n }, (_, mask) => {
    let count = 0;
    for (let value = mask; value; value &= value - 1) count += 1;
    return count;
  });
  const allowed = (k) => k === null ? Array.from({ length: Math.floor(n / 2) - 2 }, (_, i) => i + 3) : [k];
  const choices = groupCounts.map((k) => allowed(k).flatMap((count) => partitions(n, count)));
  let best = null;
  function visit(roundIndex, accumulated) {
    if (roundIndex === choices.length) {
      const degrees = accumulated.map((mask) => popcounts[mask]);
      const metrics = {
        minimumTeammates: Math.min(...degrees),
        uniquePairs: degrees.reduce((sum, value) => sum + value, 0) / 2,
        sumSquaredTeammates: degrees.reduce((sum, value) => sum + value ** 2, 0),
      };
      const next = score(metrics, objective);
      if (!best || compareVectors(next, best) > 0) best = next;
      return;
    }
    for (const candidate of choices[roundIndex]) {
      visit(roundIndex + 1, accumulated.map((mask, i) => mask | candidate.masks[i]));
    }
  }
  for (const k of allowed(groupCounts[0])) visit(1, partitions(n, k)[0].masks);
  return best;
}

test('均衡组型覆盖人数上下限，每组至少 2 人且至少 3 组', () => {
  assert.ok(LIMITS && typeof LIMITS === 'object');
  for (const n of [6, 7, 8, 9, 14, 20, 31, 300]) {
    for (let k = 3; k <= Math.floor(n / 2); k += 1) {
      const sizes = balancedSizes(n, k);
      assert.equal(sizes.length, k);
      assert.equal(sizes.reduce((sum, size) => sum + size, 0), n);
      assert.ok(sizes.every((size) => Number.isInteger(size) && size >= 2));
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
    }
  }
  assert.deepEqual(balancedSizes(14, 4), [4, 4, 3, 3]);
  assert.deepEqual(balancedSizes(14, 5), [3, 3, 3, 3, 2]);
});

test('配置拒绝不可行人数、作业数、组数与目标', () => {
  const valid = configFor(14, [null, 4, 7]);
  assert.deepEqual(validateConfig(valid).groupCounts, [null, 4, 7]);
  for (const people of [0, 5, 301, 6.5, NaN, Infinity]) assert.throws(() => validateConfig({ ...valid, people }), Error);
  for (const rounds of [0, 31, 1.5, NaN]) assert.throws(() => validateConfig({ ...valid, rounds }), Error);
  for (const groupCounts of [[2, 4, 7], [3, 8, 4], [3, 3.5, 4], [], [3, 4], [3, 4, undefined]]) {
    assert.throws(() => validateConfig({ ...valid, groupCounts }), Error);
  }
  assert.throws(() => validateConfig({ ...valid, objective: 'fewer-repeats' }), Error);
  assert.throws(() => validateConfig(null), Error);
});

test('独立枚举器的已知分区数量与 3 × 3 正交分组', () => {
  assert.equal(partitions(6, 3).length, 15);
  assert.equal(partitions(7, 3).length, 105);
  assert.equal(partitions(8, 3).length, 280);
  assert.equal(partitions(8, 4).length, 105);
  assert.equal(partitions(9, 3).length, 280);
  assert.deepEqual(exhaustiveBest(9, [3, 3], 'fair'), [4, 18, -144]);
});

for (const [n, counts] of [
  [6, [3, 3, 3]], [7, [3, 3, 3]], [8, [3, 3]], [8, [3, 4]],
  [8, [null, null, null]], [9, [3, 3]], [9, [3, 4]], [9, [null, null]],
]) {
  for (const objective of ['fair', 'coverage']) {
    test(`${n} 人 ${counts.map((k) => k ?? '自动').join('→')}：${objective} 与全部小规模可行解比较`, () => {
      const input = configFor(n, counts, objective);
      const result = solveSchedule(input, searchOptions);
      assertSchedule(result, input);
      const expected = exhaustiveBest(n, counts, objective);
      assert.deepEqual(score(result.metrics, objective), expected);
      assert.ok(result.proof.uniquePairsUpperBound >= expected[objective === 'fair' ? 1 : 0]);
      assert.ok(result.proof.minTeammatesUpperBound >= expected[objective === 'fair' ? 0 : 1]);
    });
  }
}

test('7 人 3 轮：主次目标满上界不代表第三层公平目标已获证明', () => {
  const result = solveSchedule(configFor(7, [3, 3, 3]), searchOptions);
  assert.equal(result.metrics.minimumTeammates, 4);
  assert.equal(result.metrics.uniquePairs, 15);
  assert.equal(result.metrics.sumSquaredTeammates, 132);
  // The arithmetic degree-balance bound is 130; exhaustive search proves it is
  // unattainable. A heuristic cannot claim to have proved this integrality gap.
  assert.equal(result.proof.optimal, false);
  assert.match(result.proof.label, /最优|最好|搜索|找到|best/iu);
});

for (const [n, counts] of [
  [14, [4, 5, 7]], [20, [3, 4, 5, 10]], [31, [3, 6, 10, 15]],
  [14, [null, 7, null, 4]], [20, [null, null, null, null, null]],
]) {
  for (const objective of ['fair', 'coverage']) {
    test(`${n} 人多轮混合组数：${objective} 遵守硬约束且统计独立复核`, () => {
      const input = configFor(n, counts, objective, 20261005);
      assertSchedule(solveSchedule(input, searchOptions), input);
    });
  }
}

test('两种优化目标使用字典序，公平差异只在主次目标相同时比较', () => {
  const equal = { minimumTeammates: 4, uniquePairs: 20, sumSquaredTeammates: 170, variance: 1 };
  const wider = { minimumTeammates: 3, uniquePairs: 22, sumSquaredTeammates: 190, variance: 2 };
  assert.ok(compareMetrics(equal, wider, 'fair') > 0);
  assert.ok(compareMetrics(equal, wider, 'coverage') < 0);
  assert.ok(compareMetrics({ ...equal, uniquePairs: 21 }, equal, 'fair') > 0);
  assert.ok(compareMetrics({ ...equal, minimumTeammates: 5 }, equal, 'coverage') > 0);
  assert.ok(compareMetrics({ ...equal, sumSquaredTeammates: 168, variance: 0.8 }, equal, 'fair') > 0);
  assert.ok(compareMetrics({ ...equal, sumSquaredTeammates: 168, variance: 0.8 }, equal, 'coverage') > 0);
  assert.equal(compareMetrics({ ...equal, repeatMeetings: 0 }, { ...equal, repeatMeetings: 30 }, 'fair'), 0);
  assert.equal(compareMetrics(equal, { ...equal }, 'coverage'), 0);
});

test('重复搭档对与额外相遇次数区分，个人每轮新增队友按历史累计', () => {
  const a = [[1, 2], [3, 4], [5, 6]];
  const b = [[1, 3], [2, 5], [4, 6]];
  const rounds = [a, a, b, a];
  const metrics = analyzeSchedule(rounds, 6);
  assert.equal(metrics.uniquePairs, 6);
  assert.equal(metrics.repeatedPairs, 3);
  assert.equal(metrics.repeatMeetings, 6);
  assert.equal(metrics.minimumTeammates, 2);
  assert.equal(metrics.coverage, 6 / 15);
  assert.deepEqual(metrics.rounds.map((round) => round.uniqueNewPairs), [3, 0, 3, 0]);
  assert.deepEqual(metrics.rounds.map((round) => round.pairMeetings), [3, 3, 3, 3]);
  const person = getPersonSummary(rounds, 6, 1);
  assert.equal(person.id, 1);
  assert.equal(person.uniqueCount, 2);
  assert.deepEqual([...person.teammates].sort((x, y) => x - y), [2, 3]);
  assert.deepEqual(person.rounds.map((round) => round.newTeammates), [[2], [], [3], []]);
  assert.deepEqual(person.rounds.map((round) => round.groupIndex), [0, 0, 0, 0]);
  assert.deepEqual(person.rounds.map((round) => round.roundIndex), [0, 1, 2, 3]);
});

test('6 人 5 轮轮转达到人人全覆盖，可严格标记最优', () => {
  for (const objective of ['fair', 'coverage']) {
    const input = configFor(6, Array(5).fill(null), objective, 888);
    const result = solveSchedule(input, searchOptions);
    assertSchedule(result, input);
    assert.equal(result.metrics.uniquePairs, 15);
    assert.equal(result.metrics.minimumTeammates, 5);
    assert.equal(result.metrics.maximumTeammates, 5);
    assert.equal(result.metrics.repeatedPairs, 0);
    assert.equal(result.metrics.coverage, 1);
    assert.equal(result.proof.optimal, true);
  }
});

test('新人目标不被零重复的两人组诱导：14 人单轮自动选择更大均衡组', () => {
  for (const objective of ['fair', 'coverage']) {
    const input = configFor(14, [null], objective);
    const result = solveSchedule(input, searchOptions);
    assertSchedule(result, input);
    assert.equal(result.metrics.uniquePairs, 26);
    assert.equal(result.metrics.minimumTeammates, 3);
    assert.equal(result.assignments[0].length, 3);
    assert.equal(result.proof.optimal, true);
  }
});

test('固定 seed 和工作量复现结果且不修改调用输入', () => {
  const input = configFor(20, [4, null, 5, null], 'fair', 9182);
  Object.freeze(input.groupCounts);
  Object.freeze(input);
  const first = solveSchedule(input, searchOptions);
  const second = solveSchedule(input, searchOptions);
  assert.deepEqual(first.assignments, second.assignments);
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.proof, second.proof);
  assert.equal(first.search.iterations, second.search.iterations);
  assert.deepEqual(input.groupCounts, [4, null, 5, null]);
});

test('最大人数与作业数仍输出合法结果并遵守有界搜索', () => {
  const input = configFor(300, Array(30).fill(150), 'coverage', 11);
  const started = performance.now();
  const result = solveSchedule(input, { timeBudgetMs: 500, maxIterations: 5 });
  assertSchedule(result, input);
  assert.ok(performance.now() - started < 10_000, '300 人 30 轮必须在有限时间返回。');
});

test('分组校验拒绝重复、缺失、单人组、只有两组和人数差超过 1', () => {
  const invalid = [
    [[[1, 2], [3, 4], [5, 5]]], [[[1, 2], [3, 4], [5, 7]]],
    [[[1, 2, 3], [4, 5], [6]]], [[[1, 2, 3], [4, 5, 6]]],
    [[[1, 2], [3, 4]]], [], [null], [[null]],
  ];
  for (const rounds of invalid) assert.throws(() => validateSchedule(rounds, 6), Error);
  assert.throws(() => validateSchedule([[[1, 2, 3, 4], [5, 6], [7, 8]]], 8), Error);
  const valid = [[[1, 2], [3, 4], [5, 6]]];
  for (const id of [0, 7, 1.5, NaN, '1']) assert.throws(() => getPersonSummary(valid, 6, id), Error);
  assert.throws(() => validateSchedule(valid, 6, configFor(6, [3, 3])), Error);
});

test('任意支持人数的姓名允许重名，按码点限长，数量与类型错误可见', () => {
  for (const n of [6, 14, 31, 300]) {
    const names = defaultNames(n);
    assert.equal(names.length, n);
    assert.deepEqual(parseNames(names.join('\n'), n), names);
    assert.deepEqual(parseNames(`\n ${Array(n).fill(' 同学 ').join('\r\n')} \n`, n), Array(n).fill('同学'));
    assert.throws(() => parseNames(names.slice(1).join('\n'), n), Error);
    assert.throws(() => parseNames([...names, '多一人'].join('\n'), n), Error);
  }
  const names = defaultNames(6);
  names[0] = '😀'.repeat(20);
  assert.deepEqual(parseNames(names.join('\n'), 6), names);
  names[0] = '😀'.repeat(21);
  assert.throws(() => parseNames(names.join('\n'), 6), Error);
  for (const value of [null, undefined, 14, []]) assert.throws(() => parseNames(value, 6), Error);
});

test('搜索预算、工作量、种子与进度回调的边界被校验', () => {
  const config = configFor(6, [3]);
  for (const seed of [-1, 0x100000000, 1.2, NaN, Infinity]) {
    assert.throws(() => validateConfig({ ...config, seed }), Error);
  }
  assert.equal(validateConfig({ ...config, seed: 0xffffffff }).seed, 0xffffffff);
  for (const timeBudgetMs of [0, -1, 30_001, NaN, Infinity]) {
    assert.throws(() => solveSchedule(config, { timeBudgetMs }), Error);
  }
  for (const maxIterations of [-1, 10_000_001, 1.5, NaN]) {
    assert.throws(() => solveSchedule(config, { maxIterations }), Error);
  }
  assert.throws(() => solveSchedule(config, { onProgress: true }), Error);
  const result = solveSchedule(config, { timeBudgetMs: 1000, maxIterations: 0 });
  assertSchedule(result, config);
});

test('证明由实际分组重算，不能把未全覆盖或指定组数不符的分组认证', () => {
  const round = [[1, 2], [3, 4], [5, 6]];
  const config = configFor(6, [3, 3, 3, 3, 3]);
  const proof = evaluateProof(Array(5).fill(round), config);
  assert.equal(proof.optimal, false);
  assert.equal(proof.uniquePairsUpperBound, 15);
  assert.equal(proof.minTeammatesUpperBound, 5);
  const good = solveSchedule(config, searchOptions);
  assert.deepEqual(evaluateProof(good.assignments, config), good.proof);
  assert.throws(() => evaluateProof([round], config), Error);
});

test('Worker 实际消息处理保留请求编号，返回可验证分组和可见输入错误', async () => {
  const previousSelf = globalThis.self;
  const messages = [];
  let handler;
  globalThis.self = {
    addEventListener(type, listener) {
      assert.equal(type, 'message');
      handler = listener;
    },
    postMessage(message) { messages.push(message); },
  };
  try {
    await import('../src/solver-worker.js');
    assert.equal(typeof handler, 'function');
    const config = configFor(9, [3, 3]);
    handler({ data: { type: 'solve', requestId: 'case-good', config, timeBudgetMs: 100 } });
    const result = messages.find((message) => message.type === 'result');
    assert.ok(result);
    assert.equal(result.requestId, 'case-good');
    assertSchedule(result.result, config);
    assert.ok(messages.every((message) => message.requestId === 'case-good'));
    messages.length = 0;
    const typed = { ...configFor(8, [null, null]), typeMode: 'within', types: labelsFromSizes([4, 4]) };
    handler({ data: { type: 'solve', requestId: 'case-types', config: typed, timeBudgetMs: 100 } });
    const typedResult = messages.find((message) => message.type === 'result');
    assert.ok(typedResult);
    assert.equal(typedResult.requestId, 'case-types');
    assertSchedule(typedResult.result, typed);
    assert.ok(typedResult.result.assignments.every((round) => followsTypes(round, typed.types, 'within')));
    messages.length = 0;
    const preferred = {
      ...configFor(14, [null, 7]), preferredSize: 5,
      typeMode: 'within', types: labelsFromSizes([6, 8]),
    };
    handler({ data: { type: 'solve', requestId: 'case-size', config: preferred, timeBudgetMs: 100 } });
    const preferredResult = messages.find((message) => message.type === 'result');
    assert.ok(preferredResult);
    assert.equal(preferredResult.requestId, 'case-size');
    assert.equal(preferredResult.result.config.preferredSize, 5);
    assert.deepEqual(preferredResult.result.assignments.map((round) => round.length), [4, 7]);
    assertSchedule(preferredResult.result, preferred);
    messages.length = 0;
    handler({ data: { type: 'solve', requestId: 0, config: { ...config, people: 5 } } });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'error');
    assert.equal(messages[0].requestId, 0);
    assert.match(messages[0].message, /人数/);
    messages.length = 0;
    handler({ data: { type: 'unrelated', requestId: 'ignore' } });
    assert.equal(messages.length, 0);
  } finally {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});

const labelsFromSizes = (sizes) => sizes.flatMap((size, index) => Array(size).fill(`类型${index + 1}`));

function followsTypes(round, types, mode) {
  if (mode === 'off') return true;
  if (mode === 'within') return round.every((group) => new Set(group.map((id) => types[id - 1])).size === 1);
  return [...new Set(types)].every((type) => {
    const counts = round.map((group) => group.filter((id) => types[id - 1] === type).length);
    return Math.max(...counts) - Math.min(...counts) <= 1;
  });
}

// Unlike the untyped reference, retain every first partition: relabeling students
// across types is not a symmetry. Only independently enumerated legal partitions
// are combined, avoiding the implementation's type-allocation formulas.
function exhaustiveTypedBest(config) {
  const n = config.people;
  assert.ok(n <= 9);
  const choices = config.groupCounts.map((specified) => {
    const counts = specified === null ? Array.from({ length: Math.floor(n / 2) - 2 }, (_, i) => i + 3) : [specified];
    return counts.flatMap((k) => partitions(n, k)).filter(({ round }) => followsTypes(round, config.types, config.typeMode));
  });
  if (choices.some((round) => round.length === 0)) return null;
  const popcounts = Array.from({ length: 1 << n }, (_, mask) => {
    let count = 0;
    for (let value = mask; value; value &= value - 1) count += 1;
    return count;
  });
  let best = null;
  function visit(index, masks) {
    if (index === choices.length) {
      const degrees = masks.map((mask) => popcounts[mask]);
      const metrics = {
        minimumTeammates: Math.min(...degrees),
        uniquePairs: degrees.reduce((sum, value) => sum + value, 0) / 2,
        sumSquaredTeammates: degrees.reduce((sum, value) => sum + value ** 2, 0),
      };
      const candidate = score(metrics, config.objective);
      if (!best || compareVectors(candidate, best) > 0) best = candidate;
      return;
    }
    for (const candidate of choices[index]) visit(index + 1, masks.map((mask, person) => mask | candidate.masks[person]));
  }
  visit(0, Array(n).fill(0));
  return best;
}

test('类型配置默认关闭，空白归入未分类，类型数与字符串长度有界', () => {
  const base = configFor(6, [3]);
  assert.equal(validateConfig(base).typeMode, 'off');
  const normalized = validateConfig({ ...base, typeMode: 'mix', types: [' A ', '', '  ', 'B', 'B', '😀'.repeat(20)] });
  assert.equal(normalized.types[0], 'A');
  assert.equal(normalized.types[1], '未分类');
  assert.equal(normalized.types[2], '未分类');
  assert.equal(normalized.types[5], '😀'.repeat(20));
  for (const typeMode of ['similar', '', 1]) assert.throws(() => validateConfig({ ...base, typeMode }), Error);
  for (const types of [[], Array(5).fill('A'), Array(7).fill('A'), [1, 'A', 'A', 'A', 'A', 'A'], 'AAAAAA']) {
    assert.throws(() => validateConfig({ ...base, typeMode: 'mix', types }), Error);
  }
  assert.throws(() => validateConfig({ ...base, types: ['😀'.repeat(21), 'A', 'A', 'A', 'A', 'A'] }), Error);
});

test('类型内可行组数与小规模全部分区独立枚举一致', () => {
  for (const sizes of [[6], [3, 3], [2, 4], [3, 4], [2, 2, 3], [4, 4], [2, 3, 3], [4, 5], [3, 3, 3], [2, 3, 4]]) {
    const n = sizes.reduce((sum, count) => sum + count, 0);
    const types = labelsFromSizes(sizes);
    const expected = [];
    for (let k = 3; k <= Math.floor(n / 2); k += 1) {
      const feasible = partitions(n, k).some(({ round }) => followsTypes(round, types, 'within'));
      const config = { ...configFor(n, [k]), typeMode: 'within', types };
      if (feasible) {
        expected.push(k);
        assert.doesNotThrow(() => validateConfig(config));
        const result = solveSchedule(config, searchOptions);
        assertSchedule(result, config);
        assert.ok(result.assignments.every((round) => followsTypes(round, types, 'within')));
      } else assert.throws(() => validateConfig(config), Error, `${sizes.join('+')} 人不能分成 ${k} 组`);
    }
    const automatic = { ...configFor(n, [null]), typeMode: 'within', types };
    if (expected.length) assert.deepEqual(feasibleGroupCounts(automatic), expected);
    else assert.throws(() => validateConfig(automatic), Error);
  }
});

test('类型内关键可行性：4+4 自动选四组，6+8 可四组但不能三组', () => {
  const equal = { ...configFor(8, [null, null]), typeMode: 'within', types: labelsFromSizes([4, 4]) };
  assert.deepEqual(feasibleGroupCounts(equal), [4]);
  const result = solveSchedule(equal, searchOptions);
  assertSchedule(result, equal);
  assert.deepEqual(result.assignments.map((round) => round.length), [4, 4]);
  const uneven = { ...configFor(14, [4, 7]), typeMode: 'within', types: labelsFromSizes([6, 8]) };
  const legal = solveSchedule(uneven, searchOptions);
  assertSchedule(legal, uneven);
  assert.ok(legal.assignments.every((round) => followsTypes(round, uneven.types, 'within')));
  assert.deepEqual(legal.assignments[0].map((group) => group.length).sort((a, b) => a - b), [3, 3, 4, 4]);
  assert.throws(() => validateConfig({ ...uneven, rounds: 1, groupCounts: [3] }), Error);
  assert.throws(() => validateConfig({ ...configFor(6, [null]), typeMode: 'within', types: labelsFromSizes([1, 5]) }), Error);
});

for (const [sizes, groupCounts, typeMode] of [
  [[3, 3], [3, 3, 3], 'mix'],
  [[3, 4], [3, 3], 'mix'],
  [[6, 1, 1], [3, 3], 'mix'],
  [[4, 4], [4, 4], 'mix'],
  [[2, 3, 3], [3], 'within'],
  [[3, 4], [3, 3, 3], 'within'],
  [[4, 4], [null, null, null], 'within'],
  [[4, 5], [4, 4], 'within'],
]) {
  for (const objective of ['fair', 'coverage']) {
    test(`类型 ${sizes.join('+')} / ${typeMode} / ${objective}：与独立全部可行组合最优解一致`, () => {
      const n = sizes.reduce((sum, value) => sum + value, 0);
      const config = { ...configFor(n, groupCounts, objective), typeMode, types: labelsFromSizes(sizes) };
      const result = solveSchedule(config, searchOptions);
      assertSchedule(result, config);
      assert.ok(result.assignments.every((round) => followsTypes(round, config.types, typeMode)));
      assert.deepEqual(score(result.metrics, objective), exhaustiveTypedBest(config));
    });
  }
}

test('均匀分散对每种类型逐组检查，不只检查类型总数或人数平衡', () => {
  for (const seed of [0, 1, 17, 20261005]) {
    const config = {
      ...configFor(31, [3, 6, 10, 15, null], seed % 2 ? 'fair' : 'coverage', seed),
      typeMode: 'mix', types: labelsFromSizes([1, 2, 4, 7, 17]),
    };
    const result = solveSchedule(config, searchOptions);
    assertSchedule(result, config);
    assert.ok(result.assignments.every((round) => followsTypes(round, config.types, 'mix')));
  }
});

test('分组验证拒绝不分散或跨类型合作，关闭策略时仍保持旧语义', () => {
  const pairs = [[[1, 2], [3, 4], [5, 6]]];
  const mix = { ...configFor(6, [3]), typeMode: 'mix', types: labelsFromSizes([3, 3]) };
  assert.throws(() => validateSchedule(pairs, 6, mix), Error);
  assert.equal(validateSchedule(pairs, 6, { ...mix, typeMode: 'off' }), true);
  const within = { ...configFor(8, [4]), typeMode: 'within', types: labelsFromSizes([4, 4]) };
  assert.throws(() => validateSchedule([[[1, 5], [2, 6], [3, 7], [4, 8]]], 8, within), Error);
  assert.equal(validateSchedule([[[1, 2], [3, 4], [5, 6], [7, 8]]], 8, within), true);
});

test('类型内全部覆盖按各类型容量认证，不能要求不同类型人数的个人覆盖相等', () => {
  const four = [[[3, 6], [4, 5]], [[3, 5], [6, 4]], [[3, 4], [5, 6]]];
  const six = [
    [[7, 12], [8, 11], [9, 10]], [[7, 11], [12, 10], [8, 9]],
    [[7, 10], [11, 9], [12, 8]], [[7, 9], [10, 8], [11, 12]],
    [[7, 8], [9, 12], [10, 11]],
  ];
  const assignments = six.map((groups, index) => [[1, 2], ...four[index % 3], ...groups]);
  const config = { ...configFor(12, Array(5).fill(6)), typeMode: 'within', types: labelsFromSizes([2, 4, 6]) };
  assert.equal(validateSchedule(assignments, 12, config), true);
  const independent = inspect(assignments, 12);
  assert.equal(independent.uniquePairs, 22);
  assert.equal(independent.minimumTeammates, 1);
  assert.equal(independent.sumSquaredTeammates, 188);
  const metrics = analyzeSchedule(assignments, 12, config);
  assert.equal(metrics.eligiblePairs, 22);
  assert.equal(metrics.eligibleCoverage, 1);
  assert.equal(metrics.coverage, 22 / 66);
  assert.deepEqual(metrics.people.map((person) => person.eligibleTeammates), [1, 1, 3, 3, 3, 3, 5, 5, 5, 5, 5, 5]);
  const proof = evaluateProof(assignments, config);
  assert.equal(proof.optimal, true);
  assert.equal(proof.uniquePairsUpperBound, 22);
  assert.equal(proof.minTeammatesUpperBound, 1);
});

test('类型约束保留固定种子复现与输入不可变', () => {
  const config = { ...configFor(14, [4, 7, null], 'fair', 445), typeMode: 'within', types: labelsFromSizes([6, 8]) };
  Object.freeze(config.groupCounts);
  Object.freeze(config.types);
  Object.freeze(config);
  const first = solveSchedule(config, searchOptions);
  const second = solveSchedule(config, searchOptions);
  assert.deepEqual(first.assignments, second.assignments);
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.proof, second.proof);
});

function canonicalRound(n, k) {
  let person = 0;
  return Array.from({ length: k }, (_, group) => Array.from({
    length: Math.floor(n / k) + Number(group < n % k),
  }, () => ++person));
}

test('期望人数默认空值，非法范围与类型被拒绝', () => {
  const base = configFor(14, [null]);
  assert.equal(validateConfig(base).preferredSize, null);
  assert.equal(validateConfig({ ...base, preferredSize: null }).preferredSize, null);
  for (const preferredSize of [2, 4, 300]) assert.equal(validateConfig({ ...base, preferredSize }).preferredSize, preferredSize);
  for (const preferredSize of [0, 1, -1, 301, 2.5, NaN, Infinity, '4', true]) {
    assert.throws(() => validateConfig({ ...base, preferredSize }), Error);
  }
});

for (const [n, target, expectedK, sizes] of [
  [14, 4, 4, [4, 4, 3, 3]], [14, 3, 5, [3, 3, 3, 3, 2]],
  [40, 4, 10, Array(10).fill(4)], [14, 2, 7, Array(7).fill(2)],
  [14, 300, 3, [5, 5, 4]],
]) {
  test(`${n} 人期望每组 ${target} 人：自动选最近平均人数的 ${expectedK} 组`, () => {
    for (const objective of ['fair', 'coverage']) {
      const config = { ...configFor(n, [null], objective), preferredSize: target };
      assert.deepEqual(getAutomaticGroupCounts(config), [expectedK]);
      const result = solveSchedule(config, searchOptions);
      assertSchedule(result, config);
      assert.equal(result.assignments[0].length, expectedK);
      assert.deepEqual(result.assignments[0].map((group) => group.length).sort((a, b) => b - a), sizes);
      const pairCapacity = sizes.reduce((sum, size) => sum + size * (size - 1) / 2, 0);
      assert.equal(result.proof.uniquePairsUpperBound, pairCapacity);
      assert.equal(result.proof.minTeammatesUpperBound, Math.min(...sizes) - 1);
      assert.equal(result.proof.optimal, true);
    }
  });
}

test('期望人数平手全部保留：24 人期望 7 人，3 组和 4 组均合法', () => {
  const config = { ...configFor(24, [null]), preferredSize: 7 };
  assert.deepEqual(getAutomaticGroupCounts(config), [3, 4]);
  assert.equal(validateSchedule([canonicalRound(24, 3)], 24, config), true);
  assert.equal(validateSchedule([canonicalRound(24, 4)], 24, config), true);
  assert.throws(() => validateSchedule([canonicalRound(24, 5)], 24, config), Error);
  const options = getSizeOptions(config);
  assert.deepEqual(options.slice(0, 2).map((option) => [option.groupCount, option.distance]), [[3, 1], [4, 1]]);
  const result = solveSchedule(config, searchOptions);
  assert.equal(result.assignments[0].length, 3);
  assert.equal(result.proof.uniquePairsUpperBound, 84);
  assert.equal(result.proof.optimal, true);
});

test('推荐列出全部类型合法组数，并独立于已经手动指定的组数', () => {
  const automatic = { ...configFor(14, [null]), preferredSize: 4 };
  const manual = { ...automatic, groupCounts: [7] };
  const options = getSizeOptions(automatic);
  assert.deepEqual(getSizeOptions(manual), options);
  assert.deepEqual(options.map((option) => option.groupCount).sort((a, b) => a - b), [3, 4, 5, 6, 7]);
  assert.equal(options[0].groupCount, 4);
  for (const option of options) {
    assert.equal(option.averageSize, 14 / option.groupCount);
    assert.ok(Math.abs(option.distance - Math.abs(14 / option.groupCount - 4)) < 1e-12);
    assert.deepEqual(option.sizes, canonicalRound(14, option.groupCount).map((group) => group.length));
  }
  const noPreference = configFor(14, [null]);
  assert.deepEqual(getAutomaticGroupCounts(noPreference), [3, 4, 5, 6, 7]);
  assert.equal(getSizeOptions(noPreference)[0].groupCount, 4);
  assert.equal(solveSchedule(noPreference, searchOptions).assignments[0].length, 3);
});

test('手动组数覆盖本轮期望；多轮自动与手动可以混合', () => {
  const config = { ...configFor(14, [null, 7, null, 3]), preferredSize: 4 };
  const result = solveSchedule(config, searchOptions);
  assertSchedule(result, config);
  assert.deepEqual(result.assignments.map((round) => round.length), [4, 7, 4, 3]);
  assert.equal(result.proof.uniquePairsUpperBound, 18 + 7 + 18 + 26);
  const manual = { ...configFor(14, [3]), preferredSize: 4 };
  assert.equal(validateSchedule([canonicalRound(14, 3)], 14, manual), true);
  const one = solveSchedule(manual, searchOptions);
  assert.equal(one.metrics.uniquePairs, 26);
  assert.equal(one.proof.uniquePairsUpperBound, 26);
  assert.equal(one.proof.optimal, true);
});

test('恢复分组时验证自动轮的期望限制，而手动轮保留覆盖权', () => {
  const config = { ...configFor(14, [null, 5]), preferredSize: 4 };
  assert.equal(validateSchedule([canonicalRound(14, 4), canonicalRound(14, 5)], 14, config), true);
  assert.throws(() => validateSchedule([canonicalRound(14, 5), canonicalRound(14, 5)], 14, config), Error);
  assert.throws(() => evaluateProof([canonicalRound(14, 3)], { ...config, rounds: 1, groupCounts: [null] }), Error);
});

test('类型内期望只能在可行组数中选：6+8 人期望 5 人回退到 4 组', () => {
  const config = {
    ...configFor(14, [null, 7, null]), preferredSize: 5,
    typeMode: 'within', types: labelsFromSizes([6, 8]),
  };
  const result = solveSchedule(config, searchOptions);
  assertSchedule(result, config);
  assert.deepEqual(result.assignments.map((round) => round.length), [4, 7, 4]);
  assert.deepEqual(getAutomaticGroupCounts(config), [4]);
  assert.ok(result.assignments.every((round) => followsTypes(round, config.types, 'within')));
  const options = getSizeOptions(config);
  assert.deepEqual(options.map((option) => option.groupCount).sort((a, b) => a - b), [4, 5, 6, 7]);
  assert.equal(options[0].groupCount, 4);
  assert.equal(options[0].averageSize, 3.5);
  assert.equal(options[0].distance, 1.5);
  assert.deepEqual(getSizeOptions({ ...config, groupCounts: [3, 3, 3] }), options);
});

test('期望、类型分散与固定工作量同时使用仍可复现且不修改输入', () => {
  const config = {
    ...configFor(20, [null, 10, null], 'fair', 123), preferredSize: 4,
    typeMode: 'mix', types: labelsFromSizes([6, 7, 7]),
  };
  Object.freeze(config.groupCounts);
  Object.freeze(config.types);
  Object.freeze(config);
  const first = solveSchedule(config, searchOptions);
  const second = solveSchedule(config, searchOptions);
  assertSchedule(first, config);
  assert.deepEqual(first.assignments.map((round) => round.length), [5, 10, 5]);
  assert.ok(first.assignments.every((round) => followsTypes(round, config.types, 'mix')));
  assert.deepEqual(first.assignments, second.assignments);
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.proof, second.proof);
});
