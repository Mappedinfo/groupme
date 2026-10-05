import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuickTypePlan, normalizeTypeLabels, quickTypeSizes } from '../src/type-editor.js';

test('14 人快捷分类默认 7+7 或 5+5+4', () => {
  assert.deepEqual(quickTypeSizes(14, 2), [7, 7]);
  assert.deepEqual(quickTypeSizes(14, 3), [5, 5, 4]);
  assert.deepEqual(quickTypeSizes(6, 3), [2, 2, 2]);
  assert.deepEqual(quickTypeSizes(300, 3), [100, 100, 100]);
});

test('全部支持人数的默认分类正数、人数守恒且至多相差一人', () => {
  for (let people = 6; people <= 300; people += 1) {
    for (const categoryCount of [2, 3]) {
      const sizes = quickTypeSizes(people, categoryCount);
      assert.equal(sizes.length, categoryCount);
      assert.equal(sizes.reduce((sum, count) => sum + count, 0), people);
      assert.ok(sizes.every((count) => Number.isInteger(count) && count >= 1));
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
      assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
    }
  }
});

test('两类按填写人数和余数连续分配，不受默认均分限制', () => {
  assert.deepEqual(createQuickTypePlan(14, [' 高年级 ', '低年级'], [5]), {
    sizes: [5, 9],
    types: [...Array(5).fill('高年级'), ...Array(9).fill('低年级')],
    ranges: [
      { label: '高年级', count: 5, start: 1, end: 5 },
      { label: '低年级', count: 9, start: 6, end: 14 },
    ],
  });
});

test('三类前两项独立填写，最后一类由总人数精确减去', () => {
  assert.deepEqual(createQuickTypePlan(14, ['A', 'B', 'C'], [4, 6]), {
    sizes: [4, 6, 4],
    types: [...Array(4).fill('A'), ...Array(6).fill('B'), ...Array(4).fill('C')],
    ranges: [
      { label: 'A', count: 4, start: 1, end: 4 },
      { label: 'B', count: 6, start: 5, end: 10 },
      { label: 'C', count: 4, start: 11, end: 14 },
    ],
  });
});

test('类别可只有 1 人，类型编辑不擅自施加同类组队约束', () => {
  assert.deepEqual(createQuickTypePlan(6, ['A', 'B', 'C'], [1, 4]).sizes, [1, 4, 1]);
  const plan = createQuickTypePlan(300, ['A', 'B'], [299]);
  assert.equal(plan.types.length, 300);
  assert.deepEqual(plan.ranges[1], { label: 'B', count: 1, start: 300, end: 300 });
});

test('批量类型 trim 后空白归未分类，保留重复标签', () => {
  assert.deepEqual(normalizeTypeLabels([' A ', '', ' \t ', 'A', '未分类']), ['A', '未分类', '未分类', 'A', '未分类']);
  assert.deepEqual(normalizeTypeLabels([]), []);
});

test('全部函数不修改输入，返回列表也不与输入共用', () => {
  const labels = Object.freeze([' A ', 'B', 'C']);
  const counts = Object.freeze([3, 5]);
  const plan = createQuickTypePlan(14, labels, counts);
  assert.deepEqual(labels, [' A ', 'B', 'C']);
  assert.deepEqual(counts, [3, 5]);
  const normalized = normalizeTypeLabels(labels);
  normalized[0] = '新标签';
  plan.sizes[0] = 99;
  assert.equal(labels[0], ' A ');
  assert.equal(counts[0], 3);
});

test('人数与类别数只接受规定范围的整数', () => {
  for (const people of [undefined, null, '14', NaN, Infinity, 5, 301, 14.5]) {
    assert.throws(() => quickTypeSizes(people, 2), /总人数/);
    assert.throws(() => createQuickTypePlan(people, ['A', 'B'], [1]), /总人数/);
  }
  for (const count of [undefined, null, '2', 1, 4, 2.5, NaN]) {
    assert.throws(() => quickTypeSizes(14, count), /2 类或 3 类/);
  }
});

test('快捷分类名称必须有两或三个非空、trim 后不同的标签', () => {
  for (const labels of [null, 'A,B', [], ['A'], ['A', 'B', 'C', 'D']]) {
    assert.throws(() => createQuickTypePlan(14, labels, [4]), /2 类或 3 类/);
  }
  for (const labels of [['A', ''], [' ', 'B'], ['A', ' A '], ['A', 'B', 'B']]) {
    assert.throws(() => createQuickTypePlan(14, labels, labels.length === 2 ? [4] : [4, 4]), /名称/);
  }
});

test('前置人数项数必须匹配，各项正整数且最后一类至少有一人', () => {
  for (const counts of [null, '4', [], [4, 4]]) {
    assert.throws(() => createQuickTypePlan(14, ['A', 'B'], counts), /前 1 类/);
  }
  for (const count of [undefined, null, '4', NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(() => createQuickTypePlan(14, ['A', 'B'], [count]), /至少 1 的整数/);
  }
  assert.throws(() => createQuickTypePlan(14, ['A', 'B'], [14]), /最后一类至少保留 1 人/);
  assert.throws(() => createQuickTypePlan(14, ['A', 'B', 'C'], [7, 8]), /最后一类至少保留 1 人/);
  assert.throws(() => createQuickTypePlan(14, ['A', 'B', 'C'], Array(2)), /至少 1 的整数/);
});

test('类型标签按 Unicode 码点计数，20 个 emoji 合法而 21 个不合法', () => {
  const twenty = '🙂'.repeat(20);
  const twentyOne = '🙂'.repeat(21);
  assert.deepEqual(normalizeTypeLabels([twenty]), [twenty]);
  assert.equal(createQuickTypePlan(6, [twenty, '其他'], [2]).types[0], twenty);
  assert.throws(() => normalizeTypeLabels([twentyOne]), /20 个字符/);
  assert.throws(() => createQuickTypePlan(6, [twentyOne, '其他'], [2]), /20 个字符/);
});

test('换行在 trim 前拒绝，防止空白和边缘换行被隐藏', () => {
  for (const newline of ['\n', '\r', '\r\n', '\v', '\f', '\u0085', '\u2028', '\u2029']) {
    for (const label of [newline, `A${newline}`, `A${newline}B`]) {
      assert.throws(() => normalizeTypeLabels([label]), /不能包含换行/);
      assert.throws(() => createQuickTypePlan(14, [label, 'B'], [5]), /不能包含换行/);
    }
  }
});

test('批量标签拒绝非列表、非文字及稀疏项', () => {
  for (const values of [null, undefined, 'A', 1]) assert.throws(() => normalizeTypeLabels(values), /标签列表/);
  for (const value of [undefined, null, 1, {}, []]) {
    assert.throws(() => normalizeTypeLabels([value]), /须为文字/);
    assert.throws(() => createQuickTypePlan(14, ['A', value], [5]), /须为文字/);
  }
  assert.throws(() => normalizeTypeLabels(Array(2)), /须为文字/);
});
