/**
 * Command transitions (design §4): one function per command, closed actor
 * sets, CAS on revisions, typed rejections. This module never imports the
 * classifier and never reads a proposal; the only writer of objective state
 * is `core.append`, called from here and from the engine lifecycle.
 */
import {
  COUNTED_ACTIVE,
  ITEM_KINDS,
  ITEM_TERMINAL,
  SCHEMA,
  TERMINAL_STATES,
  VERDICTS,
  clampText,
  clone,
  exhaustedCounter,
  isRecord,
  iso,
  makeBudget,
  mintId,
  normalizeCriteria,
  normalizeScope,
  positiveInt,
  statementKey,
} from './records.js'
import { countedActive, gateCreate, gateDispatch, gateItem, gateVerification, orderObjectives, queued as queuedObjectives } from './admission.js'

export const fail = (code, message, extra) => ({ ok: false, code, message, ...(extra ?? {}) })
const ok = (value) => ({ ok: true, ...value })

const bump = (record, nowMs) => ({ ...record, revision: record.revision + 1, updatedAt: iso(nowMs) })
const engineActor = { kind: 'engine' }

/** Items belonging to one objective. */
export const itemsOf = (state, objectiveId) => [...state.items.values()].filter((item) => item.objectiveId === objectiveId)
export const verificationsOf = (state, objectiveId) => [...state.verifications.values()].filter((verification) => verification.objectiveId === objectiveId)

/** Public, redacted view of an objective with progress counts. */
export const objectiveView = (state, objective) => {
  const items = itemsOf(state, objective.id)
  const counts = {}
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1
  const latest = verificationsOf(state, objective.id).slice(-1)[0]
  const { statementKey: _omit, ...rest } = objective
  return {
    ...clone(rest),
    items: { total: items.length, ...counts },
    ...(latest === undefined ? {} : { latestVerification: { id: latest.id, state: latest.state, advisory: latest.advisory, verdict: latest.verdict?.kind ?? null } }),
  }
}

const checkRevision = (record, expected) => {
  if (typeof expected === 'number' && expected !== record.revision) {
    return fail('stale-revision', `record ${record.id} is at revision ${record.revision}, not ${expected}`, { current: clone(record) })
  }
  return undefined
}

const closed = (objective) => TERMINAL_STATES.has(objective.state)
const loadObjective = (core, id) => {
  const objective = core.state.objectives.get(clampText(id, 80))
  if (objective === undefined) return { error: fail('objective-not-found', `no objective ${clampText(id, 80) || '(empty id)'}`) }
  return { objective }
}

/** Replay guard: same key + same payload returns the original result; a different payload conflicts. */
const replay = (core, key, payloadDigest) => {
  if (key === undefined) return undefined
  const seen = core.state.keys.get(key)
  if (seen === undefined) return undefined
  if (seen.digest === payloadDigest) return { replayed: true, seq: seen.seq }
  return { conflict: true, seq: seen.seq }
}

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

/** O1: create. `actor.human` decides whether the record is active or merely proposed. */
export const createObjective = (core, input, actor) => {
  const nowMs = core.now()
  const statement = clampText(input?.statement, 4000)
  if (statement === '') return fail('record-incomplete', 'objective_create needs a non-empty statement')
  const criteria = normalizeCriteria(input?.criteria)
  if (criteria.error !== undefined) return fail(criteria.code, criteria.error)
  if (typeof actor?.sessionId !== 'string' || actor.sessionId === '') return fail('unauthorized', 'objective_create must run inside an agent session')
  const key = clampText(input?.idempotencyKey, 200) || undefined
  const payloadDigest = core.digest({ statement, criteria: criteria.criteria, owner: actor.sessionId })
  const seen = replay(core, key, payloadDigest)
  if (seen?.replayed) {
    const existing = [...core.state.objectives.values()].find((objective) => objective.idempotencyKey === key)
    if (existing !== undefined) return ok({ objective: objectiveView(core.state, existing), replayed: true })
  }
  if (seen?.conflict) return fail('idempotency-conflict', `idempotency key ${key} was used with a different payload`)

  const human = actor.human === true
  if (!human && core.settings.requireHumanAuthority && !core.settings.allowAgentProposedObjectives) {
    core.reject(actor, 'unauthorized', 'objective creation requires a direct human turn on a top-level session')
    return fail('unauthorized', 'objective creation requires a direct human message in the current turn of a top-level session (allowAgentProposedObjectives is off)')
  }
  const candidate = {
    schema: SCHEMA,
    id: mintId('obj'),
    revision: 1,
    createdAt: iso(nowMs),
    updatedAt: iso(nowMs),
    statement,
    criteria: criteria.criteria,
    criteriaVersion: 1,
    owner: { kind: 'agent', sessionId: actor.sessionId, ...(actor.presetId === undefined ? {} : { presetId: actor.presetId }) },
    creator: human ? { kind: 'human', via: 'objective_create', rootSessionId: actor.sessionId } : { kind: 'agent', sessionId: actor.sessionId },
    priority: positiveInt(input?.priority, 5, 9, 0),
    scope: normalizeScope(input?.scope),
    budget: makeBudget(input?.budget ?? input, core.settings.limits),
    state: 'proposed',
    blockedReason: null,
    armed: false,
    counters: { workerFailures: 0, verificationRejects: 0, verificationInconclusives: 0, classifyCalls: 0 },
    statementKey: statementKey(actor.sessionId, statement),
    ...(key === undefined ? {} : { idempotencyKey: key }),
    allowDuplicate: input?.allowDuplicate === true,
  }
  if (core.tokens !== undefined) {
    const baseline = core.tokens.baseline(actor.sessionId)
    if (typeof baseline === 'number') candidate.budget.tokens.baseline = baseline
  }
  const gate = gateCreate(core.state, core.settings, candidate, nowMs)
  if (gate !== undefined && gate.code !== 'queue') {
    core.reject(actor, gate.code, gate)
    return fail(gate.code, `objective rejected: ${gate.code}${gate.limit ? ` (${gate.limit}=${gate.current})` : ''}`, gate)
  }
  delete candidate.allowDuplicate
  const admitted = human || !core.settings.requireHumanAuthority
  if (admitted) {
    if (gate?.code === 'queue') candidate.state = 'queued'
    else {
      candidate.state = 'active'
      candidate.armed = true
      candidate.activatedAt = iso(nowMs)
    }
  }
  core.append('objective/created', actor, { objective: candidate, resultDigest: payloadDigest }, key)
  if (candidate.state === 'queued') core.append('admission/queued', engineActor, { objective: candidate })
  return ok({ objective: objectiveView(core.state, candidate), ...(candidate.state === 'proposed' ? { note: 'proposed: a human must approve it with objective_control {action:"approve"}' } : {}) })
}

/** Human approval of a proposed objective. */
export const approveObjective = (core, objective, actor) => {
  if (objective.state !== 'proposed') return fail('objective-not-proposed', `objective is ${objective.state}`)
  const nowMs = core.now()
  const gate = gateCreate(core.state, core.settings, { ...objective, allowDuplicate: true }, nowMs)
  if (gate !== undefined && gate.code !== 'queue') return fail(gate.code, `objective rejected: ${gate.code}`, gate)
  const next = bump({ ...objective, state: gate?.code === 'queue' ? 'queued' : 'active', armed: gate?.code !== 'queue', activatedAt: iso(nowMs), creator: { ...objective.creator, approvedBy: actor.sessionId } }, nowMs)
  core.append('objective/state-changed', actor, { objective: next, from: 'proposed' })
  return ok({ objective: objectiveView(core.state, next) })
}

/** Promote queued objectives into free slots (FIFO by priority/age). Engine actor. */
export const promoteQueued = (core) => {
  const nowMs = core.now()
  const promoted = []
  for (const objective of orderObjectives(queuedObjectives(core.state), core.settings, nowMs)) {
    if (countedActive(core.state).length >= core.settings.limits.maxActiveObjectives) break
    if (nowMs - Date.parse(objective.createdAt) > core.settings.limits.maxQueueAgeMs) {
      blockObjective(core, objective, 'queue-expired', `queued for more than ${core.settings.limits.maxQueueAgeMs} ms`)
      continue
    }
    const conflict = countedActive(core.state).some((other) => other.scope?.kind === 'paths' && objective.scope?.kind === 'paths' && other.scope.paths.some((p) => objective.scope.paths.includes(p)))
    if (conflict) continue
    const next = bump({ ...objective, state: 'active', armed: core.state.engine.mode === 'running', activatedAt: iso(nowMs) }, nowMs)
    core.append('admission/dequeued', engineActor, { objective: next })
    promoted.push(next.id)
  }
  return promoted
}

/** O10 (engine): block with a typed reason. Idempotent for the same reason. */
export const blockObjective = (core, objective, code, detail) => {
  if (closed(objective)) return objective
  if (objective.state === 'blocked' && objective.blockedReason?.code === code) return objective
  const nowMs = core.now()
  const next = bump({ ...objective, state: 'blocked', previousState: objective.state, armed: false, blockedReason: { code, detail: detail ?? code, at: iso(nowMs) }, blockedNotifiedAt: null }, nowMs)
  core.append('objective/state-changed', engineActor, { objective: next, from: objective.state, code })
  cancelOpenItems(core, next, `objective blocked: ${code}`)
  return next
}

const cancelOpenItems = (core, objective, reason) => {
  const nowMs = core.now()
  for (const item of itemsOf(core.state, objective.id)) {
    if (item.state === 'queued' || item.state === 'dispatched' || item.state === 'reported') {
      const next = bump({ ...item, state: 'cancelled', cancelReason: reason }, nowMs)
      core.append('item/cancelled', engineActor, { item: next, objective })
    }
  }
}

/** O2 / O3 / O11 / O12 / edit / budget-raise: the human control surface. */
export const controlObjective = (core, input, actor) => {
  const { objective, error } = loadObjective(core, input?.objectiveId)
  if (error !== undefined) return error
  const stale = checkRevision(objective, input?.expectedRevision)
  if (stale !== undefined) return stale
  const action = typeof input?.action === 'string' ? input.action : ''
  const nowMs = core.now()
  if (closed(objective) && action !== 'status') return fail('objective-terminal', `objective is ${objective.state}`)
  switch (action) {
    case 'approve':
      return approveObjective(core, objective, actor)
    case 'pause': {
      if (!['active', 'verifying', 'awaiting-human', 'queued'].includes(objective.state)) return fail('objective-not-pausable', `objective is ${objective.state}`)
      const next = bump({ ...objective, state: 'paused', previousState: objective.state, armed: false, pausedReason: clampText(input?.reason, 500) || 'human' }, nowMs)
      core.append('objective/state-changed', actor, { objective: next, from: objective.state })
      return ok({ objective: objectiveView(core.state, next), cancelledChildren: core.cancelChildren?.(objective.id, 'objective paused') ?? 0 })
    }
    case 'resume': {
      if (objective.state !== 'paused' && objective.state !== 'blocked') return fail('objective-not-paused', `objective is ${objective.state}`)
      const counter = exhaustedCounter(objective.budget)
      if (counter !== undefined) return fail('budget-exhausted', `${counter} budget is exhausted; raise it with action "budget-raise" first`, { counter })
      if (
        objective.state === 'blocked' &&
        objective.blockedReason?.code === 'verification-failed' &&
        (objective.counters.verificationRejects >= core.settings.limits.maxVerificationRejects ||
          objective.counters.verificationInconclusives >= core.settings.limits.maxVerificationInconclusives)
      ) {
        return fail('verification-failed', 'edit the criteria (action "edit") or reset attempts (action "reset-attempts") before resuming')
      }
      if (core.state.engine.mode !== 'running') return fail('engine-paused', 'resume the engine first with objective_system {action:"resume"}')
      if (countedActive(core.state).length >= core.settings.limits.maxActiveObjectives) {
        const next = bump({ ...objective, state: 'queued', blockedReason: null, armed: false }, nowMs)
        core.append('admission/queued', actor, { objective: next })
        return ok({ objective: objectiveView(core.state, next), note: 'no active slot free; queued' })
      }
      const next = bump({ ...objective, state: 'active', blockedReason: null, armed: true, pausedReason: undefined, blockedNotifiedAt: undefined, resumedAt: iso(nowMs) }, nowMs)
      core.append('objective/state-changed', actor, { objective: next, from: objective.state })
      return ok({ objective: objectiveView(core.state, next) })
    }
    case 'cancel': {
      const next = bump({ ...objective, state: 'cancelled', armed: false, cancelledAt: iso(nowMs), cancelReason: clampText(input?.reason, 1000) || undefined }, nowMs)
      core.append('objective/closed', actor, { objective: next, from: objective.state })
      cancelOpenItems(core, next, 'objective cancelled')
      const cancelledChildren = core.cancelChildren?.(objective.id, 'objective cancelled') ?? 0
      return ok({ objective: objectiveView(core.state, next), promoted: promoteQueued(core), cancelledChildren })
    }
    case 'budget-raise': {
      const raises = isRecord(input?.budget) ? input.budget : {}
      const budget = clone(objective.budget)
      const changed = []
      for (const name of Object.keys(budget)) {
        const value = positiveInt(raises[name], undefined)
        if (value !== undefined && value > budget[name].max) {
          budget[name].max = value
          changed.push(name)
        }
      }
      if (changed.length === 0) return fail('budget-unchanged', 'budget-raise needs a budget object with at least one counter above its current max')
      const next = bump({ ...objective, budget }, nowMs)
      core.append('objective/budget-changed', actor, { objective: next, changed })
      return ok({ objective: objectiveView(core.state, next), changed })
    }
    case 'edit': {
      const patch = {}
      if (typeof input?.statement === 'string' && clampText(input.statement, 4000) !== '') patch.statement = clampText(input.statement, 4000)
      if (typeof input?.priority === 'number') patch.priority = positiveInt(input.priority, objective.priority, 9, 0)
      if (input?.scope !== undefined) patch.scope = normalizeScope(input.scope)
      let supersededVerifications = []
      if (input?.criteria !== undefined) {
        const criteria = normalizeCriteria(input.criteria)
        if (criteria.error !== undefined) return fail(criteria.code, criteria.error)
        patch.criteria = criteria.criteria
        patch.criteriaVersion = objective.criteriaVersion + 1
        supersededVerifications = verificationsOf(core.state, objective.id)
          .filter((verification) => verification.state !== 'superseded')
          .map((verification) => bump({ ...verification, state: 'superseded', supersededAt: iso(nowMs), supersededBy: 'criteria-edit' }, nowMs))
      }
      if (Object.keys(patch).length === 0) return fail('edit-empty', 'edit needs statement, criteria, priority, or scope')
      const needsPause = patch.criteria !== undefined && ['verifying', 'awaiting-human', 'active'].includes(objective.state)
      const next = bump(
        {
          ...objective,
          ...patch,
          ...(patch.statement === undefined ? {} : { statementKey: statementKey(objective.owner.sessionId, patch.statement) }),
          ...(needsPause ? { state: 'paused', previousState: objective.state, armed: false, pausedReason: 'criteria-edited' } : {}),
        },
        nowMs,
      )
      core.append('objective/edited', actor, { objective: next, verifications: supersededVerifications, changed: Object.keys(patch) })
      return ok({ objective: objectiveView(core.state, next), supersededVerifications: supersededVerifications.map((v) => v.id), ...(needsPause ? { note: 'criteria changed: the objective is paused and must be resumed explicitly' } : {}) })
    }
    case 'reset-attempts': {
      const next = bump({ ...objective, counters: { ...objective.counters, verificationRejects: 0, verificationInconclusives: 0, workerFailures: 0 } }, nowMs)
      core.append('objective/budget-changed', actor, { objective: next, changed: ['attempts'] })
      return ok({ objective: objectiveView(core.state, next) })
    }
    default:
      return fail('action-invalid', 'action must be approve, pause, resume, cancel, edit, budget-raise, or reset-attempts')
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const requireActive = (objective) => {
  if (closed(objective)) return fail('objective-terminal', `objective is ${objective.state}`)
  if (objective.state !== 'active') return fail('objective-not-active', `objective is ${objective.state}`)
  return undefined
}
const requireOwner = (objective, actor) =>
  actor?.sessionId === objective.owner.sessionId ? undefined : fail('unauthorized', 'only the objective owner session may do this')

/** I1: add a work order (or an objective-level status report / heartbeat). */
export const addItem = (core, input, actor) => {
  const { objective, error } = loadObjective(core, input?.objectiveId)
  if (error !== undefined) return error
  const notActive = requireActive(objective)
  if (notActive !== undefined) return notActive
  const owner = requireOwner(objective, actor)
  if (owner !== undefined) return owner
  const nowMs = core.now()
  const kind = ITEM_KINDS.has(input?.kind) ? input.kind : 'work-order'
  const title = clampText(input?.title ?? input?.text, 300)
  if (title === '') return fail('record-incomplete', 'objective_plan needs a title (or text)')
  const detail = clampText(input?.detail ?? (input?.title === undefined ? '' : input?.text), 4000)
  const acceptance = Array.isArray(input?.acceptance) ? input.acceptance.map((entry) => clampText(entry, 500)).filter((entry) => entry !== '').slice(0, 12) : []
  const criterionIds = Array.isArray(input?.criterionIds) ? input.criterionIds.map(String).filter((id) => objective.criteria.some((criterion) => criterion.id === id)) : []
  if (kind === 'work-order') {
    if (acceptance.length === 0) return fail('record-incomplete', 'a work-order needs at least one acceptance entry')
    if (criterionIds.length === 0) return fail('record-incomplete', `a work-order must link at least one criterion id (${objective.criteria.map((c) => c.id).join(', ')})`)
    if (!objective.armed) return fail('objective-disarmed', 'the objective is not armed; resume it first')
  }
  const gate = gateItem(core.state, core.settings, objective)
  if (gate !== undefined) return fail(gate.code, `item rejected: ${gate.code} (${gate.counter ?? gate.limit}=${gate.current})`, gate)
  const item = {
    schema: SCHEMA,
    id: mintId('itm'),
    revision: 1,
    objectiveId: objective.id,
    kind,
    createdAt: iso(nowMs),
    updatedAt: iso(nowMs),
    createdBy: { sessionId: actor.sessionId, tool: 'objective_plan' },
    title,
    detail,
    acceptance,
    link: { criterionIds },
    evidence: [],
    state: kind === 'work-order' ? 'queued' : 'reported',
    attempt: 1,
    ...(kind === 'work-order' ? {} : { report: { summary: detail || title, at: iso(nowMs), by: actor.sessionId } }),
  }
  const budget = clone(objective.budget)
  budget.items.used += 1
  const next = bump({ ...objective, budget }, nowMs)
  core.append('item/created', actor, { item, objective: next })
  return ok({ item: clone(item), objective: objectiveView(core.state, next) })
}

/** I2 (record half): mark a queued work order dispatched to a started child. */
export const markDispatched = (core, item, child, persona, actor) => {
  const nowMs = core.now()
  const objective = core.state.objectives.get(item.objectiveId)
  const next = bump({ ...item, state: 'dispatched', assignedPersona: persona, assignedChild: { ...child, dispatchedAt: iso(nowMs) }, lastActivityAt: iso(nowMs) }, nowMs)
  const budget = clone(objective.budget)
  budget.concurrency.used = itemsOf(core.state, objective.id).filter((entry) => entry.state === 'dispatched').length + 1
  const nextObjective = bump({ ...objective, budget }, nowMs)
  core.append('item/dispatched', actor, { item: next, objective: nextObjective })
  return next
}

/** Can this item be dispatched now? Returns the item or a typed failure. */
export const dispatchable = (core, input, actor) => {
  const item = core.state.items.get(clampText(input?.itemId, 80))
  if (item === undefined) return fail('item-not-found', 'unknown item')
  const objective = core.state.objectives.get(item.objectiveId)
  const notActive = requireActive(objective)
  if (notActive !== undefined) return notActive
  const owner = requireOwner(objective, actor)
  if (owner !== undefined) return owner
  const stale = checkRevision(item, input?.expectedRevision)
  if (stale !== undefined) return stale
  if (item.kind !== 'work-order') return fail('item-not-dispatchable', 'only work-orders are dispatched')
  if (item.state !== 'queued') return fail('item-not-queued', `item is ${item.state}`)
  if (!objective.armed) return fail('objective-disarmed', 'the objective is not armed')
  if (core.state.engine.mode !== 'running') return fail('engine-paused', 'the engine is paused')
  const gate = gateDispatch(core.state, core.settings, objective, core.now())
  if (gate !== undefined) return fail(gate.code, `dispatch refused: ${gate.limit}=${gate.current}`, gate)
  return ok({ item, objective })
}

const recomputeConcurrency = (core, objective) => {
  const used = itemsOf(core.state, objective.id).filter((entry) => entry.state === 'dispatched').length
  if (used === objective.budget.concurrency.used) return objective
  const budget = clone(objective.budget)
  budget.concurrency.used = used
  return { ...objective, budget }
}

/** I3: the assigned child reports; the manager may file objective-level status reports. */
export const reportItem = (core, input, actor) => {
  const { objective, error } = loadObjective(core, input?.objectiveId)
  if (error !== undefined) return error
  const nowMs = core.now()
  const itemId = clampText(input?.itemId ?? input?.progressId, 80)
  const text = clampText(input?.text ?? input?.summary, 4000)
  const kind = input?.kind === 'heartbeat' ? 'heartbeat' : 'status-report'
  const evidence = Array.isArray(input?.evidence) ? input.evidence.filter(isRecord).slice(0, 3).map((entry) => clone(entry)) : []
  if (itemId === '') {
    // Objective-level status report by the owner (or a late report while verifying).
    const owner = requireOwner(objective, actor)
    if (owner !== undefined) return owner
    if (closed(objective) || objective.state === 'blocked' || objective.state === 'awaiting-human') return fail('objective-closed', `objective is ${objective.state}`)
    if (text === '') return fail('record-incomplete', 'objective_report needs text')
    const item = {
      schema: SCHEMA,
      id: mintId('itm'),
      revision: 1,
      objectiveId: objective.id,
      kind,
      createdAt: iso(nowMs),
      updatedAt: iso(nowMs),
      createdBy: { sessionId: actor.sessionId, tool: 'objective_report' },
      title: text.slice(0, 200),
      detail: text,
      acceptance: [],
      link: { criterionIds: [] },
      evidence,
      state: 'reported',
      attempt: 1,
      report: { summary: text, at: iso(nowMs), by: actor.sessionId },
      ...(objective.state === 'verifying' ? { lateEvidence: true } : {}),
    }
    core.append('item/reported', actor, { item, objective })
    return ok({ item: clone(item) })
  }
  const item = core.state.items.get(itemId)
  if (item === undefined || item.objectiveId !== objective.id) return fail('item-not-found', 'unknown item for this objective')
  if (closed(objective) || objective.state === 'blocked') return fail('objective-closed', `objective is ${objective.state}`)
  const stale = checkRevision(item, input?.expectedRevision)
  if (stale !== undefined) return stale
  if (item.state !== 'dispatched') return fail('item-not-dispatched', `item is ${item.state}`)
  const assigned = item.assignedChild?.sessionId
  if (assigned !== undefined && assigned !== actor.sessionId) {
    // Fallback dispatch confirmation: the owner may bind an externally started child once.
    if (actor.sessionId === objective.owner.sessionId && typeof input?.childSessionId === 'string' && item.assignedChild?.kind === 'external' && item.assignedChild.sessionId === 'pending') {
      const next = bump({ ...item, assignedChild: { ...item.assignedChild, sessionId: clampText(input.childSessionId, 120) }, lastActivityAt: iso(nowMs) }, nowMs)
      core.append('item/dispatched', actor, { item: next, objective })
      return ok({ item: clone(next), note: 'child bound' })
    }
    return fail('unauthorized', 'only the assigned child session may report on this item')
  }
  if (assigned === undefined && actor.sessionId !== objective.owner.sessionId) return fail('unauthorized', 'only the assigned child or the owner may report on this item')
  if (kind === 'heartbeat') {
    const next = bump({ ...item, lastActivityAt: iso(nowMs), heartbeats: (item.heartbeats ?? 0) + 1 }, nowMs)
    core.append('item/reported', actor, { item: next, heartbeat: true })
    return ok({ item: clone(next) })
  }
  if (text === '') return fail('record-incomplete', 'a status report needs text')
  const next = bump({ ...item, state: 'reported', evidence: [...item.evidence, ...evidence].slice(-3), report: { summary: text, at: iso(nowMs), by: actor.sessionId }, lastActivityAt: iso(nowMs), notified: false }, nowMs)
  const nextObjective = recomputeConcurrency(core, { ...objective, counters: { ...objective.counters, workerFailures: 0 } })
  core.append('item/reported', actor, { item: next, objective: bump(nextObjective, nowMs) })
  return ok({ item: clone(next) })
}

/** I4 / I5 / I7 by the manager (or a human): accept, reject, cancel an item. */
export const decideItem = (core, input, actor) => {
  const item = core.state.items.get(clampText(input?.itemId, 80))
  if (item === undefined) return fail('item-not-found', 'unknown item')
  const objective = core.state.objectives.get(item.objectiveId)
  if (closed(objective)) return fail('objective-terminal', `objective is ${objective.state}`)
  const owner = requireOwner(objective, actor)
  if (owner !== undefined && actor.human !== true) return owner
  const stale = checkRevision(item, input?.expectedRevision)
  if (stale !== undefined) return stale
  const nowMs = core.now()
  const action = input?.action
  if (action === 'cancel') {
    if (ITEM_TERMINAL.has(item.state)) return fail('item-terminal', `item is ${item.state}`)
    const next = bump({ ...item, state: 'cancelled', cancelReason: clampText(input?.reason, 500) || 'cancelled by manager' }, nowMs)
    core.append('item/cancelled', actor, { item: next, objective: bump(recomputeConcurrency(core, objective), nowMs) })
    const cancelled = item.state === 'dispatched' ? (core.cancelChild?.(item.id, 'item cancelled') ?? 0) : 0
    return ok({ item: clone(next), cancelledChild: cancelled > 0 })
  }
  if (item.state !== 'reported') return fail('item-not-reported', `item is ${item.state}`)
  if (action === 'accept') {
    const producer = item.report?.by
    if (producer === actor.sessionId && actor.human !== true) return fail('unauthorized', 'the producer cannot accept its own work')
    if (producer === item.assignedChild?.sessionId && actor.sessionId === item.assignedChild?.sessionId) return fail('unauthorized', 'the producer cannot accept its own work')
    if (!item.report?.summary) return fail('record-incomplete', 'the item has no report summary to accept')
    if (item.kind === 'work-order' && item.evidence.length === 0 && (input?.acceptWithoutEvidence !== true)) {
      return fail('evidence-required', 'the report carries no evidence; pass acceptWithoutEvidence:true to accept on the summary alone (recorded)')
    }
    const deferred = Array.isArray(input?.deferred) ? input.deferred.map((entry) => clampText(entry, 500)).filter((entry) => entry !== '') : []
    const next = bump({ ...item, state: 'accepted', acceptedBy: actor.sessionId, acceptedAt: iso(nowMs), ...(deferred.length === 0 ? {} : { deferred }), ...(input?.acceptWithoutEvidence === true ? { acceptedWithoutEvidence: true } : {}) }, nowMs)
    core.append('item/accepted', actor, { item: next, objective })
    return ok({ item: clone(next), ...(allLinkedAccepted(core, objective) ? { note: 'every linked work order is accepted; request verification with objective_verify' } : {}) })
  }
  if (action === 'reject') {
    const reason = clampText(input?.reason, 1000)
    if (reason === '') return fail('record-incomplete', 'reject needs a reason')
    const next = bump({ ...item, state: 'rejected', rejectReason: reason, rejectedBy: actor.sessionId }, nowMs)
    const budget = clone(objective.budget)
    budget.rounds.used = Math.min(budget.rounds.max, budget.rounds.used + 1)
    const nextObjective = bump({ ...objective, budget }, nowMs)
    core.append('item/rejected', actor, { item: next, objective: nextObjective })
    return ok({ item: clone(next), note: 'a rejected item is terminal: create a new work order for the retry' })
  }
  return fail('action-invalid', 'action must be add, accept, reject, or cancel')
}

/** Every work order linked to any criterion is accepted (and at least one exists). */
export const allLinkedAccepted = (core, objective, criterionIds) => {
  const orders = itemsOf(core.state, objective.id).filter((item) => item.kind === 'work-order' && (criterionIds === undefined || item.link.criterionIds.some((id) => criterionIds.includes(id))))
  const open = orders.filter((item) => !['accepted', 'cancelled', 'rejected', 'failed'].includes(item.state))
  return orders.length > 0 && open.length === 0
}

/** I6 (engine): a dispatched item failed (child error, stall, restart). */
export const failItem = (core, item, code, detail) => {
  if (item.state !== 'dispatched') return item
  const nowMs = core.now()
  const objective = core.state.objectives.get(item.objectiveId)
  const next = bump({ ...item, state: 'failed', failure: { code, detail, at: iso(nowMs) }, notified: false }, nowMs)
  const failures = (objective.counters?.workerFailures ?? 0) + 1
  let nextObjective = bump(recomputeConcurrency(core, { ...objective, counters: { ...objective.counters, workerFailures: failures } }), nowMs)
  core.append('item/failed', engineActor, { item: next, objective: nextObjective, code })
  if (failures >= core.settings.limits.maxConsecutiveWorkerFailures && nextObjective.state === 'active') {
    nextObjective = blockObjective(core, core.state.objectives.get(objective.id), 'worker-failures', `${failures} consecutive worker failures`)
  }
  return next
}

/** Child settlement from subagent/end: a report filed before settlement is authoritative. */
export const settleChild = (core, item, info) => {
  if (item.state !== 'dispatched') return item
  const stop = info?.stopReason ?? 'completed'
  if (stop !== 'completed') return failItem(core, item, `child-${stop}`, `child ended with ${stop}`)
  const text = Array.isArray(info?.lastAssistantMessage)
    ? info.lastAssistantMessage.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
    : ''
  const nowMs = core.now()
  const objective = core.state.objectives.get(item.objectiveId)
  const next = bump({ ...item, state: 'reported', report: { summary: clampText(text, 4000) || '(child ended without a report)', at: iso(nowMs), by: item.assignedChild?.sessionId ?? 'child', fromSettlement: true }, lastActivityAt: iso(nowMs), notified: false }, nowMs)
  core.append('item/reported', engineActor, { item: next, objective: bump(recomputeConcurrency(core, objective), nowMs) })
  return next
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** O4: request verification. `pin` is the commit record produced by verify.js. */
export const requestVerification = (core, input, actor, pin) => {
  const { objective, error } = loadObjective(core, input?.objectiveId)
  if (error !== undefined) return error
  const notActive = requireActive(objective)
  if (notActive !== undefined) return notActive
  if (actor.sessionId !== objective.owner.sessionId && actor.human !== true) return fail('unauthorized', 'only the owner session (or a human) may request verification')
  const stale = checkRevision(objective, input?.expectedRevision)
  if (stale !== undefined) return stale
  const nowMs = core.now()
  const all = objective.criteria.map((criterion) => criterion.id)
  const requested = Array.isArray(input?.criterionIds) && input.criterionIds.length > 0 ? input.criterionIds.map(String).filter((id) => all.includes(id)) : all
  if (requested.length === 0) return fail('record-incomplete', 'criterionIds name no known criterion')
  if (!allLinkedAccepted(core, objective, requested) && input?.force !== true) {
    const open = itemsOf(core.state, objective.id).filter((item) => item.kind === 'work-order' && !['accepted', 'cancelled', 'rejected', 'failed'].includes(item.state)).map((item) => `${item.id}:${item.state}`)
    const orders = itemsOf(core.state, objective.id).filter((item) => item.kind === 'work-order').length
    return fail('not-ready', orders === 0 ? 'no work order is linked to these criteria yet (pass force:true to verify without work orders)' : `open work orders: ${open.join(', ')}`, { open })
  }
  const gate = gateVerification(core.state, core.settings, objective, nowMs)
  if (gate !== undefined) return fail(gate.code, `verification refused: ${gate.counter ?? gate.limit}=${gate.current}`, gate)
  if (core.settings.requireCommitPin && pin?.commit === undefined) return fail('commit-unavailable', 'commit pinning is required but no commit could be resolved')
  const advisory = requested.length < all.length
  const verification = {
    schema: SCHEMA,
    id: mintId('ver'),
    revision: 1,
    objectiveId: objective.id,
    criteriaVersion: objective.criteriaVersion,
    criterionIds: requested,
    advisory,
    commit: pin ?? { commit: null, pinned: false },
    requestedBy: { sessionId: actor.sessionId, tool: 'objective_verify' },
    requestedAt: iso(nowMs),
    verifier: null,
    evidence: [],
    verdict: null,
    ack: null,
    state: 'requested',
  }
  const budget = clone(objective.budget)
  budget.verifierRuns.used += 1
  const next = bump({ ...objective, budget, ...(advisory ? {} : { state: 'verifying', previousState: 'active' }), currentVerificationId: verification.id }, nowMs)
  core.append('verification/requested', actor, { verification, objective: next })
  return ok({ verification: clone(verification), objective: objectiveView(core.state, next) })
}

/** Bind the engine-started verifier child (or an external verifier) to the record. */
export const bindVerifier = (core, verification, verifier) => {
  const next = bump({ ...verification, verifier }, core.now())
  core.append('verification/requested', engineActor, { verification: next, bound: true })
  return next
}

const evidenceCovers = (criterion, entry) => {
  if (entry.criterionId !== criterion.id) return false
  const kind = criterion.check.kind
  if (kind === 'command') return entry.kind === 'command' && typeof entry.command === 'string' && typeof entry.exitCode === 'number' && entry.exitCode === criterion.check.expectedExitCode
  if (kind === 'artifact') return entry.kind === 'artifact' && typeof entry.path === 'string' && (criterion.check.sha256 === undefined || entry.sha256 === criterion.check.sha256)
  if (kind === 'human-ack') return entry.kind === 'human'
  return entry.kind === 'command' || entry.kind === 'artifact' || entry.kind === 'evidence' || entry.kind === 'inspection'
}

/**
 * O5 / O6 / O6b / O7: the verifier's verdict. Only the bound verifier (or,
 * for an external record, a non-producer session) may call this.
 */
export const recordVerdict = (core, input, actor) => {
  const verification = core.state.verifications.get(clampText(input?.verificationId, 80))
  if (verification === undefined) return fail('verification-not-found', 'unknown verification')
  const objective = core.state.objectives.get(verification.objectiveId)
  if (verification.state !== 'requested') return fail('verification-closed', `verification is ${verification.state}`)
  if (closed(objective)) return fail('objective-terminal', `objective is ${objective.state}`)
  const nowMs = core.now()
  // Authority: the exact bound verifier; otherwise (external) any non-producer session with a different preset.
  const producers = new Set([objective.owner.sessionId, ...itemsOf(core.state, objective.id).map((item) => item.assignedChild?.sessionId).filter(Boolean)])
  if (producers.has(actor.sessionId)) return fail('unauthorized', 'a producer session cannot verify its own objective')
  if (verification.verifier?.kind === 'child' && verification.verifier.sessionId !== actor.sessionId) {
    return fail('unauthorized', 'only the verifier child started by the engine may record this verdict')
  }
  if (verification.verifier?.kind === 'child' && verification.verifier.presetId !== undefined && actor.presetId !== undefined && actor.presetId !== verification.verifier.presetId) {
    return fail('unauthorized', 'verifier preset mismatch')
  }
  if (objective.owner.presetId !== undefined && actor.presetId !== undefined && actor.presetId === objective.owner.presetId && verification.verifier?.kind !== 'child') {
    return fail('unauthorized', 'the verifier must use a different preset than the producer')
  }
  const verdictKind = VERDICTS.has(input?.verdict) ? input.verdict : input?.verdict === 'pass' ? 'approve' : input?.verdict === 'fail' ? 'reject' : undefined
  if (verdictKind === undefined) return fail('verdict-invalid', 'verdict must be approve, reject, or inconclusive')
  const reason = clampText(input?.reason ?? input?.summary, 2000)
  const evidence = Array.isArray(input?.evidence) ? input.evidence.filter(isRecord).map((entry) => ({ ...clone(entry), at: typeof entry.at === 'string' ? entry.at : iso(nowMs) })) : []
  const reportedCommit = clampText(input?.commit, 64)
  const workspaceClean = input?.workspaceClean === true
  const criteria = objective.criteria.filter((criterion) => verification.criterionIds.includes(criterion.id))
  const mechanical = criteria.filter((criterion) => criterion.check.kind !== 'human-ack')
  const covered = mechanical.filter((criterion) => evidence.some((entry) => evidenceCovers(criterion, entry)))
  const uncovered = mechanical.filter((criterion) => !covered.includes(criterion)).map((criterion) => criterion.id)
  let effective = verdictKind
  let downgrade
  if (verification.criteriaVersion !== objective.criteriaVersion) {
    effective = 'inconclusive'
    downgrade = 'criteria-changed'
  } else if (verdictKind === 'approve') {
    if (verification.commit?.pinned && reportedCommit !== '' && reportedCommit !== verification.commit.commit) {
      effective = 'inconclusive'
      downgrade = 'wrong-commit'
    } else if (verification.commit?.pinned && reportedCommit === '') {
      effective = 'inconclusive'
      downgrade = 'commit-not-reported'
    } else if (verification.commit?.pinned && !workspaceClean) {
      effective = 'inconclusive'
      downgrade = 'dirty-workspace'
    } else if (uncovered.length > 0) {
      effective = 'inconclusive'
      downgrade = `missing-evidence:${uncovered.join(',')}`
    }
  } else if (verdictKind === 'reject') {
    const failing = evidence.filter((entry) => entry.failed === true || (typeof entry.exitCode === 'number' && entry.exitCode !== 0))
    if (failing.length === 0 && reason === '') {
      effective = 'inconclusive'
      downgrade = 'reject-without-evidence'
    }
  }
  const nextVerification = bump(
    {
      ...verification,
      evidence,
      reportedCommit: reportedCommit || null,
      workspaceClean,
      verdict: { kind: effective, requested: verdictKind, reason, at: iso(nowMs), ...(downgrade === undefined ? {} : { downgrade }), coverage: { covered: covered.map((c) => c.id), uncovered } },
      verifier: verification.verifier ?? { kind: 'external', sessionId: actor.sessionId, ...(actor.presetId === undefined ? {} : { presetId: actor.presetId }) },
      state: effective === 'approve' ? 'approved' : effective === 'reject' ? 'rejected' : 'inconclusive',
    },
    nowMs,
  )
  core.append('verification/verdict', actor.kind === 'engine' ? engineActor : { ...actor, kind: 'agent' }, { verification: nextVerification })
  return applyVerdictToObjective(core, objective, nextVerification)
}

/** Engine-only objective transition after a verdict is recorded. */
export const applyVerdictToObjective = (core, objectiveBefore, verification) => {
  const objective = core.state.objectives.get(objectiveBefore.id)
  const nowMs = core.now()
  const kind = verification.verdict.kind
  if (verification.advisory) {
    const next = bump({ ...objective, verdictNotice: { verificationId: verification.id, kind, advisory: true, at: iso(nowMs), notified: false } }, nowMs)
    core.append('objective/verification-verdict', engineActor, { objective: next, verificationId: verification.id, kind, advisory: true })
    return ok({ verification: clone(verification), objective: objectiveView(core.state, next), note: 'advisory verification: it cannot complete the objective' })
  }
  if (objective.state !== 'verifying') {
    const next = bump({ ...objective, verdictNotice: { verificationId: verification.id, kind, at: iso(nowMs), notified: false } }, nowMs)
    core.append('objective/verification-verdict', engineActor, { objective: next, verificationId: verification.id, kind })
    return ok({ verification: clone(verification), objective: objectiveView(core.state, next) })
  }
  const notice = { verificationId: verification.id, kind, at: iso(nowMs), notified: false }
  if (kind === 'approve') {
    const needsAck = objective.criteria.some((criterion) => verification.criterionIds.includes(criterion.id) && criterion.requiresHumanAck)
    if (needsAck) {
      const next = bump({ ...objective, state: 'awaiting-human', previousState: 'verifying', awaitingSince: iso(nowMs), verdictNotice: notice }, nowMs)
      core.append('objective/verification-verdict', engineActor, { objective: next, verificationId: verification.id, kind })
      return ok({ verification: clone(verification), objective: objectiveView(core.state, next), note: 'approved; waiting for a human acknowledgment of judgment criteria (objective_ack)' })
    }
    return completeObjective(core, objective, verification, notice)
  }
  if (kind === 'reject') {
    const rejects = (objective.counters?.verificationRejects ?? 0) + 1
    const counters = { ...objective.counters, verificationRejects: rejects }
    if (rejects >= core.settings.limits.maxVerificationRejects) {
      const recorded = bump({ ...objective, counters, verdictNotice: notice }, nowMs)
      core.append('objective/verification-verdict', engineActor, { objective: recorded, verificationId: verification.id, kind })
      const blocked = blockObjective(core, recorded, 'verification-failed', `rejected ${rejects} times`)
      return ok({ verification: clone(verification), objective: objectiveView(core.state, blocked) })
    }
    const next = bump({ ...objective, state: 'active', previousState: 'verifying', counters, verdictNotice: notice, currentVerificationId: null }, nowMs)
    core.append('objective/verification-verdict', engineActor, { objective: next, verificationId: verification.id, kind })
    return ok({ verification: clone(verification), objective: objectiveView(core.state, next), note: 'rejected: the objective is active again; create new work orders for the failing criteria' })
  }
  const inconclusives = (objective.counters?.verificationInconclusives ?? 0) + 1
  const counters = { ...objective.counters, verificationInconclusives: inconclusives }
  if (inconclusives >= core.settings.limits.maxVerificationInconclusives) {
    const recorded = bump({ ...objective, counters, verdictNotice: notice }, nowMs)
    core.append('objective/verification-verdict', engineActor, { objective: recorded, verificationId: verification.id, kind })
    const blocked = blockObjective(core, recorded, 'verification-failed', `inconclusive ${inconclusives} times`)
    return ok({ verification: clone(verification), objective: objectiveView(core.state, blocked) })
  }
  const next = bump({ ...objective, state: 'active', previousState: 'verifying', counters, verdictNotice: notice, currentVerificationId: null }, nowMs)
  core.append('objective/verification-verdict', engineActor, { objective: next, verificationId: verification.id, kind })
  return ok({ verification: clone(verification), objective: objectiveView(core.state, next), note: 'inconclusive: one re-request is allowed within budget' })
}

/** O6b / O8: terminal completion. Engine-only. */
export const completeObjective = (core, objective, verification, notice) => {
  const nowMs = core.now()
  const next = bump(
    {
      ...objective,
      state: 'completed',
      previousState: objective.state,
      armed: false,
      completedAt: iso(nowMs),
      completion: { verificationId: verification.id, verifiedBy: verification.verifier?.sessionId ?? null, ack: verification.ack ?? null, at: iso(nowMs) },
      ...(notice === undefined ? {} : { verdictNotice: { ...notice, notified: false } }),
    },
    nowMs,
  )
  core.append('objective/closed', engineActor, { objective: next, from: objective.state, verificationId: verification.id })
  cancelOpenItems(core, next, 'objective completed')
  const promoted = promoteQueued(core)
  return ok({ verification: clone(verification), objective: objectiveView(core.state, next), promoted, note: 'completed' })
}

/** O8 / O9: human acknowledgment of judgment criteria. */
export const ackObjective = (core, input, actor) => {
  const { objective, error } = loadObjective(core, input?.objectiveId)
  if (error !== undefined) return error
  if (actor.human !== true) return fail('unauthorized', 'objective_ack requires a direct human message in the current turn of a top-level session')
  if (objective.state !== 'awaiting-human') return fail('objective-not-awaiting', `objective is ${objective.state}`)
  const stale = checkRevision(objective, input?.expectedRevision)
  if (stale !== undefined) return stale
  const verification = core.state.verifications.get(objective.currentVerificationId)
  if (verification === undefined || verification.state !== 'approved') return fail('verification-required', 'no approved verification is pending acknowledgment')
  if (verification.criteriaVersion !== objective.criteriaVersion) return fail('ack-incomplete', 'the verification predates a criteria edit')
  const nowMs = core.now()
  const decision = input?.decision === 'send-back' ? 'send-back' : 'ack'
  const note = clampText(input?.note, 1000)
  if (decision === 'send-back') {
    if (note === '') return fail('record-incomplete', 'send-back needs a note')
    const superseded = bump({ ...verification, state: 'superseded', supersededAt: iso(nowMs), supersededBy: 'send-back', ack: { by: 'human', decision, note, rootSessionId: actor.sessionId, at: iso(nowMs) } }, nowMs)
    const next = bump({ ...objective, state: 'paused', previousState: 'awaiting-human', armed: false, pausedReason: 'sent-back', currentVerificationId: null, verdictNotice: null }, nowMs)
    core.append('objective/ack-recorded', actor, { objective: next, verification: superseded, decision })
    return ok({ objective: objectiveView(core.state, next), note: 'sent back: the objective is paused; resume it to continue work' })
  }
  const required = objective.criteria.filter((criterion) => criterion.requiresHumanAck).map((criterion) => criterion.id)
  const acked = Array.isArray(input?.criterionIds) && input.criterionIds.length > 0 ? input.criterionIds.map(String) : required
  const missing = required.filter((id) => !acked.includes(id))
  if (missing.length > 0) return fail('ack-incomplete', `criteria still need an ack: ${missing.join(', ')}`, { missing })
  const ack = { by: 'human', decision, criterionIds: required, note, rootSessionId: actor.sessionId, at: iso(nowMs), criteriaVersion: objective.criteriaVersion }
  const acked_ = bump({ ...verification, ack, state: 'acked' }, nowMs)
  core.append('objective/ack-recorded', actor, { objective, verification: acked_, decision })
  return completeObjective(core, core.state.objectives.get(objective.id), acked_)
}

// ---------------------------------------------------------------------------
// Budgets, wakeups, engine lifecycle
// ---------------------------------------------------------------------------

/** Consume one round. Returns the updated objective or undefined when exhausted (and blocks it). */
export const spendRound = (core, objectiveId) => {
  const objective = core.state.objectives.get(objectiveId)
  if (objective === undefined || closed(objective)) return undefined
  if (objective.budget.rounds.used >= objective.budget.rounds.max) {
    blockObjective(core, objective, 'budget-exhausted', 'rounds')
    return undefined
  }
  const budget = clone(objective.budget)
  budget.rounds.used += 1
  const next = bump({ ...objective, budget }, core.now())
  core.append('objective/budget-changed', engineActor, { objective: next, changed: ['rounds'] })
  return next
}

/** Sweep-time budget accounting: wall time, tokens, stalls, ack age. */
export const sweepObjective = (core, objective, measureTokens) => {
  if (closed(objective)) return objective
  const nowMs = core.now()
  let current = objective
  const budget = clone(current.budget)
  const start = Date.parse(current.activatedAt ?? current.createdAt)
  budget.wallTimeMs.used = Math.max(0, nowMs - start)
  if (typeof measureTokens === 'function' && typeof budget.tokens.baseline === 'number') {
    const total = measureTokens(current.owner.sessionId)
    if (typeof total === 'number') budget.tokens.used = Math.max(0, total - budget.tokens.baseline)
  }
  if (budget.wallTimeMs.used !== current.budget.wallTimeMs.used || budget.tokens.used !== current.budget.tokens.used) {
    // Record at most once per sweep interval, as an engine budget event.
    current = bump({ ...current, budget }, nowMs)
    core.append('objective/budget-changed', engineActor, { objective: current, changed: ['wallTimeMs', 'tokens'], silent: true })
  }
  if (['active', 'verifying', 'awaiting-human'].includes(current.state)) {
    const counter = exhaustedCounter(current.budget)
    if (counter !== undefined && counter !== 'rounds') return blockObjective(core, current, 'budget-exhausted', counter)
  }
  if (current.state === 'awaiting-human' && nowMs - Date.parse(current.awaitingSince ?? current.updatedAt) > core.settings.limits.maxAckAgeMs) {
    return blockObjective(core, current, 'human-ack-timeout', 'no acknowledgment within maxAckAgeMs')
  }
  for (const item of itemsOf(core.state, current.id)) {
    if (item.state === 'dispatched' && nowMs - Date.parse(item.lastActivityAt ?? item.updatedAt) > core.settings.limits.stallTimeoutMs) {
      failItem(core, item, 'stall', `no evidence or heartbeat for ${core.settings.limits.stallTimeoutMs} ms`)
      core.cancelChild?.(item.id, 'stall')
      current = core.state.objectives.get(current.id)
    }
  }
  return current
}

export const reserveWake = (core, { objectiveId, sessionId, form, revision, objectiveState }) => {
  const nowMs = core.now()
  const occurrence = [...core.state.wakes.values()].filter((wake) => wake.objectiveId === objectiveId).length + 1
  const wake = {
    id: mintId('wake'),
    objectiveId,
    sessionId,
    form,
    occurrence,
    revision,
    objectiveState: objectiveState ?? core.state.objectives.get(objectiveId)?.state,
    key: `opm:v1:wake:${objectiveId}:${occurrence}`,
    reservedAt: iso(nowMs),
    state: 'reserved',
  }
  core.append('wakeup/reserved', engineActor, { wake }, wake.key)
  return wake
}
export const setWakeState = (core, wake, state, extra) => {
  if (wake.state !== 'reserved') return wake
  const next = { ...wake, state, [`${state}At`]: iso(core.now()), ...(extra ?? {}) }
  core.append(`wakeup/${state}`, engineActor, { wake: next })
  return next
}
export const expireAllWakes = (core, reason) => {
  let count = 0
  for (const wake of core.state.wakes.values()) {
    if (wake.state === 'reserved') {
      setWakeState(core, wake, 'expired', { reason })
      count += 1
    }
  }
  return count
}

export const pauseEngine = (core, actor, reason) => {
  if (core.state.engine.mode === 'paused') return ok({ paused: true, already: true })
  core.append('engine/paused', actor ?? engineActor, { reason: clampText(reason, 500) || 'human' })
  const expired = expireAllWakes(core, 'engine-paused')
  const nowMs = core.now()
  for (const objective of core.state.objectives.values()) {
    if (objective.armed) {
      const next = bump({ ...objective, armed: false }, nowMs)
      core.append('objective/state-changed', engineActor, { objective: next, from: objective.state, code: 'disarmed' })
    }
  }
  for (const item of core.state.items.values()) {
    if (item.state === 'dispatched') {
      const next = bump({ ...item, state: 'cancelled', cancelReason: 'engine paused' }, nowMs)
      core.append('item/cancelled', engineActor, { item: next })
    }
  }
  return ok({ paused: true, expiredWakes: expired })
}

export const resumeEngine = (core, actor, { resumeAll = false } = {}) => {
  if (core.state.engine.mode === 'degraded') return fail('engine-degraded', core.state.engine.pausedReason ?? 'degraded')
  if (core.state.engine.mode !== 'running') core.append('engine/resumed', actor, {})
  const nowMs = core.now()
  const rearmed = []
  for (const objective of core.state.objectives.values()) {
    if (objective.state === 'active' && !objective.armed) {
      const next = bump({ ...objective, armed: true }, nowMs)
      core.append('objective/state-changed', engineActor, { objective: next, from: 'active', code: 'armed' })
      rearmed.push(next.id)
    } else if (resumeAll && objective.state === 'paused' && objective.pausedReason === 'process-restart') {
      const result = controlObjective(core, { objectiveId: objective.id, action: 'resume' }, actor)
      if (result.ok) rearmed.push(objective.id)
    }
  }
  return ok({ paused: false, rearmed, promoted: promoteQueued(core) })
}

/** Restart reconciliation (design §5.5): fail-closed, never wakes anything. */
export const reconcileAfterRestart = (core) => {
  const nowMs = core.now()
  const changes = { failedItems: 0, pausedObjectives: 0, inconclusiveVerifications: 0, expiredWakes: 0 }
  for (const item of core.state.items.values()) {
    if (item.state === 'dispatched') {
      const next = bump({ ...item, state: 'failed', failure: { code: 'process-restart', detail: 'the host restarted while the child ran', at: iso(nowMs) }, notified: false }, nowMs)
      core.append('item/failed', engineActor, { item: next, code: 'process-restart' })
      changes.failedItems += 1
    }
  }
  for (const verification of core.state.verifications.values()) {
    if (verification.state === 'requested') {
      const next = bump({ ...verification, state: 'inconclusive', verdict: { kind: 'inconclusive', reason: 'process-restart', at: iso(nowMs) } }, nowMs)
      core.append('verification/verdict', engineActor, { verification: next })
      changes.inconclusiveVerifications += 1
    }
  }
  for (const objective of core.state.objectives.values()) {
    if (['active', 'verifying'].includes(objective.state) || (objective.state === 'awaiting-human' && false)) {
      const next = bump({ ...objective, state: 'paused', previousState: objective.state, armed: false, pausedReason: 'process-restart', currentVerificationId: null, budget: { ...objective.budget, concurrency: { ...objective.budget.concurrency, used: 0 } } }, nowMs)
      core.append('objective/state-changed', engineActor, { objective: next, from: objective.state, code: 'process-restart' })
      changes.pausedObjectives += 1
    } else if (objective.armed) {
      const next = bump({ ...objective, armed: false }, nowMs)
      core.append('objective/state-changed', engineActor, { objective: next, from: objective.state, code: 'disarmed' })
    }
  }
  changes.expiredWakes = expireAllWakes(core, 'process-restart')
  return changes
}

export const activeCount = (core) => countedActive(core.state).length
export const queuedCount = (core) => queuedObjectives(core.state).length
export const COUNTED = COUNTED_ACTIVE
