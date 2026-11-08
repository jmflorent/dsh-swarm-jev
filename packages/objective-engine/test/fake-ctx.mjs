/**
 * A fake Cordis context for the objective engine: agents with sessions and
 * turn boundaries, the preset registry, an in-process subagent service that
 * creates child agents, a fake subprocess that answers git, and listeners.
 */
import { randomUUID } from 'node:crypto'

export const makeClock = (start = Date.parse('2026-11-07T12:00:00.000Z')) => {
  let value = start
  const clock = () => value
  clock.advance = (ms) => {
    value += ms
    return value
  }
  clock.set = (ms) => {
    value = ms
  }
  return clock
}

export const makeSession = (id, { cwd = '/workspace', events = [] } = {}) => ({
  id,
  cwd,
  events,
  header: { delegationDepth: 0 },
  snapshotEvents() {
    return [...this.events]
  },
})

export const makeCtx = ({ presets = {}, git = { head: 'a'.repeat(40), dirty: false }, systemone, commands = {} } = {}) => {
  const listeners = new Map()
  const registered = []
  const agents = new Map()
  const roots = new Set()
  const activations = []
  const spawns = []
  const services = {}

  const emit = (event, ...args) => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(...args)
  }
  /** Run the agent/pre-step waterfall through every listener. */
  const preStep = async (payload) => {
    const chain = [...(listeners.get('agent/pre-step') ?? [])]
    const run = async (index) => {
      if (index >= chain.length) return { kind: 'enter', messages: payload.messages }
      return await chain[index](payload, () => run(index + 1))
    }
    return await run(0)
  }

  const makeAgent = ({ id = randomUUID(), preset, root = true, cwd = '/workspace', owner } = {}) => {
    const session = makeSession(id, { cwd })
    const agent = {
      id,
      session,
      status: 'idle',
      preset,
      owner,
      followups: [],
      steers: [],
      cancelled: [],
      followup(input) {
        this.followups.push(input)
      },
      steer(input) {
        this.steers.push(input)
      },
      inject() {},
      cancel(cause) {
        this.cancelled.push(cause)
      },
      ctx: {},
      /** Simulate a human turn: open a turn containing a direct human message. */
      humanTurn(text = 'hello') {
        session.events.push({ type: 'turn/start', data: {} })
        session.events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
        this.openTurnStartSeq = session.events.length - 2
        this.status = 'running'
        return this
      },
      /** Simulate an engine-sourced turn (no human message). */
      engineTurn() {
        session.events.push({ type: 'turn/start', data: {} })
        session.events.push({ type: 'user/message', data: { source: { kind: 'objective-engine' } } })
        this.openTurnStartSeq = session.events.length - 2
        this.status = 'running'
        return this
      },
      idle() {
        this.openTurnStartSeq = null
        this.status = 'idle'
        emit('agent/status', { status: 'idle', agent: this })
        return this
      },
    }
    agent.openTurnStartSeq = null
    agents.set(id, agent)
    if (root) roots.add(agent)
    if (preset !== undefined) presets[id] = preset
    return agent
  }

  services.agents = {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    roots: () => [...roots],
    isOwnedBy: (id, owner) => agents.get(id)?.owner === owner,
    turnBoundaryOf: (session) => ({ openTurnStartSeq: agents.get(session.id)?.openTurnStartSeq ?? null }),
    currentInitiator: () => undefined,
  }
  services.agentPresets = { presetForSession: (session) => presets[session?.id] ?? null }
  services.workingDirectory = { get: (session) => session?.cwd }
  services.subprocess = {
    resolveExecutable: async (name) => `/usr/bin/${name}`,
    spawn: ({ argv, cwd }) => {
      spawns.push({ argv: [...argv], cwd })
      const shellCommand = /(^|\/)(bash|sh|zsh)$/.test(argv[0]) && (argv[1] === '-lc' || argv[1] === '-c') ? argv[2] : undefined
      if (shellCommand !== undefined) {
        const result = services.checkCommands[shellCommand] ?? { exitCode: 0, stdout: '', stderr: '' }
        return {
          done: result.reject === true ? Promise.reject(new Error(result.error ?? 'spawn failed')) : Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null }),
          terminate: () => {
            result.terminated = true
          },
          collected: {
            stdout: { readFrom: () => result.stdout ?? '' },
            stderr: { readFrom: () => result.stderr ?? '' },
          },
        }
      }
      const sub = argv[1]
      let stdout = ''
      let exitCode = 0
      if (sub === 'rev-parse') stdout = git.head === undefined ? '' : `${git.head}\n`
      else if (sub === 'status') stdout = git.dirty ? ' M file.txt\n' : ''
      if (git.head === undefined && sub === 'rev-parse') exitCode = 128
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: { stdout: { readFrom: () => stdout }, stderr: { readFrom: () => '' } },
      }
    },
  }
  services.checkCommands = commands
  services.subagents = {
    startActivation: async ({ provider, label, request, delivery }) => {
      if (services.subagents.reject !== undefined) throw new Error(services.subagents.reject)
      if (request.agentPreset !== undefined && services.subagents.knownPresets !== undefined && !services.subagents.knownPresets.includes(request.agentPreset)) {
        throw new Error(`unknown preset ${request.agentPreset}`)
      }
      const child = makeAgent({ preset: request.agentPreset, root: false, owner: request.parent })
      let settle
      const result = new Promise((resolve) => {
        settle = resolve
      })
      const activation = {
        childId: child.id,
        provider,
        label,
        delivery,
        request,
        result,
        disposed: false,
        settle: (stopReason = 'completed', output = []) => {
          settle({ stopReason, output })
          emit('subagent/end', { id: child.id, runId: randomUUID(), provider, local: true, stopReason, ...(output.length === 0 ? {} : { lastAssistantMessage: output }) }, request.parent)
        },
        dispose: async () => {
          activation.disposed = true
        },
      }
      activations.push(activation)
      emit('subagent/start', { id: child.id, provider, local: true }, request.parent)
      return activation
    },
  }
  if (systemone !== undefined) services.systemone = systemone

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    tools: { register: (definition) => (registered.push(definition), () => {}) },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== handler))
    },
    get: (name) => services[name],
    effect: (fn) => fn(),
    provide(name, value) {
      services[name] = value
    },
    emit,
    preStep,
    registered,
    services,
    agents,
    activations,
    spawns,
    makeAgent,
    listeners,
  }
  return ctx
}
