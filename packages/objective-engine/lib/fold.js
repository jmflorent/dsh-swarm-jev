/**
 * Pure fold: command events -> engine state. No I/O, no clocks, no decisions.
 *
 * Every mutating event carries the complete record it produced (`objective`,
 * `item`, `verification`, `wake`), so the fold is an upsert keyed by id plus a
 * few derived indexes. Advisory classification proposals never reach the fold.
 */
import { ACTOR_KINDS, EVENT_TYPES, TERMINAL_STATES } from './records.js'

/** Actor kinds allowed to author each event family. */
const ALLOWED_ACTORS = {
  'engine/': new Set(['human', 'engine']),
  'objective/created': new Set(['human', 'agent']),
  'objective/edited': new Set(['human']),
  'objective/state-changed': new Set(['human', 'engine']),
  'objective/budget-changed': new Set(['human', 'engine']),
  'objective/verification-requested': new Set(['human', 'agent', 'engine']),
  'objective/verification-verdict': new Set(['engine']),
  'objective/ack-recorded': new Set(['human']),
  'objective/closed': new Set(['human', 'engine']),
  'item/created': new Set(['human', 'agent']),
  // A human owner dispatches from a turn with a direct human message; the
  // dispatch is the human's own act, so it must fold exactly like an agent's.
  'item/dispatched': new Set(['human', 'agent', 'engine']),
  'item/reported': new Set(['agent', 'engine']),
  'item/accepted': new Set(['human', 'agent', 'engine']),
  'item/rejected': new Set(['human', 'agent']),
  'item/failed': new Set(['engine']),
  'item/cancelled': new Set(['human', 'agent', 'engine']),
  'verification/': new Set(['human', 'agent', 'engine']),
  'wakeup/': new Set(['engine']),
  'admission/': new Set(['human', 'agent', 'engine']),
}

export const actorAllowed = (type, actorKind) => {
  if (!ACTOR_KINDS.has(actorKind)) return false
  const exact = ALLOWED_ACTORS[type]
  if (exact !== undefined) return exact.has(actorKind)
  const family = Object.keys(ALLOWED_ACTORS).find((key) => key.endsWith('/') && type.startsWith(key))
  return family === undefined ? false : ALLOWED_ACTORS[family].has(actorKind)
}

export const emptyState = () => ({
  engine: { mode: 'recovering', pausedReason: undefined, startedAt: undefined, boots: 0, overloadedAt: undefined },
  objectives: new Map(),
  items: new Map(),
  verifications: new Map(),
  wakes: new Map(),
  keys: new Map(),
  rejections: [],
  dispatches: [],
  verifierStarts: [],
  recent: [],
  lastSeq: 0,
})

/** Serialize the fold state to lossless JSON for the snapshot. */
export const serializeState = (state) => ({
  engine: { ...state.engine },
  objectives: [...state.objectives.values()],
  items: [...state.items.values()],
  verifications: [...state.verifications.values()],
  wakes: [...state.wakes.values()],
  keys: [...state.keys.entries()],
  rejections: state.rejections,
  dispatches: state.dispatches,
  verifierStarts: state.verifierStarts,
  lastSeq: state.lastSeq,
})

export const deserializeState = (snapshot) => {
  const state = emptyState()
  state.engine = { ...state.engine, ...(snapshot.engine ?? {}) }
  for (const objective of snapshot.objectives ?? []) state.objectives.set(objective.id, objective)
  for (const item of snapshot.items ?? []) state.items.set(item.id, item)
  for (const verification of snapshot.verifications ?? []) state.verifications.set(verification.id, verification)
  for (const wake of snapshot.wakes ?? []) state.wakes.set(wake.id, wake)
  for (const [key, value] of snapshot.keys ?? []) state.keys.set(key, value)
  state.rejections = snapshot.rejections ?? []
  state.dispatches = snapshot.dispatches ?? []
  state.verifierStarts = snapshot.verifierStarts ?? []
  state.lastSeq = snapshot.lastSeq ?? 0
  return state
}

const remember = (list, entry, max) => {
  list.push(entry)
  while (list.length > max) list.shift()
}

/**
 * Apply one event. Returns false (and leaves the state untouched) for an
 * event the fold does not accept: unknown type, disallowed actor, bad seq.
 */
export const applyEvent = (state, event) => {
  if (!EVENT_TYPES.has(event.type)) return false
  if (!actorAllowed(event.type, event.actor?.kind)) return false
  if (typeof event.seq === 'number' && state.lastSeq !== 0 && event.seq !== state.lastSeq + 1) return false
  const data = event.data ?? {}
  switch (event.type) {
    case 'engine/started':
      state.engine.mode = 'paused'
      state.engine.pausedReason = data.reason ?? 'boot'
      state.engine.startedAt = event.at
      state.engine.boots += 1
      break
    case 'engine/paused':
      state.engine.mode = 'paused'
      state.engine.pausedReason = data.reason
      break
    case 'engine/resumed':
      state.engine.mode = 'running'
      state.engine.pausedReason = undefined
      break
    case 'engine/degraded':
      state.engine.mode = 'degraded'
      state.engine.pausedReason = data.reason
      break
    case 'engine/overloaded':
      state.engine.overloadedAt = event.at
      state.engine.overloadSignal = data.signal
      break
    case 'engine/recovered':
      state.engine.overloadedAt = undefined
      state.engine.overloadSignal = undefined
      break
    case 'admission/rejected':
      remember(state.rejections, { at: event.at, code: data.code, detail: data.detail, actor: event.actor }, 50)
      break
    case 'admission/queued':
    case 'admission/dequeued':
      if (data.objective !== undefined) state.objectives.set(data.objective.id, data.objective)
      break
    case 'item/dispatched':
      if (data.item !== undefined) state.items.set(data.item.id, data.item)
      remember(state.dispatches, event.at, 500)
      if (data.objective !== undefined) state.objectives.set(data.objective.id, data.objective)
      break
    case 'verification/requested':
      if (data.verification !== undefined) state.verifications.set(data.verification.id, data.verification)
      // Binding the verifier re-emits the record; only the request itself is a run.
      if (data.bound !== true) remember(state.verifierStarts, { at: event.at, objectiveId: data.verification?.objectiveId }, 500)
      if (data.objective !== undefined) state.objectives.set(data.objective.id, data.objective)
      break
    default:
      if (data.objective !== undefined) state.objectives.set(data.objective.id, data.objective)
      if (data.item !== undefined) state.items.set(data.item.id, data.item)
      if (Array.isArray(data.items)) for (const item of data.items) state.items.set(item.id, item)
      if (data.verification !== undefined) state.verifications.set(data.verification.id, data.verification)
      if (Array.isArray(data.verifications)) for (const verification of data.verifications) state.verifications.set(verification.id, verification)
      if (data.wake !== undefined) state.wakes.set(data.wake.id, data.wake)
      break
  }
  if (typeof event.key === 'string' && event.key !== '') {
    state.keys.set(event.key, { seq: event.seq, digest: data.resultDigest })
  }
  if (typeof event.seq === 'number') state.lastSeq = event.seq
  remember(
    state.recent,
    {
      seq: event.seq,
      at: event.at,
      type: event.type,
      actor: event.actor?.kind,
      ...(data.objective?.id !== undefined ? { objectiveId: data.objective.id } : {}),
      ...(data.item?.id !== undefined ? { itemId: data.item.id } : {}),
      ...(data.code !== undefined ? { code: data.code } : {}),
    },
    20,
  )
  // Bound the wake table: terminal wakes of closed objectives drop off.
  if (state.wakes.size > 400) {
    for (const [id, wake] of state.wakes) {
      if (wake.state !== 'reserved') state.wakes.delete(id)
      if (state.wakes.size <= 200) break
    }
  }
  return true
}

export const foldEvents = (state, events) => {
  let applied = 0
  for (const event of events) {
    if (!applyEvent(state, event)) return { applied, rejected: event }
    applied += 1
  }
  return { applied }
}

export const isTerminal = (objective) => TERMINAL_STATES.has(objective?.state)
