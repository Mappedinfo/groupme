import { LIMITS } from './grouping.js?v=i18n-1';
import { domainError } from './domain-error.js?v=i18n-1';

function validatePeople(people) {
  if (!Number.isInteger(people) || people < LIMITS.minPeople || people > LIMITS.maxPeople) {
    throw domainError(`总人数须为 ${LIMITS.minPeople} 至 ${LIMITS.maxPeople} 之间的整数。`, `Total number of people must be an integer between ${LIMITS.minPeople} and ${LIMITS.maxPeople}.`);
  }
}

function validateCategoryCount(categoryCount) {
  if (categoryCount !== 2 && categoryCount !== 3) throw domainError('快捷分类只支持 2 类或 3 类。', 'Quick type assignment supports only 2 or 3 categories.');
}

function normalizeLabel(value, index, allowBlank) {
  if (typeof value !== 'string') throw domainError(`第 ${index + 1} 个类型标签须为文字。`, `Type label ${index + 1} must be text.`);
  if (/[\r\n\v\f\u0085\u2028\u2029]/u.test(value)) throw domainError(`第 ${index + 1} 个类型标签不能包含换行。`, `Type label ${index + 1} cannot contain line breaks.`);
  const label = value.trim();
  if (!label && !allowBlank) throw domainError(`请填写第 ${index + 1} 类的名称。`, `Enter a name for category ${index + 1}.`);
  if (Array.from(label).length > 20) throw domainError(`第 ${index + 1} 个类型标签不能超过 20 个字符。`, `Type label ${index + 1} cannot exceed 20 characters.`);
  return label || '未分类';
}

/** 批量编辑可留空；标签均按 Unicode 码点限长，换行不会被 trim 隐藏。 */
export function normalizeTypeLabels(values) {
  if (!Array.isArray(values)) throw domainError('请提供类型标签列表。', 'Provide a list of type labels.');
  return Array.from(values, (value, index) => normalizeLabel(value, index, true));
}

/** 快捷分类的默认人数：尽可能平均，较大的一类在前。 */
export function quickTypeSizes(people, categoryCount) {
  validatePeople(people);
  validateCategoryCount(categoryCount);
  const smaller = Math.floor(people / categoryCount);
  return Array.from({ length: categoryCount }, (_, i) => smaller + Number(i < people % categoryCount));
}

/** 前 K−1 类由用户填写，最后一类取余；按 1-based 编号连续分配。 */
export function createQuickTypePlan(people, labels, leadingCounts) {
  validatePeople(people);
  if (!Array.isArray(labels)) throw domainError('请提供 2 类或 3 类的名称。', 'Provide names for 2 or 3 categories.');
  validateCategoryCount(labels.length);
  const normalized = Array.from(labels, (label, index) => normalizeLabel(label, index, false));
  if (new Set(normalized).size !== normalized.length) throw domainError('各类名称不能重复，请为每类填写不同的名称。', 'Category names must be unique. Enter a different name for each category.');
  if (!Array.isArray(leadingCounts) || leadingCounts.length !== labels.length - 1) {
    throw domainError(`请填写前 ${labels.length - 1} 类的人数，最后一类将自动计算。`, `Enter the counts for the first ${labels.length - 1} ${labels.length === 2 ? 'category' : 'categories'}; the final category will be calculated automatically.`);
  }
  const sizes = Array.from(leadingCounts, (count, index) => {
    if (!Number.isInteger(count) || count < 1) throw domainError(`第 ${index + 1} 类人数须为至少 1 的整数。`, `The count for category ${index + 1} must be an integer of at least 1.`);
    return count;
  });
  const remaining = people - sizes.reduce((sum, count) => sum + count, 0);
  if (remaining < 1) throw domainError(`前 ${labels.length - 1} 类人数之和须小于总人数 ${people}，为最后一类至少保留 1 人。`, `The total for the first ${labels.length - 1} ${labels.length === 2 ? 'category' : 'categories'} must be less than ${people}, leaving at least 1 person for the final category.`);
  sizes.push(remaining);
  const types = [];
  let start = 1;
  const ranges = normalized.map((label, index) => {
    const count = sizes[index];
    const end = start + count - 1;
    const range = { label, count, start, end };
    for (let i = 0; i < count; i += 1) types.push(label);
    start = end + 1;
    return range;
  });
  return { sizes, types, ranges };
}
