/**
 * Execution-time authority (the dsh-tool-goal pattern).
 *
 * A tool call carries `exec.agent`. From it we derive the actor: its session
 * id, its preset, whether it is a runtime root, and whether the current open
 * turn contains a host-attested human message (`user/message` with source
 * kind `user`). Engine wakeups and other plugins supply their own source
 * kinds, so they never inherit human authority.
 */

const hasDirectHumanInput = (registry, agent) => {
  try {
    if (typeof registry?.roots !== 'function' || !registry.roots().includes(agent)) return false
    const boundary = registry.turnBoundaryOf?.(agent.session)
    const start = boundary?.openTurnStartSeq
    if (typeof start !== 'number') return false
    const events = agent.session?.snapshotEvents?.()
    if (!Array.isArray(events)) return false
    for (let seq = start + 1; seq < events.length; seq += 1) {
      const event = events[seq]
      if (event?.type === 'user/message' && event.data?.source?.kind === 'user') return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * @param {{ctx: object, log?: Function}} options
 */
export const createAuthority = ({ ctx }) => {
  const registry = () => {
    try {
      return ctx.get?.('agents') ?? ctx.agents
    } catch {
      return undefined
    }
  }
  const presetOf = (session) => {
    try {
      const presets = ctx.get?.('agentPresets')
      const id = presets?.presetForSession?.(session)
      return typeof id === 'string' ? id : undefined
    } catch {
      return undefined
    }
  }

  /** Resolve the actor for a tool execution. Never throws. */
  const actorOf = (exec) => {
    const agent = exec?.agent
    if (agent === undefined || agent === null) return { kind: 'agent', sessionId: undefined, human: false, root: false, live: false }
    const sessionId = typeof agent.session?.id === 'string' ? agent.session.id : typeof agent.id === 'string' ? agent.id : undefined
    const agents = registry()
    const live = typeof agents?.get === 'function' ? agents.get(agent.id) === agent : true
    const root = typeof agents?.roots === 'function' ? agents.roots().includes(agent) : false
    const human = root && live && hasDirectHumanInput(agents, agent)
    const presetId = presetOf(agent.session)
    return { kind: human ? 'human' : 'agent', sessionId, presetId, human, root, live, agent }
  }

  /** The live agent handle for a session id, if it is in this process. */
  const agentFor = (sessionId) => {
    const agents = registry()
    if (typeof agents?.get !== 'function') return undefined
    try {
      return agents.get(sessionId) ?? undefined
    } catch {
      return undefined
    }
  }

  return { actorOf, agentFor, presetOf, registry }
}
