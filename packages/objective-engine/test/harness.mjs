/** Compose the engine over a fake context the way index.js does, with an injectable clock. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthority } from '../lib/authority.js'
import { createClassifier } from '../lib/classify.js'
import { createDispatcher } from '../lib/dispatch.js'
import { createEngine } from '../lib/engine.js'
import { createPump } from '../lib/pump.js'
import { resolveSettings } from '../lib/admission.js'
import { buildTools } from '../lib/tools.js'
import { createVerifierWiring } from '../lib/verify.js'

export const tempDir = () => mkdtempSync(join(tmpdir(), 'objective-engine-'))

export const baseConfig = (overrides = {}) => ({
  maxActiveObjectives: 2,
  maxQueuedObjectives: 2,
  maxObjectivesPerOwnerSession: 4,
  maxRoundsPerObjective: 4,
  minWakeGapMs: 1,
  progressIntervalMs: 60_000,
  tickMs: 3_600_000,
  stallTimeoutMs: 600_000,
  ...overrides,
})

export const compose = ({ ctx, clock, config = baseConfig(), dataDir = tempDir(), pid, decide, log = () => {} } = {}) => {
  const settings = resolveSettings(config)
  const authority = createAuthority({ ctx })
  let engine
  const dispatcher = createDispatcher({ ctx, settings, log, onSettled: (entry, info) => engine.onSettled(entry, info) })
  const verifier = createVerifierWiring({ ctx, settings, log, dispatcher, authority })
  let pump
  engine = createEngine({ config, settings, dataDir, now: clock, log, dispatcher, verifier, authority, tokenMeter: ctx.services.tokenMeter, onWork: (sessionId) => pump?.kick(sessionId, 'created'), pid })
  pump = createPump({ ctx, engine, authority, log, now: clock })
  const decideFn = decide ?? (typeof ctx.services.systemone?.decide === 'function' ? (state, questions) => ctx.services.systemone.decide(state, questions) : undefined)
  const classifier = createClassifier({ engine, decideFn, log, now: clock })
  const statusParts = () => ({ core: engine.core, store: engine.store, classifier, dispatcher, lastPumpAt: pump.lastPumpAt })
  const tools = buildTools({ engine, authority, classifier, pump, statusParts })
  const detach = [pump.attach(), dispatcher.attach()]
  // The advisory auto-tag hook, installed after the fence exactly as index.js does.
  detach.push(
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      classifier.onPreStep(payload)
      return decision
    }),
  )
  const exec = (agent) => ({ agent, signal: undefined })
  const actor = (agent) => authority.actorOf(exec(agent))
  const close = () => {
    pump.dispose()
    dispatcher.dispose()
    for (const fn of detach) fn()
    engine.close()
  }
  return { engine, pump, classifier, tools, dispatcher, authority, settings, exec, actor, close, dataDir }
}

/** A human creates an objective from a root session (opens a human turn, creates, goes idle). */
export const createAsHuman = (h, agent, input) => {
  agent.humanTurn('create objective')
  const result = h.engine.create(input, h.actor(agent))
  agent.openTurnStartSeq = null
  agent.status = 'idle'
  return result
}

export const humanControl = (h, agent, input) => {
  agent.humanTurn('control')
  const result = h.engine.control(input, h.actor(agent))
  agent.openTurnStartSeq = null
  agent.status = 'idle'
  return result
}

export const humanSystem = (h, agent, input) => {
  agent.humanTurn('system')
  const result = h.engine.system(input, h.actor(agent))
  agent.openTurnStartSeq = null
  agent.status = 'idle'
  return result
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
