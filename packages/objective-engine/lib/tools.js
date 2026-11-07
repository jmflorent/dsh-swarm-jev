/**
 * Model-facing tools of the objective engine.
 *
 * Tool identity is the deterministic boundary for the two message types: an
 * objective is created with objective_create, progress is planned or reported
 * with objective_plan / objective_report. Mammoth classification stays
 * advisory (objective_classify and the journaled auto-tags), and a producer
 * can never complete its own objective without an independent pass verdict.
 */

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** Build a registry-ready definition without importing the tools package. */
const tool = ({ name, description, parameters, execute }) => ({
  name,
  description,
  parameters,
  output: { schema: {}, render: renderJson },
  async execute(args, exec) {
    return await execute(args !== undefined && args !== null && typeof args === 'object' ? args : {}, exec)
  },
})

const sessionOf = (exec) => (typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : undefined)

const presetOf = (ctx, exec) => {
  try {
    const registry = ctx.get?.('agentPresets')
    const preset = registry?.presetForSession?.(exec?.agent?.session)
    return typeof preset === 'string' ? preset : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {{ctx: object, engine: object, classifier: object, pump: object}} options
 * @returns registry-ready tool definitions.
 */
export const buildTools = ({ ctx, engine, classifier, pump }) => {
  const actorOf = (exec) => ({ sessionId: sessionOf(exec), preset: presetOf(ctx, exec) })

  return [
    tool({
      name: 'objective_create',
      description:
        'Create an objective: a body of work with checkable criteria, an owner session, and a progress-prompt budget. ' +
        'Beyond the active limit the objective is queued instead of rejected. Requires at least one criterion; ' +
        'the creating session becomes the owner and receives progress prompts when the engine is resumed.',
      parameters: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'The objective: what state of the world should be true when it completes.' },
          criteria: { type: 'array', items: { type: 'string' }, description: 'One or more checkable acceptance criteria.' },
          budgetRounds: { type: 'integer', description: 'Progress-prompt budget for this objective (default 12).' },
          priority: { type: 'number', description: 'Ordering hint among ready objectives (higher first).' },
          idempotencyKey: { type: 'string', description: 'Repeat the same key to make creation idempotent.' },
        },
        required: ['statement', 'criteria'],
      },
      execute: (args, exec) => {
        const result = engine.create(args, actorOf(exec))
        if (result.ok && pump !== undefined) pump.kick(sessionOf(exec))
        return result
      },
    }),
    tool({
      name: 'objective_status',
      description:
        'Read the objective engine: paused/running state, limits and counters, every objective with its progress counts, ' +
        'progress items, verifications, recent classification tags, and the latest progress-prompt wakes.',
      parameters: { type: 'object', properties: {} },
      execute: () => engine.status(),
    }),
    tool({
      name: 'objective_plan',
      description:
        'Record a progress item for an active objective. A work-order is a dispatchable next step; status-report and ' +
        'heartbeat record observed progress without work. Work orders are what the orchestrator dispatches to subagents.',
      parameters: {
        type: 'object',
        properties: {
          objectiveId: { type: 'string', description: 'Objective id.' },
          text: { type: 'string', description: 'The step, work order, or observation.' },
          kind: { type: 'string', description: 'work-order (default), status-report, or heartbeat.' },
        },
        required: ['objectiveId', 'text'],
      },
      execute: (args, exec) => engine.plan(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_report',
      description:
        'Report progress for an active objective: either a status report attributed to the caller, or a state update on ' +
        'an existing progress item (reported, failed, or ready). The producer reports; it never completes.',
      parameters: {
        type: 'object',
        properties: {
          objectiveId: { type: 'string', description: 'Objective id.' },
          progressId: { type: 'string', description: 'Optional progress item to update.' },
          text: { type: 'string', description: 'What was done, what changed, or the blocker.' },
          state: { type: 'string', description: 'Optional new item state: reported, failed, or ready.' },
        },
        required: ['objectiveId'],
      },
      execute: (args, exec) => engine.report(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_verify',
      description:
        'Record an independent verification verdict for an active objective. The objective owner session is rejected; ' +
        'a pass verdict is required before the owner may call objective_complete. Evidence must be concrete.',
      parameters: {
        type: 'object',
        properties: {
          objectiveId: { type: 'string', description: 'Objective id.' },
          verdict: { type: 'string', description: 'pass, fail, or inconclusive.' },
          evidence: { type: 'string', description: 'Commands, exit codes, hashes, links — what you checked.' },
        },
        required: ['objectiveId', 'verdict', 'evidence'],
      },
      execute: (args, exec) => engine.verdict(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_complete',
      description:
        'Complete an active objective. Only the owner session may call it, and only after a different session recorded a ' +
        'pass verdict with objective_verify. Completion frees an admission slot and promotes a queued objective.',
      parameters: {
        type: 'object',
        properties: {
          objectiveId: { type: 'string', description: 'Objective id.' },
          expectedRevision: { type: 'integer', description: 'Optional compare-and-set guard.' },
          note: { type: 'string', description: 'Optional completion note.' },
        },
        required: ['objectiveId'],
      },
      execute: (args, exec) => engine.complete(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_cancel',
      description: 'Cancel an active, queued, or blocked objective owned by the calling session (administrative while paused).',
      parameters: {
        type: 'object',
        properties: {
          objectiveId: { type: 'string', description: 'Objective id.' },
          reason: { type: 'string', description: 'Why it is cancelled.' },
        },
        required: ['objectiveId'],
      },
      execute: (args, exec) => engine.cancel(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_classify',
      description:
        'Ask Mammoth whether a message is a new objective, progress toward the current objective, or not work. Advisory ' +
        'only: the answer is journaled as a tag and never mutates objective state. The deterministic boundary is the tools.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to classify.' },
          objectiveId: { type: 'string', description: 'Optional objective the message may belong to.' },
        },
        required: ['text'],
      },
      execute: async (args, exec) =>
        classifier.classify({ sessionId: sessionOf(exec), text: args.text, objectiveId: args.objectiveId }),
    }),
    tool({
      name: 'objective_system',
      description:
        'Control the engine driver. It boots paused: resume arms progress prompts, pause stops them. status returns the ' +
        'engine record including pause state, limits, and counters.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'resume, pause, or status.' },
          reason: { type: 'string', description: 'Optional pause reason.' },
        },
        required: ['action'],
      },
      execute: (args) => {
        if (args.action === 'resume') {
          const result = engine.resume()
          if (pump !== undefined) pump.kick()
          return { ok: true, ...result, engine: engine.status().engine }
        }
        if (args.action === 'pause') {
          const result = engine.pause(args.reason)
          return { ok: true, ...result, engine: engine.status().engine }
        }
        if (args.action === 'status') return { ok: true, engine: engine.status().engine }
        return { ok: false, code: 'action-invalid', message: 'action must be resume, pause, or status' }
      },
    }),
  ]
}
