/**
 * The System One decision layer for DSH 0.2.2.
 *
 * Four decisions run on harness extension points, in one of three modes:
 *
 *   off       no work is done
 *   shadow    decisions are computed and logged, harness behavior is untouched
 *   enforce   decisions narrow behavior (never widen it)
 *
 *   agent/pre-step        tool selection  -> agent.ctx.tools.restrict
 *   tools/pre-execute     call assessment -> allow / ask / cancel
 *   tools/result+guard    deterministic loop detection
 *   agent/pre-step        skill hint and model route (both opt-in)
 *
 * Safety rules carried over from the reference design: delegate first and
 * compose monotonically (a downstream deny survives), fail to ask rather than
 * allow, discard decisions made against a stale snapshot, bound every payload,
 * and never widen an existing restriction.
 *
 * @module systemone/decisions
 */

import { randomUUID } from 'node:crypto'

import { evaluatePolicy } from './policy.js'

/** Build the identified user-role notice message that `agent.inject` requires. */
const notice = (text, summary) => ({
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'plugin:systemone-decisions', form: 'notice', summary },
})

/** Tools that control the mode itself and must never be gated. */
const CONTROL_TOOLS = new Set(['swarm_enter', 'swarm_exit', 'swarm_assign'])

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const clampText = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}…`)
const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)

/**
 * Remove the scope-local names the registry refused from a restriction.
 *
 * `restrict()` rejects the whole filter when it names a tool registered on the
 * agent's own layer: those tools are visible but never restrictable. Its
 * rejection names them, and that is the only public way to learn which names a
 * scope may not name — the registry exposes no restrictable-name set. Any
 * unexpected message yields the input unchanged, so the caller's fail-open path
 * stays the only outcome when this cannot be read.
 */
const withoutUnknownNames = (error, names) => {
  const message = typeof error?.message === 'string' ? error.message : ''
  const prefix = /names unknown global tools? ([^;]*?)(?:;|$)/.exec(message)
  if (prefix === null) return [...names]
  const unknown = new Set()
  for (const entry of prefix[1].matchAll(/"([^"]+)"/g)) unknown.add(entry[1])
  return unknown.size === 0 ? [...names] : names.filter((name) => !unknown.has(name))
}

/** Deep-merge one settings layer over its defaults. */
const merge = (base, patch) => {
  if (!isRecord(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    // A volatile config reference is opaque: keep the reference, never descend.
    if (typeof value?.get === 'function') {
      out[key] = value
      continue
    }
    out[key] = isRecord(value) && isRecord(base[key]) ? merge(base[key], value) : value
  }
  return out
}

/**
 * Turn volatile config fields into live getters on the resolved settings
 * object, so a Settings write is visible at the next decision without a reload.
 */
const bindLive = (settings) => {
  const bind = (target, key) => {
    const ref = target?.[key]
    if (typeof ref?.get !== 'function') return
    Object.defineProperty(target, key, { get: () => ref.get(), enumerable: true, configurable: true })
  }
  bind(settings, 'mode')
  bind(settings, 'endpoint')
  bind(settings, 'model')
  bind(settings, 'apiKeyRef')
  bind(settings, 'timeoutMs')
  bind(settings.selection, 'enabled')
  bind(settings.assessment, 'enabled')
  bind(settings.loopDetection, 'enabled')
  bind(settings.skills, 'enabled')
  bind(settings.modelRouting, 'enabled')
}

/** Resolve a validated plugin config into the runtime settings shape. */
export const resolveSettings = (config) => {
  const base = {
    endpoint: 'http://127.0.0.1:8008/v1/systemone',
    model: 'decision-model',
    apiKeyRef: 'SYSTEMONE_API_KEY',
    mode: 'shadow',
    timeoutMs: 5000,
    budgetMs: 8000,
    maxStateChars: 4000,
    maxArgumentChars: 1200,
    maxCategories: 48,
    maxSelectedTools: 24,
    logDecisions: true,
    redactKeys: [],
    thresholds: {
      selection: 0.25,
      restriction: 0.5,
      missingInformation: 0.5,
      taskMatch: 0.35,
      skill: 0.5,
      modelRoute: 0.4,
    },
    selection: { enabled: true, alwaysAllow: [], categories: {}, toolCategories: {} },
    assessment: { enabled: true, onFailure: 'ask', includeRiskScore: false, restrictions: [] },
    loopDetection: { enabled: true, maxRepeats: 2, maxSubjects: 64 },
    skills: { enabled: false, injectHint: true, routingHints: {} },
    modelRouting: { enabled: false, routes: {} },
    policy: { default: 'allow', allow: [], deny: [], tools: {} },
    swarm: {
      presets: ['orchestrator', 'architect', 'writer', 'reviewer', 'researcher'],
      // The orchestrator never does stage work: only coordination and
      // context-reading tools stay visible while a session is in swarm mode.
      orchestratorTools: [
        'read',
        'read_image',
        'glob',
        'grep',
        'todo_write',
        'ask_user_question',
        'subagent',
        'subagent_fork',
        'workflow',
        'present',
        'skill',
        'swarm_assign',
        'swarm_enter',
        'swarm_exit',
        'systemone_ask',
        'systemone_status',
      ],
      personas: {
        orchestrator: {
          description: 'Decomposes a goal into delegable workstreams, runs them, and integrates results',
          instructions:
            'You are the orchestrator. Own the goal: decompose the stage into delegable pieces, delegate one subagent per independent piece with a self-contained brief, verify claims against the workspace, and integrate the outcomes into one result.',
        },
        architect: {
          description: 'Designs systems grounded in the repository; writes decision-complete design documents',
          instructions:
            'You are the architect. Ground every design decision in the actual repository: read the interfaces it must fit, state the constraints and tradeoffs, and produce a decision-complete design document another engineer can implement without re-deriving your reasoning.',
        },
        writer: {
          description: 'Writes prose and documents matched to audience and house style',
          instructions:
            'You are the writer. Produce prose a specific reader will act on. Match the house style, fix structure before sentences, report substantive changes, and never invent a citation, statistic, or quote.',
        },
        reviewer: {
          description: 'Independently validates a change and reports blocking defects with evidence',
          instructions:
            'You are the independent reviewer. Read the actual change and run the checks yourself. Cite evidence (file:line, command output) for every finding, order by severity, distinguish what the change does from what it was meant to do, and end with a verdict: APPROVE, APPROVE WITH NITS, or REQUEST CHANGES.',
        },
        researcher: {
          description: 'Gathers evidence from primary sources and reports with citations',
          instructions:
            'You are the researcher. Answer from sources, not memory: go to the spec, repository, filing, or paper rather than summaries. Separate what the evidence shows, what you infer, and what remains unknown; never cite a URL you did not open.',
        },
      },
    },
    presets: {},
  }
  const resolved = merge(base, config)
  // An empty personas map in the row config must not erase the catalog the
  // assignment question is built from: Schemastery materializes the optional
  // dict as `{}`, so fall back to the built-in personas when it is empty.
  if (resolved.swarm !== undefined) {
    const personas = resolved.swarm.personas
    if (personas === undefined || Object.keys(personas).length === 0) {
      resolved.swarm.personas = base.swarm.personas
    }
    if (resolved.swarm.orchestratorTools === undefined || resolved.swarm.orchestratorTools.length === 0) {
      resolved.swarm.orchestratorTools = base.swarm.orchestratorTools
    }
  }
  return resolved
}

/** Per-agent state: snapshot, the live selection restriction, and counters. */
class AgentState {
  constructor(agent) {
    this.agent = agent
    this.version = 0
    this.task = ''
    this.step = ''
    this.turn = -1
    this._selection = undefined
  }

  update({ task, step, turn }) {
    this.version += 1
    this.task = task
    this.step = step
    this.turn = turn
  }

  liftSelection() {
    const disposer = this._selection
    this._selection = undefined
    if (disposer === undefined) return
    try {
      disposer()
    } catch {
      // A disposed agent scope must not break the next turn.
    }
  }

  applySelection(apply) {
    this.liftSelection()
    this._selection = apply()
  }

  dispose() {
    this.liftSelection()
  }
}

/** Bounded, order-stable identity for one call's arguments. */
const callKey = (name, args, maxChars, redactKeys) => {
  const seen = new WeakSet()
  const walk = (value, depth) => {
    if (depth > 6) return '[depth]'
    if (Array.isArray(value)) return value.slice(0, 64).map((entry) => walk(entry, depth + 1))
    if (isRecord(value)) {
      if (seen.has(value)) return '[cycle]'
      seen.add(value)
      const out = {}
      for (const key of Object.keys(value).sort().slice(0, 128)) {
        out[key] = redactKeys.includes(key) ? '[redacted]' : walk(value[key], depth + 1)
      }
      return out
    }
    if (typeof value === 'string') return clampText(value, 512)
    return value
  }
  return `${name}\u0000${clampText(JSON.stringify(walk(args, 0)), maxChars)}`
}

/** Build the category catalog for one tool set. */
const buildCatalog = (schemas, settings) => {
  const categories = new Map()
  const candidates = schemas.map((tool) => {
    const configured = settings.selection.toolCategories[tool.name]
    // A tool with no declared category is never subject to selection: selection
    // narrows only the tools the operator explicitly grouped.
    const ids = Array.isArray(configured) && configured.length > 0 ? configured : []
    for (const id of ids) {
      if (!categories.has(id)) categories.set(id, settings.selection.categories[id] ?? id)
    }
    return { id: tool.name, categories: ids }
  })
  return { candidates, categories: [...categories.entries()].map(([id, description]) => ({ id, description })) }
}

/** Resolve the Bearer token: DSH credentials first, then the environment. */
const resolveKey = async (ctx, ref) => {
  if (typeof ref !== 'string' || ref.trim() === '') return undefined
  const name = ref.trim()
  try {
    const resolved = await ctx.credentials?.resolve?.(name)
    if (resolved && typeof resolved.value === 'string' && resolved.value.length > 0) return resolved.value
  } catch {
    // Fall through to the environment.
  }
  const fromEnv = process.env[name]
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined
}

export function createDecisionRuntime(ctx, rawConfig) {
  const settings = resolveSettings(rawConfig)
  bindLive(settings)
  const presetOverrides = settings.presets ?? {}
  const states = new Map()
  const loops = new Map()
  // Swarm mode is a session mode (like plan mode), not a preset: the set holds
  // the Agents currently in it, and the map holds their prompt-section disposers.
  const swarmSessions = new Set()
  const swarmRestrictions = new Map()
  const stats = {
    selections: 0,
    selectionApplied: 0,
    selectionFailures: 0,
    assessments: 0,
    asks: 0,
    holds: 0,
    loopDenials: 0,
    skillHints: 0,
    routes: 0,
    staleDiscarded: 0,
    failures: 0,
    lastFailure: undefined,
  }
  const inFlight = new Set()
  const recent = []
  const record = (entry) => {
    recent.push({ at: new Date().toISOString(), ...entry })
    if (recent.length > 20) recent.shift()
  }

  const log = (level, message, data) => {
    if (!settings.logDecisions && level !== 'warn') return
    const text = `[systemone] ${message}`
    const logger = ctx.logger
    try {
      if (level === 'warn') logger?.warn?.(text, data ?? '')
      else if (level === 'debug') logger?.debug?.(text, data ?? '')
      else logger?.info?.(text, data ?? '')
    } catch {
      // Logging must never break a decision path.
    }
  }

  const stateFor = (agent) => {
    let state = states.get(agent)
    if (state === undefined) {
      state = new AgentState(agent)
      states.set(agent, state)
    }
    return state
  }

  /** One batched decision call. Never throws for provider problems. */
  const decide = async (state, questions, signal, model = settings.model) => {
    const payload = JSON.stringify({ state, questions, model })
    const startedAt = Date.now()
    const deadline = AbortSignal.timeout(settings.timeoutMs)
    const fused = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    const controller = new AbortController()
    inFlight.add(controller)
    const combined = AbortSignal.any([fused, controller.signal])
    try {
      const apiKey = await resolveKey(ctx, settings.apiKeyRef)
      const response = await fetch(settings.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        body: payload,
        signal: combined,
      })
      const text = await response.text()
      if (!response.ok) {
        return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${response.status}` }
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, latencyMs: Date.now() - startedAt, error: 'response was not JSON' }
      }
      if (!isRecord(parsed) || !isRecord(parsed.answers)) {
        return { ok: false, latencyMs: Date.now() - startedAt, error: 'response has no answers object' }
      }
      const answers = {}
      for (const [id, question] of Object.entries(questions)) {
        const raw = parsed.answers[id]
        if (!isRecord(raw)) continue
        if (question.type === 'noul') {
          const value = finite(raw.noul)
          if (value !== undefined) answers[id] = value
        } else if (question.type === 'choice') {
          if (typeof raw.choice === 'string') answers[id] = raw.choice
        } else if (question.type === 'score') {
          const value = finite(raw.score)
          if (value !== undefined) answers[id] = value
        }
      }
      return {
        ok: true,
        answers,
        model: typeof parsed.model === 'string' ? parsed.model : model,
        latencyMs: Date.now() - startedAt,
      }
    } catch (error) {
      const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: aborted ? `no answer within ${settings.timeoutMs} ms` : `endpoint failed: ${error?.message ?? error}`,
      }
    } finally {
      inFlight.delete(controller)
    }
  }

  const recordFailure = (error) => {
    stats.failures += 1
    stats.lastFailure = { at: new Date().toISOString(), error: String(error?.message ?? error) }
  }

  /** Extract bounded task text from the admitted messages. */
  const taskOf = (messages) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.source?.kind !== 'user') continue
      const text = (message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text.length > 0) return clampText(text, settings.maxStateChars)
    }
    return undefined
  }

  /** Preset id currently composing the agent, when the registry exposes it. */
  const presetOf = (agent) => {
    try {
      const registry = ctx.get('agentPresets')
      const id = registry?.presetForSession?.(agent?.session)
      if (typeof id === 'string' && id.length > 0) return id
    } catch {
      // The registry is optional; a session without it uses the base settings.
    }
    return undefined
  }

  /**
   * Effective settings for one agent: per-preset overrides on top of the base.
   * The base view keeps volatile getters, so Settings toggles stay live.
   */
  const viewFor = (agent) => {
    const id = presetOf(agent)
    const override = id === undefined ? undefined : presetOverrides[id]
    // `swarm` is a mode, not a preset: it enforces only for agents whose preset
    // is a declared swarm member and leaves every other session completely
    // inert, so an orchestrator/lead session cannot block itself.
    const modeOf = (baseMode) => {
      if (baseMode !== 'swarm') return baseMode
      return swarmSessions.has(agent) ? 'enforce' : 'off'
    }
    return {
      mode: modeOf(override?.mode ?? settings.mode),
      selection: { ...settings.selection, ...(override?.selection ?? {}) },
      assessment: { ...settings.assessment, ...(override?.assessment ?? {}) },
      thresholds: { ...settings.thresholds, ...(override?.thresholds ?? {}) },
      policy: override?.policy ?? settings.policy,
      judge: override?.judge,
      skills: settings.skills,
      modelRouting: settings.modelRouting,
    }
  }

  // ---------------------------------------------------------------- selection
  const runSelection = async (agent, state, signal, view) => {
    const settings = view
    if (typeof agent.ctx?.tools?.restrict !== 'function') return
    const schemas = ctx.tools.schemas(agent).filter((schema) => ctx.tools.get(schema.name, agent) !== undefined)
    if (schemas.length === 0) return
    const { candidates, categories } = buildCatalog(schemas, settings)
    const ceiling = positive(settings.maxCategories, 48)
    if (categories.length > ceiling) {
      // Restricting a catalog we never asked about could hide a needed tool.
      log('warn', `tool selection skipped: ${categories.length} categories exceed maxCategories ${ceiling}`)
      return
    }
    const used = categories
    if (used.length === 0) {
      log('debug', 'tool selection skipped: no tool categories configured')
      return
    }
    const questions = {}
    for (const category of used) {
      questions[`category_${category.id}`] = {
        type: 'noul',
        instructions:
          `Does the current task need the "${category.id}" capability (${category.description})? ` +
          'Answer with the probability that tools in this category are needed for the next step.',
      }
    }
    const version = state.version
    const result = await decide({ task: state.task, step: state.step }, questions, signal)
    stats.selections += 1
    if (!result.ok) {
      stats.selectionFailures += 1
      log('warn', `tool selection skipped: ${result.error}`)
      return
    }
    if (state.version !== version) {
      stats.staleDiscarded += 1
      log('warn', 'tool selection discarded: task snapshot changed')
      return
    }
    const unmapped = candidates
      .filter((candidate) => candidate.categories.length === 0)
      .map((candidate) => candidate.id)
    const keep = [...new Set([...settings.selection.alwaysAllow, 'systemone_ask', 'systemone_status', ...unmapped])]
    const wanted = new Set(keep)
    for (const [id, probability] of Object.entries(result.answers)) {
      if (probability < settings.thresholds.selection) continue
      const category = id.slice('category_'.length)
      for (const candidate of candidates) {
        if (candidate.categories.includes(category)) wanted.add(candidate.id)
      }
    }
    const visible = (name) => ctx.tools.get(name, agent) !== undefined
    const mustKeep = keep.filter(visible)
    const chosen = [...wanted]
      .filter((name) => !mustKeep.includes(name) && visible(name))
      .slice(0, positive(settings.maxSelectedTools, 24))
    const allow = [...mustKeep, ...chosen]
    const probabilities = Object.fromEntries(
      Object.entries(result.answers).map(([id, probability]) => [
        id.slice('category_'.length),
        Number(probability.toFixed(3)),
      ]),
    )
    log('info', 'tool selection', {
      mode: settings.mode,
      categories: used.length,
      probabilities,
      allow: allow.length,
      latencyMs: result.latencyMs,
    })
    record({
      decision: 'selection',
      mode: settings.mode,
      preset: presetOf(agent),
      categories: used.length,
      allow: allow.length,
      probabilities,
      latencyMs: result.latencyMs,
    })
    if (settings.mode !== 'enforce' || allow.length === 0) return
    if (allow.length >= schemas.length) return
    // Fail-open guard: a restriction that would leave almost no tools is more
    // likely a bad decision than a real narrowing, so keep the full catalog.
    if (allow.length < Math.max(3, Math.floor(schemas.length * 0.15))) {
      log('warn', `tool restriction skipped: only ${allow.length} of ${schemas.length} tools selected`)
      return
    }
    // A restriction filters the INHERITED surface — the global layer plus the
    // preset's ancestor layers — and never the agent's own registrations. Those
    // own registrations stay visible but are not restrictable, so naming one
    // makes the registry reject the whole decision. In this harness most host
    // tools live on the agent plane (the global view holds only a handful), so
    // the rejection names are the only public source of that distinction: trim
    // exactly those once and retry. Any other failure keeps the fail-open path.
    const restrictAll = (names) => {
      state.applySelection(() => agent.ctx.tools.restrict({ allow: names }))
      stats.selectionApplied += 1
    }
    try {
      restrictAll(allow)
    } catch (error) {
      const trimmed = withoutUnknownNames(error, allow)
      if (trimmed.length === 0 || trimmed.length === allow.length) {
        recordFailure(error)
        log('warn', `tool restriction rejected: ${error?.message ?? error}`)
        return
      }
      try {
        restrictAll(trimmed)
      } catch (retryError) {
        recordFailure(retryError)
        log('warn', `tool restriction rejected after trimming: ${retryError?.message ?? retryError}`)
      }
    }
  }

  // --------------------------------------------------------------- assessment
  const assess = async (exec, state, signal, view) => {
    const settings = view
    const questions = {
      matchesTask: {
        type: 'noul',
        instructions:
          'Does calling this tool with these arguments serve the current task? ' +
          'Answer with the probability that the call is on-task.',
        boundary: {
          true: 'The call advances the stated task',
          false: 'The call is unrelated to the stated task',
        },
      },
      missingInformation: {
        type: 'noul',
        instructions:
          'Is the call missing information or based on an unverified assumption that a human should resolve first? ' +
          'Answer with the probability that required information is missing.',
      },
      violatesRestriction: {
        type: 'noul',
        instructions:
          'Does the call conflict with an explicit restriction or a safety boundary for this task? ' +
          'Answer with the probability that the call violates one.',
        boundary: { true: 'Conflicts with an explicit restriction', false: 'Within the stated boundaries' },
      },
    }
    if (settings.assessment.includeRiskScore) {
      questions.risk = {
        type: 'score',
        instructions: 'How risky is running this call?',
        criteria: ['harmless', 'recoverable', 'costly', 'irreversible'],
      }
    }
    // Model-judged persona rule: the probabilistic half of the tool policy.
    // It is asked in the model's own terms, so indirect violations (an
    // interpreter writing a source file, a build step rewriting sources) are
    // caught where a deterministic pattern cannot enumerate them.
    if (
      settings.judge !== undefined &&
      typeof settings.judge.instructions === 'string' &&
      settings.judge.instructions.trim() !== ''
    ) {
      questions.persona = {
        type: 'noul',
        instructions:
          `Persona rule: ${settings.judge.instructions.trim()} ` +
          'Does the proposed call violate that rule? Answer with the probability that it does.',
        ...(settings.judge.boundary === undefined ? {} : { boundary: settings.judge.boundary }),
      }
    }
    const argumentsText = clampText(
      JSON.stringify(exec.arguments ?? null) ?? 'null',
      settings.maxArgumentChars,
    )
    const result = await decide(
      {
        task: state.task,
        step: state.step,
        tool: exec.name,
        arguments: argumentsText,
        restrictions: settings.assessment.restrictions,
      },
      questions,
      signal,
    )
    stats.assessments += 1
    if (!result.ok) {
      stats.assessmentFailures = (stats.assessmentFailures ?? 0) + 1
      return { action: settings.assessment.onFailure === 'hold' ? 'cancel' : 'ask', reason: `assessment failed: ${result.error}` }
    }
    const violates = result.answers.violatesRestriction ?? 0
    const missing = result.answers.missingInformation ?? 0
    const matches = result.answers.matchesTask ?? 1
    const personaViolation = result.answers.persona
    if (personaViolation !== undefined && personaViolation >= settings.thresholds.restriction) {
      return { action: 'ask', reason: `persona rule violation p=${personaViolation.toFixed(3)}` }
    }
    if (violates >= settings.thresholds.restriction) {
      return { action: 'ask', reason: `restriction conflict p=${violates.toFixed(3)}` }
    }
    if (missing >= settings.thresholds.missingInformation) {
      return { action: 'ask', reason: `missing information p=${missing.toFixed(3)}` }
    }
    // Low task match is a weak signal on its own: it is recorded, never gated.
    const values = { matches: Number(matches.toFixed(3)), missing: Number(missing.toFixed(3)) }
    if (personaViolation !== undefined) values.persona = Number(personaViolation.toFixed(3))
    if (matches < settings.thresholds.taskMatch) {
      return { action: 'allow', note: `low task match p=${(1 - matches).toFixed(3)}`, values }
    }
    return { action: 'allow', values }
  }

  // ---------------------------------------------------------------- loop guard
  const resetLoop = (agent) => loops.delete(agent)
  const loopKeyOf = (exec) => callKey(exec.name, exec.arguments, settings.maxArgumentChars, settings.redactKeys)
  const observeLoop = (exec) => {
    if (exec.agent === undefined) return 0
    let counters = loops.get(exec.agent)
    if (counters === undefined) {
      counters = new Map()
      loops.set(exec.agent, counters)
    }
    const key = loopKeyOf(exec)
    const count = (counters.get(key) ?? 0) + 1
    counters.set(key, count)
    return count
  }
  const peekLoop = (exec) => {
    if (exec.agent === undefined) return 0
    return loops.get(exec.agent)?.get(loopKeyOf(exec)) ?? 0
  }

  // ------------------------------------------------------------------ install
  const install = () => {
    if (settings.mode === 'off' || (!settings.selection.enabled && !settings.assessment.enabled && !settings.loopDetection.enabled && !settings.skills.enabled && !settings.modelRouting.enabled)) {
      log('info', 'decision layer idle: mode "off" or every feature disabled')
      return
    }

    ctx.on('agent/disposed', ({ agent }) => {
      states.get(agent)?.dispose()
      states.delete(agent)
      resetLoop(agent)
      swarm.exit(agent)
    })

    ctx.effect(() => () => {
      for (const state of states.values()) state.dispose()
      states.clear()
      loops.clear()
      for (const controller of inFlight) controller.abort(new Error('systemone decision layer disposed'))
      inFlight.clear()
    }, 'systemone decision layer cleanup')

    // Selection, skill hint, and model routing share the pre-step snapshot.
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      const { agent, messages, step, turn, signal } = payload
      const view = viewFor(agent)
      if (view.mode === 'off' || decision?.kind === 'reject') return decision
      if (messages.some((message) => message?.source?.kind === 'user')) resetLoop(agent)
      // Strict orchestrator boundary, before this step's tool schema assembles.
      if (view.mode === 'enforce' && swarmSessions.has(agent)) applyOrchestratorRestriction(agent)
      const state = stateFor(agent)
      state.update({
        task: taskOf(messages) ?? state.task,
        step: `step ${step}`,
        turn,
      })
      try {
        if (view.selection.enabled) await runSelection(agent, state, signal, view)
      } catch (error) {
        recordFailure(error)
        log('warn', `selection failed: ${error?.message ?? error}`)
      }
      try {
        if (view.skills.enabled) await runSkillHint(agent, state, signal)
      } catch (error) {
        recordFailure(error)
        log('warn', `skill hint failed: ${error?.message ?? error}`)
      }
      try {
        if (view.modelRouting.enabled) await runModelRoute(agent, state, signal)
      } catch (error) {
        recordFailure(error)
        log('warn', `model routing failed: ${error?.message ?? error}`)
      }
      return decision
    })

    // Assessment runs after the rest of the policy chain, so it composes with it.
    ctx.on('tools/pre-execute', async (exec, next) => {
      const downstream = await next()
      if (exec.agent === undefined) return downstream
      const view = viewFor(exec.agent)
      if (view.mode === 'off') return downstream
      if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
      // Deterministic persona policy: explicit rules, no model call, and it
      // composes monotonically — it can only add a denial, never remove one.
      const verdict = evaluatePolicy(view.policy, exec)
      if (verdict.decision === 'deny') {
        record({
          decision: 'policy',
          mode: view.mode,
          preset: presetOf(exec.agent),
          tool: exec.name,
          action: 'deny',
          reason: verdict.reason,
        })
        log('info', 'persona policy deny', { mode: view.mode, tool: exec.name, reason: verdict.reason })
        if (view.mode === 'enforce') return { kind: 'deny', reason: `[systemone] ${verdict.reason}` }
        return downstream
      }
      // Control-plane tools are never gated by the gate they control: a
      // session must always be able to leave swarm mode (and ask for an
      // assignment) even when the model would hold an ordinary call.
      if (CONTROL_TOOLS.has(exec.name)) return downstream
      if (!view.assessment.enabled) return downstream
      const state = states.get(exec.agent)
      if (state === undefined) return downstream
      const version = state.version
      let assessment
      try {
        assessment = await assess(exec, state, exec.signal, view)
      } catch (error) {
        recordFailure(error)
        log('warn', `assessment threw: ${error?.message ?? error}`)
        return view.mode === 'enforce' ? { kind: 'ask', reason: '[systemone] no usable assessment' } : downstream
      }
      if (state.version !== version) {
        stats.staleDiscarded += 1
        return downstream
      }
      log('info', 'tool assessment', {
        mode: view.mode,
        tool: exec.name,
        action: assessment.action,
        reason: assessment.reason,
      })
      record({
        decision: 'assessment',
        mode: view.mode,
        tool: exec.name,
        action: assessment.action,
        ...(assessment.reason === undefined ? {} : { reason: assessment.reason }),
        ...(assessment.note === undefined ? {} : { note: assessment.note }),
        ...(assessment.values === undefined ? {} : { values: assessment.values }),
      })
      if (view.mode !== 'enforce' || assessment.action === 'allow') return downstream
      if (assessment.action === 'cancel') {
        stats.holds += 1
        return { kind: 'cancel' }
      }
      stats.asks += 1
      if (downstream.kind === 'ask') return downstream
      return { kind: 'ask', reason: `[systemone] ${assessment.reason}` }
    })

    // Deterministic loop detection: observe outcomes, deny the repeat.
    if (settings.loopDetection.enabled) {
      ctx.on('tools/result', (exec) => {
        if (exec.agent === undefined || viewFor(exec.agent).mode === 'off') return
        const count = observeLoop(exec)
        if (count === settings.loopDetection.maxRepeats) {
          log('warn', `possible tool loop: ${exec.name} repeated ${count} times with identical arguments`)
        }
      })
      ctx.effect(() => {
        const dispose = ctx.tools.guard((exec) => {
          if (exec.agent === undefined || viewFor(exec.agent).mode !== 'enforce') return undefined
          const count = peekLoop(exec)
          if (count < settings.loopDetection.maxRepeats) return undefined
          stats.loopDenials += 1
          log('warn', `loop guard denied ${exec.name}`, { count })
          return `[systemone] identical ${exec.name} call already completed ${count} times; change the arguments or the approach before retrying`
        })
        return () => dispose()
      }, 'systemone loop guard')
    }

    log('info', 'decision layer loaded', {
      provider: settings.endpoint,
      model: settings.model,
      mode: settings.mode,
      selection: settings.selection.enabled,
      assessment: settings.assessment.enabled,
      loopDetection: settings.loopDetection.enabled,
      skills: settings.skills.enabled,
      modelRouting: settings.modelRouting.enabled,
    })
  }

  // ------------------------------------------------------------------- skills
  const runSkillHint = async (agent, state, signal) => {
    const skills = ctx.get('skills')
    if (skills === undefined) return
    const catalog = await skills.list({ scope: agent })
    const candidates = catalog.filter((skill) => skill.invocation?.modelInvocable === true).slice(0, 20)
    if (candidates.length === 0) return
    const questions = {
      useSkill: {
        type: 'choice',
        instructions: 'Which skill, if any, would help most with the current task?',
        criteria: Object.fromEntries([
          ['none', 'No skill is needed'],
          ...candidates.map((skill) => [skill.name, skill.description]),
        ]),
      },
    }
    const result = await decide({ task: state.task, step: state.step }, questions, signal)
    if (!result.ok) return
    const selected = result.answers.useSkill
    if (typeof selected !== 'string' || selected === 'none') return
    const skill = candidates.find((entry) => entry.name === selected)
    if (skill === undefined) return
    log('info', 'skill hint', { skill: skill.name, mode: settings.mode })
    if (settings.mode !== 'enforce' || !settings.skills.injectHint) return
    if (typeof agent.inject !== 'function') return
    try {
      agent.inject(notice(
        `Skill suggestion: "${skill.name}" — ${skill.description}. Load its instructions only if they help this task.`,
        `skill: ${skill.name}`,
      ))
      stats.skillHints += 1
    } catch (error) {
      log('warn', `skill hint rejected: ${error?.message ?? error}`)
    }
  }

  // --------------------------------------------------------------- model route
  const runModelRoute = async (agent, state, signal) => {
    const routes = settings.modelRouting.routes
    const names = Object.keys(routes ?? {})
    if (names.length === 0) return
    const llm = ctx.get('llm')
    if (llm === undefined) return
    const questions = {
      route: {
        type: 'choice',
        instructions: 'Which model route class fits the current task?',
        criteria: Object.fromEntries(names.map((name) => [name, `${name} route`])),
      },
    }
    const result = await decide({ task: state.task, step: state.step }, questions, signal)
    if (!result.ok) return
    const route = result.answers.route
    if (typeof route !== 'string' || routes[route] === undefined) return
    const target = routes[route]
    if (isRecord(target) && typeof target.provider === 'string' && typeof target.model === 'string') {
      try {
        const models = await llm.listModels(target.provider)
        if (!models.some((model) => model.id === target.model)) {
          log('warn', 'model route target is not in the provider catalog; keeping the current model', target)
          return
        }
      } catch (error) {
        log('warn', `model catalog unavailable: ${error?.message ?? error}`)
        return
      }
      log('info', 'model route', { mode: settings.mode, route, target })
      if (settings.mode !== 'enforce') return
      if (typeof agent.model?.select !== 'function') return
      try {
        agent.model.select({ provider: target.provider, model: target.model })
        stats.routes += 1
      } catch (error) {
        log('warn', `model selection rejected: ${error?.message ?? error}`)
      }
    }
  }

/** Prompt section injected while a session is in swarm mode. */
const SWARM_POLICY = [
  'You are operating in SWARM MODE. You are the orchestrator: a manager who never does the work.',
  'Your tool surface is restricted to coordination and reading. You do not edit files, run builds or tests,',
  'write documents, or produce deliverables — workers do that. You decompose, assign, dispatch, verify and integrate.',
  '',
  'Maintain an explicit workplan with the todo list: each stage names its goal, inputs, and acceptance criteria.',
  'For every stage, call swarm_assign with the stage description and what it needs. The decision model (Mammoth)',
  'chooses which persona executes it and returns that persona brief. Dispatch that worker with the subagent tool',
  '(or a fork when the child needs this conversation), carrying its instructions and a self-contained brief.',
  'Never execute a stage yourself and never choose the persona yourself when swarm_assign answers — its answer',
  'is the assignment.',
  '',
  'Every tool call you and your stage agents make is judged by the decision model. A hold or ask is a signal:',
  'read the reason, fix the brief, and change the call. Do not route around it, and never rephrase a denied call',
  'only to get it through. Keep one stage in flight per subagent, verify each result against the workspace, and',
  'integrate the stage outputs into the final answer with what changed, what was verified, and what remains open.',
].join('\n')

  /** Hide every non-coordination tool from a swarm orchestrator. */
  const applyOrchestratorRestriction = (agent) => {
    if (swarmRestrictions.has(agent)) return
    try {
      const restrict = agent?.ctx?.tools?.restrict
      if (typeof restrict !== 'function') return
      const allow = [...new Set(settings.swarm?.orchestratorTools ?? [])]
      try {
        swarmRestrictions.set(agent, restrict({ allow }))
      } catch (error) {
        const trimmed = withoutUnknownNames(error, allow)
        if (trimmed.length === 0 || trimmed.length === allow.length) throw error
        swarmRestrictions.set(agent, restrict({ allow: trimmed }))
      }
    } catch (error) {
      recordFailure(error)
      log('warn', `orchestrator restriction rejected: ${error?.message ?? error}`)
    }
  }

  const swarm = {
    active: (agent) => swarmSessions.has(agent),
    enter: (agent) => {
      swarmSessions.add(agent)
      // The tool boundary is applied from the pre-step hook, not here: a tool's
      // exec.agent exposes no context, and mid-step restriction is too late for
      // the step's own tool schema. Pre-step has agent.ctx and runs before
      // assembly, so hidden tools are never offered to the model.
      applyOrchestratorRestriction(agent)
      // Per-agent context travels as a logged notice (agent.inject), which is
      // the supported per-agent mechanism: a host-level prompt section cannot
      // be made conditional on one session, and a scoped section needs the
      // agent context this plugin does not own.
      try {
        if (typeof agent?.inject === 'function') {
          agent.inject(notice(SWARM_POLICY, 'swarm mode'))
        }
      } catch (error) {
        recordFailure(error)
        log('warn', `swarm policy injection rejected: ${error?.message ?? error}`)
      }
      return { ok: true, active: true }
    },
    exit: (agent) => {
      swarmSessions.delete(agent)
      const lift = swarmRestrictions.get(agent)
      swarmRestrictions.delete(agent)
      try {
        lift?.()
      } catch (error) {
        recordFailure(error)
        log('warn', `orchestrator restriction not lifted cleanly: ${error?.message ?? error}`)
      }
      return { ok: true, active: false }
    },
    assign: async (input, signal) => {
      const personas = settings.swarm?.personas ?? {}
      const all = Object.keys(personas)
      const candidates = Array.isArray(input?.candidates) && input.candidates.length > 0
        ? input.candidates.filter((id) => personas[id] !== undefined)
        : all
      if (candidates.length === 0) {
        return { ok: false, error: 'no persona candidates configured for swarm assignment' }
      }
      const criteria = Object.fromEntries(
        candidates.map((id) => [id, personas[id].description ?? id]),
      )
      const stage = typeof input?.stage === 'string' ? clampText(input.stage, 4000) : ''
      const questions = {
        agent: {
          type: 'choice',
          instructions:
            `Which agent persona should execute this workplan stage?\n\nStage: ${stage}` +
            (typeof input?.needs === 'string' && input.needs.trim() !== ''
              ? `\nStage needs: ${clampText(input.needs, 2000)}`
              : ''),
          criteria,
        },
      }
      const startedAt = Date.now()
      const result = await decide(
        { task: stage, stage, needs: input?.needs ?? null, context: input?.context ?? null },
        questions,
        signal,
      )
      if (!result.ok) {
        return { ok: false, error: result.error, latencyMs: Date.now() - startedAt }
      }
      const persona = result.answers.agent
      if (typeof persona !== 'string' || personas[persona] === undefined) {
        return { ok: false, error: 'the decision model returned no readable persona', latencyMs: Date.now() - startedAt }
      }
      record({ decision: 'assign', stage: clampText(stage, 200), persona, latencyMs: Date.now() - startedAt })
      return {
        ok: true,
        persona,
        description: personas[persona].description,
        instructions: personas[persona].instructions,
        choices: candidates,
        latencyMs: Date.now() - startedAt,
      }
    },
  }

  return {
    settings,
    stats,
    install,
    swarm,
    decide: (state, questions, signal) => decide(state, questions, signal),
    /**
     * Read-only snapshot for the browser swarm panel.
     *
     * Safe to expose to an authenticated same-origin page: it carries decision
     * metadata only (counters, recent decisions, persona catalog, the set of
     * swarm-mode sessions by opaque Session id). It never carries prompts,
     * credentials, tool arguments, or session content.
     */
    panel: () => {
      const members = []
      for (const agent of swarmSessions) {
        const sessionId = agent?.session?.id
        const preset = presetOf(agent)
        members.push({
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          ...(typeof preset === 'string' ? { preset } : {}),
        })
      }
      const personas = Object.entries(settings.swarm?.personas ?? {}).map(([id, persona]) => ({
        id,
        description: typeof persona?.description === 'string' ? persona.description : '',
      }))
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        engine: {
          mode: settings.mode,
          endpoint: settings.endpoint,
          model: settings.model,
          timeoutMs: settings.timeoutMs,
          presets: [...(settings.swarm?.presets ?? [])],
        },
        swarm: {
          active: swarmSessions.size,
          members,
          personas,
        },
        stats: JSON.parse(JSON.stringify(stats)),
        recent: JSON.parse(JSON.stringify(recent)),
      }
    },
    status: () => ({
      mode: settings.mode,
      endpoint: settings.endpoint,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      selectionCategories: Object.keys(settings.selection.categories ?? {}),
      toolCategoryMap: settings.selection.toolCategories ?? {},
      presetOverrides: Object.keys(presetOverrides),
      policy: {
        default: settings.policy.default,
        presets: Object.entries(presetOverrides)
          .filter(([, override]) => Object.keys(override?.policy?.tools ?? {}).length > 0)
          .map(([id, override]) => ({ id, tools: Object.keys(override.policy.tools) })),
      },
      swarm: {
        active: swarmSessions.size,
        personas: Object.keys(settings.swarm?.personas ?? {}),
        judgedPresets: Object.entries(presetOverrides)
          .filter(([, override]) => typeof override?.judge?.instructions === 'string' && override.judge.instructions.trim() !== '')
          .map(([id]) => id),
      },
      features: {
        selection: settings.selection.enabled,
        assessment: settings.assessment.enabled,
        loopDetection: settings.loopDetection.enabled,
        skills: settings.skills.enabled,
        modelRouting: settings.modelRouting.enabled,
      },
      thresholds: { ...settings.thresholds },
      // Tool output must be lossless JSON: drop undefined-valued keys.
      stats: JSON.parse(JSON.stringify(stats)),
      recent: JSON.parse(JSON.stringify(recent)),
    }),
  }
}
