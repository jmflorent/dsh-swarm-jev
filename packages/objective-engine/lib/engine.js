/**
 * Engine composition: store + fold + transitions + admission behind one
 * service API (design §8.2). The host adapters (authority, dispatcher,
 * verifier wiring, token meter) are injected so the same engine runs under a
 * fake context in tests.
 */
import { applyEvent, deserializeState, emptyState, foldEvents, serializeState } from './fold.js'
import { COUNTED_ACTIVE, clampText, clone, digest, iso } from './records.js'
import { resolveSettings } from './admission.js'
import { openStore } from './store.js'
import {
  ackObjective,
  addItem,
  bindVerifier,
  controlObjective,
  createObjective,
  decideItem,
  dispatchable,
  expireAllWakes,
  fail,
  itemsOf,
  markDispatched,
  objectiveView,
  pauseEngine,
  promoteQueued,
  reconcileAfterRestart,
  recordVerdict,
  reportItem,
  requestVerification,
  reserveWake,
  resumeEngine,
  setWakeState,
  settleChild,
  spendRound,
  sweepObjective,
} from './transition.js'

const engineActor = { kind: 'engine' }

/**
 * @param {object} options
 * @param {object} options.config row config
 * @param {string} options.dataDir storage directory
 * @param {() => number} [options.now]
 * @param {Function} [options.log]
 * @param {object} [options.dispatcher] createDispatcher() result
 * @param {object} [options.verifier] createVerifierWiring() result
 * @param {object} [options.authority] createAuthority() result
 * @param {object} [options.tokenMeter] { measure(session) }
 * @param {Function} [options.onWork] called with a session id when that owner may need a prompt
 */
export const createEngine = ({ config, settings: provided, dataDir, now = Date.now, log = () => {}, dispatcher, verifier, authority, tokenMeter, onWork, pid }) => {
  const settings = provided ?? resolveSettings(config)
  const store = openStore({ dataDir, snapshotEvery: settings.snapshotEvery, now, pid })
  const state = store.snapshot === undefined ? emptyState() : deserializeState(store.snapshot.state)
  const folded = foldEvents(state, store.events)
  let foldError
  if (folded.rejected !== undefined) foldError = `fold rejected event seq ${folded.rejected.seq} (${folded.rejected.type})`

  const tokens =
    tokenMeter !== undefined && authority !== undefined
      ? {
          baseline: (sessionId) => measure(sessionId),
          measure: (sessionId) => measure(sessionId),
        }
      : undefined
  const measure = (sessionId) => {
    try {
      const agent = authority?.agentFor(sessionId)
      const value = agent === undefined ? undefined : tokenMeter.measure(agent.session)?.totalTokens
      return typeof value === 'number' ? value : undefined
    } catch {
      return undefined
    }
  }

  const core = {
    state,
    settings,
    now,
    digest,
    tokens,
    append(type, actor, data, key) {
      const event = {
        at: iso(now()),
        type,
        actor: { kind: actor?.kind ?? 'engine', ...(actor?.sessionId === undefined ? {} : { sessionId: actor.sessionId }), ...(actor?.presetId === undefined ? {} : { presetId: actor.presetId }) },
        ...(key === undefined ? {} : { key }),
        data,
      }
      const written = store.append(event)
      if (!applyEvent(state, written)) throw new Error(`fold rejected a freshly written event: ${type}`)
      if (store.snapshotDue()) store.writeSnapshot(serializeState(state))
      return written
    },
    reject(actor, code, detail) {
      try {
        core.append('admission/rejected', actor?.kind === 'human' ? actor : { kind: 'engine' }, { code, detail: clone(detail) ?? code })
      } catch {
        /* a rejection record is best effort */
      }
    },
    cancelChild: (itemId, reason) => dispatcher?.cancelChild(itemId, reason) ?? 0,
    cancelChildren: (objectiveId, reason) => dispatcher?.cancelChildren(objectiveId, reason) ?? 0,
  }

  // --- boot ------------------------------------------------------------------
  let bootChanges
  if (store.degraded !== undefined || foldError !== undefined) {
    state.engine.mode = 'degraded'
    state.engine.pausedReason = store.degraded ?? foldError
    log('warn', `engine degraded: ${state.engine.pausedReason}`)
  } else {
    core.append('engine/started', engineActor, { reason: store.pausedSentinel() ? 'paused-sentinel' : 'process-start', repaired: store.repaired, snapshotUsed: store.snapshotUsed })
    bootChanges = reconcileAfterRestart(core)
  }

  const guard = () => {
    if (!settings.enabled) return fail('engine-disabled', 'the objective engine is disabled in its row config')
    if (state.engine.mode === 'degraded') return fail('engine-degraded', state.engine.pausedReason ?? 'degraded (read-only)')
    return undefined
  }
  const wrap = (fn) => (...args) => {
    const blocked = guard()
    if (blocked !== undefined) return blocked
    try {
      return fn(...args)
    } catch (error) {
      if (error?.code === 'persistence-failed' || error?.code === 'engine-degraded') {
        state.engine.mode = 'degraded'
        state.engine.pausedReason = error.message
        return fail(error.code, error.message)
      }
      throw error
    }
  }
  const wrapAsync = (fn) => async (...args) => {
    const blocked = guard()
    if (blocked !== undefined) return blocked
    try {
      return await fn(...args)
    } catch (error) {
      if (error?.code === 'persistence-failed' || error?.code === 'engine-degraded') {
        state.engine.mode = 'degraded'
        state.engine.pausedReason = error.message
        return fail(error.code, error.message)
      }
      throw error
    }
  }

  const objectivesOf = (sessionId) => [...state.objectives.values()].filter((objective) => objective.owner.sessionId === sessionId)
  const kick = (sessionId) => {
    try {
      onWork?.(sessionId)
    } catch {
      /* the pump must never break a command */
    }
  }

  const engine = {
    settings,
    state,
    store,
    core,
    get mode() {
      return state.engine.mode
    },
    get paused() {
      return state.engine.mode !== 'running'
    },
    bootChanges,
    objectiveView: (objective) => objectiveView(state, objective),
    activeFor: (sessionId) => objectivesOf(sessionId).filter((objective) => COUNTED_ACTIVE.has(objective.state)),
    hasOwner: (sessionId) => objectivesOf(sessionId).some((objective) => !['completed', 'cancelled'].includes(objective.state)),
    owners: () => [...new Set([...state.objectives.values()].filter((objective) => !['completed', 'cancelled'].includes(objective.state)).map((objective) => objective.owner.sessionId))],
    objectivesOf,
    itemsOf: (objectiveId) => itemsOf(state, objectiveId),
    recordProposal: (record) => store.appendAdvisory(record),

    // --- commands --------------------------------------------------------------
    create: wrap((input, actor) => {
      const result = createObjective(core, input, actor)
      if (result.ok && result.objective.state === 'active') kick(actor.sessionId)
      return result
    }),
    control: wrap((input, actor) => {
      if (actor?.human !== true) return fail('unauthorized', 'objective_control requires a direct human message in the current turn of a top-level session')
      const result = controlObjective(core, input, actor)
      if (result.ok) kick(result.objective?.owner?.sessionId)
      return result
    }),
    plan: wrap((input, actor) => {
      const action = typeof input?.action === 'string' ? input.action : 'add'
      const result = action === 'add' ? addItem(core, input, actor) : decideItem(core, { ...input, action }, actor)
      if (result.ok) kick(actor.sessionId)
      return result
    }),
    dispatch: wrapAsync(async (input, actor) => {
      const check = dispatchable(core, input, actor)
      if (!check.ok) return check
      const { item, objective } = check
      const persona = clampText(input?.persona, 80)
      const brief = clampText(input?.brief, 12000)
      if (persona === '') return fail('record-incomplete', 'objective_dispatch needs the persona swarm_assign returned')
      if (brief === '') return fail('record-incomplete', 'objective_dispatch needs a self-contained brief for the child')
      if (item.assignedPersona !== undefined && item.assignedPersona !== persona && input?.reassign !== true) {
        return fail('persona-mismatch', `the item was planned for ${item.assignedPersona}; pass reassign:true to change it`)
      }
      if (dispatcher === undefined || !dispatcher.available()) {
        if (input?.external === true) {
          const dispatched = markDispatched(core, item, { kind: 'external', sessionId: 'pending' }, persona, actor)
          return { ok: true, item: clone(dispatched), fallback: true, note: 'subagent service unavailable: start the child yourself with the subagent tool, then bind it with objective_report {itemId, childSessionId}' }
        }
        return fail('dispatch-unavailable', 'the subagent service is not composed; pass external:true to use the manager-driven fallback')
      }
      const parent = authority?.agentFor(objective.owner.sessionId) ?? actor?.agent
      const started = await dispatcher.dispatchWorker({ objective, item, persona, brief, instructions: clampText(input?.instructions, 4000) || undefined, parent })
      if (!started.ok) return started
      const dispatched = markDispatched(core, item, { kind: 'child', sessionId: started.childId, presetId: started.preset }, persona, actor)
      return { ok: true, item: clone(dispatched), childSessionId: started.childId }
    }),
    report: wrap((input, actor) => {
      const result = reportItem(core, input, actor)
      if (result.ok) {
        const objective = state.objectives.get(clampText(input?.objectiveId, 80))
        kick(objective?.owner?.sessionId)
      }
      return result
    }),
    verify: wrapAsync(async (input, actor) => {
      const objective = state.objectives.get(clampText(input?.objectiveId, 80))
      if (objective === undefined) return fail('objective-not-found', 'unknown objective')
      const parent = authority?.agentFor(objective.owner.sessionId) ?? actor?.agent
      const pin = verifier === undefined ? { commit: null, pinned: false, reason: 'pinning-unavailable' } : await verifier.pinCommit(parent)
      const requested = requestVerification(core, input, actor, pin)
      if (!requested.ok) return requested
      const record = state.verifications.get(requested.verification.id)
      if (verifier === undefined || dispatcher === undefined || !dispatcher.available()) {
        const bound = bindVerifier(core, record, { kind: 'external' })
        return { ...requested, verification: clone(bound), note: 'no subagent service: a different session (not the owner, different preset) must call objective_verdict with evidence' }
      }
      const started = await verifier.startVerifier({ objective: state.objectives.get(objective.id), verification: record })
      if (!started.ok) {
        const bound = bindVerifier(core, record, { kind: 'external', startFailure: started.code })
        return { ...requested, verification: clone(bound), note: `verifier child could not be started (${started.code}); an independent session must call objective_verdict` }
      }
      const bound = bindVerifier(core, record, started.verifier)
      return { ...requested, verification: clone(bound), verifierSessionId: started.verifier.sessionId }
    }),
    verdict: wrap((input, actor) => {
      const result = recordVerdict(core, input, actor)
      if (result.ok) kick(state.objectives.get(result.objective.id)?.owner?.sessionId)
      return result
    }),
    ack: wrap((input, actor) => {
      const result = ackObjective(core, input, actor)
      if (result.ok) kick(result.objective?.owner?.sessionId)
      return result
    }),
    system: wrap((input, actor) => {
      const action = input?.action
      if (action === 'status') return { ok: true }
      if (action === 'pause') {
        if (actor?.root !== true && actor?.human !== true && actor?.kind !== 'engine') return fail('unauthorized', 'pause requires a top-level session')
        const result = pauseEngine(core, actor?.human ? actor : engineActor, input?.reason)
        const cancelled = dispatcher?.cancelAll('engine paused') ?? 0
        return { ...result, cancelledChildren: cancelled }
      }
      if (action === 'resume') {
        if (actor?.human !== true) return fail('unauthorized', 'resume requires a direct human message in the current turn of a top-level session')
        if (store.pausedSentinel()) return fail('paused-sentinel', `remove ${store.dataDir}/PAUSED to allow resuming`)
        const result = resumeEngine(core, actor, { resumeAll: input?.resumeAll === true })
        if (result.ok) for (const owner of engine.owners()) kick(owner)
        return result
      }
      return fail('action-invalid', 'action must be resume, pause, or status')
    }),
    pauseAll: (reason) => {
      const blocked = guard()
      if (blocked !== undefined) return blocked
      const result = pauseEngine(core, engineActor, reason)
      const cancelled = dispatcher?.cancelAll(reason ?? 'pauseAll') ?? 0
      return { ...result, cancelledChildren: cancelled }
    },

    // --- driver support ----------------------------------------------------------
    spendRound: (objectiveId) => spendRound(core, objectiveId),
    reserveWake: (input) => reserveWake(core, input),
    admitWake: (wake) => setWakeState(core, wake, 'admitted'),
    expireWake: (wake, reason) => setWakeState(core, wake, 'expired', { reason }),
    supersedeWake: (wake, reason) => setWakeState(core, wake, 'superseded', { reason }),
    expireAllWakes: (reason) => expireAllWakes(core, reason),
    /** Mark notices as delivered, carried on the wake reservation itself. */
    markNotified: ({ objective, items, verdict, blocked, ack }) => {
      const nowIso = iso(now())
      const nextObjective = {
        ...objective,
        ...(verdict && objective.verdictNotice ? { verdictNotice: { ...objective.verdictNotice, notified: true } } : {}),
        ...(blocked ? { blockedNotifiedAt: nowIso } : {}),
        ...(ack ? { ackRemindedAt: nowIso } : {}),
        revision: objective.revision + 1,
        updatedAt: nowIso,
      }
      const nextItems = (items ?? []).map((item) => ({ ...item, notified: true, revision: item.revision + 1, updatedAt: nowIso }))
      core.append('objective/state-changed', engineActor, { objective: nextObjective, items: nextItems, code: 'notice' })
      return nextObjective
    },
    promoteQueued: () => promoteQueued(core),
    sweep: () => {
      const blocked = guard()
      if (blocked !== undefined) return []
      const changed = []
      for (const objective of [...state.objectives.values()]) {
        const before = objective.state
        const after = sweepObjective(core, objective, tokens?.measure)
        if (after.state !== before) changed.push(after.id)
      }
      changed.push(...promoteQueued(core))
      return changed
    },
    /** Dispatcher settlement: worker report/failure or verifier death. */
    onSettled: (entry, info) => {
      const blocked = guard()
      if (blocked !== undefined) return
      if (entry.role === 'worker') {
        const item = state.items.get(entry.itemId)
        if (item !== undefined) settleChild(core, item, info)
      } else if (entry.role === 'verifier') {
        const verification = state.verifications.get(entry.verificationId)
        if (verification !== undefined && verification.state === 'requested') {
          recordVerdict(core, { verificationId: verification.id, verdict: 'inconclusive', reason: `verifier ended without a verdict (${info?.stopReason ?? 'ended'})` }, { kind: 'engine', sessionId: verification.verifier?.sessionId ?? 'engine', presetId: verification.verifier?.presetId })
        }
      }
      const objective = state.objectives.get(entry.objectiveId)
      kick(objective?.owner?.sessionId)
    },
    snapshotNow: () => store.writeSnapshot(serializeState(state)),
    close: () => {
      try {
        if (state.engine.mode !== 'degraded') store.writeSnapshot(serializeState(state))
      } catch {
        /* best effort */
      }
      store.close()
    },
  }
  return engine
}
