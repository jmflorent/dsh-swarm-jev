/**
 * systemone — model-visible tools for a self-hosted, Jev-style decision model.
 *
 * The decision service ("System One") answers typed questions — `noul` (the
 * probability a yes/no statement holds), `choice` (one of declared options),
 * `score` (a position on an ordered rubric) — with calibrated numbers. It does
 * not write prose, and these tools give the agent exactly that surface and
 * nothing more.
 *
 * Egress: every call sends the state and questions given in the tool arguments
 * to the configured endpoint, which is the user's own decision server. That is
 * the only transmission this plugin makes; the resolved credential is never
 * returned from a tool, never logged, and never written to configuration.
 */

import { defineTool } from './lib/define-tool.js'
import Schema from './vendor/schemastery/index.mjs'
import { createDecisionRuntime } from './lib/decisions.js'
import { buildMultipart, loadImage } from './lib/vision.js'

export const name = 'systemone'

/** `tools` registers the model-facing tools; `credentials` is read opportunistically. */
export const inject = ['tools']

/**
 * Model-judged persona rule: a natural-language allowance the System One model
 * evaluates against every tool call of the persona. This is the probabilistic
 * half of the policy — it catches indirect violations (an interpreter writing a
 * source file, a build step rewriting sources) that no deterministic pattern
 * can enumerate, at the cost of one decision call per gated tool call.
 */
const judgeSchema = Schema.object({
  instructions: Schema.string().description(
    'What this persona may and may not do, in the model\'s own terms. The layer asks the ' +
      'decision model whether a call violates this on every gated tool call.',
  ),
  boundary: Schema.object({
    true: Schema.string().description('What counts as a violation.'),
    false: Schema.string().description('What stays within the persona\'s allowance.'),
  }).description('Optional boundary definitions that make the probability interpretable.'),
})

/**
 * Deterministic per-persona tool policy. Explicit rules, evaluated
 * synchronously on every call; see lib/policy.js for the evaluation order.
 */
const policySchema = Schema.object({
  default: Schema.union(['allow', 'deny']).default('allow'),
  allow: Schema.array(Schema.string()).default([]),
  deny: Schema.array(Schema.string()).default([]),
  tools: Schema.dict(
    Schema.object({
      deny: Schema.boolean(),
      paths: Schema.object({
        allow: Schema.array(Schema.string()).default([]),
        deny: Schema.array(Schema.string()).default([]),
      }),
      commands: Schema.object({
        deny: Schema.array(Schema.string()).default([]),
      }),
    }),
  ).default({}),
})

export const Config = Schema.object({
  endpoint: Schema.string()
    .default('http://127.0.0.1:8008/v1/systemone')
    .volatile()
    .description('Full URL of the System One decision endpoint that receives POST requests.'),
  model: Schema.string()
    .default('decision-model')
    .volatile()
    .description('Model id sent with every request.'),
  apiKeyRef: Schema.string()
    .default('SYSTEMONE_API_KEY')
    .volatile()
    .description(
      'Credential reference resolved through the DSH credential service (then the environment) ' +
        'and sent as a Bearer token. Empty or unresolved means no Authorization header.',
    ),
  timeoutMs: Schema.number()
    .default(20000)
    .volatile()
    .description('Per-call deadline in milliseconds.'),
  maxQuestions: Schema.number()
    .default(64)
    .description('Maximum number of questions accepted in one batch.'),
  maxRequestChars: Schema.number()
    .default(262144)
    .description('Maximum serialized request size in characters (256 KiB).'),
  maxRequestBytes: Schema.number()
    .default(8388608)
    .description('Maximum multipart request size in bytes when images are attached (8 MiB).'),
  maxImageBytes: Schema.number()
    .default(4194304)
    .description('Maximum size of one attached PNG/JPEG image in bytes (4 MiB).'),
  maxResponseChars: Schema.number()
    .default(1048576)
    .description('Maximum accepted response size in characters (1 MiB).'),
  mode: Schema.union(['off', 'shadow', 'enforce', 'swarm'])
    .default('shadow')
    .volatile()
    .description(
      'Decision-layer behavior: off does nothing, shadow computes and logs decisions, ' +
        'enforce applies them, and swarm enforces them ONLY for sessions that entered the mode ' +
        'with `swarm_enter` — every other session stays completely inert (no model calls, no ' +
        'restrictions, no denials). Decisions can only narrow behavior, never widen it.',
    ),
  swarm: Schema.object({
    orchestratorTools: Schema.array(Schema.string()).description(
      'Tools the orchestrator keeps while in swarm mode. Everything else is hidden from it: ' +
        'a swarm orchestrator never does stage work — it decomposes, assigns with swarm_assign, ' +
        'dispatches subagents, verifies, and integrates. Workers keep the full toolset.',
    ),
    personas: Schema.dict(
      Schema.object({
        description: Schema.string(),
        instructions: Schema.string(),
      }),
    ).description(
      'Persona catalog the assignment question is built from, keyed by persona id. Each entry ' +
        'needs a one-line description (the choice criteria the model sees) and the operating ' +
        'instructions handed back to the orchestrator when that persona is assigned.',
    ),
  }).description(
    'Preset ids treated as swarm members. In swarm mode only these sessions get the ' +
      'decision layer; every other preset is inert, so an orchestrator/lead session cannot ' +
      'block itself.',
  ),
  thresholds: Schema.object({
    selection: Schema.number().default(0.25),
    restriction: Schema.number().default(0.5),
    missingInformation: Schema.number().default(0.5),
    taskMatch: Schema.number().default(0.35),
    skill: Schema.number().default(0.5),
    modelRoute: Schema.number().default(0.4),
  }).description('Probability thresholds for each decision class.'),
  selection: Schema.object({
    enabled: Schema.boolean().default(true).volatile(),
    alwaysAllow: Schema.array(Schema.string()).default([]),
    categories: Schema.dict(Schema.string()).default({}),
    toolCategories: Schema.dict(Schema.array(Schema.string())).default({}),
  }).description('Per-turn tool preselection applied through the agent-scoped tool restriction.'),
  assessment: Schema.object({
    enabled: Schema.boolean().default(true).volatile(),
    onFailure: Schema.union(['ask', 'hold']).default('ask'),
    includeRiskScore: Schema.boolean().default(false),
    restrictions: Schema.array(Schema.string()).default([]),
  }).description('Per-call assessment composed onto the pre-execute policy chain.'),
  loopDetection: Schema.object({
    enabled: Schema.boolean().default(true).volatile(),
    maxRepeats: Schema.number().default(2),
  }).description('Deterministic repeated-call guard; uses no model.'),
  skills: Schema.object({
    enabled: Schema.boolean().default(false).volatile(),
    injectHint: Schema.boolean().default(true),
  }).description('Optional one-skill-per-turn routing hint.'),
  modelRouting: Schema.object({
    enabled: Schema.boolean().default(false).volatile(),
    routes: Schema.dict(
      Schema.object({
        provider: Schema.string(),
        model: Schema.string(),
      }),
    ).default({}),
  }).description(
    'Optional route selection. Targets must exist in the live provider catalog and ' +
      'apply to the next step, because a step\'s model selection is captured before it runs.',
  ),
  presets: Schema.dict(
    Schema.object({
      mode: Schema.union(['off', 'shadow', 'enforce']),
      selection: Schema.object({
        alwaysAllow: Schema.array(Schema.string()),
        categories: Schema.dict(Schema.string()),
        toolCategories: Schema.dict(Schema.array(Schema.string())),
      }),
      assessment: Schema.object({
        onFailure: Schema.union(['ask', 'hold']),
        restrictions: Schema.array(Schema.string()),
      }),
      thresholds: Schema.object({
        selection: Schema.number(),
        restriction: Schema.number(),
        missingInformation: Schema.number(),
        taskMatch: Schema.number(),
      }),
      policy: policySchema,
      judge: judgeSchema,
    }),
  ).default({}).description(
    'Per-agent-preset overrides keyed by preset id (for example "reviewer" or "researcher"). ' +
      'A session running that preset gets its own category taxonomy, mode, thresholds, and ' +
      'tool policy; unlisted presets use the top-level settings.',
  ),
  policy: policySchema.description(
    'Deterministic tool policy applied to every call of a matching persona: explicit allow/deny ' +
      'rules, file-path constraints for read/write/edit, and command patterns for bash. Evaluated ' +
      'synchronously with no model round-trip; denies in enforce mode, records in shadow mode.',
  ),
})

/** True for a plain JSON object, excluding arrays and null. */
const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A finite number, or undefined for anything else. */
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Truncate a string for a bounded detail field. */
const truncateText = (text, max = 2000) =>
  text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`

/** Bounded one-line JSON rendering of an unexpected response body. */
const detailOf = (value) => {
  try {
    return truncateText(JSON.stringify(value))
  } catch {
    return undefined
  }
}

const QUESTION_TYPES = ['noul', 'choice', 'score', 'box']

/**
 * Validate one model-supplied question and reduce it to the wire shape:
 * `{ type, instructions }` plus `criteria` (a label→description map for
 * choice, an ordered level-description array for score) and an optional noul
 * `boundary`. A malformed question is a caller bug, so it throws.
 */
const validateQuestion = (id, raw) => {
  if (!isRecord(raw)) {
    throw new Error(`question "${id}" must be an object like { type, instructions, criteria }`)
  }
  if (!QUESTION_TYPES.includes(raw.type)) {
    throw new Error(
      `question "${id}" has type ${JSON.stringify(raw.type)}; expected one of ` +
        `${QUESTION_TYPES.map((t) => `"${t}"`).join(', ')}`,
    )
  }
  if (raw.instructions === undefined || raw.instructions === null) {
    throw new Error(`question "${id}" is missing "instructions"`)
  }
  const question = { type: raw.type, instructions: raw.instructions }
  if (raw.type === 'choice') {
    if (!isRecord(raw.criteria) || Object.keys(raw.criteria).length === 0) {
      throw new Error(
        `question "${id}" is a choice: "criteria" must be a non-empty map of option label ` +
          `to description, e.g. { billing: "Payments and refunds" }`,
      )
    }
    question.criteria = raw.criteria
  } else if (raw.type === 'score') {
    if (!Array.isArray(raw.criteria) || raw.criteria.length < 2) {
      throw new Error(
        `question "${id}" is a score: "criteria" must be an array of at least two level ` +
          `descriptions written in ascending order, e.g. ["unclear", "partly clear", "clear"]`,
      )
    }
    question.criteria = raw.criteria
  } else if (raw.type === 'box') {
    if (typeof raw.instructions !== 'string' || raw.instructions.trim().length === 0) {
      throw new Error(
        `question "${id}" is a box: "instructions" must name what to locate in the image, ` +
          'for example "Locate the damaged corner"',
      )
    }
  } else if (raw.boundary !== undefined) {
    if (!isRecord(raw.boundary)) {
      throw new Error(`question "${id}" is a noul: "boundary" must be an object like { true: '...', false: '...' }`)
    }
    question.boundary = raw.boundary
  }
  return question
}

/**
 * Normalize one raw answer against the question type it answers, following the
 * System One wire shapes: noul `{ noul }`, choice `{ choice, probabilities?,
 * confidence? }`, score `{ score, legend?, probabilities?, confidence? }`.
 * Nothing is invented: an answer that does not match its expected shape is
 * reported as unmatched rather than coerced.
 */
const normalizeAnswer = (raw, expected) => {
  if (!isRecord(raw)) return undefined
  const confidence = finite(raw.confidence)
  if (expected === 'noul') {
    const noul = finite(raw.noul)
    return noul === undefined ? undefined : { type: 'noul', noul }
  }
  if (expected === 'box') {
    const box = isRecord(raw.box) ? raw.box : undefined
    if (box === undefined) return undefined
    const edge = (key) => finite(box[key])
    const top = edge('top')
    const bottom = edge('bottom')
    const left = edge('left')
    const right = edge('right')
    if (top === undefined || bottom === undefined || left === undefined || right === undefined) return undefined
    return {
      type: 'box',
      box: { top, bottom, left, right },
      ...(confidence === undefined ? {} : { confidence }),
    }
  }
  if (expected === 'score') {
    const score = finite(raw.score)
    if (score === undefined) return undefined
    const legend = {}
    if (isRecord(raw.legend)) {
      for (const [index, description] of Object.entries(raw.legend)) {
        if (typeof description === 'string') legend[index] = description
      }
    }
    return {
      type: 'score',
      score,
      legend,
      probabilities: probabilitiesOf(raw.probabilities),
      ...(confidence === undefined ? {} : { confidence }),
    }
  }
  const choice = typeof raw.choice === 'string' ? raw.choice : undefined
  if (choice === undefined) return undefined
  return {
    type: 'choice',
    choice,
    probabilities: probabilitiesOf(raw.probabilities),
    ...(confidence === undefined ? {} : { confidence }),
  }
}

/** Probability entries, keeping only finite numbers. */
function probabilitiesOf(value) {
  const probabilities = {}
  if (!isRecord(value)) return probabilities
  for (const [key, entry] of Object.entries(value)) {
    const probability = finite(entry)
    if (probability !== undefined) probabilities[key] = probability
  }
  return probabilities
}

/** Pull token usage fields the endpoint reported, under either spelling. */
const readUsage = (value) => {
  if (!isRecord(value)) return undefined
  const pick = (...keys) => {
    for (const key of keys) {
      const entry = finite(value[key])
      if (entry !== undefined) return entry
    }
    return undefined
  }
  const usage = {}
  const inputTokens = pick('inputTokens', 'input_tokens')
  const outputTokens = pick('outputTokens', 'output_tokens')
  const costUsd = pick('costUsd', 'cost_usd')
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  if (costUsd !== undefined) usage.costUsd = costUsd
  return Object.keys(usage).length > 0 ? usage : undefined
}

/**
 * Resolve the Bearer token for one call: the DSH credential service first,
 * then the environment variable of the same reference name. Returns undefined
 * when nothing is set — the request then carries no Authorization header.
 * The key itself never leaves this function's return path.
 */
const resolveApiKey = async (ctx, ref) => {
  if (typeof ref !== 'string' || ref.trim() === '') return undefined
  const name = ref.trim()
  try {
    const credentials = ctx.credentials
    if (credentials && typeof credentials.resolve === 'function') {
      const resolved = await credentials.resolve(name)
      if (resolved && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return resolved.value
      }
    }
  } catch {
    // Fall through to the environment.
  }
  const fromEnv = process.env[name]
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined
}

/**
 * POST one decision request to the configured endpoint.
 *
 * Domain outcome, not a throw: an unreachable or misbehaving endpoint is
 * reported as `{ ok: false, ... }` so the calling model receives structured
 * facts instead of an opaque error. Malformed tool arguments are the caller's
 * fault and throw before any request is built.
 */
const postDecision = async (config, ctx, payload, signal, override) => {
  const startedAt = Date.now()
  const apiKey = await resolveApiKey(ctx, config.apiKeyRef)
  const deadline = AbortSignal.timeout(config.timeoutMs)
  const fused = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  let response
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': override?.contentType ?? 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: override?.body ?? payload,
      signal: fused,
    })
  } catch (error) {
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
    const reason = aborted
      ? `no answer within ${config.timeoutMs} ms`
      : `connection to the decision endpoint failed: ${error?.message ?? String(error)}`
    return { ok: false, latencyMs: Date.now() - startedAt, error: reason }
  }
  const latencyMs = Date.now() - startedAt
  let text
  try {
    text = await response.text()
  } catch (error) {
    return {
      ok: false,
      latencyMs,
      status: response.status,
      error: `reading the response body failed: ${error?.message ?? String(error)}`,
    }
  }
  if (text.length > config.maxResponseChars) {
    return {
      ok: false,
      latencyMs,
      status: response.status,
      error: `response is ${text.length} characters; the configured maximum is ${config.maxResponseChars}`,
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      latencyMs,
      status: response.status,
      error: `the decision endpoint answered HTTP ${response.status} ${response.statusText}`.trim(),
      ...(text.length === 0 ? {} : { detail: truncateText(text) }),
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ok: false,
      latencyMs,
      status: response.status,
      error: 'the decision endpoint returned a body that is not JSON',
      detail: truncateText(text),
    }
  }
  return { ok: true, latencyMs, status: response.status, response: parsed }
}

/**
 * Build the plugin runtime: the two tools plus the small shared call record
 * the status tool reports. Kept outside `apply` so the wiring is testable
 * against a fake context.
 */
export const buildTools = (ctx, config, lastCall, runtime) => {
  const recordCall = (tool, outcome) => {
    lastCall.current = {
      at: new Date().toISOString(),
      tool,
      ok: outcome.ok,
      latencyMs: outcome.latencyMs,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    }
  }

  const askTool = defineTool({
    name: 'systemone_ask',
    description:
      'Ask the self-hosted System One decision model a batch of typed questions about one state ' +
      'and receive calibrated answers. It does not write prose or explain: it returns numbers. ' +
      'Use it for judgments the work branches on — routing, classifying, scoring, triaging, ' +
      'deciding — and do NOT use it to generate text, summarize, or write code.\n\n' +
      'Question types: "noul" returns the probability that a yes/no statement holds; "choice" ' +
      'picks one of the option labels you declare in criteria; "score" places the state on an ' +
      'ordered scale whose level descriptions you declare in criteria, lowest level first, and ' +
      'answers with a numeric score that may fall between levels; "box" locates what its ' +
      'instructions describe in an attached image and answers with { top, bottom, left, right } ' +
      'as fractions of the image, and requires "images". Several questions in one call are ' +
      'answered independently against the same state and cost one round-trip, so batch what ' +
      'you need. The task state and questions are sent to the configured decision endpoint.',
    parameters: {
      state: {
        type: 'json',
        required: true,
        description:
          'The evidence to judge: the task, question, or facts the questions are about. This is ' +
          'transmitted to the configured decision endpoint.',
      },
      questions: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description:
          'Map of question id to question: { type, instructions, criteria?, boundary? }. ' +
          '"instructions" states the question itself. "criteria" is required for choice (map of ' +
          'permitted answer label to description) and for score (array of level descriptions in ' +
          'ascending order). A noul may declare "boundary" ({ true, false }) when the line ' +
          'between yes and no is not self-evident.',
      },
      images: {
        type: 'json',
        description:
          'Optional PNG/JPEG images sent as multipart assets for vision-capable models. An array of ' +
          '{ path, name? }: "path" is an absolute file path, "name" is the alias (default derived ' +
          'from the file). Reference the alias literally inside "state" or question instructions, ' +
          'e.g. "<photo>", as the assets protocol expects. With images the request is ' +
          'multipart/form-data rather than JSON.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          endpoint: { type: 'string', required: true },
          model: { type: 'string' },
          answers: { type: 'json', required: true },
          unmatched: { type: 'json', required: true },
          usage: { type: 'json' },
          latencyMs: { type: 'number', required: true },
          error: { type: 'string' },
          status: { type: 'number' },
          detail: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const questionInput = args.questions
      if (!isRecord(questionInput) || Object.keys(questionInput).length === 0) {
        throw new Error('"questions" must be an object with at least one entry')
      }
      const ids = Object.keys(questionInput)
      if (ids.length > config.maxQuestions) {
        throw new Error(
          `too many questions (${ids.length}); the configured maximum is ${config.maxQuestions}`,
        )
      }
      const questions = {}
      for (const id of ids) questions[id] = validateQuestion(id, questionInput[id])

      const requestedImages = Array.isArray(args?.images) ? args.images : []
      if (requestedImages.length === 0 && Object.values(questions).some((question) => question.type === 'box')) {
        throw new Error('"box" questions locate something in an image, so they require "images"')
      }
      let payload = ''
      let override
      if (requestedImages.length > 0) {
        const loaded = []
        for (let index = 0; index < requestedImages.length; index += 1) {
          loaded.push(await loadImage(requestedImages[index], index, config.maxImageBytes))
        }
        const multipart = buildMultipart(
          { state: args.state, questions, model: config.model },
          loaded,
        )
        if (multipart.body.byteLength > config.maxRequestBytes) {
          throw new Error(
            `multipart request is ${multipart.body.byteLength} bytes; the configured maximum is ` +
              `${config.maxRequestBytes}. Use smaller images or raise maxRequestBytes.`,
          )
        }
        override = { body: multipart.body, contentType: multipart.contentType }
      } else {
        payload = JSON.stringify({ state: args.state, questions, model: config.model })
        if (payload.length > config.maxRequestChars) {
          throw new Error(
            `serialized request is ${payload.length} characters; the configured maximum is ` +
              `${config.maxRequestChars}. Trim the state or raise maxRequestChars.`,
          )
        }
      }

      const outcome = await postDecision(config, ctx, payload, exec?.signal, override)
      recordCall('systemone_ask', outcome)
      if (!outcome.ok) {
        const multipartRejected = override !== undefined && outcome.status === 422
        return {
          ok: false,
          endpoint: config.endpoint,
          answers: {},
          unmatched: [],
          latencyMs: outcome.latencyMs,
          error: multipartRejected
            ? 'the endpoint rejected the multipart asset request (HTTP 422). This deployment accepts ' +
              'application/json only, so it does not support image assets; call again without "images".'
            : outcome.error,
          ...(outcome.status === undefined ? {} : { status: outcome.status }),
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        }
      }
      const response = outcome.response
      const rawAnswers = isRecord(response) && isRecord(response.answers) ? response.answers : undefined
      if (rawAnswers === undefined) {
        return {
          ok: false,
          endpoint: config.endpoint,
          answers: {},
          unmatched: [],
          latencyMs: outcome.latencyMs,
          error:
            'the response carries no "answers" object, so it does not follow the System One ' +
            'contract — the endpoint may be a different service than configured',
          status: outcome.status,
          ...(detailOf(response) === undefined ? {} : { detail: detailOf(response) }),
        }
      }
      const answers = {}
      const unmatched = []
      for (const id of Object.keys(questions)) {
        const answer = normalizeAnswer(rawAnswers[id], questions[id].type)
        if (answer === undefined) unmatched.push(id)
        else answers[id] = answer
      }
      const usage = readUsage(isRecord(response) ? response.usage : undefined)
      const model =
        isRecord(response) && typeof response.model === 'string' ? response.model : config.model
      return {
        ok: true,
        endpoint: config.endpoint,
        model,
        answers,
        unmatched,
        ...(usage === undefined ? {} : { usage }),
        latencyMs: outcome.latencyMs,
      }
    },
  })

  const statusTool = defineTool({
    name: 'systemone_status',
    description:
      'Report how the System One decision-model tools are configured: the endpoint, the model id, ' +
      'whether a credential is set (never its value), and the outcome of the most recent call. ' +
      'With probe=true it also sends one tiny test question to verify end-to-end connectivity, ' +
      'which consumes a little of the decision model.',
    parameters: {
      probe: {
        type: 'boolean',
        description: 'Send one tiny noul test question to verify the endpoint answers end to end.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          endpoint: { type: 'string', required: true },
          model: { type: 'string', required: true },
          auth: { type: 'string', required: true },
          lastCall: { type: 'json' },
          layer: { type: 'json' },
          probe: { type: 'json' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const hasCredential = (await resolveApiKey(ctx, config.apiKeyRef)) !== undefined
      const status = {
        ok: true,
        endpoint: config.endpoint,
        model: config.model,
        auth: hasCredential ? 'credential configured' : 'no credential (requests carry no auth header)',
        ...(lastCall.current === null ? {} : { lastCall: lastCall.current }),
        ...(runtime === undefined ? {} : { layer: runtime.status() }),
      }
      if (args?.probe === true) {
        const payload = JSON.stringify({
          state: { task: 'Connectivity self-test from the DSH systemone plugin.' },
          questions: {
            probe: {
              type: 'noul',
              instructions: 'Does 2 plus 2 equal 4? Answer with the probability that the statement is true.',
            },
          },
          model: config.model,
        })
        const outcome = await postDecision(config, ctx, payload, exec?.signal)
        recordCall('systemone_status(probe)', outcome)
        if (outcome.ok) {
          const response = outcome.response
          const rawAnswers = isRecord(response) && isRecord(response.answers) ? response.answers : undefined
          const answer =
            rawAnswers === undefined ? undefined : normalizeAnswer(rawAnswers.probe, 'noul')
          status.probe = answer === undefined
            ? {
                ok: false,
                latencyMs: outcome.latencyMs,
                error: 'the endpoint answered but the probe answer was not a readable noul',
                ...(detailOf(response) === undefined ? {} : { detail: detailOf(response) }),
              }
            : {
                ok: true,
                latencyMs: outcome.latencyMs,
                model: isRecord(response) && typeof response.model === 'string' ? response.model : config.model,
                answers: { probe: answer },
              }
        } else {
          status.probe = {
            ok: false,
            latencyMs: outcome.latencyMs,
            error: outcome.error,
            ...(outcome.status === undefined ? {} : { status: outcome.status }),
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          }
        }
      }
      return status
    },
  })

  const swarmEnterTool = defineTool({
    name: 'swarm_enter',
    description:
      'Enter SWARM MODE for this session. The primary agent becomes the orchestrator: it keeps an ' +
      'explicit workplan, and swarm_assign asks the decision model which persona executes each stage. ' +
      'In swarm mode the decision model also judges every tool call. Leave with swarm_exit.',
    parameters: {
      note: { type: 'string', description: 'Why the session is entering swarm mode.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          active: { type: 'boolean', required: true },
          personas: { type: 'json', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec?.agent === undefined) throw new Error('swarm_enter requires an agent session')
      const result = runtime.swarm.enter(exec.agent)
      return {
        ok: true,
        active: result.active,
        personas: Object.keys(runtime.settings.swarm?.personas ?? {}),
      }
    },
  })

  const swarmExitTool = defineTool({
    name: 'swarm_exit',
    description: "Leave SWARM MODE for this session: the orchestrator policy section is removed, stage assignment stops, and the decision layer stops judging this session's tool calls.",
    parameters: {
      note: { type: 'string', description: 'Why the session is leaving swarm mode.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          active: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec?.agent === undefined) throw new Error('swarm_exit requires an agent session')
      const result = runtime.swarm.exit(exec.agent)
      return { ok: true, active: result.active }
    },
  })

  const swarmAssignTool = defineTool({
    name: 'swarm_assign',
    description:
      'Ask the System One decision model which agent persona should execute one stage of the ' +
      'workplan. Returns the chosen persona id, its description, and its operating instructions; ' +
      'then invoke that persona — spawn a subagent with those instructions and the stage brief, or ' +
      'execute the stage yourself when you are that persona. This is the assignment authority in ' +
      'swarm mode: do not choose the persona yourself when this tool answers.',
    parameters: {
      stage: {
        type: 'string',
        required: true,
        description: 'The workplan stage: its goal, inputs, and acceptance criteria.',
      },
      needs: {
        type: 'string',
        description: 'Optional: what the stage needs — evidence, artifacts, skills, constraints.',
      },
      context: {
        type: 'json',
        description: 'Optional extra state sent with the question (task, repository facts, constraints).',
      },
      candidates: {
        type: 'json',
        description: 'Optional array of persona ids to choose among; defaults to the configured swarm personas.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          persona: { type: 'string' },
          description: { type: 'string' },
          instructions: { type: 'string' },
          choices: { type: 'json' },
          latencyMs: { type: 'number', required: true },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof args?.stage !== 'string' || args.stage.trim() === '') {
        throw new Error('"stage" must be a non-empty description of the workplan stage')
      }
      const result = await runtime.swarm.assign(
        { stage: args.stage, needs: args.needs, context: args.context, candidates: args.candidates },
        exec?.signal,
      )
      if (!result.ok) {
        return { ok: false, latencyMs: result.latencyMs ?? 0, error: result.error }
      }
      return {
        ok: true,
        persona: result.persona,
        description: result.description,
        instructions: result.instructions,
        choices: result.choices,
        latencyMs: result.latencyMs,
      }
    },
  })

  return { askTool, statusTool, swarmEnterTool, swarmExitTool, swarmAssignTool }
}

/** Cordis plugin entry: the decision layer, then both tools as lifecycle-managed effects. */
export function apply(ctx, config) {
  const lastCall = { current: null }
  const runtime = createDecisionRuntime(ctx, config)
  // Volatile config fields (endpoint, model, apiKeyRef, timeoutMs, mode, feature
  // toggles) arrive as live references; the runtime settings object turns them
  // into getters, so every tool and decision below reads the Settings-screen
  // value at call time instead of the value captured at startup.
  const settings = runtime.settings
  runtime.install()
  const { askTool, statusTool, swarmEnterTool, swarmExitTool, swarmAssignTool } = buildTools(
    ctx,
    settings,
    lastCall,
    runtime,
  )
  ctx.effect(() => ctx.tools.register(askTool))
  ctx.effect(() => ctx.tools.register(statusTool))
  ctx.effect(() => ctx.tools.register(swarmEnterTool))
  ctx.effect(() => ctx.tools.register(swarmExitTool))
  ctx.effect(() => ctx.tools.register(swarmAssignTool))
  // Decision-plane seam for other host plugins (the objective engine's advisory
  // classifier). Read-only: no credentials, no state mutation.
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide('systemone', {
        decide: (state, questions, signal) => runtime.decide(state, questions, signal),
        status: () => runtime.status(),
      })
    }
  } catch (error) {
    ctx.logger?.warn?.('[systemone] decision-plane service not provided', error?.message ?? error)
  }

  // Browser swarm panel: one same-origin, connection-authenticated JSON snapshot.
  // Registered only where the Web host and its connection gate are composed, so
  // headless profiles never expose a route. `connection.admit` applies the
  // Host/Origin fence and the browser-session cookie check used by /api.
  if (typeof ctx.inject === 'function' && typeof runtime.panel === 'function') {
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      const respond = (status, body) =>
        new Response(JSON.stringify(body), {
          status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        })
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'exact',
            path: '/systemone/panel.json',
            resource: (request) => {
              try {
                const connection = webCtx.connection ?? webCtx.get?.('connection')
                const admission = connection?.admit?.(request)
                if (admission === undefined || 'rejection' in admission) {
                  return respond(admission?.rejection ?? 503, { ok: false, error: 'unauthorized' })
                }
                return respond(200, runtime.panel())
              } catch {
                return respond(500, { ok: false, error: 'panel-unavailable' })
              }
            },
          }),
        'systemone: swarm panel route',
      )
    })
  }

  const line =
    `[systemone] ready · endpoint=${settings.endpoint} · model=${settings.model} · ` +
    `mode=${settings.mode} · ` +
    'egress=ON (task state and questions are sent to the configured endpoint)'
  const logger = ctx.logger
  if (logger && typeof logger.info === 'function') logger.info(line)
  else console.info(line)
}
