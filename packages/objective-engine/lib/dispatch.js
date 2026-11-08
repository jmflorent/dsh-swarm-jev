/**
 * Child dispatch and tracking over `ctx.subagents.startActivation`.
 *
 * The engine starts workers (and the verifier) itself so the provenance of a
 * child is recorded by the control plane, not claimed by the manager. When the
 * subagent service is absent the dispatcher reports `dispatch-unavailable`
 * and the tools fall back to the documented manager-driven path.
 */
import { renderWorkerBrief } from './prompts.js'

const stopReasonOf = (result) => (typeof result?.stopReason === 'string' ? result.stopReason : 'completed')

export const createDispatcher = ({ ctx, settings, log, onSettled }) => {
  /** childSessionId -> { role, objectiveId, itemId?, verificationId?, activation, controller } */
  const children = new Map()
  let disposed = false

  const service = () => {
    try {
      return ctx.get?.('subagents') ?? ctx.subagents
    } catch {
      return undefined
    }
  }
  const available = () => typeof service()?.startActivation === 'function'

  // The subagent service treats `maxDepth` as an ABSOLUTE cap on the child's
  // own delegation depth (a top-level owner is depth 0, its worker is depth 1).
  // The engine therefore allows exactly one delegation level below the owner,
  // so a worker can never start a grandchild even when the owner itself is a
  // nested orchestrator.
  const depthOf = (parent) => {
    const header = parent?.session?.header?.delegationDepth
    const runtime = parent?.options?.subagentDepth
    const fromHeader = Number.isSafeInteger(header) && header >= 0 ? header : 0
    const fromRuntime = Number.isSafeInteger(runtime) && runtime >= 0 ? runtime : 0
    return Math.max(fromHeader, fromRuntime)
  }
  const childDepthCap = (parent) => depthOf(parent) + Math.max(1, settings.workerMaxDepth)

  const cwdOf = async (parent) => {
    try {
      const wd = ctx.get?.('workingDirectory') ?? ctx.workingDirectory
      if (typeof wd?.get === 'function') {
        const value = wd.get(parent.session)
        if (typeof value === 'string' && value !== '') return value
      }
      if (typeof wd?.ensure === 'function') return await wd.ensure(parent)
    } catch {
      /* fall through */
    }
    return undefined
  }

  const start = async ({ role, objectiveId, itemId, verificationId, parent, label, prompt, presets }) => {
    const subagents = service()
    if (typeof subagents?.startActivation !== 'function') return { ok: false, code: 'dispatch-unavailable', message: 'the subagent service is not composed' }
    if (parent === undefined) return { ok: false, code: 'owner-offline', message: 'the owner session is not live in this process' }
    const controller = new AbortController()
    const cwd = await cwdOf(parent)
    let lastError
    for (const preset of presets) {
      try {
        const activation = await subagents.startActivation({
          provider: settings.subagentProvider,
          label,
          request: {
            parent,
            prompt: [{ type: 'text', text: prompt }],
            ...(preset === undefined ? {} : { agentPreset: preset }),
            ...(cwd === undefined ? {} : { cwd }),
            maxDepth: childDepthCap(parent),
          },
          signal: controller.signal,
          delivery: 'parent',
        })
        const entry = { role, objectiveId, itemId, verificationId, activation, controller, preset, childId: activation.childId, startedAt: Date.now() }
        children.set(activation.childId, entry)
        Promise.resolve(activation.result)
          .then((result) => settle(activation.childId, { stopReason: stopReasonOf(result), lastAssistantMessage: result?.output }))
          .catch((error) => settle(activation.childId, { stopReason: 'error', error: String(error?.message ?? error) }))
        return { ok: true, childId: activation.childId, preset }
      } catch (error) {
        lastError = error
        log('warn', `activation with preset ${preset ?? '(inherit)'} failed`, { error: String(error?.message ?? error) })
      }
    }
    return { ok: false, code: 'dispatch-failed', message: String(lastError?.message ?? lastError ?? 'activation failed') }
  }

  const settle = (childId, info) => {
    const entry = children.get(childId)
    if (entry === undefined) return
    children.delete(childId)
    try {
      onSettled(entry, info)
    } catch (error) {
      log('warn', 'settlement handler failed', { childId, error: String(error?.message ?? error) })
    }
  }

  const cancelEntry = (entry, reason) => {
    try {
      entry.controller.abort({ kind: 'hook', reason: `objective-engine: ${reason}` })
    } catch {
      /* ignore */
    }
    try {
      const child = ctx.get?.('agents')?.get?.(entry.childId)
      if (typeof child?.cancel === 'function') child.cancel({ kind: 'hook', reason: `objective-engine: ${reason}` })
    } catch {
      /* ignore */
    }
    try {
      const outcome = entry.activation?.dispose?.()
      if (outcome !== undefined && typeof outcome.catch === 'function') outcome.catch(() => {})
    } catch {
      /* ignore */
    }
  }

  const dispatcher = {
    available,
    children,
    /** Start a worker for a queued work order. */
    dispatchWorker: ({ objective, item, persona, brief, instructions, parent }) =>
      start({
        role: 'worker',
        objectiveId: objective.id,
        itemId: item.id,
        parent,
        label: item.title.slice(0, 80),
        prompt: renderWorkerBrief({ objective, item, persona, brief, instructions, criteria: objective.criteria.filter((criterion) => (item.link?.criterionIds ?? []).includes(criterion.id)) }),
        presets: [persona],
      }),
    /** Start the verifier child for a verification record. */
    dispatchVerifier: ({ objective, verification, parent, prompt, presetsOverride }) =>
      start({
        role: 'verifier',
        objectiveId: objective.id,
        verificationId: verification.id,
        parent,
        label: `verify ${objective.id}`,
        prompt,
        presets: Array.isArray(presetsOverride) && presetsOverride.length > 0 ? presetsOverride : settings.verifierPresets,
      }),
    cancelChild: (itemId, reason) => {
      let count = 0
      for (const entry of [...children.values()]) {
        if (entry.itemId === itemId) {
          children.delete(entry.childId)
          cancelEntry(entry, reason)
          count += 1
        }
      }
      return count
    },
    cancelChildren: (objectiveId, reason) => {
      let count = 0
      for (const entry of [...children.values()]) {
        if (entry.objectiveId === objectiveId) {
          children.delete(entry.childId)
          cancelEntry(entry, reason)
          count += 1
        }
      }
      return count
    },
    cancelAll: (reason) => {
      let count = 0
      for (const entry of [...children.values()]) {
        children.delete(entry.childId)
        cancelEntry(entry, reason)
        count += 1
      }
      return count
    },
    entryFor: (childId) => children.get(childId),
    attach: () => {
      const disposers = []
      try {
        disposers.push(
          ctx.on('subagent/end', (info) => {
            const childId = info?.id
            if (typeof childId === 'string' && children.has(childId)) settle(childId, { stopReason: info.stopReason, lastAssistantMessage: info.lastAssistantMessage })
          }),
        )
      } catch (error) {
        log('warn', 'subagent/end listener not installed', { error: String(error?.message ?? error) })
      }
      return () => {
        for (const disposer of disposers) {
          try {
            disposer?.()
          } catch {
            /* ignore */
          }
        }
      }
    },
    dispose: () => {
      disposed = true
      children.clear()
    },
    get disposed() {
      return disposed
    },
  }
  return dispatcher
}
