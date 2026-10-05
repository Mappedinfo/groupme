import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, balancedSizes, validateConfig, validateSchedule, solveSchedule,
  analyzeSchedule, compareMetrics, getPersonSummary, defaultNames, parseNames, evaluateProof,
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
