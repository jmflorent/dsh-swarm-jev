/**
 * objective-engine — the objective/progress control plane for DeepSeek Harness.
 *
 * Two record types, one durable registry: an objective is a body of work with
 * checkable criteria, an owner, budgets, and a closed state machine; progress
 * is a work order, a status report, or a heartbeat recorded against it. The
 * engine journals every mutation, admits work within measured limits, starts
 * workers and the verifier itself, gates completion on an independent verdict
 * (plus a human ack for judgment criteria), and wakes the owning orchestrator
 * only on events — never from a self-calling loop.
 *
 * It never does stage work. The session it wakes is the orchestrator: it
 * decomposes, asks swarm_assign for personas, dispatches, accepts reports,
 * and requests verification. Mammoth classification is advisory only.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAuthority } from './lib/authority.js'
import { createClassifier } from './lib/classify.js'
import { createDispatcher } from './lib/dispatch.js'
import { createEngine } from './lib/engine.js'
import { createPump } from './lib/pump.js'
import { resolveSettings } from './lib/admission.js'
import { panelSnapshot } from './lib/status.js'
import { buildTools } from './lib/tools.js'
import { createVerifierWiring } from './lib/verify.js'

export const name = 'objective-engine'

/** Required host services; everything else is optional via ctx.get with typed degradation. */
export const inject = ['tools']

export function apply(ctx, config) {
  const options = config !== undefined && config !== null && typeof config === 'object' ? config : {}
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const dataDir = typeof options.dataDir === 'string' && options.dataDir !== '' ? options.dataDir : join(dshHome, 'storages', 'objective-engine')

  const log = (level, message, data) => {
    try {
      const logger = ctx.logger
      const line = `[objective-engine] ${message}`
      if (level === 'warn') logger?.warn?.(line, data ?? '')
      else logger?.info?.(line, data ?? '')
    } catch {
      /* Logging must never break the engine. */
    }
  }
  const optional = (service) => {
    try {
      return ctx.get?.(service)
    } catch {
      return undefined
    }
  }

  const settings = resolveSettings(options)
  const authority = createAuthority({ ctx })
  let engine
  const dispatcher = createDispatcher({ ctx, settings, log, onSettled: (entry, info) => engine?.onSettled(entry, info) })
  const verifier = createVerifierWiring({ ctx, settings, log, dispatcher, authority })
  let pump
  engine = createEngine({
    config: options,
    settings,
    dataDir,
    log,
    dispatcher,
    verifier,
    authority,
    tokenMeter: optional('tokenMeter'),
    onWork: (sessionId) => pump?.kick(sessionId, 'created'),
  })
  pump = createPump({ ctx, engine, authority, log })

  const systemone = optional('systemone')
  const decideFn = typeof systemone?.decide === 'function' ? (state, questions, signal) => systemone.decide(state, questions, signal) : undefined
  const classifier = createClassifier({ engine, decideFn, log })

  const statusParts = () => ({ core: engine.core, store: engine.store, classifier, dispatcher, lastPumpAt: pump.lastPumpAt })
  const tools = buildTools({ engine, authority, classifier, pump, statusParts })
  for (const definition of tools) ctx.effect(() => ctx.tools.register(definition))

  // Advisory auto-tagging of incoming human messages in owner sessions, after
  // the step decision so a slow decision model never delays a step.
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
        /* ignore */
      }
    }
  })

  // Service seam for other host plugins (the systemone sidebar panel).
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide('objectives', {
        snapshot: () => panelSnapshot({ core: engine.core }),
        status: () => statusParts(),
        pauseAll: (reason) => engine.pauseAll(reason ?? 'service'),
        pump: () => pump.tick(),
      })
    }
  } catch (error) {
    log('warn', 'objectives service not provided', { error: String(error?.message ?? error) })
  }

  ctx.effect(() => {
    const detachPump = pump.attach()
    const detachDispatch = dispatcher.attach()
    pump.start()
    return () => {
      pump.dispose()
      dispatcher.cancelAll('plugin unload')
      dispatcher.dispose()
      detachDispatch()
      detachPump()
      engine.close()
    }
  })

  const boot = engine.bootChanges
  log(
    'info',
    `ready · mode=${engine.mode} · journal=${engine.store.journalFile}` +
      (boot === undefined ? '' : ` · restart: ${boot.pausedObjectives} objective(s) paused, ${boot.failedItems} item(s) failed, ${boot.expiredWakes} wakeup(s) expired`) +
      ' · resume with objective_system {action:"resume"}',
  )
}
