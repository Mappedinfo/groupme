import { domainError } from './domain-error.js?v=i18n-1';

/** 纯浏览器分组内核。编号从 1 开始；指标均由实际同组关系计算。 */
export const LIMITS = Object.freeze({ minPeople: 6, maxPeople: 300, minRounds: 1, maxRounds: 30 });

function integer(value, min, max, label, labelEn) {
  if (!Number.isInteger(value) || value < min || value > max) throw domainError(`${label}须为 ${min} 至 ${max} 之间的整数。`, `${labelEn} must be an integer between ${min} and ${max}.`);
  return value;
}

function typeLabelEn(label) {
  return label === '未分类' ? 'Unassigned' : label;
}

export function balancedSizes(n, k) {
  integer(n, LIMITS.minPeople, LIMITS.maxPeople, '总人数', 'Total number of people');
  integer(k, 3, Math.floor(n / 2), '组数', 'Number of groups');
  const small = Math.floor(n / k);
  return Array.from({ length: k }, (_, i) => small + Number(i < n % k));
}

/** 固定组草稿只校验结构；全轮可行性由 validateConfig 统一检查。 */
export function normalizeFixedGroups(fixedGroups, people) {
  integer(people, LIMITS.minPeople, LIMITS.maxPeople, '总人数', 'Total number of people');
  const source = fixedGroups ?? [];
  if (!Array.isArray(source)) throw domainError('固定小组须为成员编号列表的数组。', 'Fixed groups must be an array of member ID lists.');
  const seen = new Set();
  return Array.from(source, (group, index) => {
    if (!Array.isArray(group) || group.length < 2) throw domainError(`固定小组 ${index + 1} 至少需要 2 位成员。`, `Fixed group ${index + 1} must contain at least 2 members.`);
    return Array.from(group, (id) => {
      integer(id, 1, people, '固定小组成员编号', 'Fixed-group member ID');
      if (seen.has(id)) throw domainError(`${id} 号同学在固定小组中重复出现；组内和不同固定组之间都不能重复。`, `Person ${id} appears more than once in the fixed groups. Members cannot be repeated within or across fixed groups.`);
      seen.add(id);
      return id;
    }).sort((a, b) => a - b);
  }).sort((a, b) => a[0] - b[0]);
}

function typeContext(config) {
  const labels = [];
  const members = [];
  const labelIds = new Map();
  const fixedGroups = config.fixedGroups.map((group) => group.map((id) => id - 1));
  const fixedGroupIndex = new Int16Array(config.people).fill(-1);
  fixedGroups.forEach((group, index) => group.forEach((id) => { fixedGroupIndex[id] = index; }));
  const rotatingIds = [];
  const ids = config.types.map((label, person) => {
    if (!labelIds.has(label)) {
      labelIds.set(label, labels.length);
      labels.push(label);
      members.push([]);
    }
    const id = labelIds.get(label);
    if (fixedGroupIndex[person] === -1) { members[id].push(person); rotatingIds.push(person); }
    return id;
  });
  const counts = members.map((list) => list.length);
  const fixedPairs = fixedGroups.reduce((sum, group) => sum + group.length * (group.length - 1) / 2, 0);
  const rotatingEligiblePairs = config.typeMode === 'within' ? counts.reduce((sum, count) => sum + count * (count - 1) / 2, 0) : rotatingIds.length * (rotatingIds.length - 1) / 2;
  return { mode: config.typeMode, labels, members, ids, counts, fixedGroups, fixedGroupIndex, rotatingIds, fixedPairs, rotatingEligiblePairs };
}

const feasibilityCache = new Map();
function allowedCounts(n, mode, counts, fixedGroups = []) {
  if (mode !== 'within' && fixedGroups.length === 0) return Array.from({ length: Math.floor(n / 2) - 2 }, (_, i) => i + 3);
  const fixedSizes = fixedGroups.map((group) => group.length);
  const rotatingPeople = n - fixedSizes.reduce((sum, size) => sum + size, 0);
  const key = `${n}:${mode}:${[...counts].sort((a, b) => a - b).join(',')}:${fixedSizes.sort((a, b) => a - b).join(',')}`;
  if (feasibilityCache.has(key)) return [...feasibilityCache.get(key)];
  const allowed = [];
  for (let k = 3; k <= Math.floor(n / 2); k += 1) {
    const small = Math.floor(n / k);
    const rotatingGroups = k - fixedGroups.length;
    if (rotatingGroups < 0 || fixedSizes.some((size) => size < small || size > small + Number(n % k > 0))) continue;
    if (rotatingGroups === 0) { if (rotatingPeople === 0) allowed.push(k); continue; }
    if (rotatingPeople < small * rotatingGroups || rotatingPeople > (small + 1) * rotatingGroups) continue;
    if (mode !== 'within') { allowed.push(k); continue; }
    let least = 0;
    let most = 0;
    let possible = true;
    for (const count of counts) {
      const lower = Math.ceil(count / (small + 1));
      const upper = Math.floor(count / small);
      if (lower > upper) { possible = false; break; }
      least += lower;
      most += upper;
    }
    if (possible && least <= rotatingGroups && rotatingGroups <= most) allowed.push(k);
  }
  if (feasibilityCache.size >= 128) feasibilityCache.delete(feasibilityCache.keys().next().value);
  feasibilityCache.set(key, [...allowed]);
  return allowed;
}

// 距离写成 |N-pK|/K，以整数交叉乘积判断并列，避免浮点误差遗漏候选。
function compareSizeDistance(n, preferred, a, b) {
  return Math.abs(n - preferred * a) * b - Math.abs(n - preferred * b) * a;
}

function effectiveAutomaticCounts(config, context = typeContext(config)) {
  const allowed = allowedCounts(config.people, config.typeMode, context.counts, context.fixedGroups);
  if (config.preferredSize === null) return allowed;
  let best = allowed[0];
  for (const k of allowed) {
    if (compareSizeDistance(config.people, config.preferredSize, k, best) < 0) best = k;
  }
  return allowed.filter((k) => compareSizeDistance(config.people, config.preferredSize, k, best) === 0);
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw domainError('请提供有效的分组设置。', 'Please provide valid grouping settings.');
  const people = integer(config.people, LIMITS.minPeople, LIMITS.maxPeople, '总人数', 'Total number of people');
  const rounds = integer(config.rounds, LIMITS.minRounds, LIMITS.maxRounds, '作业次数', 'Number of assignments');
  const rawCounts = config.groupCounts ?? Array(rounds).fill(null);
  if (!Array.isArray(rawCounts) || rawCounts.length !== rounds) throw domainError('请为每次作业提供一个组数或自动选项。', 'Provide a group count or the automatic option for each assignment.');
  const groupCounts = Array.from(rawCounts, (k) => k === null ? null : integer(k, 3, Math.floor(people / 2), '每次作业的组数', 'Group count for each assignment'));
  const objective = config.objective ?? 'fair';
  if (!['fair', 'coverage'].includes(objective)) throw domainError('请选择公平优先或覆盖优先。', 'Choose either fairness first or overall coverage first.');
  const seed = config.seed ?? 1;
  integer(seed, 0, 0xffffffff, '随机种子', 'Random seed');
  const preferredSize = config.preferredSize ?? null;
  if (preferredSize !== null) integer(preferredSize, 2, LIMITS.maxPeople, '每组期望人数', 'Preferred group size');
  const typeMode = config.typeMode ?? 'off';
  if (!['off', 'mix', 'within'].includes(typeMode)) throw domainError('请选择不限制类型、均匀混合或同类组队。', 'Choose no type restriction, evenly mixed types, or groups within each type.');
  const rawTypes = config.types ?? Array(people).fill('未分类');
  if (!Array.isArray(rawTypes) || rawTypes.length !== people) throw domainError(`请提供恰好 ${people} 位同学的类型。`, `Provide a type for exactly ${people} people.`);
  const types = Array.from(rawTypes, (value, index) => {
    if (typeof value !== 'string') throw domainError(`第 ${index + 1} 位同学的类型须为文字。`, `The type for person ${index + 1} must be text.`);
    const label = value.trim() || '未分类';
    if (Array.from(label).length > 20) throw domainError(`第 ${index + 1} 位同学的类型不能超过 20 个字符。`, `The type for person ${index + 1} cannot exceed 20 characters.`);
    return label;
  });
  const fixedGroups = normalizeFixedGroups(config.fixedGroups, people);
  const normalized = { people, rounds, groupCounts, objective, seed: seed >>> 0, typeMode, types, preferredSize, fixedGroups };
  if (typeMode === 'within' || fixedGroups.length) {
    const context = typeContext(normalized);
    if (context.rotatingIds.length === 1) throw domainError('固定小组之外只剩 1 位轮换成员，无法满足每组至少 2 人；请调整固定小组。', 'Only 1 rotating member remains outside the fixed groups, so groups of at least 2 are impossible. Please adjust the fixed groups.');
    const singleton = typeMode === 'within' ? context.counts.indexOf(1) : -1;
    if (singleton !== -1) throw domainError(`${fixedGroups.length ? '轮换成员中的' : ''}类型「${context.labels[singleton]}」只有 1 人，无法同类组队且每组至少 2 人。`, `Type “${typeLabelEn(context.labels[singleton])}” has only 1 ${fixedGroups.length ? 'rotating member' : 'person'}, so groups within each type cannot contain at least 2 people.`);
    const allowed = allowedCounts(people, typeMode, context.counts, context.fixedGroups);
    if (!allowed.length) throw domainError(`${fixedGroups.length ? '固定小组与当前人数、类型规则' : '这些类型人数'}无法同时满足至少 3 组、每组至少 2 人和全轮人数相差不超过 1 人；请调整固定小组、类型或组队方式。`, `${fixedGroups.length ? 'The fixed groups, population and type rules' : 'These type counts'} cannot satisfy all three requirements: at least 3 groups, at least 2 people per group, and group sizes differing by at most 1 within each assignment. Please adjust the fixed groups, types or grouping mode.`);
    groupCounts.forEach((k, round) => {
      if (k !== null && !allowed.includes(k)) throw domainError(`作业 ${round + 1} 的 ${k} 组不满足${fixedGroups.length ? '固定小组、类型与' : '同类组队与'}均匀人数要求；可行组数为 ${allowed.join('、')}。`, `Assignment ${round + 1} cannot use ${k} groups while satisfying ${fixedGroups.length ? 'the fixed-group, type and balanced-size rules' : 'the within-type and balanced-size rules'}. Feasible group counts: ${allowed.join(', ')}.`);
    });
  }
  return normalized;
}

export function feasibleGroupCounts(config) {
  const normalized = validateConfig(config);
  const context = typeContext(normalized);
  return allowedCounts(normalized.people, normalized.typeMode, context.counts, context.fixedGroups);
}

export function getAutomaticGroupCounts(config) {
  return effectiveAutomaticCounts(validateConfig(config));
}

/** 推荐不受逐轮手动组数限制。未填写偏好时仅以约 4 人排序，不改变求解约束。 */
export function getSizeOptions(config) {
  if (!config || typeof config !== 'object') throw domainError('请提供有效的分组设置。', 'Please provide valid grouping settings.');
  const normalized = validateConfig({ ...config, groupCounts: undefined });
  const preferred = normalized.preferredSize ?? 4;
  const context = typeContext(normalized);
  return allowedCounts(normalized.people, normalized.typeMode, context.counts, context.fixedGroups)
    .sort((a, b) => compareSizeDistance(normalized.people, preferred, a, b) || a - b)
    .map((groupCount) => ({
      groupCount,
      sizes: balancedSizes(normalized.people, groupCount),
      averageSize: normalized.people / groupCount,
      distance: Math.abs(normalized.people - preferred * groupCount) / groupCount,
    }));
}

export function validateSchedule(assignments, n, config) {
  integer(n, LIMITS.minPeople, LIMITS.maxPeople, '总人数', 'Total number of people');
  if (!Array.isArray(assignments) || assignments.length < 1 || assignments.length > LIMITS.maxRounds) throw domainError(`作业次数须为 1 至 ${LIMITS.maxRounds}。`, `The number of assignments must be between 1 and ${LIMITS.maxRounds}.`);
  const normalized = config ? validateConfig(config) : null;
  if (normalized && (normalized.people !== n || normalized.rounds !== assignments.length)) throw domainError('分组与总人数或作业次数不一致。', 'The schedule does not match the total number of people or assignments.');
  const context = normalized ? typeContext(normalized) : null;
  const automaticCounts = normalized ? effectiveAutomaticCounts(normalized) : null;
  for (let r = 0; r < assignments.length; r += 1) {
    const round = assignments[r];
    if (!Array.isArray(round)) throw domainError(`作业 ${r + 1} 的分组无效。`, `Assignment ${r + 1} has invalid groups.`);
    const expectedSizes = balancedSizes(n, round.length);
    if (normalized?.groupCounts[r] != null && normalized.groupCounts[r] !== round.length) throw domainError(`作业 ${r + 1} 的组数与设置不一致。`, `The group count for assignment ${r + 1} does not match the settings.`);
    if (normalized?.groupCounts[r] === null && !automaticCounts.includes(round.length)) {
      const requirement = normalized.preferredSize === null ? '当前固定小组与类型组队约束' : `每组期望人数 ${normalized.preferredSize} 人`;
      const requirementEn = normalized.preferredSize === null ? 'the current fixed-group and type constraints' : `the preferred group size of ${normalized.preferredSize}`;
      throw domainError(`作业 ${r + 1} 的组数不符合${requirement}；自动可选组数为 ${automaticCounts.join('、')}。`, `The group count for assignment ${r + 1} does not satisfy ${requirementEn}. Automatic group-count options: ${automaticCounts.join(', ')}.`);
    }
    if (round.some((group) => !Array.isArray(group))) throw domainError('每个小组须为成员列表。', 'Each group must be a list of members.');
    const sizes = round.map((group) => group.length).sort((a, b) => b - a);
    if (sizes.some((size, i) => size !== expectedSizes[i])) throw domainError(`作业 ${r + 1} 必须均匀分组，每组至少两人，大小最多相差一人。`, `Assignment ${r + 1} must have balanced groups of at least 2 people, with group sizes differing by at most 1.`);
    const seen = new Set();
    for (const group of round) {
      for (const id of group) {
        integer(id, 1, n, '成员编号', 'Member ID');
        if (seen.has(id)) throw domainError(`作业 ${r + 1} 的 ${id} 号同学重复出现。`, `Person ${id} appears more than once in assignment ${r + 1}.`);
        seen.add(id);
      }
    }
    if (seen.size !== n) throw domainError(`作业 ${r + 1} 必须包含全部 ${n} 位同学。`, `Assignment ${r + 1} must include all ${n} people.`);
    for (const fixed of normalized?.fixedGroups ?? []) {
      if (!round.some((group) => group.length === fixed.length && fixed.every((id) => group.includes(id)))) {
        throw domainError(`作业 ${r + 1} 的固定小组（${fixed.join('、')} 号）必须完整保留，不能加人、拆分或交换成员。`, `The fixed group with members ${fixed.join(', ')} must remain intact in assignment ${r + 1}. Members cannot be added, split into other groups or exchanged.`);
      }
    }
    const rotatingRound = context ? round.filter((group) => context.fixedGroupIndex[group[0] - 1] === -1) : round;
    if (normalized?.typeMode === 'within') {
      for (const group of rotatingRound) {
        if (group.some((id) => normalized.types[id - 1] !== normalized.types[group[0] - 1])) throw domainError(`作业 ${r + 1} 违反同类组队要求。`, `Assignment ${r + 1} violates the requirement to group members within the same type.`);
      }
    } else if (normalized?.typeMode === 'mix') {
      for (const label of new Set(normalized.types)) {
        const amounts = rotatingRound.map((group) => group.reduce((sum, id) => sum + Number(normalized.types[id - 1] === label), 0));
        if (Math.max(...amounts) - Math.min(...amounts) > 1) throw domainError(`作业 ${r + 1} 的类型「${label}」未均匀分散到各组。`, `Type “${typeLabelEn(label)}” is not evenly distributed across the rotating groups in assignment ${r + 1}.`);
      }
    }
  }
  return true;
}

export function analyzeSchedule(assignments, n, config) {
  const normalized = config ? validateConfig(config) : validateConfig({ people: n, rounds: assignments?.length });
  validateSchedule(assignments, n, normalized);
  const context = typeContext(normalized);
  const counts = new Uint16Array(n * n);
  const people = Array.from({ length: n }, (_, i) => {
    const fixedGroupIndex = context.fixedGroupIndex[i] === -1 ? null : context.fixedGroupIndex[i];
    const domain = fixedGroupIndex !== null ? context.fixedGroups[fixedGroupIndex]
      : normalized.typeMode === 'within' ? context.members[context.ids[i]] : context.rotatingIds;
    const eligibleTeammateIds = domain.filter((id) => id !== i).map((id) => id + 1);
    return { id: i + 1, type: normalized.types[i], fixedGroupIndex, eligibleTeammateIds, eligibleTeammates: eligibleTeammateIds.length, teammates: [], uniqueCount: 0, rounds: [] };
  });
  const sets = Array.from({ length: n }, () => new Set());
  let uniquePairs = 0;
  let repeatedPairs = 0;
  let repeatMeetings = 0;
  const rounds = assignments.map((round, roundIndex) => {
    let uniqueNewPairs = 0;
    let pairMeetings = 0;
    round.forEach((group, groupIndex) => {
      for (const id of group) {
        const teammates = group.filter((other) => other !== id).sort((a, b) => a - b);
        const newTeammates = teammates.filter((other) => !sets[id - 1].has(other));
        people[id - 1].rounds.push({ roundIndex, groupIndex, teammates, newTeammates });
        teammates.forEach((other) => sets[id - 1].add(other));
      }
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const a = Math.min(group[i], group[j]) - 1;
          const b = Math.max(group[i], group[j]) - 1;
          const index = a * n + b;
          if (counts[index] === 0) { uniquePairs += 1; uniqueNewPairs += 1; }
          else { repeatMeetings += 1; if (counts[index] === 1) repeatedPairs += 1; }
          counts[index] += 1;
          pairMeetings += 1;
        }
      }
    });
    return { groupCount: round.length, sizes: round.map((group) => group.length), uniqueNewPairs, pairMeetings, fixedGroupCount: normalized.fixedGroups.length, rotatingGroupCount: round.length - normalized.fixedGroups.length };
  });
  const frequencies = new Map();
  let sumSquaredTeammates = 0;
  people.forEach((person, i) => {
    person.teammates = [...sets[i]].sort((a, b) => a - b);
    person.uniqueCount = person.teammates.length;
    sumSquaredTeammates += person.uniqueCount ** 2;
    frequencies.set(person.uniqueCount, (frequencies.get(person.uniqueCount) ?? 0) + 1);
  });
  const possiblePairs = n * (n - 1) / 2;
  const eligiblePairs = people.reduce((sum, person) => sum + person.eligibleTeammates, 0) / 2;
  const averageTeammates = uniquePairs * 2 / n;
  const fixedUniquePairs = context.fixedGroups.reduce((sum, group) => sum + group.length * (group.length - 1) / 2, 0);
  const rotating = people.filter((person) => person.fixedGroupIndex === null);
  const rotatingUniquePairs = uniquePairs - fixedUniquePairs;
  const rotatingEligiblePairs = eligiblePairs - fixedUniquePairs;
  const rotatingDegrees = rotating.map((person) => person.uniqueCount);
  const fixedRepeatMeetings = fixedUniquePairs * (assignments.length - 1);
  return {
    uniquePairs, possiblePairs, repeatMeetings, repeatedPairs, coverage: uniquePairs / possiblePairs,
    eligiblePairs, eligibleCoverage: uniquePairs / eligiblePairs, typeMode: normalized.typeMode,
    types: context.labels.map((label, i) => ({ label, people: normalized.types.filter((entry) => entry === label).length, rotatingPeople: context.counts[i] })),
    fixedGroupCount: normalized.fixedGroups.length, fixedPeople: n - rotating.length, fixedUniquePairs, fixedRepeatMeetings,
    rotatingPeople: rotating.length, rotatingUniquePairs, rotatingEligiblePairs,
    rotatingMinimumTeammates: rotating.length ? Math.min(...rotatingDegrees) : 0,
    rotatingMaximumTeammates: rotating.length ? Math.max(...rotatingDegrees) : 0,
    rotatingAverageTeammates: rotating.length ? rotatingUniquePairs * 2 / rotating.length : 0,
    rotatingSumSquaredTeammates: rotatingDegrees.reduce((sum, degree) => sum + degree ** 2, 0),
    rotatingCoverage: rotatingEligiblePairs ? rotatingUniquePairs / rotatingEligiblePairs : 1,
    rotatingRepeatMeetings: repeatMeetings - fixedRepeatMeetings,
    minimumTeammates: Math.min(...people.map((person) => person.uniqueCount)),
    maximumTeammates: Math.max(...people.map((person) => person.uniqueCount)),
    averageTeammates, sumSquaredTeammates,
    variance: Math.max(0, sumSquaredTeammates / n - averageTeammates ** 2),
    distribution: [...frequencies].sort(([a], [b]) => a - b).map(([teammates, count]) => ({ teammates, people: count })),
    people, rounds,
  };
}

export function getPersonSummary(assignments, n, id, config) {
  integer(id, 1, n, '成员编号', 'Member ID');
  return analyzeSchedule(assignments, n, config).people[id - 1];
}

export function defaultNames(n) {
  integer(n, LIMITS.minPeople, LIMITS.maxPeople, '总人数', 'Total number of people');
  return Array.from({ length: n }, (_, i) => `${i + 1}号`);
}

export function parseNames(text, n) {
  integer(n, LIMITS.minPeople, LIMITS.maxPeople, '总人数', 'Total number of people');
  if (typeof text !== 'string') throw domainError('请按每行一人的格式输入姓名。', 'Enter names as text, with one person per line.');
  const names = text.split(/\r\n?|\n/u).map((name) => name.trim()).filter(Boolean);
  if (names.length !== n) throw domainError(`请填写恰好 ${n} 位同学，当前为 ${names.length} 位。`, `Enter exactly ${n} names; ${names.length} were provided.`);
  const tooLong = names.findIndex((name) => Array.from(name).length > 20);
  if (tooLong !== -1) throw domainError(`第 ${tooLong + 1} 位同学的姓名不能超过 20 个字符。`, `The name for person ${tooLong + 1} cannot exceed 20 characters.`);
  return names;
}

function squaredCoverage(metrics) {
  if (Number.isFinite(metrics.rotatingSumSquaredTeammates)) return metrics.rotatingSumSquaredTeammates;
  if (Number.isFinite(metrics.sumSquaredTeammates)) return metrics.sumSquaredTeammates;
  if (metrics.people) return metrics.people.reduce((sum, person) => sum + person.uniqueCount ** 2, 0);
  return metrics.distribution.reduce((sum, row) => sum + row.teammates ** 2 * row.people, 0);
}

/** 正式目标包含个人最小覆盖、不同搭档总数、覆盖离散程度。 */
export function compareMetrics(a, b, objective = 'fair') {
  if (!['fair', 'coverage'].includes(objective)) throw domainError('无效的比较目标。', 'The comparison objective is invalid.');
  const minimum = (metrics) => metrics.rotatingMinimumTeammates ?? metrics.minimumTeammates;
  const unique = (metrics) => metrics.rotatingUniquePairs ?? metrics.uniquePairs;
  const minDifference = minimum(a) - minimum(b);
  const uniqueDifference = unique(a) - unique(b);
  return (objective === 'fair' ? minDifference || uniqueDifference : uniqueDifference || minDifference)
    || squaredCoverage(b) - squaredCoverage(a);
}

function rngFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function pairMeetingsFor(n, k) {
  return balancedSizes(n, k).reduce((sum, size) => sum + size * (size - 1) / 2, 0);
}

function boundsFor(config) {
  const n = config.people;
  const context = typeContext(config);
  const smallestK = effectiveAutomaticCounts(config, context)[0];
  const rotatingCount = context.rotatingIds.length;
  const maxPairs = config.groupCounts.reduce((sum, k) => sum + pairMeetingsFor(n, k ?? smallestK) - context.fixedPairs, 0);
  const personalCap = !rotatingCount ? 0 : config.typeMode === 'within' ? Math.min(...context.counts.filter((count) => count > 0)) - 1 : rotatingCount - 1;
  let minUpper = rotatingCount ? Math.min(personalCap, Math.floor(2 * maxPairs / rotatingCount)) : 0;
  if (config.rounds === 1 && rotatingCount) {
    const rotatingGroups = (config.groupCounts[0] ?? smallestK) - context.fixedGroups.length;
    minUpper = Math.min(personalCap, Math.floor(rotatingCount / rotatingGroups) - 1);
  }
  const rotatingUniquePairsUpperBound = Math.min(context.rotatingEligiblePairs, maxPairs);
  return { uniquePairsUpperBound: context.fixedPairs + rotatingUniquePairsUpperBound, minTeammatesUpperBound: minUpper, rotatingUniquePairsUpperBound };
}

function meetsProof(metrics, bounds, context) {
  if (metrics.uniquePairs === context.fixedPairs + context.rotatingEligiblePairs) return true;
  const people = context.rotatingIds.length;
  const total = metrics.rotatingUniquePairs * 2;
  const low = people ? Math.floor(total / people) : 0;
  const highCount = people ? total % people : 0;
  const minimumSquares = (people - highCount) * low ** 2 + highCount * (low + 1) ** 2;
  return metrics.uniquePairs === bounds.uniquePairsUpperBound
    && metrics.rotatingMinimumTeammates === bounds.minTeammatesUpperBound
    && metrics.rotatingSumSquaredTeammates === minimumSquares;
}

function proofFor(config, metrics) {
  const bounds = boundsFor(config);
  const context = typeContext(config);
  const fullyEligible = metrics.uniquePairs === metrics.eligiblePairs;
  const optimal = meetsProof(metrics, bounds, context);
  return {
    optimal,
    label: optimal ? '已证明覆盖目标最优' : '预算内找到的最佳方案',
    labelEn: optimal ? 'Proven optimal for the coverage objectives' : 'Best solution found within the search budget',
    reason: optimal
      ? (metrics.rotatingPeople === 0
        ? '所有同学都在固定小组中，每次作业完整保留这些小组；没有需要轮换的成员，当前约束下的合作关系已全部覆盖。'
        : fullyEligible && config.fixedGroups.length
        ? '固定小组完整保留，轮换成员已覆盖固定边界与类型规则允许的全部合作关系；轮换成员的最小覆盖、总覆盖与公平度均已最优。此证明不包含重复碰面次数最少。'
        : fullyEligible && config.typeMode === 'within'
        ? '每个人都已与同类型的其余全部同学合作；同类组队限制下的个人最小覆盖、总覆盖与覆盖公平度均已最优。此证明不包含重复碰面次数最少。'
        : metrics.uniquePairs === metrics.possiblePairs
        ? '每个人都已与其余全部同学合作；个人最小覆盖、总覆盖与覆盖公平度都达到理论最优。此证明不包含重复碰面次数最少。'
        : `${config.fixedGroups.length ? '轮换成员的' : '个人'}最小覆盖和不同搭档总数都达到当前约束下的有效上界，覆盖离散程度也达到整数理论下界。此证明不包含重复碰面次数最少。`)
      : '当前方案满足全部分组约束，但尚未取得全局最优证明；更长搜索或不同种子可能找到更好的方案。',
    reasonEn: optimal
      ? (metrics.rotatingPeople === 0
        ? 'Everyone belongs to a fixed group, and these groups remain intact in every assignment. There are no rotating members, and all cooperation relationships permitted by the current constraints are covered.'
        : fullyEligible && config.fixedGroups.length
        ? 'The fixed groups remain intact, and rotating members have covered every cooperation relationship permitted by the fixed-group boundaries and type rules. Their minimum coverage, total coverage and coverage balance are optimal. This does not prove that repeat meetings are minimized.'
        : fullyEligible && config.typeMode === 'within'
        ? 'Everyone has worked with every other person of the same type. Minimum individual coverage, total coverage and coverage balance are optimal under the within-type restriction. This does not prove that repeat meetings are minimized.'
        : metrics.uniquePairs === metrics.possiblePairs
        ? 'Everyone has worked with every other person. Minimum individual coverage, total coverage and coverage balance have all reached their theoretical optima. This does not prove that repeat meetings are minimized.'
        : `${config.fixedGroups.length ? 'The minimum coverage of rotating members' : 'Minimum individual coverage'} and the number of distinct teammate pairs have reached valid upper bounds under the current constraints. Coverage dispersion has also reached its integer lower bound. This does not prove that repeat meetings are minimized.`)
      : 'This solution satisfies all grouping constraints, but global optimality has not been proved. A longer search or a different seed may find a better solution.',
    ...bounds,
  };
}

export function evaluateProof(assignments, config) {
  const normalized = validateConfig(config);
  validateSchedule(assignments, normalized.people, normalized);
  return proofFor(normalized, analyzeSchedule(assignments, normalized.people, normalized));
}

function createState(n, context) {
  return { n, context, counts: new Uint16Array(n * n), degrees: new Int16Array(n), uniquePairs: 0, meetings: 0, squares: 0, minimum: 0, rotatingUniquePairs: 0, rotatingSquares: 0, rotatingMinimum: 0 };
}

function changePair(state, a, b, direction) {
  const index = a * state.n + b;
  const previous = state.counts[index];
  state.counts[index] += direction;
  state.counts[b * state.n + a] += direction;
  state.meetings += direction;
  const degreeChange = direction === 1 ? Number(previous === 0) : -Number(previous === 1);
  if (degreeChange) {
    state.uniquePairs += degreeChange;
    const squareChange = 2 * degreeChange * (state.degrees[a] + state.degrees[b]) + 2;
    state.squares += squareChange;
    if (state.context.fixedGroupIndex[a] === -1) { state.rotatingUniquePairs += degreeChange; state.rotatingSquares += squareChange; }
    state.degrees[a] += degreeChange;
    state.degrees[b] += degreeChange;
  }
}

function changeRound(state, round, direction) {
  for (const group of round) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) changePair(state, group[i], group[j], direction);
    }
  }
  state.minimum = Math.min(...state.degrees);
  state.rotatingMinimum = state.context.rotatingIds.length ? Math.min(...state.context.rotatingIds.map((id) => state.degrees[id])) : 0;
}

function stateMetrics(state) {
  return { minimumTeammates: state.minimum, uniquePairs: state.uniquePairs, sumSquaredTeammates: state.squares, repeatMeetings: state.meetings - state.uniquePairs,
    rotatingMinimumTeammates: state.rotatingMinimum, rotatingUniquePairs: state.rotatingUniquePairs, rotatingSumSquaredTeammates: state.rotatingSquares };
}

function cloneSchedule(schedule) { return schedule.map((round) => round.map((group) => [...group])); }

function typeSlots(state, k, random, totalGroups) {
  const { context } = state;
  const slots = Array.from({ length: k }, () => new Uint16Array(context.counts.length));
  if (context.mode === 'mix') {
    // 每类连续走过循环槽位：每类各组相差至多一人，全体也相差至多一人。
    const groupOrder = shuffle(Array.from({ length: k }, (_, i) => i), random);
    const typeOrder = shuffle(Array.from({ length: context.counts.length }, (_, i) => i), random);
    let cursor = 0;
    for (const type of typeOrder) {
      for (let i = 0; i < context.counts[type]; i += 1) {
        slots[groupOrder[cursor % k]][type] += 1;
        cursor += 1;
      }
    }
  } else {
    // c=q*t+b：每类组数 t 可取一个连续整数区间，据此精确配出总共 k 组。
    const small = Math.floor(state.n / totalGroups);
    const groupCounts = context.counts.map((count) => Math.ceil(count / (small + 1)));
    let remaining = k - groupCounts.reduce((sum, count) => sum + count, 0);
    const order = shuffle(Array.from({ length: context.counts.length }, (_, i) => i), random);
    for (const type of order) {
      const extra = Math.min(remaining, Math.floor(context.counts[type] / small) - groupCounts[type]);
      groupCounts[type] += extra;
      remaining -= extra;
    }
    let group = 0;
    for (const type of order) {
      const larger = context.counts[type] - small * groupCounts[type];
      for (let i = 0; i < groupCounts[type]; i += 1) {
        slots[group][type] = small + Number(i < larger);
        group += 1;
      }
    }
    shuffle(slots, random);
  }
  return slots;
}

function makeRound(state, k, random, variation) {
  const { context } = state;
  const fixed = context.fixedGroups.map((group) => [...group]);
  const rotatingGroups = k - fixed.length;
  if (rotatingGroups === 0) return fixed;
  const rotatingPeople = context.rotatingIds.length;
  const slots = context.mode === 'off' ? null : typeSlots(state, rotatingGroups, random, k);
  const smaller = Math.floor(rotatingPeople / rotatingGroups);
  const sizes = slots ? slots.map((group) => group.reduce((sum, count) => sum + count, 0))
    : Array.from({ length: rotatingGroups }, (_, i) => smaller + Number(i < rotatingPeople % rotatingGroups));
  const groups = sizes.map(() => []);
  const order = shuffle([...context.rotatingIds], random);
  if (variation % 3 !== 2) order.sort((a, b) => state.degrees[a] - state.degrees[b]);
  for (const person of order) {
    let best = -1;
    let bestCost = Infinity;
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[g];
      if (group.length >= sizes[g] || (slots && slots[g][state.context.ids[person]] === 0)) continue;
      let repeats = 0;
      let meetings = 0;
      for (const other of group) {
        const count = state.counts[person * state.n + other];
        if (count) repeats += 1;
        meetings += count;
      }
      const cost = 12 * repeats + 0.1 * meetings + 2 * group.length / sizes[g] + random() * (variation % 2 ? 1.5 : 0.1);
      if (cost < bestCost) { best = g; bestCost = cost; }
    }
    groups[best].push(person);
    if (slots) slots[best][state.context.ids[person]] -= 1;
  }
  return [...fixed, ...groups];
}

function pairRoundRobin(n, roundIndex, permutation) {
  // 偶数人数的循环赛：前 n−1 次作业每对同学恰好合作一次。
  const rotating = permutation.slice(1);
  const shift = roundIndex % (n - 1);
  const order = [permutation[0], ...rotating.slice(shift), ...rotating.slice(0, shift)];
  return Array.from({ length: n / 2 }, (_, i) => [order[i], order[n - 1 - i]]);
}

function attemptSwap(state, round, random, objective, scratch) {
  const { context } = state;
  const offset = context.fixedGroups.length;
  const rotatingGroups = round.length - offset;
  if (rotatingGroups < 2) return false;
  const aGroupIndex = offset + Math.floor(random() * rotatingGroups);
  let bGroupIndex = offset + Math.floor(random() * (rotatingGroups - 1));
  if (bGroupIndex >= aGroupIndex) bGroupIndex += 1;
  const aGroup = round[aGroupIndex];
  const bGroup = round[bGroupIndex];
  const aIndex = Math.floor(random() * aGroup.length);
  const bIndex = Math.floor(random() * bGroup.length);
  const a = aGroup[aIndex];
  const b = bGroup[bIndex];
  const aType = context.ids[a];
  const bType = context.ids[b];
  if (aType !== bType && context.mode === 'within') return false;
  if (aType !== bType && context.mode === 'mix') {
    const aLow = Math.floor(context.counts[aType] / rotatingGroups);
    const aHigh = Math.ceil(context.counts[aType] / rotatingGroups);
    const bLow = Math.floor(context.counts[bType] / rotatingGroups);
    const bHigh = Math.ceil(context.counts[bType] / rotatingGroups);
    const count = (group, type) => group.reduce((sum, person) => sum + Number(context.ids[person] === type), 0);
    if (count(aGroup, aType) - 1 < aLow || count(bGroup, aType) + 1 > aHigh
        || count(bGroup, bType) - 1 < bLow || count(aGroup, bType) + 1 > bHigh) return false;
  }
  const deltas = scratch;
  deltas.fill(0);
  let deltaPairs = 0;
  for (const other of aGroup) {
    if (other === a) continue;
    if (state.counts[a * state.n + other] === 1) { deltas[a] -= 1; deltas[other] -= 1; deltaPairs -= 1; }
    if (state.counts[b * state.n + other] === 0) { deltas[b] += 1; deltas[other] += 1; deltaPairs += 1; }
  }
  for (const other of bGroup) {
    if (other === b) continue;
    if (state.counts[b * state.n + other] === 1) { deltas[b] -= 1; deltas[other] -= 1; deltaPairs -= 1; }
    if (state.counts[a * state.n + other] === 0) { deltas[a] += 1; deltas[other] += 1; deltaPairs += 1; }
  }
  let minimum = state.n;
  let rotatingMinimum = state.n;
  let squares = state.squares;
  for (let id = 0; id < state.n; id += 1) {
    minimum = Math.min(minimum, state.degrees[id] + deltas[id]);
    if (context.fixedGroupIndex[id] === -1) rotatingMinimum = Math.min(rotatingMinimum, state.degrees[id] + deltas[id]);
    squares += 2 * state.degrees[id] * deltas[id] + deltas[id] ** 2;
  }
  const candidate = { minimumTeammates: minimum, uniquePairs: state.uniquePairs + deltaPairs, sumSquaredTeammates: squares,
    rotatingMinimumTeammates: rotatingMinimum, rotatingUniquePairs: state.rotatingUniquePairs + deltaPairs, rotatingSumSquaredTeammates: state.rotatingSquares + squares - state.squares };
  const comparison = compareMetrics(candidate, stateMetrics(state), objective);
  if (comparison < 0 || (comparison === 0 && random() > 0.15)) return false;
  for (const other of aGroup) {
    if (other !== a) { changePair(state, a, other, -1); changePair(state, b, other, 1); }
  }
  for (const other of bGroup) {
    if (other !== b) { changePair(state, b, other, -1); changePair(state, a, other, 1); }
  }
  aGroup[aIndex] = b;
  bGroup[bIndex] = a;
  state.minimum = minimum;
  state.rotatingMinimum = rotatingMinimum;
  return true;
}

/**
 * 多起点、逐轮构造与同轮换人搜索。自动组数也是搜索变量。
 * 同种子与固定 maxIterations 可复验；真实时间截止保护较慢设备。
 */
export function solveSchedule(rawConfig, options = {}) {
  const config = validateConfig(rawConfig);
  const { timeBudgetMs = 4000, onProgress, maxIterations } = options;
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 30000) throw domainError('搜索预算须为 1 至 30000 毫秒。', 'The search time budget must be between 1 and 30000 milliseconds.');
  if (maxIterations != null) integer(maxIterations, 0, 10000000, '最大迭代次数', 'Maximum iteration count');
  if (onProgress != null && typeof onProgress !== 'function') throw domainError('进度回调须为函数。', 'The progress callback must be a function.');
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const started = now();
  const deadline = started + timeBudgetMs;
  const random = rngFrom(config.seed);
  const n = config.people;
  const context = typeContext(config);
  const allowedK = effectiveAutomaticCounts(config, context);
  const smallestK = allowedK[0];
  const scratch = new Int16Array(n);
  // 固定工作量限额便于复验；初始化计入搜索预算，到期后完成有界结果校验。
  const iterationLimit = maxIterations ?? Math.min(10000000, Math.max(300, Math.floor(timeBudgetMs * 240000 / (n + 30))));
  let iterations = 0;
  let lastProgress = started;
  let bestSchedule;
  let bestMetrics;
  let work = 0;
  let timeLimitReached = false;
  const fullPairs = context.fixedPairs + context.rotatingEligiblePairs;
  const upperBounds = boundsFor(config);
  function proved(metrics) {
    return meetsProof(metrics, upperBounds, context);
  }
  function expired() {
    if (now() >= deadline) { timeLimitReached = true; return true; }
    return iterations >= iterationLimit;
  }
  function record(schedule, state) {
    const metrics = stateMetrics(state);
    const comparison = bestMetrics ? compareMetrics(metrics, bestMetrics, config.objective) : 1;
    if (comparison > 0 || (comparison === 0 && metrics.repeatMeetings < bestMetrics.repeatMeetings)) {
      bestSchedule = cloneSchedule(schedule);
      bestMetrics = metrics;
    }
    const current = now();
    if (onProgress && current - lastProgress >= 200) {
      onProgress({ iterations, elapsedMs: Math.round(current - started), best: { ...bestMetrics }, groupCounts: bestSchedule.map((round) => round.length) });
      lastProgress = current;
    }
  }
  const automaticRounds = config.groupCounts.map((k, i) => k === null ? i : -1).filter((i) => i >= 0);
  const allPairs = n % 2 === 0 && config.groupCounts.every((k) => k === n / 2 || (k === null && allowedK.length === 1 && allowedK[0] === n / 2))
    && (config.typeMode === 'off' || context.counts.filter((count) => count > 0).length <= 1);
  let schedule = [];
  let state = createState(n, context);
  const initialPermutation = shuffle([...context.rotatingIds], random);
  for (let r = 0; r < config.rounds; r += 1) {
    const round = allPairs
      ? [...context.fixedGroups.map((group) => [...group]), ...(initialPermutation.length ? pairRoundRobin(initialPermutation.length, r, initialPermutation) : [])]
      : makeRound(state, config.groupCounts[r] ?? smallestK, random, 0);
    schedule.push(round);
    changeRound(state, round, 1);
  }
  record(schedule, state);
  // 单轮与标准循环赛构造已达到有效上界，无需随机搜索。
  if (config.rounds > 1 && !allPairs && !proved(bestMetrics)) {
    let start = 0;
    let stagnation = 0;
    const localLength = Math.max(250, n * config.rounds * 3);
    while (!expired()) {
      const previous = stateMetrics(state);
      for (let step = 0; step < localLength && !expired(); step += 1) {
        iterations += 1;
        const r = Math.floor(random() * config.rounds);
        attemptSwap(state, schedule[r], random, config.objective, scratch);
        if (step % 64 === 0) record(schedule, state);
      }
      record(schedule, state);
      if (bestMetrics.uniquePairs === fullPairs || proved(bestMetrics)) break;
      if (expired()) break;
      if (compareMetrics(stateMetrics(state), previous, config.objective) > 0) stagnation = 0;
      else stagnation += 1;
      // 逐轮重新分组时同时探索合法组数。
      const r = automaticRounds.length && work % 2 === 0
        ? automaticRounds[Math.floor(random() * automaticRounds.length)]
        : Math.floor(random() * config.rounds);
      const original = schedule[r];
      const before = stateMetrics(state);
      let k = config.groupCounts[r];
      if (k === null) {
        const position = allowedK.indexOf(original.length);
        k = work % 4 < 2
          ? allowedK[Math.max(0, Math.min(allowedK.length - 1, position + (random() < 0.5 ? -1 : 1)))]
          : allowedK[Math.floor(random() * allowedK.length)];
      }
      changeRound(state, original, -1);
      const replacement = makeRound(state, k, random, start + work + 1);
      changeRound(state, replacement, 1);
      iterations += 1;
      if (compareMetrics(stateMetrics(state), before, config.objective) >= 0) {
        schedule[r] = replacement;
      } else {
        changeRound(state, replacement, -1);
        changeRound(state, original, 1);
      }
      work += 1;
      record(schedule, state);
      if (stagnation >= 2 && !expired()) {
        // 新起点与历史最好方案交替，越过局部最优。
        start += 1;
        state = createState(n, context);
        if (start % 2 === 0) {
          schedule = cloneSchedule(bestSchedule);
          schedule.forEach((round) => changeRound(state, round, 1));
          const r2 = Math.floor(random() * config.rounds);
          changeRound(state, schedule[r2], -1);
          schedule[r2] = makeRound(state, schedule[r2].length, random, start);
          changeRound(state, schedule[r2], 1);
        } else {
          schedule = [];
          for (let roundIndex = 0; roundIndex < config.rounds; roundIndex += 1) {
            const specified = config.groupCounts[roundIndex];
            const k2 = specified ?? (random() < 0.7 ? smallestK : allowedK[Math.floor(random() * Math.min(4, allowedK.length))]);
            const round = makeRound(state, k2, random, start);
            schedule.push(round);
            changeRound(state, round, 1);
          }
        }
        stagnation = 0;
        record(schedule, state);
      }
    }
  }
  const assignments = bestSchedule.map((round) => round.map((group) => group.map((id) => id + 1).sort((a, b) => a - b)));
  const metrics = analyzeSchedule(assignments, n, config);
  if (metrics.uniquePairs !== bestMetrics.uniquePairs
      || metrics.minimumTeammates !== bestMetrics.minimumTeammates
      || metrics.sumSquaredTeammates !== bestMetrics.sumSquaredTeammates
      || metrics.rotatingUniquePairs !== bestMetrics.rotatingUniquePairs
      || metrics.rotatingMinimumTeammates !== bestMetrics.rotatingMinimumTeammates
      || metrics.rotatingSumSquaredTeammates !== bestMetrics.rotatingSumSquaredTeammates
      || metrics.repeatMeetings !== bestMetrics.repeatMeetings) throw domainError('分组统计校验失败，请重新计算。', 'The grouping statistics failed verification. Please solve again.');
  return {
    config, assignments, metrics, proof: proofFor(config, metrics),
    search: { seed: config.seed, iterations, elapsedMs: Math.round(now() - started), timeLimitReached, workLimitReached: iterations >= iterationLimit },
  };
}
