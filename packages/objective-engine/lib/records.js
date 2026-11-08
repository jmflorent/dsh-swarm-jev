/**
 * Record vocabulary and validation helpers for the objective engine (opm/v1).
 *
 * Everything here is pure: id minting, text bounds, criteria normalization,
 * budget shapes, canonical JSON, and the hash chain primitive. No I/O.
 */
import { createHash, randomUUID } from 'node:crypto'

export const SCHEMA = 'opm/v1'
export const TEMPLATE_VERSION = 1

export const OBJECTIVE_STATES = Object.freeze([
  'proposed',
  'queued',
  'active',
  'paused',
  'verifying',
  'awaiting-human',
  'blocked',
  'completed',
  'cancelled',
])
export const OPEN_STATES = new Set(['queued', 'active', 'paused', 'verifying', 'awaiting-human', 'blocked', 'proposed'])
export const COUNTED_ACTIVE = new Set(['active', 'verifying', 'awaiting-human'])
export const TERMINAL_STATES = new Set(['completed', 'cancelled'])
export const ITEM_STATES = Object.freeze(['queued', 'dispatched', 'reported', 'accepted', 'rejected', 'failed', 'cancelled'])
export const ITEM_TERMINAL = new Set(['accepted', 'rejected', 'failed', 'cancelled'])
export const ITEM_KINDS = new Set(['work-order', 'status-report', 'heartbeat'])
export const CHECK_KINDS = new Set(['command', 'artifact', 'human-ack', 'evidence'])
export const VERDICTS = new Set(['approve', 'reject', 'inconclusive'])
export const WAKE_FORMS = new Set(['work', 'plan', 'verdict', 'failure', 'ack', 'blocked', 'paused'])

/** Closed command-event vocabulary. Anything else is rejected by the fold. */
export const EVENT_TYPES = new Set([
  'engine/started',
  'engine/paused',
  'engine/resumed',
  'engine/degraded',
  'engine/overloaded',
  'engine/recovered',
  'objective/created',
  'objective/edited',
  'objective/state-changed',
  'objective/budget-changed',
  'objective/verification-requested',
  'objective/verification-verdict',
  'objective/ack-recorded',
  'objective/closed',
  'item/created',
  'item/dispatched',
  'item/reported',
  'item/accepted',
  'item/rejected',
  'item/failed',
  'item/cancelled',
  'verification/requested',
  'verification/evidence',
  'verification/verdict',
  'verification/superseded',
  'wakeup/reserved',
  'wakeup/admitted',
  'wakeup/expired',
  'wakeup/superseded',
  'admission/rejected',
  'admission/queued',
  'admission/dequeued',
])

/** Actor kinds permitted per event family (Section 4 closed actor sets). */
export const ACTOR_KINDS = new Set(['human', 'agent', 'engine'])

const base32 = () => randomUUID().replace(/-/g, '').slice(0, 20)
export const mintId = (prefix) => `${prefix}-${base32()}`

export const clampText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export const positiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER, min = 1) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < min) return fallback
  return Math.min(Math.floor(number), max)
}
export const nonNegativeInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => positiveInt(value, fallback, max, 0)
export const unitInterval = (value, fallback) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) return fallback
  return number
}

/** Deterministic JSON: object keys sorted recursively, lossless scalars only. */
export const canonicalJson = (value) => JSON.stringify(sortKeys(value))
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isRecord(value)) {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortKeys(value[key])
    }
    return out
  }
  return value
}
export const sha256 = (text) => createHash('sha256').update(text).digest('hex')
export const digest = (value) => sha256(canonicalJson(value))
export const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/** Normalize one criterion input into the opm/v1 criterion record. */
export const normalizeCriterion = (input, index) => {
  const id = `c${index + 1}`
  if (typeof input === 'string') {
    const statement = clampText(input, 1000)
    if (statement === '') return undefined
    return { id, statement, check: { kind: 'evidence' }, requiresHumanAck: false }
  }
  if (!isRecord(input)) return undefined
  const statement = clampText(input.statement, 1000)
  if (statement === '') return undefined
  const rawCheck = isRecord(input.check) ? input.check : { kind: 'evidence' }
  const kind = CHECK_KINDS.has(rawCheck.kind) ? rawCheck.kind : undefined
  if (kind === undefined) return { error: `criterion ${id}: check.kind must be one of ${[...CHECK_KINDS].join(', ')}` }
  let check
  if (kind === 'command') {
    const command = clampText(rawCheck.command, 2000)
    if (command === '') return { error: `criterion ${id}: a command check needs a command` }
    check = {
      kind,
      command,
      ...(clampText(rawCheck.cwd, 1000) === '' ? {} : { cwd: clampText(rawCheck.cwd, 1000) }),
      expectedExitCode: nonNegativeInt(rawCheck.expectedExitCode, 0, 255),
      ...(rawCheck.timeoutMs === undefined ? {} : { timeoutMs: positiveInt(rawCheck.timeoutMs, 600000, 3600000) }),
    }
  } else if (kind === 'artifact') {
    const path = clampText(rawCheck.path, 1000)
    if (path === '') return { error: `criterion ${id}: an artifact check needs a path` }
    check = { kind, path, ...(/^[0-9a-f]{64}$/i.test(String(rawCheck.sha256 ?? '')) ? { sha256: String(rawCheck.sha256).toLowerCase() } : {}) }
  } else if (kind === 'human-ack') {
    check = { kind, prompt: clampText(rawCheck.prompt, 1000) || statement }
  } else {
    check = { kind: 'evidence', ...(clampText(rawCheck.hint, 1000) === '' ? {} : { hint: clampText(rawCheck.hint, 1000) }) }
  }
  const requiresHumanAck = kind === 'human-ack' ? true : input.requiresHumanAck === true
  return { id, statement, check, requiresHumanAck }
}

/**
 * Normalize a criteria array. Returns `{criteria}` or `{error, code}`.
 * Creation is rejected when there is no criterion at all or when any entry is
 * malformed; the closed check vocabulary is enforced here.
 */
export const normalizeCriteria = (input) => {
  if (!Array.isArray(input) || input.length === 0) return { error: 'at least one checkable criterion is required', code: 'record-incomplete' }
  if (input.length > 12) return { error: 'at most 12 criteria per objective', code: 'record-incomplete' }
  const criteria = []
  for (let index = 0; index < input.length; index += 1) {
    const criterion = normalizeCriterion(input[index], index)
    if (criterion === undefined) return { error: `criterion ${index + 1} is empty`, code: 'record-incomplete' }
    if (criterion.error !== undefined) return { error: criterion.error, code: 'record-incomplete' }
    criteria.push(criterion)
  }
  return { criteria }
}

export const normalizeScope = (input) => {
  if (!isRecord(input)) return { kind: 'paths', paths: [] }
  if (input.kind === 'worktree' && typeof input.path === 'string') {
    return {
      kind: 'worktree',
      path: clampText(input.path, 1000),
      ...(typeof input.branch === 'string' ? { branch: clampText(input.branch, 200) } : {}),
      ...(typeof input.baseCommit === 'string' ? { baseCommit: clampText(input.baseCommit, 64) } : {}),
    }
  }
  const paths = Array.isArray(input.paths) ? input.paths.map((path) => clampText(path, 1000)).filter((path) => path !== '') : []
  return { kind: 'paths', paths: [...new Set(paths)].slice(0, 64) }
}

const normalizePath = (path) => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
/** Two path scopes overlap when either path is a prefix of the other. */
export const scopesOverlap = (a, b) => {
  if (a?.kind !== 'paths' || b?.kind !== 'paths') return false
  for (const left of a.paths) {
    const l = normalizePath(left)
    for (const right of b.paths) {
      const r = normalizePath(right)
      if (l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`)) return true
    }
  }
  return false
}

/** Build the six-counter budget from the request and the deployment maxima. */
export const makeBudget = (input, limits) => ({
  rounds: { used: 0, max: positiveInt(input?.rounds ?? input?.budgetRounds, limits.maxRoundsPerObjective, limits.maxRoundsPerObjective) },
  tokens: { used: 0, max: positiveInt(input?.tokens, limits.maxTokensPerObjective, limits.maxTokensPerObjective) },
  wallTimeMs: { used: 0, max: positiveInt(input?.wallTimeMs, limits.maxWallTimePerObjective, limits.maxWallTimePerObjective) },
  items: { used: 0, max: positiveInt(input?.items, limits.maxItemsPerObjective, limits.maxItemsPerObjective) },
  verifierRuns: { used: 0, max: positiveInt(input?.verifierRuns, limits.maxVerifierRunsPerObjective, limits.maxVerifierRunsPerObjective) },
  concurrency: { used: 0, max: positiveInt(input?.concurrency, limits.maxActiveItemsPerObjective, limits.maxActiveItemsPerObjective) },
})

/** Which budget counter is exhausted, if any. */
export const exhaustedCounter = (budget) => {
  for (const name of ['rounds', 'tokens', 'wallTimeMs', 'items', 'verifierRuns']) {
    const counter = budget?.[name]
    if (counter !== undefined && counter.used >= counter.max) return name
  }
  return undefined
}

/** Normalized statement hash used for duplicate detection (owner + text). */
export const statementKey = (ownerSessionId, statement) =>
  sha256(`${ownerSessionId}\n${statement.toLowerCase().replace(/\s+/g, ' ').trim()}`)

export const iso = (ms) => new Date(ms).toISOString()
