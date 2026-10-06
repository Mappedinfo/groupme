import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfig, validateSchedule, normalizeFixedGroups, feasibleGroupCounts,
  getAutomaticGroupCounts, getSizeOptions, solveSchedule, analyzeSchedule,
  getPersonSummary, compareMetrics, evaluateProof,
} from '../src/grouping.js';

const ids = (n) => Array.from({ length: n }, (_, index) => index + 1);
const configFor = (people, groupCounts, fixedGroups, extra = {}) => ({
  people, rounds: groupCounts.length, groupCounts, fixedGroups,
  objective: 'fair', seed: 17603, ...extra,
});
const searchOptions = { timeBudgetMs: 10_000, maxIterations: 6000 };
const key = (group) => [...group].sort((a, b) => a - b).join(':');

// Independent rule check: fixed groups are exact sets, while type constraints
// apply only to the remaining groups. No production feasibility helper is used.
function followsRules(round, config) {
  const n = config.people;
  if (round.length < 3 || round.some((group) => group.length < 2)) return false;
  const sizes = round.map((group) => group.length);
  if (Math.max(...sizes) - Math.min(...sizes) > 1) return false;
  if (key(round.flat()) !== key(ids(n))) return false;
  const fixed = new Set(config.fixedGroups.map(key));
  if ([...fixed].some((wanted) => !round.some((group) => key(group) === wanted))) return false;
  const remaining = round.filter((group) => !fixed.has(key(group)));
  const mode = config.typeMode ?? 'off';
  const types = config.types ?? Array(n).fill('未分类');
  if (mode === 'within') return remaining.every((group) => new Set(group.map((person) => types[person - 1])).size === 1);
  if (mode === 'mix' && remaining.length) {
    const labels = new Set(remaining.flat().map((person) => types[person - 1]));
    return [...labels].every((label) => {
      const counts = remaining.map((group) => group.filter((person) => types[person - 1] === label).length);
      return Math.max(...counts) - Math.min(...counts) <= 1;
    });
  }
  return true;
}

function independentMetrics(assignments, config) {
  const fixedIds = new Set(config.fixedGroups.flat());
  const rotatingIds = ids(config.people).filter((person) => !fixedIds.has(person));
  const neighbors = Array.from({ length: config.people }, () => new Set());
  const encounters = new Map();
  for (const round of assignments) for (const group of round) {
    for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
      const [a, b] = [group[i], group[j]].sort((x, y) => x - y);
      const pair = `${a}:${b}`;
      encounters.set(pair, (encounters.get(pair) ?? 0) + 1);
      neighbors[a - 1].add(b);
      neighbors[b - 1].add(a);
    }
  }
  const degrees = rotatingIds.map((person) => neighbors[person - 1].size);
  const fixedUniquePairs = config.fixedGroups.reduce((sum, group) => sum + group.length * (group.length - 1) / 2, 0);
  const fixedRepeatMeetings = fixedUniquePairs * (assignments.length - 1);
  return {
    uniquePairs: encounters.size, fixedUniquePairs, fixedRepeatMeetings,
    rotatingPeople: rotatingIds.length, rotatingIds,
    rotatingUniquePairs: encounters.size - fixedUniquePairs,
    rotatingMinimumTeammates: degrees.length ? Math.min(...degrees) : 0,
    rotatingMaximumTeammates: degrees.length ? Math.max(...degrees) : 0,
    rotatingSumSquaredTeammates: degrees.reduce((sum, value) => sum + value ** 2, 0),
    rotatingAverageTeammates: degrees.length ? degrees.reduce((sum, value) => sum + value, 0) / degrees.length : 0,
    repeatMeetings: [...encounters.values()].reduce((sum, count) => sum + count - 1, 0),
    neighbors,
  };
}

function assertResult(result, config) {
  assert.equal(result.assignments.length, config.rounds);
  for (const [index, round] of result.assignments.entries()) {
    assert.ok(followsRules(round, config), `作业 ${index + 1} 必须保持全部固定组和其余约束。`);
    if (config.groupCounts[index] !== null) assert.equal(round.length, config.groupCounts[index]);
  }
  assert.equal(validateSchedule(result.assignments, config.people, result.config), true);
  const expected = independentMetrics(result.assignments, config);
  for (const field of [
    'uniquePairs', 'fixedUniquePairs', 'fixedRepeatMeetings', 'rotatingPeople',
    'rotatingUniquePairs', 'rotatingMinimumTeammates', 'rotatingMaximumTeammates',
    'rotatingSumSquaredTeammates', 'rotatingAverageTeammates', 'repeatMeetings',
  ]) assert.equal(result.metrics[field], expected[field], field);
  assert.equal(result.metrics.rotatingRepeatMeetings, expected.repeatMeetings - expected.fixedRepeatMeetings);
  assert.ok(result.proof.uniquePairsUpperBound >= expected.uniquePairs);
  assert.ok(result.proof.minTeammatesUpperBound >= expected.rotatingMinimumTeammates);
  return expected;
}

function* choose(items, count, start = 0, chosen = []) {
  if (count === 0) { yield chosen; return; }
  for (let index = start; index <= items.length - count; index += 1) {
    yield* choose(items, count - 1, index + 1, [...chosen, items[index]]);
  }
}

const partitionCache = new Map();
function partitions(n, k) {
  const cacheKey = `${n}:${k}`;
  if (partitionCache.has(cacheKey)) return partitionCache.get(cacheKey);
  const sizes = Array.from({ length: k }, (_, index) => Math.floor(n / k) + Number(index < n % k));
  const result = [];
  function visit(remaining, pending, groups) {
    if (!remaining.length) { result.push(groups); return; }
    for (const size of new Set(pending)) for (const others of choose(remaining.slice(1), size - 1)) {
      const group = [remaining[0], ...others];
      const used = new Set(group);
      const next = pending.slice();
      next.splice(next.indexOf(size), 1);
      visit(remaining.filter((person) => !used.has(person)), next, [...groups, group]);
    }
  }
  visit(ids(n), sizes, []);
  partitionCache.set(cacheKey, result);
  return result;
}

function vector(metrics, objective) {
  return objective === 'fair'
    ? [metrics.rotatingMinimumTeammates, metrics.uniquePairs, -metrics.rotatingSumSquaredTeammates]
    : [metrics.uniquePairs, metrics.rotatingMinimumTeammates, -metrics.rotatingSumSquaredTeammates];
}

function compare(a, b) {
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function exhaustiveBest(config) {
  assert.ok(config.people <= 9);
  const options = config.groupCounts.map((specified) => {
    const counts = specified === null ? Array.from({ length: Math.floor(config.people / 2) - 2 }, (_, index) => index + 3) : [specified];
    return counts.flatMap((k) => partitions(config.people, k)).filter((round) => followsRules(round, config));
  });
  let best = null;
  function visit(index, schedule) {
    if (index === options.length) {
      const next = vector(independentMetrics(schedule, config), config.objective);
      if (!best || compare(next, best) > 0) best = next;
      return;
    }
    for (const round of options[index]) visit(index + 1, [...schedule, round]);
  }
  visit(0, []);
  return best;
}

test('固定组规范化不改变输入，组内与跨组重复以及非法编号被拒绝', () => {
  const original = Object.freeze([Object.freeze([8, 4]), Object.freeze([2, 1])]);
  assert.deepEqual(normalizeFixedGroups(original, 10), [[1, 2], [4, 8]]);
  assert.deepEqual(original, [[8, 4], [2, 1]]);
  assert.deepEqual(validateConfig(configFor(10, [5], original)).fixedGroups, [[1, 2], [4, 8]]);
  assert.deepEqual(validateConfig({ people: 8, rounds: 1 }).fixedGroups, []);
  for (const fixedGroups of [
    [1, 2], [[]], [[1]], [[1, 1]], [[1, 2], [2, 3]], [[1, 2], [2, 1]],
    [[0, 2]], [[1, 11]], [[1, 2.5]], [[1, '2']], [null], [[1, undefined]],
  ]) assert.throws(() => normalizeFixedGroups(fixedGroups, 10), Error);
});

test('固定组不放宽总组数与全轮人数均衡，剩余单人明确不可行', () => {
  for (const config of [
    configFor(9, [null], [[1, 2], [3, 4], [5, 6], [7, 8]]),
    configFor(6, [null], [[1, 2, 3], [4, 5, 6]]),
    configFor(8, [null], [[1, 2], [3, 4, 5, 6]]),
    configFor(8, [null], [[1, 2, 3, 4]]),
  ]) assert.throws(() => validateConfig(config), Error);
});

test('完整固定约束下可行 K 与所有小规模均衡分区独立枚举一致', () => {
  const cases = [
    configFor(6, [null], [[1, 2]]), configFor(7, [null], [[1, 2]]),
    configFor(7, [null], [[1, 2, 3]]), configFor(8, [null], [[1, 2]]),
    configFor(8, [null], [[1, 2, 3]]), configFor(8, [null], [[1, 2], [3, 4]]),
    configFor(8, [null], [[1, 2, 3], [4, 5, 6]]),
    configFor(8, [null], [[1, 2], [3, 4, 5], [6, 7, 8]]),
    configFor(9, [null], [[1, 2, 3]]), configFor(9, [null], [[1, 2], [3, 4]]),
    configFor(8, [null], [[1, 2]], { typeMode: 'within', types: ['A', 'B', 'C', 'C', 'C', 'D', 'D', 'D'] }),
  ];
  for (const config of cases) {
    const expected = [];
    for (let k = 3; k <= Math.floor(config.people / 2); k += 1) {
      const possible = partitions(config.people, k).some((round) => followsRules(round, config));
      if (possible) {
        expected.push(k);
        assert.doesNotThrow(() => validateConfig({ ...config, groupCounts: [k] }));
      } else assert.throws(() => validateConfig({ ...config, groupCounts: [k] }), Error);
    }
    assert.deepEqual(feasibleGroupCounts(config), expected);
    assert.deepEqual(getAutomaticGroupCounts(config), expected);
    assert.deepEqual(getSizeOptions(config).map((option) => option.groupCount).sort((a, b) => a - b), expected);
  }
});

for (const base of [
  configFor(8, [4, 4, 4], [[1, 2]]),
  configFor(8, [null, null], [[1, 2]]),
  configFor(9, [3, 4], [[1, 2, 3]]),
  configFor(8, [4, 4, 4], [[1, 2], [3, 4]]),
  configFor(8, [3, 3], [[1, 2]], { typeMode: 'mix', types: ['A', 'A', 'B', 'B', 'B', 'C', 'C', 'C'] }),
  configFor(8, [3, 3], [[1, 2]], { typeMode: 'within', types: ['A', 'B', 'C', 'C', 'C', 'D', 'D', 'D'] }),
]) {
  for (const objective of ['fair', 'coverage']) {
    test(`${base.people} 人固定 ${base.fixedGroups.map(key).join('/')} / ${base.typeMode ?? 'off'} / ${base.groupCounts.join(',')} / ${objective}：对照全部可行分组组合`, () => {
      const config = { ...base, objective };
      const result = solveSchedule(config, searchOptions);
      assertResult(result, config);
      assert.deepEqual(vector(result.metrics, objective), exhaustiveBest(config));
    });
  }
}

test('固定成员恒定覆盖不压制公平目标，固定搭档上界只计一次', () => {
  const config = configFor(8, [4, 4, 4], [[1, 2]]);
  const result = solveSchedule(config, searchOptions);
  assertResult(result, config);
  assert.equal(result.metrics.minimumTeammates, 1);
  assert.equal(result.metrics.rotatingMinimumTeammates, 3);
  assert.equal(result.metrics.rotatingUniquePairs, 9);
  assert.equal(result.metrics.uniquePairs, 10);
  assert.equal(result.metrics.fixedRepeatMeetings, 2);
  assert.equal(result.proof.uniquePairsUpperBound, 10);
  assert.equal(result.proof.minTeammatesUpperBound, 3);
  assert.equal(result.proof.optimal, true);
  const fairer = { minimumTeammates: 1, uniquePairs: 10, rotatingUniquePairs: 9, rotatingMinimumTeammates: 3, rotatingSumSquaredTeammates: 54 };
  const wider = { minimumTeammates: 1, uniquePairs: 11, rotatingUniquePairs: 10, rotatingMinimumTeammates: 2, rotatingSumSquaredTeammates: 70 };
  assert.ok(compareMetrics(fairer, wider, 'fair') > 0);
  assert.ok(compareMetrics(fairer, wider, 'coverage') < 0);
});

test('两种目标确有不同最优解，两个轮换组的宽松上界不能直接当作证明', () => {
  for (const objective of ['fair', 'coverage']) {
    const config = configFor(9, [3, 3, 3], [[1, 2, 3]], { objective });
    const result = solveSchedule(config, searchOptions);
    assertResult(result, config);
    assert.deepEqual(vector(result.metrics, objective), exhaustiveBest(config));
    assert.equal(result.metrics.rotatingMinimumTeammates, objective === 'fair' ? 4 : 3);
    assert.equal(result.metrics.uniquePairs, objective === 'fair' ? 15 : 16);
    assert.equal(result.proof.uniquePairsUpperBound, 18);
    assert.equal(result.proof.optimal, false);
  }
});

test('固定组优先于类型，同类限制只检查剩余人员并排除已固定的单人类型', () => {
  const config = configFor(8, [3, 3], [[1, 2]], {
    typeMode: 'within', types: ['A', 'B', 'C', 'C', 'C', 'D', 'D', 'D'],
  });
  const result = solveSchedule(config, searchOptions);
  assertResult(result, config);
  assert.equal(result.metrics.eligiblePairs, 7);
  assert.equal(result.metrics.rotatingEligiblePairs, 6);
  assert.equal(result.metrics.rotatingCoverage, 1);
  assert.equal(result.proof.optimal, true);
  assert.deepEqual(result.metrics.people[0].eligibleTeammateIds, [2]);
  assert.deepEqual(result.metrics.people[1].eligibleTeammateIds, [1]);
  assert.deepEqual(result.metrics.people[2].eligibleTeammateIds, [4, 5]);
  assert.deepEqual(result.metrics.people.map((person) => person.fixedGroupIndex), [0, 0, null, null, null, null, null, null]);
  assert.equal(getPersonSummary(result.assignments, 8, 1, config).fixedGroupIndex, 0);
  assert.throws(() => validateConfig({ ...config, types: ['X', 'Y', 'X', 'Y', 'Y', 'Y', 'Y', 'Y'] }), Error);
});

test('混合只均衡轮换组，固定组类型构成可以不均衡', () => {
  const config = configFor(8, [3], [[1, 2]], { typeMode: 'mix', types: ['A', 'A', 'B', 'B', 'B', 'C', 'C', 'C'] });
  const legal = [[[1, 2], [3, 4, 6], [5, 7, 8]]];
  assert.equal(validateSchedule(legal, 8, config), true);
  assert.throws(() => validateSchedule([[[1, 2], [3, 4, 5], [6, 7, 8]]], 8, config), Error);
});

test('所有人固定时无需轮换，恒定指标与重复次数仍准确', () => {
  const config = configFor(8, [null, 3, null], [[1, 2], [3, 4, 5], [6, 7, 8]], {
    typeMode: 'within', types: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  });
  const result = solveSchedule(config, searchOptions);
  assertResult(result, config);
  for (const field of [
    'rotatingPeople', 'rotatingUniquePairs', 'rotatingEligiblePairs', 'rotatingMinimumTeammates',
    'rotatingMaximumTeammates', 'rotatingAverageTeammates', 'rotatingSumSquaredTeammates',
  ]) assert.equal(result.metrics[field], 0, field);
  assert.equal(result.metrics.rotatingCoverage, 1);
  assert.equal(result.metrics.fixedPeople, 8);
  assert.equal(result.metrics.fixedGroupCount, 3);
  assert.equal(result.metrics.uniquePairs, 7);
  assert.equal(result.metrics.fixedRepeatMeetings, 14);
  assert.equal(result.proof.uniquePairsUpperBound, 7);
  assert.equal(result.proof.minTeammatesUpperBound, 0);
  assert.equal(result.proof.optimal, true);
});

test('只剩一个轮换组也合法，只要全轮仍有至少三个均衡小组', () => {
  const config = configFor(8, [3, 3, 3], [[1, 2, 3], [4, 5, 6]], {
    typeMode: 'mix', types: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  });
  const result = solveSchedule(config, searchOptions);
  assertResult(result, config);
  assert.equal(result.metrics.rotatingPeople, 2);
  assert.equal(result.metrics.rotatingUniquePairs, 1);
  assert.equal(result.metrics.rotatingMinimumTeammates, 1);
  assert.equal(result.metrics.rotatingRepeatMeetings, 2);
  assert.deepEqual(result.metrics.people[6].eligibleTeammateIds, [8]);
  assert.equal(result.proof.optimal, true);
});

test('固定组不能拆开、加人或换人，验证不依赖成员及组的显示顺序', () => {
  const config = configFor(6, [3], [[1, 2]]);
  assert.equal(validateSchedule([[[3, 4], [2, 1], [5, 6]]], 6, config), true);
  assert.throws(() => validateSchedule([[[1, 3], [2, 4], [5, 6]]], 6, config), Error);
  const eight = configFor(8, [3], [[1, 2]]);
  assert.throws(() => validateSchedule([[[1, 2, 3], [4, 5, 6], [7, 8]]], 8, eight), Error);
  assert.throws(() => evaluateProof([[[1, 3], [2, 4], [5, 6]]], config), Error);
});

test('期望人数在完整固定约束的合法 K 中选择，手动组数仍不能违反固定组', () => {
  const config = configFor(14, [null, 7], [[1, 2]], { preferredSize: 4 });
  assert.deepEqual(feasibleGroupCounts(config), [5, 6, 7]);
  assert.deepEqual(getAutomaticGroupCounts(config), [5]);
  assert.deepEqual(getSizeOptions(config).map((option) => option.groupCount).sort((a, b) => a - b), [5, 6, 7]);
  const result = solveSchedule(config, searchOptions);
  assertResult(result, config);
  assert.deepEqual(result.assignments.map((round) => round.length), [5, 7]);
  assert.throws(() => validateConfig({ ...config, groupCounts: [4, 7] }), Error);
});

test('固定组输入冻结、规范顺序与固定种子不改变结果', () => {
  const fixedGroups = Object.freeze([Object.freeze([4, 3]), Object.freeze([2, 1])]);
  const config = Object.freeze(configFor(12, Object.freeze([5, 6, null]), fixedGroups));
  const first = solveSchedule(config, searchOptions);
  const second = solveSchedule({ ...config, fixedGroups: [[1, 2], [3, 4]] }, searchOptions);
  assertResult(first, config);
  assert.deepEqual(first.assignments, second.assignments);
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(config.fixedGroups, [[4, 3], [2, 1]]);
});

test('300 人 30 轮包含大量固定组时仍有界并保持轮换合法', () => {
  const fixedGroups = Array.from({ length: 100 }, (_, index) => [index * 2 + 1, index * 2 + 2]);
  const config = configFor(300, Array(30).fill(150), fixedGroups);
  const started = performance.now();
  const result = solveSchedule(config, { timeBudgetMs: 500, maxIterations: 5 });
  assertResult(result, config);
  assert.equal(result.metrics.fixedPeople, 200);
  assert.equal(result.metrics.rotatingPeople, 100);
  assert.ok(performance.now() - started < 10_000);
});

test('Worker 往返完整固定组配置并返回可验证结果，重叠固定组报错', async () => {
  const previous = globalThis.self;
  const messages = [];
  let handler;
  globalThis.self = {
    addEventListener(type, listener) { assert.equal(type, 'message'); handler = listener; },
    postMessage(message) { messages.push(message); },
  };
  try {
    await import('../src/solver-worker.js');
    const config = configFor(8, [4, 4, 4], [[2, 1]]);
    handler({ data: { type: 'solve', requestId: 'fixed-groups', config, timeBudgetMs: 100 } });
    const response = messages.find((message) => message.type === 'result');
    assert.ok(response);
    assert.equal(response.requestId, 'fixed-groups');
    assert.deepEqual(response.result.config.fixedGroups, [[1, 2]]);
    assertResult(response.result, config);
    messages.length = 0;
    handler({ data: { type: 'solve', requestId: 'invalid-fixed', config: { ...config, fixedGroups: [[1, 2], [2, 3]] } } });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'error');
    assert.equal(messages[0].requestId, 'invalid-fixed');
    assert.ok(messages[0].message.length > 0);
  } finally {
    if (previous === undefined) delete globalThis.self;
    else globalThis.self = previous;
  }
});
