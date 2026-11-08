/**
 * Read-only status payloads: the objective_status tool result (design §9.2)
 * and the compact panel snapshot the systemone sidebar renders.
 */
import { loadSnapshot, pendingWakes } from './admission.js'
import { itemsOf, objectiveView } from './transition.js'

const counts = (state) => {
  const out = { proposed: 0, queued: 0, active: 0, paused: 0, verifying: 0, 'awaiting-human': 0, blocked: 0, completed: 0, cancelled: 0 }
  for (const objective of state.objectives.values()) out[objective.state] = (out[objective.state] ?? 0) + 1
  return out
}

export const engineStatus = ({ core, store, classifier, dispatcher, lastPumpAt }) => {
  const nowMs = core.now()
  const load = loadSnapshot(core.state, core.settings, nowMs, store.journalBytes())
  const wakes = [...core.state.wakes.values()]
  return {
    mode: core.state.engine.mode,
    ...(core.state.engine.pausedReason === undefined ? {} : { pausedReason: core.state.engine.pausedReason }),
    ...(core.state.engine.startedAt === undefined ? {} : { startedAt: core.state.engine.startedAt }),
    ...(lastPumpAt === undefined ? {} : { lastPumpAt: new Date(lastPumpAt).toISOString() }),
    enabled: core.settings.enabled,
    degraded: store.degraded ?? null,
    pausedSentinel: store.pausedSentinel(),
    counts: counts(core.state),
    limits: { ...core.settings.limits },
    timing: { ...core.settings.timing },
    load: { inFlightItems: load.inFlightItems, verifierQueueDepth: load.verifierQueueDepth, pendingWakeups: load.pendingWakeups, dispatchRate1h: load.dispatchRate1h, verifierRate24h: load.verifierRate24h, journalBytes: load.journalBytes, backpressure: load.backpressure, ...(core.state.engine.overloadedAt === undefined ? {} : { overloadedAt: core.state.engine.overloadedAt, overloadSignal: core.state.engine.overloadSignal }) },
    trackedChildren: dispatcher === undefined ? 0 : dispatcher.children.size,
    dispatchAvailable: dispatcher === undefined ? false : dispatcher.available(),
    journal: { file: store.journalFile, lastSeq: store.lastSeq, hash: store.lastHash.slice(0, 16), repaired: store.repaired, snapshotUsed: store.snapshotUsed },
    classifier: classifier === undefined ? { enabled: false, available: false } : classifier.status(),
    wakeups: { pending: pendingWakes(core.state).length, recent: wakes.slice(-20).map(({ id, objectiveId, form, occurrence, state, reservedAt }) => ({ id, objectiveId, form, occurrence, state, reservedAt })) },
    rejections: core.state.rejections.slice(-10),
    recentEvents: core.state.recent.slice(-20),
  }
}

/** Full tool payload: engine + redacted records. */
export const fullStatus = (parts, { sessionId, objectiveId } = {}) => {
  const { core, store } = parts
  const objectives = [...core.state.objectives.values()].filter((objective) => objectiveId === undefined || objective.id === objectiveId)
  const items = [...core.state.items.values()].filter((item) => objectiveId === undefined || item.objectiveId === objectiveId)
  const verifications = [...core.state.verifications.values()].filter((verification) => objectiveId === undefined || verification.objectiveId === objectiveId)
  return {
    ok: true,
    engine: engineStatus(parts),
    objectives: objectives.map((objective) => objectiveView(core.state, objective)),
    items: items.slice(-200).map((item) => ({ ...item, evidence: (item.evidence ?? []).map((entry) => ({ ...entry, stdoutExcerpt: undefined })) })),
    verifications: verifications.slice(-50).map((verification) => ({ ...verification, evidence: verification.evidence.map((entry) => ({ criterionId: entry.criterionId, kind: entry.kind, ...(entry.command ? { command: entry.command } : {}), ...(typeof entry.exitCode === 'number' ? { exitCode: entry.exitCode } : {}), ...(entry.path ? { path: entry.path } : {}), ...(entry.failed ? { failed: true } : {}) })) })),
    proposals: store.readAdvisory(10),
    ...(sessionId === undefined ? {} : { caller: sessionId }),
  }
}

/** Compact snapshot for the sidebar panel. */
export const panelSnapshot = ({ core }) => ({
  paused: core.state.engine.mode !== 'running',
  mode: core.state.engine.mode,
  counts: counts(core.state),
  objectives: [...core.state.objectives.values()]
    .filter((objective) => !['completed', 'cancelled'].includes(objective.state))
    .slice(-12)
    .map((objective) => ({
      id: objective.id,
      statement: objective.statement.slice(0, 240),
      state: objective.state,
      armed: objective.armed,
      rounds: objective.budget.rounds.used,
      maxRounds: objective.budget.rounds.max,
      progress: itemsOf(core.state, objective.id).length,
      ...(objective.blockedReason ? { blocked: objective.blockedReason.code } : {}),
    })),
})
