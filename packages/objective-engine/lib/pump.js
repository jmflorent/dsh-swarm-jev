/**
 * The driver (design §5): a serialized pump that turns engine state into at
 * most one wakeup per owner session, a pre-step fence that admits or rejects
 * engine prompts, and one coarse sweep timer for deadlines.
 *
 * Rounds are consumed when a wakeup is admitted into a model step, never
 * when it is reserved, so a stale or superseded prompt costs nothing.
 */
import { loadSnapshot } from './admission.js'
import { renderAck, renderBlocked, renderFailure, renderPlan, renderVerdict, renderWork } from './prompts.js'

const SOURCE_KIND = 'objective-engine'
const isIdle = (agent) => agent !== undefined && agent !== null && agent.status === 'idle'

export const createPump = ({ ctx, engine, authority, log, now = Date.now }) => {
  const agents = new Map()
  const pending = new Map()
  const timers = new Set()
  let ticker
  let disposed = false
  let lastPumpAt
  let hotSweeps = 0

  const remember = (agent) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string' && sessionId !== '') agents.set(sessionId, agent)
  }
  const agentFor = (sessionId) => agents.get(sessionId) ?? authority?.agentFor(sessionId)

  const schedule = (sessionId, reason, delay = 50) => {
    if (disposed || typeof sessionId !== 'string') return
    if (pending.has(sessionId)) return
    const timer = setTimeout(() => {
      pending.delete(sessionId)
      timers.delete(timer)
      try {
        pump(sessionId, reason)
      } catch (error) {
        log('warn', 'pump failed', { sessionId, error: String(error?.message ?? error) })
      }
    }, Math.max(0, delay))
    timer.unref?.()
    pending.set(sessionId, timer)
    timers.add(timer)
  }

  const reservedFor = (sessionId) => [...engine.state.wakes.values()].filter((wake) => wake.sessionId === sessionId && wake.state === 'reserved')
  const lastWakeAt = (sessionId) => {
    let latest = 0
    for (const wake of engine.state.wakes.values()) {
      if (wake.sessionId === sessionId) latest = Math.max(latest, Date.parse(wake.reservedAt))
    }
    return latest
  }

  /** Pick the single most urgent action for one session (design §5.2 priority). */
  const selectAction = (sessionId, reason) => {
    const nowMs = now()
    const load = loadSnapshot(engine.state, engine.settings, nowMs)
    const objectives = engine.objectivesOf(sessionId).filter((objective) => !['completed', 'cancelled', 'proposed', 'queued'].includes(objective.state))
    const byPriority = [...objectives].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
    const candidates = []
    for (const objective of byPriority) {
      const items = engine.itemsOf(objective.id)
      const verification = objective.verdictNotice ? engine.state.verifications.get(objective.verdictNotice.verificationId) : undefined
      if (objective.state === 'awaiting-human') {
        const remindDue = objective.ackRemindedAt === undefined || nowMs - Date.parse(objective.ackRemindedAt) >= engine.settings.limits.ackReminderMs
        if ((objective.verdictNotice && !objective.verdictNotice.notified) || remindDue) candidates.push({ rank: 0, form: 'ack', objective, verification })
        continue
      }
      if (objective.verdictNotice && !objective.verdictNotice.notified) candidates.push({ rank: 1, form: 'verdict', objective, verification })
      const failed = items.filter((item) => item.state === 'failed' && item.notified === false)
      if (failed.length > 0 && objective.state !== 'blocked') candidates.push({ rank: 2, form: 'failure', objective, items: failed })
      if (objective.state === 'blocked') {
        if (!objective.blockedNotifiedAt) candidates.push({ rank: 4, form: 'blocked', objective })
        continue
      }
      if (objective.state !== 'active' || !objective.armed) continue
      const queued = items.filter((item) => item.state === 'queued')
      const reported = items.filter((item) => item.state === 'reported' && item.kind === 'work-order')
      const open = items.filter((item) => ['queued', 'dispatched', 'reported'].includes(item.state) && item.kind === 'work-order')
      if (reported.length > 0 || (queued.length > 0 && !load.backpressure)) {
        candidates.push({ rank: 3, form: 'work', objective, items })
        continue
      }
      if (open.length === 0) {
        const due = nowMs - lastWakeAt(sessionId) >= engine.settings.timing.progressIntervalMs
        const fresh = lastWakeAt(sessionId) === 0 || ['resume', 'child-end', 'created', 'verdict'].includes(reason)
        if (due || fresh) candidates.push({ rank: 5, form: 'plan', objective, items })
      }
    }
    candidates.sort((a, b) => a.rank - b.rank)
    return candidates[0]
  }

  const render = (action, wake) => {
    const { objective } = action
    const criteria = objective.criteria
    switch (action.form) {
      case 'work':
        return renderWork({ objective, wake, items: action.items, criteria })
      case 'plan':
        return renderPlan({ objective, wake, items: action.items, criteria })
      case 'verdict':
        return renderVerdict({ objective, wake, verification: action.verification ?? { id: objective.verdictNotice?.verificationId, verdict: { kind: objective.verdictNotice?.kind } } })
      case 'failure':
        return renderFailure({ objective, wake, items: action.items }).replace('{max}', String(engine.settings.limits.maxConsecutiveWorkerFailures))
      case 'ack':
        return renderAck({ objective, wake, verification: action.verification })
      case 'blocked':
        return renderBlocked({ objective, wake })
      default:
        return renderPlan({ objective, wake, items: action.items ?? [], criteria })
    }
  }

  const pump = (sessionId, reason) => {
    if (disposed || engine.paused) return
    lastPumpAt = now()
    const agent = agentFor(sessionId)
    if (!isIdle(agent) || typeof agent.followup !== 'function') return
    if (reservedFor(sessionId).length > 0) return
    const since = now() - lastWakeAt(sessionId)
    if (since < engine.settings.timing.minWakeGapMs) {
      schedule(sessionId, reason, engine.settings.timing.minWakeGapMs - since + 50)
      return
    }
    const action = selectAction(sessionId, reason)
    if (action === undefined) return
    const consumesRound = action.form !== 'blocked'
    if (consumesRound && action.objective.budget.rounds.used >= action.objective.budget.rounds.max) {
      // Exhausted: block (once) instead of looping; the block notice follows on the next pump.
      engine.spendRound(action.objective.id)
      schedule(sessionId, 'blocked', 50)
      return
    }
    const notified = engine.markNotified({
      objective: action.objective,
      items: action.form === 'failure' ? action.items : undefined,
      verdict: action.form === 'verdict' || action.form === 'ack',
      blocked: action.form === 'blocked',
      ack: action.form === 'ack',
    })
    const wake = engine.reserveWake({ objectiveId: notified.id, sessionId, form: action.form, revision: notified.revision, objectiveState: notified.state })
    const text = render({ ...action, objective: notified }, wake)
    try {
      agent.followup({
        content: [{ type: 'text', text }],
        source: { kind: SOURCE_KIND, form: action.form, objectiveId: notified.id, wakeId: wake.id, occurrence: wake.occurrence, summary: `objective ${notified.id} ${action.form} #${wake.occurrence}` },
      })
      log('info', 'wakeup queued', { sessionId, objectiveId: notified.id, form: action.form, occurrence: wake.occurrence, reason })
    } catch (error) {
      engine.expireWake(wake, `followup rejected: ${String(error?.message ?? error)}`)
      log('warn', 'wakeup rejected by the agent', { sessionId, objectiveId: notified.id, error: String(error?.message ?? error) })
    }
  }

  /** Pre-step fence: admit, supersede, or reject engine-authored messages. */
  const fence = async (payload, next) => {
    remember(payload?.agent)
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const engineMessages = messages.filter((message) => message?.source?.kind === SOURCE_KIND)
    if (engineMessages.length === 0) return await next()
    const humanPresent = messages.some((message) => message?.source?.kind === 'user')
    let reject = false
    for (const message of engineMessages) {
      const wake = engine.state.wakes.get(message.source.wakeId)
      if (wake === undefined || wake.state !== 'reserved') {
        reject = reject || !humanPresent
        continue
      }
      const objective = engine.state.objectives.get(wake.objectiveId)
      const stale = engine.paused || objective === undefined || objective.state !== wake.objectiveState || (['work', 'plan'].includes(wake.form) && !objective.armed)
      if (humanPresent) {
        engine.supersedeWake(wake, 'human message in the same batch')
        continue
      }
      if (stale) {
        engine.expireWake(wake, 'stale: objective changed before the step entered')
        reject = true
        continue
      }
      if (wake.form !== 'blocked') {
        const spent = engine.spendRound(wake.objectiveId)
        if (spent === undefined) {
          engine.expireWake(wake, 'budget exhausted at admission')
          reject = true
          continue
        }
      }
      engine.admitWake(wake)
    }
    if (reject) {
      log('info', 'stale engine wakeup rejected', { sessionId: payload?.agent?.session?.id })
      schedule(payload?.agent?.session?.id, 'rejected', engine.settings.timing.minWakeGapMs)
      return { kind: 'reject' }
    }
    return await next()
  }

  const tick = () => {
    if (disposed) return
    try {
      const changed = engine.sweep()
      for (const objectiveId of changed) {
        const owner = engine.state.objectives.get(objectiveId)?.owner?.sessionId
        if (typeof owner === 'string') schedule(owner, 'sweep', 100)
      }
      if (engine.paused) return
      const load = loadSnapshot(engine.state, engine.settings, now())
      hotSweeps = load.hot ? hotSweeps + 1 : 0
      if (hotSweeps >= 2 && (engine.state.engine.overloadedAt === undefined || now() - Date.parse(engine.state.engine.overloadedAt) > 3_600_000)) {
        engine.core.append('engine/overloaded', { kind: 'engine' }, { signal: load.ratios })
        log('warn', 'overload signal', load.ratios)
      } else if (!load.hot && engine.state.engine.overloadedAt !== undefined) {
        engine.core.append('engine/recovered', { kind: 'engine' }, {})
      }
      for (const sessionId of engine.owners()) {
        if (now() - lastWakeAt(sessionId) >= engine.settings.timing.progressIntervalMs) schedule(sessionId, 'timer', 50)
      }
    } catch (error) {
      log('warn', 'sweep failed', { error: String(error?.message ?? error) })
    }
  }

  const attach = () => {
    const disposers = []
    const on = (event, handler) => {
      try {
        disposers.push(ctx.on(event, handler))
      } catch (error) {
        log('warn', `listener for ${event} not installed`, { error: String(error?.message ?? error) })
      }
    }
    on('agent/status', (payload = {}) => {
      remember(payload.agent)
      const sessionId = payload.agent?.session?.id
      if (payload.status === 'idle' && typeof sessionId === 'string' && engine.hasOwner(sessionId)) schedule(sessionId, 'idle')
    })
    on('agent/pre-step', fence)
    on('agent/disposed', (payload = {}) => {
      const sessionId = payload.agent?.session?.id
      if (typeof sessionId === 'string') agents.delete(sessionId)
    })
    on('subagent/end', (_info, parent) => {
      const sessionId = parent?.session?.id
      if (typeof sessionId === 'string' && engine.hasOwner(sessionId)) schedule(sessionId, 'child-end', 400)
    })
    return () => {
      for (const disposer of disposers) {
        try {
          disposer?.()
        } catch {
          /* ignore */
        }
      }
    }
  }

  const start = () => {
    if (ticker !== undefined || disposed) return
    ticker = setInterval(tick, engine.settings.timing.tickMs)
    ticker.unref?.()
  }
  const kick = (sessionId, reason = 'resume') => {
    if (typeof sessionId === 'string') schedule(sessionId, reason, 100)
    else for (const owner of engine.owners()) schedule(owner, reason, 100)
  }
  const dispose = () => {
    disposed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    pending.clear()
    if (ticker !== undefined) clearInterval(ticker)
    ticker = undefined
    agents.clear()
  }

  return {
    attach,
    start,
    kick,
    tick,
    pump,
    fence,
    dispose,
    agents,
    get lastPumpAt() {
      return lastPumpAt
    },
  }
}
