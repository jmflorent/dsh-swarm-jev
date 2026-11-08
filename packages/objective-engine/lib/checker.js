/**
 * Deterministic delivery checks (the Ringer lesson).
 *
 * An objective's command/artifact criteria are executed by the engine itself,
 * in the owner's workspace, with captured exit codes and output. The verifier
 * child still runs independently and judges semantic quality, but it no longer
 * supplies the only evidence for mechanical criteria: approval requires the
 * engine's own executed checks to pass. Evidence and human-ack criteria remain
 * judgment criteria handled by the verifier and the human.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const MECHANICAL_KINDS = new Set(['command', 'artifact'])

const TAIL = 4000

const tail = (text) => {
  const value = typeof text === 'string' ? text : ''
  return value.length > TAIL ? value.slice(-TAIL) : value
}

const readCollected = (handle, stream) => {
  try {
    const read = handle.collected?.[stream]?.readFrom?.(0)
    if (typeof read === 'string') return read
    if (read?.text !== undefined) return String(read.text)
    if (read?.data !== undefined) return Buffer.isBuffer(read.data) ? read.data.toString('utf8') : String(read.data)
    if (Buffer.isBuffer(read)) return read.toString('utf8')
    return read === undefined ? '' : String(read)
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Lint (adapted from the check-lint rules Ringer applies to its manifests)
// ---------------------------------------------------------------------------

const stripShellComments = (command) => {
  const result = []
  let single = false
  let double = false
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      result.push(char)
      escaped = false
      continue
    }
    if (char === '\\' && !single) {
      result.push(char)
      escaped = true
      continue
    }
    if (char === "'" && !double) {
      single = !single
      result.push(char)
      continue
    }
    if (char === '"' && !single) {
      double = !double
      result.push(char)
      continue
    }
    if (char === '#' && !single && !double && (result.length === 0 || /\s/.test(result[result.length - 1]))) {
      while (index < command.length && command[index] !== '\n') index += 1
      continue
    }
    result.push(char)
  }
  return result.join('')
}

const splitParts = (command, separators) => {
  // A deliberately small tokenizer: enough to classify shell check shapes.
  const parts = []
  let current = ''
  let single = false
  let double = false
  let escaped = false
  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && !single) {
      current += char
      escaped = true
      continue
    }
    if (char === "'" && !double) {
      single = !single
      current += char
      continue
    }
    if (char === '"' && !single) {
      double = !double
      current += char
      continue
    }
    if (!single && !double && separators.includes(char)) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  parts.push(current.trim())
  return parts.filter((part) => part !== '')
}

const firstToken = (part) => {
  const match = /^\s*([^\s]+)/.exec(part)
  return match === null ? '' : match[1]
}

export const checkCannotFail = (command) => {
  const stripped = stripShellComments(command).trim()
  if (stripped === '' || ['true', ':', 'exit 0'].includes(stripped)) return true
  if (stripped.includes('||') || /[|<>]/.test(stripped)) return false
  const parts = splitParts(stripped, ['&&', ';', '\n']).map((part) => part.replace(/\s+/g, ' ').trim())
  return parts.length > 0 && parts.every((part) => firstToken(part) === 'echo' || part.startsWith('echo '))
}

const SILENT_PROBES = new Set(['test', '[', 'grep', 'git', 'cmp', 'diff'])
const silentProbe = (part) => {
  const token = firstToken(part)
  if (!SILENT_PROBES.has(token)) return false
  if (/\b(-q|--quiet|-s|--silent|-z)\b/.test(part)) return true
  if (/\bdiff\s+-q\b/.test(part) || /\bgit\s+diff\s+--quiet\b/.test(part)) return true
  return token === 'cmp' && /\s-s\b/.test(part)
}

export const checkMayFailSilently = (command) => {
  const stripped = stripShellComments(command).trim()
  if (stripped === '' || stripped.includes('||')) return false
  if (/[|\n;]/.test(stripped)) return false
  const parts = splitParts(stripped, ['&&']).map((part) => part.replace(/\s+/g, ' ').trim())
  return parts.length > 0 && parts.every(silentProbe)
}

/**
 * Check lint findings. Warnings are advisory; the engine still executes the
 * check and blocks completion if it fails. Findings carry the criterion id so
 * an owner can fix the specific expectation.
 */
export const lintCriteria = (criteria, { scope } = {}) => {
  const findings = []
  const seenCommands = new Map()
  const mechanical = criteria.filter((criterion) => MECHANICAL_KINDS.has(criterion.check?.kind))
  for (const criterion of criteria) {
    const check = criterion.check ?? {}
    if (check.kind === 'command') {
      const command = check.command ?? ''
      if (checkCannotFail(command)) {
        findings.push({
          code: 'vacuous-check',
          severity: 'warning',
          criterionId: criterion.id,
          message: `criterion ${criterion.id} uses a check that cannot fail ("${tail(command).slice(0, 120)}"); it proves nothing about the delivery.`,
        })
      } else if (checkMayFailSilently(command)) {
        findings.push({
          code: 'silent-check',
          severity: 'warning',
          criterionId: criterion.id,
          message: `criterion ${criterion.id} may fail without printing why; the owner would get no failure context. Make it print a diagnosis (for example, use diff instead of diff -q).`,
        })
      }
      const normalized = command.replace(/\s+/g, ' ').trim()
      if (seenCommands.has(normalized)) {
        findings.push({
          code: 'duplicate-check',
          severity: 'warning',
          criterionId: criterion.id,
          message: `criterion ${criterion.id} runs the same command as ${seenCommands.get(normalized)}; consider one criterion.`,
        })
      } else {
        seenCommands.set(normalized, criterion.id)
      }
    }
    if (check.kind === 'artifact' && typeof check.path === 'string' && check.path.startsWith('~')) {
      findings.push({
        code: 'artifact-tilde-path',
        severity: 'warning',
        criterionId: criterion.id,
        message: `criterion ${criterion.id} names an expandable "~" path; use an absolute path or a path relative to the working directory.`,
      })
    }
  }
  if (mechanical.length === 0) {
    findings.push({
      code: 'no-executable-check',
      severity: 'warning',
      message: 'no command or artifact criterion: completion depends entirely on verifier judgment (and human-ack criteria).',
    })
  }
  if (scope?.kind === 'paths' && scope.paths.length === 0) {
    findings.push({
      code: 'no-scope',
      severity: 'warning',
      message: 'the objective declares no scope.paths, so concurrent objectives cannot be checked for overlapping writes.',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// Deterministic execution
// ---------------------------------------------------------------------------

const runCommand = async (service, shell, criterion, baseCwd, settings, log) => {
  const check = criterion.check
  const startedAt = Date.now()
  const commandCwd = check.cwd === undefined ? baseCwd : isAbsolute(check.cwd) ? check.cwd : resolve(baseCwd ?? process.cwd(), check.cwd)
  if (typeof commandCwd !== 'string' || commandCwd === '') {
    return { criterionId: criterion.id, kind: 'command', command: check.command, cwd: null, exitCode: null, timedOut: false, durationMs: 0, passed: false, executedBy: 'engine', error: 'cwd-unavailable', executedAt: new Date(startedAt).toISOString() }
  }
  const timeoutMs = Math.min(check.timeoutMs ?? settings.checker.timeoutMs, settings.checker.maxTimeoutMs)
  let timedOut = false
  let handle
  const killTimer = setTimeout(() => {
    timedOut = true
    try {
      handle?.terminate?.()
    } catch (error) {
      log?.('warn', 'checker: terminate failed', { error: String(error?.message ?? error) })
    }
  }, timeoutMs)
  try {
    handle = service.spawn({
      argv: [shell, '-lc', check.command],
      cwd: commandCwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: settings.checker.maxOutputBytes },
        stderr: { maxBytes: settings.checker.maxOutputBytes },
      },
      graceMs: 2000,
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      return {
        criterionId: criterion.id,
        kind: 'command',
        command: check.command,
        cwd: commandCwd,
        exitCode: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        passed: false,
        executedBy: 'engine',
        error: String(error?.message ?? error),
        executedAt: new Date(startedAt).toISOString(),
      }
    }
    const exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : null
    const stdout = readCollected(handle, 'stdout')
    const stderr = readCollected(handle, 'stderr')
    const passed = !timedOut && exitCode === check.expectedExitCode
    return {
      criterionId: criterion.id,
      kind: 'command',
      command: check.command,
      cwd: commandCwd,
      exitCode,
      signal: outcome?.signal ?? null,
      timedOut,
      durationMs: Date.now() - startedAt,
      passed,
      executedBy: 'engine',
      stdoutExcerpt: tail(stdout),
      stderrExcerpt: tail(stderr),
      executedAt: new Date(startedAt).toISOString(),
    }
  } finally {
    clearTimeout(killTimer)
  }
}

const runArtifact = (criterion, baseCwd) => {
  const check = criterion.check
  const startedAt = Date.now()
  const path = isAbsolute(check.path) ? check.path : resolve(baseCwd ?? process.cwd(), check.path)
  const minBytes = check.minBytes === undefined ? 1 : check.minBytes
  const result = {
    criterionId: criterion.id,
    kind: 'artifact',
    path,
    expectedSha256: check.sha256 ?? null,
    minBytes,
    executedBy: 'engine',
    executedAt: new Date(startedAt).toISOString(),
  }
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    return { ...result, exists: false, bytes: null, sha256: null, passed: false, error: `missing-artifact: ${String(error?.code ?? error?.message ?? error)}`, durationMs: Date.now() - startedAt }
  }
  if (!stat.isFile()) {
    return { ...result, exists: false, bytes: null, sha256: null, passed: false, error: 'not-a-file', durationMs: Date.now() - startedAt }
  }
  let sha256 = null
  try {
    sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    return { ...result, exists: true, bytes: stat.size, sha256: null, passed: false, error: `unreadable: ${String(error?.message ?? error)}`, durationMs: Date.now() - startedAt }
  }
  const bytes = stat.size
  const passed = bytes >= minBytes && (check.sha256 === undefined || sha256 === check.sha256)
  return {
    ...result,
    exists: true,
    bytes,
    sha256,
    passed,
    ...(passed ? {} : { error: bytes < minBytes ? `artifact too small: ${bytes} < ${minBytes} bytes` : 'sha256-mismatch' }),
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Execute every mechanical criterion. Never throws: a failed spawn becomes a
 * failed check result, not a lost verification.
 * @param {object} options
 * @param {object} options.ctx cordis context (for the subprocess service).
 * @param {Array} options.criteria objective criteria.
 * @param {string} [options.cwd] owner workspace directory.
 * @param {object} options.settings resolved engine settings.
 * @param {Function} [options.log] optional logger.
 * @returns {Promise<{mode: string, available: boolean, executed: number, results: Array, failures: Array}>}
 */
export const runMechanicalChecks = async ({ ctx, criteria, cwd, settings, log }) => {
  const mechanical = criteria.filter((criterion) => MECHANICAL_KINDS.has(criterion.check?.kind))
  if (settings?.checker?.execute === false) {
    return { mode: 'verifier', available: false, reason: 'checker-disabled', executed: 0, results: [], failures: [] }
  }
  const service = (() => {
    try {
      return ctx.get?.('subprocess') ?? ctx.subprocess
    } catch {
      return undefined
    }
  })()
  if (typeof service?.spawn !== 'function') {
    return { mode: 'verifier', available: false, reason: 'subprocess-unavailable', executed: 0, results: [], failures: [] }
  }
  let shell = 'bash'
  try {
    if (typeof service.resolveExecutable === 'function') shell = await service.resolveExecutable('bash')
  } catch (error) {
    log?.('warn', 'checker: bash resolution failed, falling back to argv bash', { error: String(error?.message ?? error) })
  }
  const results = []
  // Command checks first: a command may create the deliverable an artifact
  // criterion then asserts (the Ringer ordering guarantee).
  for (const criterion of mechanical.filter((entry) => entry.check.kind === 'command')) {
    results.push(await runCommand(service, shell, criterion, cwd, settings, log))
  }
  for (const criterion of mechanical.filter((entry) => entry.check.kind === 'artifact')) {
    results.push(runArtifact(criterion, cwd))
  }
  return {
    mode: 'engine',
    available: true,
    executed: results.length,
    results,
    failures: results.filter((result) => result.passed !== true),
  }
}

/** One-line-per-check summary for tool results and status (outputs redacted). */
export const summarizeChecks = (checks) =>
  (checks?.results ?? []).map((result) => ({
    criterionId: result.criterionId,
    kind: result.kind,
    ...(result.kind === 'command' ? { command: result.command, exitCode: result.exitCode, timedOut: result.timedOut } : {}),
    ...(result.kind === 'artifact' ? { path: result.path, bytes: result.bytes } : {}),
    passed: result.passed === true,
    ...(result.error === undefined ? {} : { error: result.error }),
    durationMs: result.durationMs,
  }))

/** Failure context for the owner wakeup and the retry work order. */
export const describeCheckFailures = (checks, max = 3) => {
  const failures = (checks?.results ?? []).filter((result) => result.passed !== true)
  if (failures.length === 0) return ''
  return failures
    .slice(0, max)
    .map((result) => {
      if (result.kind === 'command') {
        const output = (result.stdoutExcerpt ?? '').trim() || (result.stderrExcerpt ?? '').trim()
        return `${result.criterionId} command exit=${result.exitCode ?? '?'}${result.timedOut ? ' (timed out)' : ''}${output === '' ? '' : ` — ${tail(output).slice(-1200)}`}`
      }
      return `${result.criterionId} artifact ${result.path ?? '?'}${result.error === undefined ? '' : ` — ${result.error}`}`
    })
    .join('\n')
}
