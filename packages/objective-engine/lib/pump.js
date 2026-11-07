/**
 * The driver: turns engine state into progress prompts over time.
 *
 * Event-driven (owner idle, tracked child settled) with a coarse timer as the
 * "drop a progress prompt over time" source. Every wake is recorded before it
 * is delivered and consumes one round of that objective's budget, so an
 * unresponsive orchestrator cannot loop forever. The pump never runs while the
 * engine is paused, and it only ever prompts a session that owns work.
 */

const renderProgressPrompt = (engine, objective, sessionId) => {
  const remaining = Math.max(0, objective.budget.rounds.max - objective.budget.rounds.used)
  const tag = engine.recentTag(sessionId)
  const ready = [...engine.state.progress.values()].filter((item) => item.objectiveId === objective.id && item.state === 'ready').length
  const reported = [...engine.state.progress.values()].filter((item) => item.objectiveId === objective.id && item.state === 'reported').length
  const queued = engine.queuedCount()
  const lines = [
    `[objective-engine] progress prompt · objective ${objective.id} · round ${objective.budget.rounds.used}/${objective.budget.rounds.max}`,
    `Objective: "${objective.statement.length > 300 ? `${objective.statement.slice(0, 300)}…` : objective.statement}"`,
    `State: active · progress items: ${ready} ready, ${reported} reported${queued > 0 ? ` · ${queued} queued objective(s)` : ''}`,
  ]
  if (tag !== undefined) {
    lines.push(
      `Latest classified incoming message: ${tag.choice} (new-objective p=${typeof tag.newObjectiveP === 'number' ? tag.newObjectiveP.toFixed(2) : '?'}) — advisory only, not a commitment.`,
    )
  }
  lines.push(
    '',
    'You are the orchestrator for this objective. Continue it now:',
    '1. If you are not in swarm mode yet, enter it (swarm_enter) and route stages with swarm_assign.',
    '2. Advance the work: record the next work order with objective_plan, dispatch one subagent with a self-contained brief, or record a status report with objective_report.',
    '3. Independent verification is required: a different session must call objective_verify(objectiveId, verdict "pass", evidence) before you may call objective_complete. You cannot verify your own objective.',
    '4. If the objective is blocked, say so plainly: objective_cancel with the reason, or ask the human. Do not spend the prompt on a plan you will not execute.',
    `Budget: ${remaining} progress prompt(s) remain for this objective. Act in this turn; the engine will prompt again when it has reason to.`,
  )
  return lines.join('\n')
}

const isIdle = (agent) => agent !== undefined && agent.status === 'idle'

/**
 * Create the pump.
 * @param {{ctx: object, engine: object, log: Function}} options
 * @returns pump API: attach, start, kick, dispose.
 */
export const createPump = ({ ctx, engine, log }) => {
  const agents = new Map()
  const pending = new Map()
  const timers = new Set()
  let ticker
  let disposed = false

  const remember = (agent) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string' && sessionId !== '') agents.set(sessionId, agent)
  }

  const schedule = (sessionId, reason, delay = 500) => {
    if (disposed || !engine.settings.enabled) return
    if (pending.has(sessionId)) return
    const timer = setTimeout(() => {
      pending.delete(sessionId)
      timers.delete(timer)
      pump(sessionId, reason)
    }, Math.max(0, delay))
    timer.unref?.()
    pending.set(sessionId, timer)
    timers.add(timer)
  }

  const pump = (sessionId, reason) => {
    if (disposed || !engine.settings.enabled || engine.paused) return
    const agent = agents.get(sessionId)
    if (!isIdle(agent)) return
    const since = Date.now() - engine.lastWakeAt(sessionId)
    if (since < engine.settings.minWakeGapMs) {
      schedule(sessionId, reason, engine.settings.minWakeGapMs - since + 100)
      return
    }
    engine.blockExhausted(sessionId)
    const candidates = engine.claimable(sessionId)
    if (candidates.length === 0) return
    for (const candidate of candidates) {
      const objective = engine.spendRound(candidate.id)
      if (objective === undefined) continue
      const wake = engine.recordWake({ sessionId, objectiveId: objective.id, reason })
      const prompt = renderProgressPrompt(engine, objective, sessionId)
      try {
        agent.followup({
          content: [{ type: 'text', text: prompt }],
          source: {
            kind: 'plugin:objective-engine',
            form: 'progress',
            summary: `objective ${objective.id} round ${objective.budget.rounds.used}/${objective.budget.rounds.max} (${wake.id})`,
          },
        })
        log('info', 'progress prompt sent', {
          sessionId,
          objectiveId: objective.id,
          round: objective.budget.rounds.used,
          reason,
        })
      } catch (error) {
        log('warn', 'progress prompt rejected', {
          sessionId,
          objectiveId: objective.id,
          error: String(error?.message ?? error),
        })
      }
      return objective
    }
  }

  const tick = () => {
    if (disposed) return
    const promoted = engine.promoteQueued()
    if (promoted.length > 0) {
      for (const objectiveId of promoted) {
        const objective = engine.state.objectives.get(objectiveId)
        const owner = objective?.owner?.sessionId
        if (typeof owner === 'string') schedule(owner, 'queue', 100)
      }
    }
    if (engine.paused || !engine.settings.enabled) return
    for (const sessionId of engine.owners()) {
      const due = Date.now() - engine.lastWakeAt(sessionId) >= engine.settings.progressIntervalMs
      if (due) schedule(sessionId, 'timer', 50)
    }
  }

  const attach = () => {
    const disposers = []
    disposers.push(
      ctx.on('agent/status', (payload = {}) => {
        remember(payload.agent)
        if (payload.status === 'idle' && typeof payload.agent?.session?.id === 'string') {
          schedule(payload.agent.session.id, 'idle')
        }
      }),
    )
    disposers.push(
      ctx.on('agent/pre-step', async (payload, next) => {
        remember(payload?.agent)
        return await next()
      }),
    )
    disposers.push(
      ctx.on('subagent/end', (info, parent) => {
        const sessionId = parent?.session?.id ?? info?.parent?.session?.id
        if (typeof sessionId === 'string' && engine.hasOwner(sessionId)) schedule(sessionId, 'child-end')
      }),
    )
    return () => {
      for (const disposer of disposers) {
        try {
          disposer?.()
        } catch {
          /* Listener teardown never blocks the plugin. */
        }
      }
    }
  }

  const start = () => {
    if (ticker !== undefined || disposed) return
    ticker = setInterval(tick, engine.settings.tickMs)
    ticker.unref?.()
  }

  const kick = (sessionId) => {
    if (typeof sessionId === 'string') schedule(sessionId, 'resume', 100)
    else for (const owner of engine.owners()) schedule(owner, 'resume', 100)
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

  return { attach, start, kick, dispose, agents }
}
