import test, { after } from 'node:test';
import assert from 'node:assert/strict';
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
after(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});
const {
  messages, getLanguage, setLanguage, t, errorText, proofText,
  localizeName, localizeType, applyPageTranslations,
} = await import('../src/i18n.js');

async function withStorage(storage, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { return await callback(); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
}

let moduleVersion = 0;
const freshModule = () => import(`../src/i18n.js?test=${++moduleVersion}`);
const placeholders = value => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort();

test('所有产品文案提供中英版本，参数对应且英文模板无残留中文', () => {
  assert.ok(Object.isFrozen(messages));
  assert.ok(Object.keys(messages).length > 0);
  for (const [key, entry] of Object.entries(messages)) {
    assert.equal(typeof entry.zh, 'string', `${key}: zh`);
    assert.equal(typeof entry.en, 'string', `${key}: en`);
    assert.deepEqual(placeholders(entry.zh), placeholders(entry.en), `${key}: parameters`);
    assert.doesNotMatch(entry.en, /\p{Script=Han}/u, `${key}: English`);
  }
});

test('切换语言可重复执行，未知语言不改变当前语言', () => {
  assert.equal(setLanguage('zh'), true);
  assert.equal(t('page.people'), '总人数');
  assert.equal(setLanguage('en'), true);
  assert.equal(getLanguage(), 'en');
  assert.equal(t('page.people'), 'Total people');
  for (const invalid of ['EN', 'fr', '', null, undefined]) {
    assert.equal(setLanguage(invalid), false);
    assert.equal(getLanguage(), 'en');
  }
  assert.equal(setLanguage('en'), true);
  assert.equal(t('page.people'), 'Total people');
  setLanguage('zh');
});

test('参数保留零值和空文本，用户花括号及Unicode只插入一次', () => {
  setLanguage('en');
  assert.equal(t('app.size.composition', { count: 0, size: '' }), '0 ×  people');
  const name = '王同学🙂 {id} <b>原文</b>';
  const params = Object.freeze({ name, id: 7 });
  assert.equal(t('app.nameWithId', params), `${name} (ID 7)`);
  const inherited = Object.create({ size: 4 });
  assert.equal(t('app.size.each', inherited), '{size} people per group');
  assert.equal(t('app.size.each'), '{size} people per group');
  setLanguage('zh');
  assert.equal(t('app.nameWithId', params), `${name}（7号）`);
});

test('未知文案键明确报错，不静默混用另一语言', () => {
  for (const language of ['zh', 'en']) {
    setLanguage(language);
    assert.throws(() => t('missing.key'), new RegExp(`Missing ${language} translation: missing.key`));
  }
  setLanguage('zh');
});

test('错误与证明取当前语言，缺少英文时显示英文通用提示', () => {
  const error = Object.freeze({ message: '原始错误', messageEn: 'Original error' });
  const proof = Object.freeze({ reason: '数学证明', reasonEn: 'Mathematical proof' });
  setLanguage('zh');
  assert.equal(errorText(error), '原始错误');
  assert.equal(proofText(proof), '数学证明');
  assert.equal(errorText(null), t('page.unexpectedError'));
  setLanguage('en');
  assert.equal(errorText(error), 'Original error');
  assert.equal(proofText(proof), 'Mathematical proof');
  assert.equal(errorText({ message: '只有中文' }), t('page.unexpectedError'));
  assert.equal(proofText({ reason: '只有中文' }), t('page.proofUnavailable'));
  assert.equal(proofText(null), t('page.proofUnavailable'));
  setLanguage('zh');
});

test('系统编号和未分类只翻译展示，中文姓名和自定义类型保持', () => {
  const data = Object.freeze({ name: '6号', customName: '六号同学', type: '未分类', customType: '进阶组' });
  setLanguage('en');
  assert.equal(localizeName(data.name, 6), 'Person 6');
  assert.equal(localizeName(data.customName, 6), data.customName);
  assert.equal(localizeName('7号', 6), '7号');
  assert.equal(localizeType(data.type), 'Unassigned');
  assert.equal(localizeType(data.customType), data.customType);
  assert.deepEqual(data, { name: '6号', customName: '六号同学', type: '未分类', customType: '进阶组' });
  setLanguage('zh');
  assert.equal(localizeName(data.name, 6), '6号');
  assert.equal(localizeType(data.type), '未分类');
});

test('独立语言存储能恢复英文，损坏或未知设置回到中文', async () => {
  for (const [stored, expected] of [['en', 'en'], ['zh', 'zh'], [null, 'zh'], ['broken', 'zh']]) {
    await withStorage({ getItem(key) { assert.equal(key, 'groupme.language'); return stored; } }, async () => {
      const module = await freshModule();
      assert.equal(module.getLanguage(), expected);
    });
  }
});

test('语言保存只写专用键，存储拒绝仍可在当前会话切换', async () => {
  const writes = [];
  await withStorage({ getItem: () => null, setItem: (...args) => writes.push(args) }, async () => {
    const module = await freshModule();
    assert.equal(module.setLanguage('en'), true);
    assert.equal(module.setLanguage('invalid'), false);
    assert.deepEqual(writes, [['groupme.language', 'en']]);
  });
  await withStorage({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }, async () => {
    const module = await freshModule();
    assert.equal(module.getLanguage(), 'zh');
    assert.equal(module.setLanguage('en'), true);
    assert.equal(module.getLanguage(), 'en');
    assert.equal(module.t('page.people'), 'Total people');
  });
});

test('静态翻译更新文字、辅助属性和页面语言，不重写输入值', () => {
  const text = { dataset: { i18n: 'page.people' }, textContent: '' };
  Object.defineProperty(text, 'innerHTML', { set() { throw new Error('must use textContent'); } });
  const input = {
    value: '1.5', attributes: new Map([['data-i18n-placeholder', 'page.unlimited']]),
    getAttribute(key) { return this.attributes.get(key); },
    setAttribute(key, value) { this.attributes.set(key, value); },
  };
  const label = {
    attributes: new Map([['data-i18n-aria-label', 'page.language'], ['data-i18n-title', 'page.title'], ['data-i18n-content', 'page.description']]),
    getAttribute(key) { return this.attributes.get(key); },
    setAttribute(key, value) { this.attributes.set(key, value); },
  };
  const selector = { value: 'zh' };
  const root = {
    documentElement: { lang: 'zh-CN' }, title: '',
    querySelector: key => key === '#language-select' ? selector : null,
    querySelectorAll: query => query === '[data-i18n]' ? [text]
      : query === '[data-i18n-placeholder]' ? [input] : [label],
  };
  setLanguage('en');
  applyPageTranslations(root);
  assert.equal(text.textContent, 'Total people');
  assert.equal(input.value, '1.5');
  assert.equal(input.getAttribute('placeholder'), 'Any');
  assert.equal(label.getAttribute('aria-label'), 'Interface language');
  assert.equal(label.getAttribute('title'), t('page.title'));
  assert.equal(label.getAttribute('content'), t('page.description'));
  assert.equal(root.documentElement.lang, 'en');
  assert.equal(root.title, t('page.title'));
  assert.equal(selector.value, 'en');
  setLanguage('zh');
  applyPageTranslations(root);
  assert.equal(input.value, '1.5');
  assert.equal(text.textContent, '总人数');
  assert.equal(root.documentElement.lang, 'zh-CN');
  assert.equal(selector.value, 'zh');
});
