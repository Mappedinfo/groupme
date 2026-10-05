import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANS, DEFAULT_NAMES, createAssignment, analyzeAssignment,
  getTeammates, shuffleOrder, parseNames,
} from '../src/grouping.js';

const ids = Array.from({ length: 14 }, (_, i) => i + 1);
const expected = {
  four: { sizes: [[4, 4, 3, 3], [4, 4, 3, 3]], pairs: 36, distribution: [[6, 4], [5, 8], [4, 2]] },
  mixed: { sizes: [[4, 4, 3, 3], [3, 3, 3, 3, 2]], pairs: 31, distribution: [[5, 6], [4, 8]] },
  five: { sizes: [[3, 3, 3, 3, 2], [3, 3, 3, 3, 2]], pairs: 26, distribution: [[4, 10], [3, 4]] },
};

for (const plan of PLANS) {
  test(`${plan.label}：人数、零重复及队友统计`, () => {
    const assignment = createAssignment(plan.id);
    const target = expected[plan.id];
    for (const [index, round] of [assignment.first, assignment.second].entries()) {
      assert.deepEqual([...round.flat()].sort((a, b) => a - b), ids);
      assert.deepEqual(round.map((group) => group.length), target.sizes[index]);
    }
    assert.deepEqual(analyzeAssignment(assignment), {
      repeatedPairs: 0,
      uniquePairs: target.pairs,
      distribution: target.distribution.map(([teammates, people]) => ({ teammates, people })),
      averageTeammates: target.pairs * 2 / 14,
    });
    let teammateTotal = 0;
    for (const id of ids) {
      const teammates = getTeammates(assignment, id);
      assert.equal(teammates.first.some((other) => teammates.second.includes(other)), false);
      assert.equal(teammates.uniqueCount, teammates.first.length + teammates.second.length);
      assert.ok(assignment.first[teammates.firstGroup].includes(id));
      assert.ok(assignment.second[teammates.secondGroup].includes(id));
      assert.equal([...teammates.first, ...teammates.second].includes(id), false);
      teammateTotal += teammates.uniqueCount;
    }
    assert.equal(teammateTotal, target.pairs * 2);
  });

  test(`${plan.label}：确定性洗牌保持双射和零重复`, () => {
    const order = shuffleOrder(ids, () => 0);
    const assignment = createAssignment(plan.id, order);
    assert.deepEqual(analyzeAssignment(assignment), analyzeAssignment(createAssignment(plan.id)));
    assert.deepEqual(assignment.first, plan.first.map((group) => group.map((id) => order[id - 1])));
    assert.deepEqual(assignment.second, plan.second.map((group) => group.map((id) => order[id - 1])));
    for (const round of [assignment.first, assignment.second]) {
      assert.deepEqual(round.flat().sort((a, b) => a - b), ids);
    }
    for (const id of ids) {
      const { first, second } = getTeammates(assignment, id);
      assert.equal(first.some((other) => second.includes(other)), false);
    }
  });
}

test('已验证的 11 号队友和零基组索引', () => {
  assert.deepEqual(getTeammates(createAssignment('four'), 11), {
    first: [9, 10], second: [3, 7], uniqueCount: 4, firstGroup: 2, secondGroup: 2,
  });
  assert.deepEqual(getTeammates(createAssignment('mixed'), 11), {
    first: [9, 10], second: [7, 14], uniqueCount: 4, firstGroup: 2, secondGroup: 3,
  });
});

test('两轮完全相同时正确计数重复人员对', () => {
  const { first } = createAssignment('four');
  const result = analyzeAssignment({ first, second: first });
  assert.equal(result.repeatedPairs, 18);
  assert.equal(result.uniquePairs, 18);
  assert.deepEqual(getTeammates({ first, second: first }, 1), {
    first: [2, 3, 4], second: [2, 3, 4], uniqueCount: 3, firstGroup: 0, secondGroup: 0,
  });
});

test('模板和调用输入互不污染', () => {
  const assignment = createAssignment('four');
  assignment.first[0][0] = 99;
  assert.equal(createAssignment('four').first[0][0], 1);
  const order = Object.freeze([...ids]);
  assert.deepEqual(shuffleOrder(order, () => 0), [...ids.slice(1), 1]);
  assert.deepEqual(order, ids);
  assert.deepEqual(shuffleOrder(order, () => 0.999), ids);
  assert.equal(Object.isFrozen(PLANS[0].first[0]), true);
});

test('默认姓名以及空白、换行与重名处理', () => {
  assert.deepEqual(DEFAULT_NAMES, ids.map((id) => `${id}号`));
  const text = `\n  同学  \r\n\r\n${Array(13).fill(' 同学 ').join('\r')}\n`;
  assert.deepEqual(parseNames(text), Array(14).fill('同学'));
  const limitNames = [...DEFAULT_NAMES];
  limitNames[0] = '😀'.repeat(20);
  assert.deepEqual(parseNames(limitNames.join('\n')), limitNames);
});

test('姓名人数、长度和类型错误使用中文提示', () => {
  for (const text of ['', '同学', DEFAULT_NAMES.slice(1).join('\n'), [...DEFAULT_NAMES, '多一人'].join('\n')]) {
    assert.throws(() => parseNames(text), /恰好 14 位/);
  }
  const tooLong = [...DEFAULT_NAMES];
  tooLong[6] = '王'.repeat(21);
  assert.throws(() => parseNames(tooLong.join('\n')), /第 7 位.*20 个字符/);
  for (const value of [null, undefined, 14, []]) {
    assert.throws(() => parseNames(value), /每行一人/);
  }
});

test('非法方案、人员顺序和随机来源被拒绝', () => {
  assert.throws(() => createAssignment('missing'), /有效的分组方案/);
  const invalidOrders = [null, [], ids.slice(1), [...ids.slice(0, -1), 1], [...ids.slice(0, -1), 15], ids.map(String), Array(14)];
  for (const order of invalidOrders) {
    assert.throws(() => createAssignment('four', order), /每人出现一次/);
    assert.throws(() => shuffleOrder(order), /每人出现一次/);
  }
  assert.throws(() => shuffleOrder(ids, null), /必须是函数/);
  for (const sample of [1, -0.1, NaN, Infinity, '0.5']) {
    assert.throws(() => shuffleOrder(ids, () => sample), /随机来源必须返回/);
  }
});

test('非法分组与不存在的人员被拒绝', () => {
  for (const assignment of [null, {}, { first: [], second: [] }, { first: [null], second: [] }]) {
    assert.throws(() => analyzeAssignment(assignment), Error);
    assert.throws(() => getTeammates(assignment, 1), Error);
  }
  const duplicate = createAssignment('four');
  duplicate.first[0][0] = 2;
  assert.throws(() => analyzeAssignment(duplicate), /每人出现一次/);
  const assignment = createAssignment('four');
  for (const id of [0, 15, 1.5, '1', undefined]) {
    assert.throws(() => getTeammates(assignment, id), /1 至 14 号/);
  }
});
