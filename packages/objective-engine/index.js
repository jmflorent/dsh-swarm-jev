/**
 * objective-engine — a durable objective/progress orchestrator driver.
 *
 * Two record types, one loop: an objective is a body of work with checkable
 * criteria; progress items are work orders and status reports. The engine
 * journals both, an independent verifier gates completion, and a driver drops
 * progress prompts into the owning orchestrator session over time until every
 * objective is completed, cancelled, blocked, or out of budget.
 *
 * It never does stage work itself: the orchestrator decomposes, dispatches
 * subagents (with swarm mode + swarm_assign when desired), verifies, and
 * integrates. The engine only tracks state, enforces the budget/admission
 * limits, and keeps the loop alive.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from './lib/engine.js'
import { createPump } from './lib/pump.js'
import { createClassifier } from './lib/classify.js'
import { buildTools } from './lib/tools.js'

export const name = 'objective-engine'

/** The tool registry is the only host service the engine itself needs. */
export const inject = ['tools']

export function apply(ctx, config) {
  const options = config !== undefined && config !== null && typeof config === 'object' ? config : {}
  const dshHome =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  const dataDir =
    typeof options.dataDir === 'string' && options.dataDir !== ''
      ? options.dataDir
      : join(dshHome, 'storages', 'objective-engine')
  const journalFile = join(dataDir, 'journal.jsonl')

  const log = (level, message, data) => {
    try {
      const logger = ctx.logger
      if (level === 'warn') logger?.warn?.(`[objective-engine] ${message}`, data ?? '')
      else logger?.info?.(`[objective-engine] ${message}`, data ?? '')
    } catch {
      /* Logging must never break the engine. */
    }
  }

  let pump
  const engine = createEngine({
    config: options,
    journalFile,
    onWorkAvailable: (sessionId) => pump?.kick(sessionId),
  })

  const systemone = ctx.get?.('systemone')
  const decide =
    typeof systemone?.decide === 'function'
      ? (state, questions, signal) => systemone.decide(state, questions, signal)
      : undefined

  pump = createPump({ ctx, engine, log })
  const classifier = createClassifier({ engine, decide, log })
  const tools = buildTools({ ctx, engine, classifier, pump })
  for (const definition of tools) ctx.effect(() => ctx.tools.register(definition))

  // Advisory classification of incoming user messages in owner sessions.
  // It runs after the step decision so a slow decision model never delays work.
  ctx.effect(() => {
    const off = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        classifier.onPreStep(payload)
      } catch (error) {
        log('warn', 'classification hook failed', { error: String(error?.message ?? error) })
      }
      return decision
    })
    return () => {
      try {
        off?.()
      } catch {
        /* Listener teardown never blocks the plugin. */
      }
    }
  })

  // Read-only snapshot for the swarm panel: objectives without prompts,
  // arguments, evidence bodies, or session content.
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide('objectives', {
        snapshot: () => engine.snapshot(),
        status: () => engine.status(),
      })
    }
  } catch (error) {
    log('warn', 'objectives service not provided', { error: String(error?.message ?? error) })
  }

  ctx.effect(() => {
    const detach = pump.attach()
    pump.start()
    return () => {
      pump.dispose()
      detach()
    }
  })

  log(
    'info',
    `ready · journal=${journalFile} · active=${engine.activeCount()} · paused=${engine.paused} (resume with objective_system)`,
  )
}
