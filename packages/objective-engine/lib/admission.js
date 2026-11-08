/**
 * Admission control and the overload model (design §6).
 *
 * Objective count is an admission bound, not a load bound: load is measured
 * from in-flight items, verifier backlog, dispatch rate, pending wakeups, and
 * token rate. Every gate returns a typed reason; nothing here mutates state.
 */
import { COUNTED_ACTIVE, nonNegativeInt, positiveInt, scopesOverlap, statementKey, unitInterval } from './records.js'

export const DEFAULT_LIMITS = Object.freeze({
  maxActiveObjectives: 3,
  maxQueuedObjectives: 32,
  maxObjectivesPerOwnerSession: 3,
  maxItemsPerObjective: 16,
  maxActiveItemsPerObjective: 2,
  maxInFlightItemsGlobal: 4,
  maxConcurrentVerifierRuns: 1,
  maxVerifierRunsPerObjective: 6,
  maxVerifierRunsPerObjectivePerDay: 6,
  maxDispatchesPerHour: 12,
  maxRoundsPerObjective: 12,
  maxTokensPerObjective: 2_000_000,
  maxWallTimePerObjective: 86_400_000,
  stallTimeoutMs: 1_800_000,
  maxConsecutiveWorkerFailures: 3,
  maxVerificationRejects: 2,
  maxVerificationInconclusives: 2,
  maxQueueAgeMs: 7 * 86_400_000,
  maxAckAgeMs: 7 * 86_400_000,
  ackReminderMs: 86_400_000,
  classificationCallsPerHour: 60,
  duplicateWindowMs: 86_400_000,
  agingStepMs: 6 * 3_600_000,
  agingCapMs: 86_400_000,
  tokenRateSoftLimit: 0.8,
})

export const DEFAULT_TIMING = Object.freeze({
  progressIntervalMs: 45_000,
  minWakeGapMs: 8_000,
  tickMs: 20_000,
  sweepMs: 60_000,
})

export const DEFAULT_CLASSIFICATION = Object.freeze({
  enabled: true,
  autoTag: true,
  objectiveProbability: 0.7,
  progressProbability: 0.6,
  choiceFloor: 0.35,
  confidenceFloor: 0.3,
  margin: 0.1,
  breakerFailures: 3,
  breakerCooldownMs: 300_000,
  maxActiveObjectivesInPrompt: 5,
})

export const DEFAULT_CHECKER = Object.freeze({
  execute: true,
  timeoutMs: 120_000,
  maxTimeoutMs: 3_600_000,
  maxOutputBytes: 64 * 1024,
})

/** Resolve the row config into validated settings with defaults. */
export const resolveSettings = (config = {}) => {
  const limits = {}
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    limits[name] = name === 'tokenRateSoftLimit' ? unitInterval(config[name], fallback) : positiveInt(config[name], fallback, Number.MAX_SAFE_INTEGER, name === 'maxQueuedObjectives' ? 0 : 1)
  }
  const timing = {}
  for (const [name, fallback] of Object.entries(DEFAULT_TIMING)) timing[name] = positiveInt(config[name], fallback, 86_400_000)
  const checker = {
    execute: config.checkerExecute !== false,
    timeoutMs: positiveInt(config.checkerTimeoutMs, DEFAULT_CHECKER.timeoutMs, DEFAULT_CHECKER.maxTimeoutMs),
    maxTimeoutMs: positiveInt(config.checkerMaxTimeoutMs, DEFAULT_CHECKER.maxTimeoutMs, 86_400_000),
    maxOutputBytes: positiveInt(config.checkerMaxOutputBytes, DEFAULT_CHECKER.maxOutputBytes, 1_048_576),
  }
  const classification = {}
  const rawClassification = config.classification ?? {}
  for (const [name, fallback] of Object.entries(DEFAULT_CLASSIFICATION)) {
    if (typeof fallback === 'boolean') classification[name] = rawClassification[name] !== false && (rawClassification[name] === undefined ? fallback : true)
    else if (fallback < 1 && fallback > 0) classification[name] = unitInterval(rawClassification[name], fallback)
    else classification[name] = positiveInt(rawClassification[name], fallback, Number.MAX_SAFE_INTEGER)
  }
  return {
    enabled: config.enabled !== false,
    limits,
    timing,
    checker,
    classification,
    allowAgentProposedObjectives: config.allowAgentProposedObjectives === true,
    requireHumanAuthority: config.requireHumanAuthority !== false,
    autoVerify: config.autoVerify === true,
    verifierPresets: Array.isArray(config.verifierPresets) && config.verifierPresets.length > 0 ? config.verifierPresets.map(String) : ['verifier', 'reviewer'],
    workerMaxDepth: nonNegativeInt(config.workerMaxDepth, 1, 4),
    subagentProvider: typeof config.subagentProvider === 'string' && config.subagentProvider !== '' ? config.subagentProvider : 'spawn',
    requireCommitPin: config.requireCommitPin === true,
    snapshotEvery: positiveInt(config.snapshotEvery, 128, 100_000),
  }
}

export const countedActive = (state) => [...state.objectives.values()].filter((objective) => COUNTED_ACTIVE.has(objective.state))
export const queued = (state) => [...state.objectives.values()].filter((objective) => objective.state === 'queued')
export const inFlightItems = (state, objectiveId) =>
  [...state.items.values()].filter((item) => item.state === 'dispatched' && (objectiveId === undefined || item.objectiveId === objectiveId))
export const verifierBacklog = (state) => [...state.verifications.values()].filter((verification) => verification.state === 'requested')
export const pendingWakes = (state) => [...state.wakes.values()].filter((wake) => wake.state === 'reserved')
const withinWindow = (timestamps, nowMs, windowMs) => timestamps.filter((at) => nowMs - Date.parse(at) < windowMs).length

/** Measured load tuple (design §6.4). */
export const loadSnapshot = (state, settings, nowMs, journalBytes = 0) => {
  const limits = settings.limits
  const load = {
    inFlightItems: inFlightItems(state).length,
    verifierQueueDepth: verifierBacklog(state).length,
    pendingWakeups: pendingWakes(state).length,
    dispatchRate1h: withinWindow(state.dispatches, nowMs, 3_600_000),
    verifierRate24h: state.verifierStarts.filter((entry) => nowMs - Date.parse(entry.at) < 86_400_000).length,
    journalBytes,
  }
  load.ratios = {
    inFlight: load.inFlightItems / limits.maxInFlightItemsGlobal,
    verifier: load.verifierQueueDepth / limits.maxConcurrentVerifierRuns,
    dispatch: load.dispatchRate1h / limits.maxDispatchesPerHour,
  }
  load.backpressure = load.ratios.inFlight >= 1 || load.ratios.verifier >= 1 || load.ratios.dispatch >= 1
  load.hot = Object.values(load.ratios).some((ratio) => ratio >= 0.9)
  return load
}

/** Admission gate for objective creation. Returns undefined when admitted. */
export const gateCreate = (state, settings, candidate, nowMs) => {
  const limits = settings.limits
  const owner = candidate.owner.sessionId
  const objectives = [...state.objectives.values()]
  const ownerOpen = objectives.filter((objective) => objective.owner.sessionId === owner && !['completed', 'cancelled'].includes(objective.state))
  if (ownerOpen.length >= limits.maxObjectivesPerOwnerSession) {
    return { code: 'admission-rejected', limit: 'maxObjectivesPerOwnerSession', current: ownerOpen.length }
  }
  const key = statementKey(owner, candidate.statement)
  const duplicate = objectives.find(
    (objective) => objective.statementKey === key && !['cancelled'].includes(objective.state) && nowMs - Date.parse(objective.createdAt) < limits.duplicateWindowMs,
  )
  if (duplicate !== undefined && candidate.allowDuplicate !== true) {
    return { code: 'duplicate-objective', existing: duplicate.id }
  }
  const conflicting = objectives.find((objective) => COUNTED_ACTIVE.has(objective.state) && scopesOverlap(objective.scope, candidate.scope))
  if (conflicting !== undefined) return { code: 'scope-conflict', existing: conflicting.id }
  const active = countedActive(state).length
  if (active < limits.maxActiveObjectives) return undefined
  const waiting = queued(state).length
  if (waiting < limits.maxQueuedObjectives) return { code: 'queue', current: active }
  return { code: 'admission-rejected', limit: 'maxQueuedObjectives', current: waiting }
}

/** Gate for adding an item to an objective. */
export const gateItem = (state, settings, objective) => {
  const count = [...state.items.values()].filter((item) => item.objectiveId === objective.id).length
  if (count >= objective.budget.items.max) return { code: 'budget-exhausted', counter: 'items', current: count }
  if (count >= settings.limits.maxItemsPerObjective) return { code: 'admission-rejected', limit: 'maxItemsPerObjective', current: count }
  return undefined
}

/** Gate for dispatching a work order. */
export const gateDispatch = (state, settings, objective, nowMs) => {
  const limits = settings.limits
  const perObjective = inFlightItems(state, objective.id).length
  if (perObjective >= objective.budget.concurrency.max) return { code: 'admission-busy', limit: 'concurrency', current: perObjective, retryAfterMs: settings.timing.minWakeGapMs }
  const global = inFlightItems(state).length
  if (global >= limits.maxInFlightItemsGlobal) return { code: 'admission-busy', limit: 'maxInFlightItemsGlobal', current: global, retryAfterMs: settings.timing.progressIntervalMs }
  const rate = withinWindow(state.dispatches, nowMs, 3_600_000)
  if (rate >= limits.maxDispatchesPerHour) return { code: 'admission-busy', limit: 'maxDispatchesPerHour', current: rate, retryAfterMs: 3_600_000 / limits.maxDispatchesPerHour }
  return undefined
}

/** Gate for starting a verifier run. */
export const gateVerification = (state, settings, objective, nowMs) => {
  const limits = settings.limits
  if (objective.budget.verifierRuns.used >= objective.budget.verifierRuns.max) {
    return { code: 'budget-exhausted', counter: 'verifierRuns', current: objective.budget.verifierRuns.used }
  }
  const backlog = verifierBacklog(state).length
  if (backlog >= limits.maxConcurrentVerifierRuns) return { code: 'admission-busy', limit: 'maxConcurrentVerifierRuns', current: backlog, retryAfterMs: settings.timing.progressIntervalMs }
  const perDay = state.verifierStarts.filter((entry) => entry.objectiveId === objective.id && nowMs - Date.parse(entry.at) < 86_400_000).length
  if (perDay >= limits.maxVerifierRunsPerObjectivePerDay) return { code: 'admission-rejected', limit: 'maxVerifierRunsPerObjectivePerDay', current: perDay }
  return undefined
}

/** Fairness ordering: priority (0 first) with aging, then createdAt; starvation cap. */
export const effectivePriority = (objective, settings, nowMs) => {
  const age = nowMs - Date.parse(objective.createdAt)
  const aged = Math.floor(age / settings.limits.agingStepMs)
  return Math.max(0, objective.priority - aged)
}
export const orderObjectives = (objectives, settings, nowMs) =>
  [...objectives].sort((a, b) => {
    const starvedA = nowMs - Date.parse(a.createdAt) >= settings.limits.agingCapMs
    const starvedB = nowMs - Date.parse(b.createdAt) >= settings.limits.agingCapMs
    if (starvedA !== starvedB) return starvedA ? -1 : 1
    const pa = effectivePriority(a, settings, nowMs)
    const pb = effectivePriority(b, settings, nowMs)
    if (pa !== pb) return pa - pb
    return a.createdAt.localeCompare(b.createdAt)
  })
