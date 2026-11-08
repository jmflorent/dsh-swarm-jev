/**
 * Commit pinning and verifier wiring (design §7.3).
 *
 * The engine resolves the commit itself through `ctx.subprocess` before the
 * verifier starts, and starts the verifier child with a distinct preset. The
 * verifier reports through objective_verdict; a child that ends without a
 * verdict is recorded inconclusive.
 */
import { runMechanicalChecks } from './checker.js'
import { EVIDENCE_FORMAT, renderVerifierBrief } from './prompts.js'

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

export const createVerifierWiring = ({ ctx, settings, log, dispatcher, authority }) => {
  const subprocess = () => {
    try {
      return ctx.get?.('subprocess') ?? ctx.subprocess
    } catch {
      return undefined
    }
  }

  const runGit = async (cwd, args) => {
    const service = subprocess()
    if (typeof service?.spawn !== 'function') return undefined
    const git = typeof service.resolveExecutable === 'function' ? await service.resolveExecutable('git') : 'git'
    const handle = service.spawn({
      argv: [git, ...args],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
      graceMs: 2000,
    })
    const outcome = await handle.done
    return { exitCode: outcome?.exitCode, stdout: readCollected(handle, 'stdout').trim() }
  }

  const pinAt = async (cwd) => {
    if (typeof cwd !== 'string' || cwd === '') return { commit: null, pinned: false, reason: 'cwd-unavailable' }
    try {
      const head = await runGit(cwd, ['rev-parse', 'HEAD'])
      if (head === undefined || head.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout)) return { commit: null, pinned: false, cwd, reason: 'not-a-git-repository' }
      const status = await runGit(cwd, ['status', '--porcelain'])
      return { commit: head.stdout.toLowerCase(), pinned: true, cwd, dirty: status === undefined ? null : status.stdout !== '', pinnedAt: new Date().toISOString() }
    } catch (error) {
      return { commit: null, pinned: false, cwd, reason: `git-failed: ${String(error?.message ?? error)}` }
    }
  }

  /** Resolve the pinned commit for the owner's working directory. Never throws. */
  const pinCommit = async (parent) => {
    const service = subprocess()
    if (typeof service?.spawn !== 'function') return { commit: null, pinned: false, reason: 'subprocess-unavailable' }
    let cwd
    try {
      const wd = ctx.get?.('workingDirectory') ?? ctx.workingDirectory
      cwd = typeof wd?.get === 'function' && parent !== undefined ? wd.get(parent.session) : undefined
      if (cwd === undefined && typeof wd?.ensure === 'function' && parent !== undefined) cwd = await wd.ensure(parent)
    } catch {
      cwd = undefined
    }
    return pinAt(cwd)
  }

  /** Execute the mechanical criteria in the owner's workspace. */
  const runChecks = async ({ criteria, cwd }) => runMechanicalChecks({ ctx, criteria, cwd, settings, log })

  /** Re-execute the mechanical criteria at verdict time and re-pin the tree. */
  const recheck = async ({ verification, criteria }) => {
    const cwd = verification.commit?.cwd
    const checks = await runChecks({ criteria, cwd })
    const commit = await pinAt(cwd)
    return { checks, commit }
  }

  /** Start the verifier child for a requested record. */
  const startVerifier = async ({ objective, verification }) => {
    const parent = authority.agentFor(objective.owner.sessionId)
    const criteria = objective.criteria.filter((criterion) => verification.criterionIds.includes(criterion.id))
    const prompt = renderVerifierBrief({ objective, verification, criteria, checks: verification.checks, evidenceFormat: EVIDENCE_FORMAT })
    // The verifier preset must differ from the producer's; drop any candidate that matches.
    const presets = settings.verifierPresets.filter((preset) => preset !== objective.owner.presetId)
    if (presets.length === 0) return { ok: false, code: 'verifier-preset-unavailable', message: 'every configured verifier preset matches the producer preset' }
    const started = await dispatcher.dispatchVerifier({ objective, verification, parent, prompt: prompt, presetsOverride: presets })
    if (!started.ok) return started
    return { ok: true, verifier: { kind: 'child', sessionId: started.childId, presetId: started.preset, parentSessionId: objective.owner.sessionId } }
  }

  return { pinCommit, runChecks, recheck, startVerifier }
}
