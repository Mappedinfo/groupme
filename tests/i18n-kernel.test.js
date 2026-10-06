import test from 'node:test';
import assert from 'node:assert/strict';
import {
  balancedSizes, validateConfig, validateSchedule, normalizeFixedGroups,
  parseNames, defaultNames, getPersonSummary, compareMetrics, solveSchedule,
  evaluateProof,
} from '../src/grouping.js';
import { createQuickTypePlan, normalizeTypeLabels, quickTypeSizes } from '../src/type-editor.js';

const base = { people: 6, rounds: 1, groupCounts: [3], objective: 'fair', seed: 1 };
const pairs = [[1, 2], [3, 4], [5, 6]];

function bilingualError(action, chinese, english, preservedText = '') {
  let captured;
  assert.throws(action, (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, chinese);
    assert.equal(typeof error.messageEn, 'string');
    assert.match(error.messageEn, english);
    assert.doesNotMatch(error.messageEn, /undefined|NaN/);
    if (preservedText) assert.ok(error.messageEn.includes(preservedText));
    else assert.doesNotMatch(error.messageEn, /\p{Script=Han}/u);
    captured = error;
    return true;
  });
  return captured;
}

test('内核整数与搜索校验保留中文消息，并提供准确的英文范围和字段名', () => {
  for (const [action, zh, en] of [
    [() => balancedSizes(5, 3), /总人数.*6.*300/, /Total number of people.*6.*300/],
    [() => balancedSizes(14, 2), /组数.*3.*7/, /Number of groups.*3.*7/],
    [() => validateConfig({ ...base, rounds: 31 }), /作业次数.*1.*30/, /Number of assignments.*1.*30/],
    [() => validateConfig({ ...base, groupCounts: [2] }), /每次作业的组数/, /Group count for each assignment/],
    [() => validateConfig({ ...base, seed: -1 }), /随机种子/, /Random seed.*0.*4294967295/],
    [() => validateConfig({ ...base, preferredSize: 1 }), /每组期望人数/, /Preferred group size.*2.*300/],
    [() => normalizeFixedGroups([[1, 7]], 6), /固定小组成员编号/, /Fixed-group member ID.*1.*6/],
    [() => getPersonSummary([pairs], 6, 7), /成员编号/, /Member ID.*1.*6/],
    [() => solveSchedule(base, { maxIterations: -1 }), /最大迭代次数/, /Maximum iteration count.*0.*10000000/],
    [() => solveSchedule(base, { timeBudgetMs: 0 }), /搜索预算/, /search time budget.*1.*30000/],
    [() => solveSchedule(base, { onProgress: 1 }), /进度回调/, /progress callback.*function/],
  ]) bilingualError(action, zh, en);
});

test('配置、姓名及固定组错误提供英文，业务数据与默认编号不被翻译', () => {
  for (const [action, zh, en] of [
    [() => validateConfig(null), /分组设置/, /grouping settings/],
    [() => validateConfig({ ...base, groupCounts: [] }), /每次作业/, /each assignment/],
    [() => validateConfig({ ...base, objective: 'x' }), /公平优先/, /fairness first/],
    [() => validateConfig({ ...base, typeMode: 'x' }), /均匀混合/, /evenly mixed types/],
    [() => validateConfig({ ...base, types: [] }), /恰好 6/, /exactly 6/],
    [() => validateConfig({ ...base, types: [null, 'A', 'A', 'A', 'A', 'A'] }), /第 1 位/, /person 1.*text/],
    [() => validateConfig({ ...base, types: ['x'.repeat(21), 'A', 'A', 'A', 'A', 'A'] }), /20 个字符/, /20 characters/],
    [() => normalizeFixedGroups('1,2', 6), /数组/, /array of member ID lists/],
    [() => normalizeFixedGroups([[1]], 6), /至少需要 2/, /at least 2 members/],
    [() => normalizeFixedGroups([[1, 2], [2, 3]], 6), /2 号.*重复/, /Person 2.*within or across/],
    [() => parseNames(1, 6), /每行一人/, /one person per line/],
    [() => parseNames('A\nB', 6), /恰好 6.*2 位/, /exactly 6.*2 were provided/],
    [() => parseNames(['x'.repeat(21), 'A', 'B', 'C', 'D', 'E'].join('\n'), 6), /第 1 位.*20/, /person 1.*20/],
    [() => compareMetrics({}, {}, 'x'), /比较目标/, /comparison objective/],
  ]) bilingualError(action, zh, en);
  assert.deepEqual(defaultNames(6), ['1号', '2号', '3号', '4号', '5号', '6号']);
  assert.deepEqual(normalizeTypeLabels(['基础', '', 'Advanced']), ['基础', '未分类', 'Advanced']);
  assert.deepEqual(validateConfig({ ...base, types: ['基础', '基础', '进阶', '进阶', 'A', 'A'] }).types, ['基础', '基础', '进阶', '进阶', 'A', 'A']);
});

test('类型与可行性错误的英文保留原始用户标签和准确的替代组数', () => {
  const label = '入门 <L1>';
  bilingualError(
    () => validateConfig({ ...base, typeMode: 'within', types: [label, 'B', 'B', 'B', 'B', 'B'] }),
    /只有 1 人/, /Type.*only 1 person/, label,
  );
  bilingualError(
    () => validateSchedule([pairs], 6, { ...base, typeMode: 'mix', types: [label, label, label, 'B', 'B', 'B'] }),
    /未均匀分散/, /not evenly distributed.*assignment 1/, label,
  );
  bilingualError(
    () => validateConfig({ people: 8, rounds: 1, groupCounts: [3], typeMode: 'within', types: ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'] }),
    /可行组数为 4/, /Feasible group counts: 4/,
  );
  bilingualError(
    () => validateConfig({ people: 9, rounds: 1, fixedGroups: [[1, 2], [3, 4], [5, 6], [7, 8]] }),
    /只剩 1 位轮换成员/, /Only 1 rotating member.*at least 2/,
  );
  bilingualError(
    () => validateConfig({ ...base, fixedGroups: [[1, 2, 3], [4, 5, 6]] }),
    /至少 3 组/, /at least 3 groups.*at least 2 people.*at most 1/,
  );
});

test('英文类型错误翻译系统未分类标签，中文消息与存储值保持原样', () => {
  const types = ['', 'B', 'B', 'B', 'B', 'B'];
  bilingualError(
    () => validateConfig({ ...base, typeMode: 'within', types }),
    /类型「未分类」只有 1 人/, /Type “Unassigned” has only 1 person/,
  );
  assert.equal(validateConfig({ ...base, types }).types[0], '未分类');
  bilingualError(
    () => validateSchedule([pairs], 6, { ...base, typeMode: 'mix', types: ['', '', '', 'B', 'B', 'B'] }),
    /类型「未分类」未均匀分散/, /Type “Unassigned” is not evenly distributed/,
  );
});

test('恢复分组时的错误能准确指出英文作业号、固定成员及规模规则', () => {
  for (const [action, zh, en] of [
    [() => validateSchedule([], 6), /作业次数/, /assignments.*1.*30/],
    [() => validateSchedule([pairs], 6, { ...base, rounds: 2, groupCounts: [3, 3] }), /不一致/, /does not match.*people or assignments/],
    [() => validateSchedule([null], 6), /作业 1/, /Assignment 1/],
    [() => validateSchedule([[null, [3, 4], [5, 6]]], 6), /成员列表/, /list of members/],
    [() => validateSchedule([[[1, 2, 3], [4, 5], [6]]], 6), /均匀分组/, /Assignment 1.*at least 2.*at most 1/],
    [() => validateSchedule([[[1, 2], [3, 4], [5, 5]]], 6), /5 号.*重复/, /Person 5.*assignment 1/],
    [() => validateSchedule([[[1, 3], [2, 4], [5, 6]]], 6, { ...base, fixedGroups: [[1, 2]] }), /固定小组/, /members 1, 2.*assignment 1.*cannot be added/],
    [() => validateSchedule([[[1, 3], [2, 4], [5, 6]]], 6, { ...base, typeMode: 'within', types: ['A', 'A', 'B', 'B', 'C', 'C'] }), /同类组队/, /same type/],
    [() => validateSchedule([[[1, 2, 3], [4, 5, 6], [7, 8]]], 8, { people: 8, rounds: 1, groupCounts: [null], preferredSize: 2 }), /期望人数 2/, /preferred group size of 2.*options: 4/],
  ]) bilingualError(action, zh, en);
});

test('快捷分类的英文包含字段号、人数余数和标签限制，中文兼容', () => {
  for (const [action, zh, en] of [
    [() => quickTypeSizes(5, 2), /总人数/, /6.*300/],
    [() => quickTypeSizes(6, 4), /2 类或 3 类/, /2 or 3 categories/],
    [() => normalizeTypeLabels(null), /标签列表/, /list of type labels/],
    [() => normalizeTypeLabels([12]), /第 1 个/, /Type label 1.*text/],
    [() => normalizeTypeLabels(['A\nB']), /换行/, /line breaks/],
    [() => normalizeTypeLabels(['x'.repeat(21)]), /20 个字符/, /20 characters/],
    [() => createQuickTypePlan(6, null, [3]), /名称/, /names for 2 or 3/],
    [() => createQuickTypePlan(6, ['', 'B'], [3]), /第 1 类/, /category 1/],
    [() => createQuickTypePlan(6, ['A', 'A'], [3]), /不能重复/, /must be unique/],
    [() => createQuickTypePlan(6, ['A', 'B', 'C'], [3]), /前 2 类/, /first 2 categories.*automatically/],
    [() => createQuickTypePlan(6, ['A', 'B'], [0]), /至少 1/, /category 1.*at least 1/],
    [() => createQuickTypePlan(6, ['A', 'B', 'C'], [3, 3]), /总人数 6/, /less than 6.*at least 1 person/],
  ]) bilingualError(action, zh, en);
});

test('最优性说明的每个分支均有对应英文，保留未证明与重复次数边界', () => {
  const robin = [
    [[1, 6], [2, 5], [3, 4]], [[1, 5], [6, 4], [2, 3]],
    [[1, 4], [5, 3], [6, 2]], [[1, 3], [4, 2], [5, 6]],
    [[1, 2], [3, 6], [4, 5]],
  ];
  const fixedRound = [[1, 2], [3, 4, 5], [6, 7, 8]];
  const cases = [
    [[pairs, pairs], { ...base, rounds: 2, groupCounts: [3, 3] }, false, /未取得全局最优证明/, /global optimality has not been proved/],
    [[fixedRound], { people: 8, rounds: 1, groupCounts: [3], fixedGroups: fixedRound }, true, /没有需要轮换/, /no rotating members/],
    [robin.map((round) => [[1, 2], ...round.map((group) => group.map((id) => id + 2))]), { people: 8, rounds: 5, groupCounts: Array(5).fill(4), fixedGroups: [[1, 2]] }, true, /固定边界与类型规则/, /fixed-group boundaries and type rules/],
    [[fixedRound], { people: 8, rounds: 1, groupCounts: [3], typeMode: 'within', types: ['A', 'A', 'B', 'B', 'B', 'C', 'C', 'C'] }, true, /同类型/, /every other person of the same type/],
    [robin, { ...base, rounds: 5, groupCounts: Array(5).fill(3) }, true, /其余全部同学/, /Everyone has worked with every other person/],
    [[pairs], base, true, /有效上界/, /Minimum individual coverage.*valid upper bounds/],
    [[[[1, 2], [3, 4], [5, 6], [7, 8]]], { people: 8, rounds: 1, groupCounts: [4], fixedGroups: [[1, 2]] }, true, /轮换成员的/, /minimum coverage of rotating members.*valid upper bounds/],
  ];
  for (const [assignments, config, optimal, zh, en] of cases) {
    const proof = evaluateProof(assignments, config);
    assert.equal(proof.optimal, optimal);
    assert.match(proof.reason, zh);
    assert.match(proof.reasonEn, en);
    assert.doesNotMatch(proof.reasonEn, /\p{Script=Han}|undefined/u);
    assert.ok(proof.labelEn.length > 0);
    if (optimal && !config.fixedGroups?.length && assignments.length) assert.match(proof.reasonEn, /does not prove that repeat meetings are minimized/);
  }
});

test('Worker 返回双语错误和英文证明，原始标签在消息往返后保留', async () => {
  const previous = globalThis.self;
  const messages = [];
  let handler;
  globalThis.self = {
    addEventListener(type, callback) { assert.equal(type, 'message'); handler = callback; },
    postMessage(message) { messages.push(message); },
  };
  try {
    await import('../src/solver-worker.js');
    const label = '基础';
    handler({ data: { type: 'solve', requestId: 'localized-error', config: { ...base, typeMode: 'within', types: [label, 'B', 'B', 'B', 'B', 'B'] } } });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'error');
    assert.equal(messages[0].requestId, 'localized-error');
    assert.match(messages[0].message, /类型「基础」只有 1 人/);
    assert.match(messages[0].messageEn, /Type “基础” has only 1 person/);
    messages.length = 0;
    handler({ data: { type: 'solve', requestId: 'localized-proof', config: base, timeBudgetMs: 100 } });
    const result = messages.find((message) => message.type === 'result');
    assert.ok(result);
    assert.equal(result.requestId, 'localized-proof');
    assert.match(result.result.proof.reasonEn, /valid upper bounds/);
  } finally {
    if (previous === undefined) delete globalThis.self;
    else globalThis.self = previous;
  }
});
