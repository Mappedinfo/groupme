/** 纯浏览器分组内核。编号从 1 开始；指标均由实际同组关系计算。 */
export const LIMITS = Object.freeze({ minPeople: 6, maxPeople: 300, minRounds: 1, maxRounds: 30 });

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}须为 ${min} 至 ${max} 之间的整数。`);
  return value;
}

export function balancedSizes(n, k) {
  integer(n, LIMITS.minPeople, LIMITS.maxPeople, '总人数');
  integer(k, 3, Math.floor(n / 2), '组数');
  const small = Math.floor(n / k);
  return Array.from({ length: k }, (_, i) => small + Number(i < n % k));
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('请提供有效的分组设置。');
  const people = integer(config.people, LIMITS.minPeople, LIMITS.maxPeople, '总人数');
  const rounds = integer(config.rounds, LIMITS.minRounds, LIMITS.maxRounds, '作业次数');
  const rawCounts = config.groupCounts ?? Array(rounds).fill(null);
  if (!Array.isArray(rawCounts) || rawCounts.length !== rounds) throw new Error('请为每次作业提供一个组数或自动选项。');
  const groupCounts = Array.from(rawCounts, (k) => k === null ? null : integer(k, 3, Math.floor(people / 2), '每次作业的组数'));
  const objective = config.objective ?? 'fair';
  if (!['fair', 'coverage'].includes(objective)) throw new Error('请选择公平优先或覆盖优先。');
  const seed = config.seed ?? 1;
  integer(seed, 0, 0xffffffff, '随机种子');
  return { people, rounds, groupCounts, objective, seed: seed >>> 0 };
}

export function validateSchedule(assignments, n, config) {
  integer(n, LIMITS.minPeople, LIMITS.maxPeople, '总人数');
  if (!Array.isArray(assignments) || assignments.length < 1 || assignments.length > LIMITS.maxRounds) throw new Error(`作业次数须为 1 至 ${LIMITS.maxRounds}。`);
  const normalized = config ? validateConfig(config) : null;
  if (normalized && (normalized.people !== n || normalized.rounds !== assignments.length)) throw new Error('分组与总人数或作业次数不一致。');
  for (let r = 0; r < assignments.length; r += 1) {
    const round = assignments[r];
    if (!Array.isArray(round)) throw new Error(`作业 ${r + 1} 的分组无效。`);
    const expectedSizes = balancedSizes(n, round.length);
    if (normalized?.groupCounts[r] != null && normalized.groupCounts[r] !== round.length) throw new Error(`作业 ${r + 1} 的组数与设置不一致。`);
    if (round.some((group) => !Array.isArray(group))) throw new Error('每个小组须为成员列表。');
    const sizes = round.map((group) => group.length).sort((a, b) => b - a);
    if (sizes.some((size, i) => size !== expectedSizes[i])) throw new Error(`作业 ${r + 1} 必须均匀分组，每组至少两人，大小最多相差一人。`);
    const seen = new Set();
    for (const group of round) {
      for (const id of group) {
        integer(id, 1, n, '成员编号');
        if (seen.has(id)) throw new Error(`作业 ${r + 1} 的 ${id} 号同学重复出现。`);
        seen.add(id);
      }
    }
    if (seen.size !== n) throw new Error(`作业 ${r + 1} 必须包含全部 ${n} 位同学。`);
  }
  return true;
}

export function analyzeSchedule(assignments, n) {
  validateSchedule(assignments, n);
  const counts = new Uint16Array(n * n);
  const people = Array.from({ length: n }, (_, i) => ({ id: i + 1, teammates: [], uniqueCount: 0, rounds: [] }));
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
    return { groupCount: round.length, sizes: round.map((group) => group.length), uniqueNewPairs, pairMeetings };
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
  const averageTeammates = uniquePairs * 2 / n;
  return {
    uniquePairs, possiblePairs, repeatMeetings, repeatedPairs, coverage: uniquePairs / possiblePairs,
    minimumTeammates: Math.min(...people.map((person) => person.uniqueCount)),
    maximumTeammates: Math.max(...people.map((person) => person.uniqueCount)),
    averageTeammates, sumSquaredTeammates,
    variance: Math.max(0, sumSquaredTeammates / n - averageTeammates ** 2),
    distribution: [...frequencies].sort(([a], [b]) => a - b).map(([teammates, count]) => ({ teammates, people: count })),
    people, rounds,
  };
}

export function getPersonSummary(assignments, n, id) {
  integer(id, 1, n, '成员编号');
  return analyzeSchedule(assignments, n).people[id - 1];
}

export function defaultNames(n) {
  integer(n, LIMITS.minPeople, LIMITS.maxPeople, '总人数');
  return Array.from({ length: n }, (_, i) => `${i + 1}号`);
}

export function parseNames(text, n) {
  integer(n, LIMITS.minPeople, LIMITS.maxPeople, '总人数');
  if (typeof text !== 'string') throw new Error('请按每行一人的格式输入姓名。');
  const names = text.split(/\r\n?|\n/u).map((name) => name.trim()).filter(Boolean);
  if (names.length !== n) throw new Error(`请填写恰好 ${n} 位同学，当前为 ${names.length} 位。`);
  const tooLong = names.findIndex((name) => Array.from(name).length > 20);
  if (tooLong !== -1) throw new Error(`第 ${tooLong + 1} 位同学的姓名不能超过 20 个字符。`);
  return names;
}

function squaredCoverage(metrics) {
  if (Number.isFinite(metrics.sumSquaredTeammates)) return metrics.sumSquaredTeammates;
  if (metrics.people) return metrics.people.reduce((sum, person) => sum + person.uniqueCount ** 2, 0);
  return metrics.distribution.reduce((sum, row) => sum + row.teammates ** 2 * row.people, 0);
}

/** 正式目标包含个人最小覆盖、不同搭档总数、覆盖离散程度。 */
export function compareMetrics(a, b, objective = 'fair') {
  if (!['fair', 'coverage'].includes(objective)) throw new Error('无效的比较目标。');
  const first = objective === 'fair' ? 'minimumTeammates' : 'uniquePairs';
  const second = objective === 'fair' ? 'uniquePairs' : 'minimumTeammates';
  return a[first] - b[first] || a[second] - b[second] || squaredCoverage(b) - squaredCoverage(a);
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
  const maxPairs = config.groupCounts.reduce((sum, k) => sum + pairMeetingsFor(n, k ?? 3), 0);
  const possiblePairs = n * (n - 1) / 2;
  let minUpper = Math.min(n - 1, Math.floor(2 * maxPairs / n));
  if (config.rounds === 1) minUpper = Math.floor(n / (config.groupCounts[0] ?? 3)) - 1;
  return { uniquePairsUpperBound: Math.min(possiblePairs, maxPairs), minTeammatesUpperBound: minUpper };
}

function proofFor(config, metrics) {
  const bounds = boundsFor(config);
  const total = metrics.uniquePairs * 2;
  const low = Math.floor(total / config.people);
  const highCount = total % config.people;
  const minimumSquares = (config.people - highCount) * low ** 2 + highCount * (low + 1) ** 2;
  const optimal = metrics.uniquePairs === bounds.uniquePairsUpperBound
    && metrics.minimumTeammates === bounds.minTeammatesUpperBound
    && metrics.sumSquaredTeammates === minimumSquares;
  return {
    optimal,
    label: optimal ? '已证明覆盖目标最优' : '预算内找到的最佳方案',
    reason: optimal
      ? (metrics.uniquePairs === metrics.possiblePairs
        ? '每个人都已与其余全部同学合作；个人最小覆盖、总覆盖与覆盖公平度都达到理论最优。此证明不包含重复碰面次数最少。'
        : '个人最小覆盖和不同搭档总数都达到组数约束下的有效上界，覆盖离散程度也达到整数理论下界。此证明不包含重复碰面次数最少。')
      : '当前方案满足全部分组约束，但尚未取得全局最优证明；更长搜索或不同种子可能找到更好的方案。',
    ...bounds,
  };
}

export function evaluateProof(assignments, config) {
  const normalized = validateConfig(config);
  validateSchedule(assignments, normalized.people, normalized);
  return proofFor(normalized, analyzeSchedule(assignments, normalized.people));
}

function createState(n) {
  return { n, counts: new Uint16Array(n * n), degrees: new Int16Array(n), uniquePairs: 0, meetings: 0, squares: 0, minimum: 0 };
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
    state.squares += 2 * degreeChange * (state.degrees[a] + state.degrees[b]) + 2;
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
}

function stateMetrics(state) {
  return { minimumTeammates: state.minimum, uniquePairs: state.uniquePairs, sumSquaredTeammates: state.squares, repeatMeetings: state.meetings - state.uniquePairs };
}

function cloneSchedule(schedule) { return schedule.map((round) => round.map((group) => [...group])); }

function makeRound(state, k, random, variation) {
  const sizes = balancedSizes(state.n, k);
  const groups = sizes.map(() => []);
  const order = shuffle(Array.from({ length: state.n }, (_, id) => id), random);
  if (variation % 3 !== 2) order.sort((a, b) => state.degrees[a] - state.degrees[b]);
  for (const person of order) {
    let best = -1;
    let bestCost = Infinity;
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[g];
      if (group.length >= sizes[g]) continue;
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
  }
  return groups;
}

function pairRoundRobin(n, roundIndex, permutation) {
  // 偶数人数的循环赛：前 n−1 次作业每对同学恰好合作一次。
  const rotating = permutation.slice(1);
  const shift = roundIndex % (n - 1);
  const order = [permutation[0], ...rotating.slice(shift), ...rotating.slice(0, shift)];
  return Array.from({ length: n / 2 }, (_, i) => [order[i], order[n - 1 - i]]);
}

function attemptSwap(state, round, random, objective, scratch) {
  const aGroupIndex = Math.floor(random() * round.length);
  let bGroupIndex = Math.floor(random() * (round.length - 1));
  if (bGroupIndex >= aGroupIndex) bGroupIndex += 1;
  const aGroup = round[aGroupIndex];
  const bGroup = round[bGroupIndex];
  const aIndex = Math.floor(random() * aGroup.length);
  const bIndex = Math.floor(random() * bGroup.length);
  const a = aGroup[aIndex];
  const b = bGroup[bIndex];
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
  let squares = state.squares;
  for (let id = 0; id < state.n; id += 1) {
    minimum = Math.min(minimum, state.degrees[id] + deltas[id]);
    squares += 2 * state.degrees[id] * deltas[id] + deltas[id] ** 2;
  }
  const candidate = { minimumTeammates: minimum, uniquePairs: state.uniquePairs + deltaPairs, sumSquaredTeammates: squares };
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
  return true;
}

/**
 * 多起点、逐轮构造与同轮换人搜索。自动组数也是搜索变量。
 * 同种子与固定 maxIterations 可复验；真实时间截止保护较慢设备。
 */
export function solveSchedule(rawConfig, options = {}) {
  const config = validateConfig(rawConfig);
  const { timeBudgetMs = 4000, onProgress, maxIterations } = options;
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 30000) throw new Error('搜索预算须为 1 至 30000 毫秒。');
  if (maxIterations != null) integer(maxIterations, 0, 10000000, '最大迭代次数');
  if (onProgress != null && typeof onProgress !== 'function') throw new Error('进度回调须为函数。');
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const started = now();
  const deadline = started + timeBudgetMs;
  const random = rngFrom(config.seed);
  const n = config.people;
  const scratch = new Int16Array(n);
  // 固定工作量限额便于复验；初始化计入搜索预算，到期后完成有界结果校验。
  const iterationLimit = maxIterations ?? Math.min(10000000, Math.max(300, Math.floor(timeBudgetMs * 240000 / (n + 30))));
  let iterations = 0;
  let lastProgress = started;
  let bestSchedule;
  let bestMetrics;
  let work = 0;
  let timeLimitReached = false;
  const fullPairs = n * (n - 1) / 2;
  const upperBounds = boundsFor(config);
  function proved(metrics) {
    const total = metrics.uniquePairs * 2;
    const low = Math.floor(total / n);
    const extra = total % n;
    return metrics.uniquePairs === upperBounds.uniquePairsUpperBound
      && metrics.minimumTeammates === upperBounds.minTeammatesUpperBound
      && metrics.sumSquaredTeammates === (n - extra) * low ** 2 + extra * (low + 1) ** 2;
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
  const allPairs = n % 2 === 0 && config.groupCounts.every((k) => k === n / 2);
  let schedule = [];
  let state = createState(n);
  const initialPermutation = shuffle(Array.from({ length: n }, (_, id) => id), random);
  for (let r = 0; r < config.rounds; r += 1) {
    const round = allPairs ? pairRoundRobin(n, r, initialPermutation) : makeRound(state, config.groupCounts[r] ?? 3, random, 0);
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
        const maximum = Math.floor(n / 2);
        k = work % 4 < 2
          ? Math.max(3, Math.min(maximum, original.length + (random() < 0.5 ? -1 : 1)))
          : 3 + Math.floor(random() * (maximum - 2));
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
        state = createState(n);
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
            const k2 = specified ?? (random() < 0.7 ? 3 : 3 + Math.floor(random() * Math.min(4, Math.floor(n / 2) - 2)));
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
  const metrics = analyzeSchedule(assignments, n);
  if (metrics.uniquePairs !== bestMetrics.uniquePairs
      || metrics.minimumTeammates !== bestMetrics.minimumTeammates
      || metrics.sumSquaredTeammates !== bestMetrics.sumSquaredTeammates
      || metrics.repeatMeetings !== bestMetrics.repeatMeetings) throw new Error('分组统计校验失败，请重新计算。');
  return {
    config, assignments, metrics, proof: proofFor(config, metrics),
    search: { seed: config.seed, iterations, elapsedMs: Math.round(now() - started), timeLimitReached, workLimitReached: iterations >= iterationLimit },
  };
}
