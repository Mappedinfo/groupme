import { appMessages } from './app-messages.js?v=i18n-1';
import { pageMessages } from './page-messages.js?v=i18n-1';

export const messages = Object.freeze({ ...pageMessages, ...appMessages });
const LANGUAGE_KEY = 'groupme.language';
let language = 'zh';
try { if (globalThis.localStorage?.getItem(LANGUAGE_KEY) === 'en') language = 'en'; } catch { /* Local storage is optional. */ }

export function getLanguage() { return language; }
export function setLanguage(value) {
  if (value !== 'zh' && value !== 'en') return false;
  language = value;
  try { globalThis.localStorage?.setItem(LANGUAGE_KEY, value); } catch { /* The current session still switches. */ }
  return true;
}
export function t(key, params = {}) {
  const template = messages[key]?.[language];
  if (typeof template !== 'string') throw new Error(`Missing ${language} translation: ${key}`);
  return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
export function errorText(error) {
  return language === 'en' ? error?.messageEn || t('page.unexpectedError') : error?.message || t('page.unexpectedError');
}
export function proofText(proof) {
  return language === 'en' ? proof?.reasonEn || t('page.proofUnavailable') : proof?.reason || t('page.proofUnavailable');
}
export function localizeName(name, id) { return language === 'en' && name === `${id}号` ? `Person ${id}` : name; }
export function localizeType(label) { return language === 'en' && label === '未分类' ? 'Unassigned' : label; }

export function applyPageTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  for (const attribute of ['aria-label', 'placeholder', 'title', 'content']) {
    root.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    });
  }
  if (root.documentElement) {
    root.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    root.title = t('page.title');
    const select = root.querySelector('#language-select');
    if (select) select.value = language;
  }
}
