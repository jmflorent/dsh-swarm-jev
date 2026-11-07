/**
 * Objective engine state machine.
 *
 * Records are folded from an append-only journal and every mutation appends
 * before it becomes visible, so a restart reconstructs the same state. The
 * engine is deliberately small: objectives, progress items (work orders and
 * status reports), verifications, advisory classification tags, and wakeups.
 * It never performs work itself — it tracks and drives an orchestrator session.
 */
import { randomUUID } from 'node:crypto'
import { createAppender, loadJournal } from './journal.js'

const VERSION = 1
const STATE = new Set(['queued', 'active', 'blocked', 'completed', 'cancelled'])
const WAKE_REASONS = new Set(['idle', 'timer', 'child-end', 'resume', 'queue'])

export const DEFAULTS = Object.freeze({
  enabled: true,
  maxActiveObjectives: 3,
  maxQueuedObjectives: 16,
  maxRoundsPerObjective: 12,
  progressIntervalMs: 45000,
  minWakeGapMs: 8000,
  tickMs: 20000,
  maxTags: 50,
  classification: { enabled: true },
})

const clone = (value) => JSON.parse(JSON.stringify(value))
const positiveInt = (value, fallback, max) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), max)
}
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const id = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`
const nowIso = (now) => new Date(now()).toISOString()

/** Fold one journal event into the live state. */
const fold = (state, event) => {
  const data = event.data ?? {}
  switch (event.type) {
    case 'engine/boot':
      state.paused = true
      state.pausedReason = typeof data.reason === 'string' ? data.reason : 'boot'
      state.bootedAt = event.at
      break
    case 'engine/paused':
      state.paused = data.paused === true
      state.pausedReason = typeof data.reason === 'string' ? data.reason : undefined
      break
    case 'objective/upsert':
      if (data.objective !== undefined) {
        state.objectives.set(data.objective.id, data.objective)
        if (typeof data.idempotencyKey === 'string' && data.idempotencyKey !== '') {
          state.idempotency.set(data.idempotencyKey, data.objective.id)
        }
      }
      break
    case 'progress/upsert':
      if (data.item !== undefined) state.progress.set(data.item.id, data.item)
      break
    case 'verification/recorded':
      if (data.verification !== undefined) {
        state.verifications.push(data.verification)
        while (state.verifications.length > 200) state.verifications.shift()
      }
      break
    case 'tag/recorded':
      if (data.tag !== undefined) {
        state.tags.push(data.tag)
        while (state.tags.length > 50) state.tags.shift()
      }
      break
    case 'wake/recorded':
      if (data.wake !== undefined) {
        state.wakes.push(data.wake)
        while (state.wakes.length > 200) state.wakes.shift()
        state.lastWakeAt.set(data.wake.sessionId, Date.parse(data.wake.at))
      }
      break
    default:
      break
  }
}

const objectiveView = (state, objective) => {
  const items = [...state.progress.values()].filter((item) => item.objectiveId === objective.id)
  return {
    ...clone(objective),
    progress: {
      total: items.length,
      ready: items.filter((item) => item.state === 'ready').length,
      reported: items.filter((item) => item.state === 'reported').length,
    },
  }
}

/**
 * Build the engine over one journal file.
 * @param {{config: object, journalFile: string, now?: () => number, onWorkAvailable?: (sessionId: string) => void}} options
 * @returns engine API used by tools and the pump.
 */
export const createEngine = ({ config, journalFile, now = Date.now, onWorkAvailable }) => {
  const settings = {
    enabled: config?.enabled !== false,
    maxActiveObjectives: positiveInt(config?.maxActiveObjectives, DEFAULTS.maxActiveObjectives, 64),
    maxQueuedObjectives: positiveInt(config?.maxQueuedObjectives, DEFAULTS.maxQueuedObjectives, 256),
    maxRoundsPerObjective: positiveInt(config?.maxRoundsPerObjective, DEFAULTS.maxRoundsPerObjective, 1000),
    progressIntervalMs: positiveInt(config?.progressIntervalMs, DEFAULTS.progressIntervalMs, 86_400_000),
    minWakeGapMs: positiveInt(config?.minWakeGapMs, DEFAULTS.minWakeGapMs, 3_600_000),
    tickMs: positiveInt(config?.tickMs, DEFAULTS.tickMs, 3_600_000),
    classification: { enabled: config?.classification?.enabled !== false },
  }
  const state = {
    objectives: new Map(),
    progress: new Map(),
    verifications: [],
    tags: [],
    wakes: [],
    idempotency: new Map(),
    lastWakeAt: new Map(),
    paused: true,
    pausedReason: 'boot',
    bootedAt: undefined,
  }

  const { events, repaired } = loadJournal(journalFile)
  for (const event of events) fold(state, event)
  const appender = createAppender(journalFile)
  let seq = events.length === 0 ? 0 : Number(events[events.length - 1].seq ?? events.length)
  const append = (type, data) => {
    seq += 1
    const event = { v: VERSION, seq, at: nowIso(now), type, data }
    appender.append(event)
    fold(state, event)
    return event
  }
  // Every process start begins paused: arming the driver is an explicit act.
  append('engine/boot', { reason: 'process-start', repaired })

  const fail = (code, message) => ({ ok: false, code, message })
  const ownerOf = (actor) => (typeof actor?.sessionId === 'string' && actor.sessionId !== '' ? actor.sessionId : undefined)
  const activeCount = () => [...state.objectives.values()].filter((objective) => objective.state === 'active').length
  const queuedCount = () => [...state.objectives.values()].filter((objective) => objective.state === 'queued').length
  const objectivesOf = (sessionId) => [...state.objectives.values()].filter((objective) => objective.owner.sessionId === sessionId)
  const view = (objective) => objectiveView(state, objective)
  const latestVerification = (objectiveId) => {
    const matches = state.verifications.filter((verification) => verification.objectiveId === objectiveId)
    return matches.length === 0 ? undefined : matches[matches.length - 1]
  }

  const promoteQueued = () => {
    const promoted = []
    for (const sessionId of new Set([...state.objectives.values()].map((objective) => objective.owner.sessionId))) {
      while (activeCount() < settings.maxActiveObjectives) {
        const next = [...state.objectives.values()]
          .filter((objective) => objective.owner.sessionId === sessionId && objective.state === 'queued')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
        if (next === undefined) break
        append('objective/upsert', {
          objective: { ...next, state: 'active', revision: next.revision + 1, updatedAt: nowIso(now) },
        })
        promoted.push(next.id)
      }
    }
    return promoted
  }

  const complete = (objectiveId, outcome, patch) => {
    const objective = state.objectives.get(objectiveId)
    if (objective === undefined) return fail('objective-not-found', `no objective ${objectiveId}`)
    append('objective/upsert', {
      objective: {
        ...objective,
        state: 'completed',
        revision: objective.revision + 1,
        updatedAt: nowIso(now),
        completedAt: nowIso(now),
        completion: { ...outcome, at: nowIso(now), ...(patch === undefined ? {} : patch) },
      },
    })
    const promoted = promoteQueued()
    return { ok: true, objective: view(state.objectives.get(objectiveId)), promoted }
  }

  const block = (objective, reason) => {
    append('objective/upsert', {
      objective: {
        ...objective,
        state: 'blocked',
        blockedReason: reason,
        revision: objective.revision + 1,
        updatedAt: nowIso(now),
      },
    })
  }

  const engine = {
    settings,
    config: settings,
    journalFile,
    state,
    get paused() {
      return state.paused
    },
    status: () => ({
      ok: true,
      engine: {
        paused: state.paused,
        // Tool outputs must be lossless JSON: omit empty optional keys entirely.
        ...(typeof state.pausedReason === 'string' ? { pausedReason: state.pausedReason } : {}),
        ...(typeof state.bootedAt === 'string' ? { bootedAt: state.bootedAt } : {}),
        enabled: settings.enabled,
        limits: {
          maxActiveObjectives: settings.maxActiveObjectives,
          maxQueuedObjectives: settings.maxQueuedObjectives,
          maxRoundsPerObjective: settings.maxRoundsPerObjective,
          progressIntervalMs: settings.progressIntervalMs,
          minWakeGapMs: settings.minWakeGapMs,
        },
        counts: {
          active: activeCount(),
          queued: queuedCount(),
          blocked: [...state.objectives.values()].filter((objective) => objective.state === 'blocked').length,
          completed: [...state.objectives.values()].filter((objective) => objective.state === 'completed').length,
          cancelled: [...state.objectives.values()].filter((objective) => objective.state === 'cancelled').length,
        },
        journal: journalFile,
        lastWakes: [...state.lastWakeAt.entries()].map(([sessionId, at]) => ({ sessionId, at: new Date(at).toISOString() })),
      },
      objectives: [...state.objectives.values()].map(view),
      progress: [...state.progress.values()].slice(-200),
      verifications: state.verifications.slice(-50),
      tags: state.tags.slice(-20),
      wakes: state.wakes.slice(-10),
    }),
    snapshot: () => ({
      paused: state.paused,
      counts: {
        active: activeCount(),
        queued: queuedCount(),
        blocked: [...state.objectives.values()].filter((objective) => objective.state === 'blocked').length,
        completed: [...state.objectives.values()].filter((objective) => objective.state === 'completed').length,
      },
      objectives: [...state.objectives.values()]
        .filter((objective) => objective.state === 'active' || objective.state === 'queued' || objective.state === 'blocked')
        .slice(-12)
        .map((objective) => ({
          id: objective.id,
          statement: objective.statement.slice(0, 240),
          state: objective.state,
          rounds: objective.budget.rounds.used,
          maxRounds: objective.budget.rounds.max,
          progress: [...state.progress.values()].filter((item) => item.objectiveId === objective.id).length,
        })),
    }),
    create: (input, actor) => {
      const statement = text(input?.statement, 4000)
      if (statement === '') return fail('statement-required', 'objective_create needs a non-empty statement')
      const criteria = Array.isArray(input?.criteria)
        ? input.criteria.map((entry) => text(entry, 1000)).filter((entry) => entry !== '')
        : []
      if (criteria.length === 0) return fail('criteria-required', 'objective_create needs at least one checkable criterion')
      const owner = ownerOf(actor)
      if (owner === undefined) return fail('no-session', 'objective_create must run inside an agent session')
      const idempotencyKey = text(input?.idempotencyKey, 200)
      if (idempotencyKey !== '' && state.idempotency.has(idempotencyKey)) {
        const existing = state.objectives.get(state.idempotency.get(idempotencyKey))
        if (existing !== undefined) return { ok: true, objective: view(existing), deduplicated: true }
      }
      if (activeCount() >= settings.maxActiveObjectives && queuedCount() >= settings.maxQueuedObjectives) {
        return fail('admission-full', 'active and queued objective limits are both full')
      }
      const roundLimit = positiveInt(input?.budgetRounds, settings.maxRoundsPerObjective, settings.maxRoundsPerObjective)
      const objective = {
        id: id('obj'),
        revision: 1,
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
        statement,
        criteria: criteria.map((criterion, index) => ({ id: `c${index + 1}`, statement: criterion })),
        priority: typeof input?.priority === 'number' && Number.isFinite(input.priority) ? input.priority : 0,
        state: activeCount() < settings.maxActiveObjectives ? 'active' : 'queued',
        owner: { sessionId: owner, ...(typeof actor?.preset === 'string' ? { preset: actor.preset } : {}) },
        budget: { rounds: { used: 0, max: roundLimit } },
      }
      append('objective/upsert', {
        objective,
        ...(idempotencyKey === '' ? {} : { idempotencyKey }),
      })
      if (objective.state === 'active') onWorkAvailable?.(owner)
      return { ok: true, objective: view(objective) }
    },
    plan: (input, actor) => {
      const objective = state.objectives.get(text(input?.objectiveId, 80))
      if (objective === undefined) return fail('objective-not-found', 'unknown objective')
      if (objective.state !== 'active') return fail('objective-not-active', `objective is ${objective.state}`)
      const description = text(input?.text, 2000)
      if (description === '') return fail('text-required', 'objective_plan needs text')
      const kind = input?.kind === 'status-report' || input?.kind === 'heartbeat' ? input.kind : 'work-order'
      const item = {
        id: id('itm'),
        objectiveId: objective.id,
        kind,
        text: description,
        state: kind === 'work-order' ? 'ready' : 'reported',
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
        ...(typeof actor?.sessionId === 'string' ? { by: actor.sessionId } : {}),
      }
      append('progress/upsert', { item })
      return { ok: true, item: clone(item) }
    },
    report: (input, actor) => {
      const objective = state.objectives.get(text(input?.objectiveId, 80))
      if (objective === undefined) return fail('objective-not-found', 'unknown objective')
      if (objective.state !== 'active') return fail('objective-not-active', `objective is ${objective.state}`)
      const progressId = text(input?.progressId, 80)
      const description = text(input?.text, 4000)
      if (progressId !== '') {
        const item = state.progress.get(progressId)
        if (item === undefined || item.objectiveId !== objective.id) return fail('progress-not-found', 'unknown progress item for this objective')
        if (description === '' && input?.state === undefined) return fail('text-required', 'objective_report needs text or state')
        const nextState = input?.state === 'failed' ? 'failed' : input?.state === 'ready' ? 'ready' : 'reported'
        const updated = {
          ...item,
          state: nextState,
          ...(description === '' ? {} : { text: description }),
          updatedAt: nowIso(now),
          ...(typeof actor?.sessionId === 'string' ? { by: actor.sessionId } : {}),
        }
        append('progress/upsert', { item: updated })
        return { ok: true, item: clone(updated) }
      }
      if (description === '') return fail('text-required', 'objective_report needs text')
      const item = {
        id: id('itm'),
        objectiveId: objective.id,
        kind: 'status-report',
        text: description,
        state: 'reported',
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
        ...(typeof actor?.sessionId === 'string' ? { by: actor.sessionId } : {}),
      }
      append('progress/upsert', { item })
      return { ok: true, item: clone(item) }
    },
    verdict: (input, actor) => {
      const objective = state.objectives.get(text(input?.objectiveId, 80))
      if (objective === undefined) return fail('objective-not-found', 'unknown objective')
      if (objective.state !== 'active') return fail('objective-not-active', `objective is ${objective.state}`)
      const verdict = input?.verdict
      if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'inconclusive') {
        return fail('verdict-invalid', 'verdict must be pass, fail, or inconclusive')
      }
      const evidence = text(input?.evidence, 4000)
      if (verdict !== 'inconclusive' && evidence === '') return fail('evidence-required', 'a verdict needs concrete evidence')
      const by = ownerOf(actor)
      if (by === undefined) return fail('no-session', 'objective_verify must run inside an agent session')
      if (by === objective.owner.sessionId) {
        return fail('self-verification', 'the objective owner cannot verify its own objective')
      }
      const verification = {
        id: id('ver'),
        objectiveId: objective.id,
        verdict,
        evidence,
        at: nowIso(now),
        by: { sessionId: by, ...(typeof actor?.preset === 'string' ? { preset: actor.preset } : {}) },
      }
      append('verification/recorded', { verification })
      return { ok: true, verification: clone(verification) }
    },
    complete: (input, actor) => {
      const objective = state.objectives.get(text(input?.objectiveId, 80))
      if (objective === undefined) return fail('objective-not-found', 'unknown objective')
      if (objective.state !== 'active') return fail('objective-not-active', `objective is ${objective.state}`)
      if (ownerOf(actor) !== objective.owner.sessionId) {
        return fail('not-owner', 'only the objective owner session may complete it')
      }
      if (typeof input?.expectedRevision === 'number' && input.expectedRevision !== objective.revision) {
        return fail('stale-revision', `objective is at revision ${objective.revision}`)
      }
      const verification = latestVerification(objective.id)
      if (verification === undefined || verification.verdict !== 'pass') {
        return fail('verification-required', 'an independent pass verdict is required before completion')
      }
      return complete(objective.id, { verificationId: verification.id, verifiedBy: verification.by.sessionId }, {
        ...(text(input?.note, 1000) === '' ? {} : { note: text(input?.note, 1000) }),
      })
    },
    completeVerified: (objectiveId, verificationId, note) => complete(objectiveId, { verificationId }, note === undefined ? undefined : { note }),
    cancel: (input, actor) => {
      const objective = state.objectives.get(text(input?.objectiveId, 80))
      if (objective === undefined) return fail('objective-not-found', 'unknown objective')
      if (objective.state !== 'active' && objective.state !== 'queued' && objective.state !== 'blocked') {
        return fail('objective-not-cancellable', `objective is ${objective.state}`)
      }
      if (ownerOf(actor) !== objective.owner.sessionId) {
        return fail('not-owner', 'only the objective owner session may cancel it')
      }
      const reason = text(input?.reason, 1000)
      append('objective/upsert', {
        objective: {
          ...objective,
          state: 'cancelled',
          revision: objective.revision + 1,
          updatedAt: nowIso(now),
          cancelledAt: nowIso(now),
          ...(reason === '' ? {} : { cancelReason: reason }),
        },
      })
      const promoted = promoteQueued()
      return { ok: true, objective: view(state.objectives.get(objective.id)), promoted }
    },
    pause: (reason) => {
      append('engine/paused', { paused: true, ...(text(reason, 500) === '' ? {} : { reason: text(reason, 500) }) })
      return { ok: true, paused: true }
    },
    resume: () => {
      append('engine/paused', { paused: false })
      return { ok: true, paused: false }
    },
    blockExhausted: (sessionId) => {
      let count = 0
      for (const objective of objectivesOf(sessionId)) {
        if (objective.state === 'active' && objective.budget.rounds.used >= objective.budget.rounds.max) {
          block(objective, 'budget-exhausted')
          count += 1
        }
      }
      return count
    },
    claimable: (sessionId) =>
      objectivesOf(sessionId)
        .filter((objective) => objective.state === 'active' && objective.budget.rounds.used < objective.budget.rounds.max)
        .sort((a, b) => a.budget.rounds.used - b.budget.rounds.used || a.createdAt.localeCompare(b.createdAt)),
    spendRound: (objectiveId) => {
      const objective = state.objectives.get(objectiveId)
      if (objective === undefined) return undefined
      if (objective.budget.rounds.used >= objective.budget.rounds.max) {
        block(objective, 'budget-exhausted')
        return undefined
      }
      const updated = {
        ...objective,
        budget: { rounds: { used: objective.budget.rounds.used + 1, max: objective.budget.rounds.max } },
        revision: objective.revision + 1,
        updatedAt: nowIso(now),
      }
      append('objective/upsert', { objective: updated })
      return updated
    },
    recordWake: ({ sessionId, objectiveId, reason }) => {
      if (!WAKE_REASONS.has(reason)) throw new Error(`unknown wake reason ${reason}`)
      const wake = {
        id: id('wke'),
        at: nowIso(now),
        sessionId,
        objectiveId,
        reason,
        round: state.objectives.get(objectiveId)?.budget.rounds.used ?? 0,
      }
      append('wake/recorded', { wake })
      return wake
    },
    lastWakeAt: (sessionId) => state.lastWakeAt.get(sessionId) ?? 0,
    owners: () => [...new Set([...state.objectives.values()]
      .filter((objective) => objective.state === 'active' || objective.state === 'queued')
      .map((objective) => objective.owner.sessionId))],
    hasOwner: (sessionId) => objectivesOf(sessionId).some((objective) => objective.state === 'active' || objective.state === 'queued'),
    activeCount,
    queuedCount,
    promoteQueued,
    markBlocked: (objectiveId, reason) => {
      const objective = state.objectives.get(objectiveId)
      if (objective !== undefined) block(objective, reason)
    },
    recentTag: (sessionId) => [...state.tags].reverse().find((tag) => tag.sessionId === sessionId),
    activeFor: (sessionId) => objectivesOf(sessionId).filter((objective) => objective.state === 'active'),
    recordTag: (tag) => append('tag/recorded', { tag }),
    close: () => appender.close(),
  }

  return engine
}
