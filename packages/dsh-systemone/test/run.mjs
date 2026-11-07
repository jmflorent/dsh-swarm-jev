/**
 * Self-test for the systemone plugin: tools, decision layer, and vision.
 *
 * Imports the real package directly; the vendored dependencies in
 * systemone-plugin/node_modules provide the genuine @deepseek-ai/dsh-tools
 * defineTool and @deepseek-ai/schemastery, so this exercises the exact code
 * and validation the installed plugin will run. The harness itself is
 * replaced by a fake Cordis context that only records registrations.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockSystemOne } from './mock-server.mjs'

const { apply, Config } = await import('../index.js')
const { createDecisionRuntime } = await import('../lib/decisions.js')
const { buildMultipart, loadImage } = await import('../lib/vision.js')

// --- in-process mock -------------------------------------------------------
const mock = createMockSystemOne()
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${mock.address().port}/systemone`

// --- fake Cordis context ---------------------------------------------------
// Mirrors this harness's registry facts: the global view holds only a handful
// of tools, while the host tools live on the agent/preset plane; scope-local
// (agent-owned) tools are visible but NOT restrictable, and `restrict()` rejects
// the whole filter when one is named. That rejection is the only public signal
// the decision layer can use, so the fake reproduces it verbatim.
const GLOBAL_TOOLS = [
  'systemone_ask',
  'systemone_status',
  'swarm_assign',
  'swarm_enter',
  'swarm_exit',
  'working_directory',
]
const AGENT_TOOLS = [
  'ask_user_question',
  'bash',
  'edit',
  'glob',
  'grep',
  'read',
  'present',
  'skill',
  'subagent',
  'subagent_fork',
  'systemone_ask',
  'systemone_status',
  'todo_write',
  'web_search',
  'workflow',
  'write',
]
const SCOPED_TOOLS = ['spawn_teammate', 'team_task_list']
const RESTRICTABLE = new Set([...GLOBAL_TOOLS, ...AGENT_TOOLS])

const makeContext = (options = {}) => {
  const registered = []
  const listeners = new Map()
  const guards = []
  const restrictCalls = []
  const restrictAttempts = []
  const restrictLifts = []
  const visibleNames = (scope) => (scope === undefined ? GLOBAL_TOOLS : [...AGENT_TOOLS, ...SCOPED_TOOLS])
  const ctx = {
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
      guard: (fn) => {
        guards.push(fn)
        return () => {}
      },
      schemas: (scope) => visibleNames(scope).map((name) => ({ name })),
      get: (name, scope) => (visibleNames(scope).includes(name) ? { name } : undefined),
      restrict: (filter) => {
        const allow = [...(filter.allow ?? [])]
        restrictAttempts.push(allow)
        const unknown = allow.filter((name) => !RESTRICTABLE.has(name))
        if (unknown.length > 0) {
          throw new Error(
            `tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ` +
              `${unknown.map((name) => `"${name}"`).join(', ')}; known global tools: ` +
              `${[...RESTRICTABLE].sort().join(', ')}`,
          )
        }
        restrictCalls.push({ allow })
        return () => {
          restrictLifts.push(allow)
        }
      },
    },
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    get: (name) =>
      name === 'agentPresets' && options.presetId !== undefined
        ? { presetForSession: () => options.presetId }
        : undefined,
    effect: (callback) => callback(),
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    credentials: {
      resolve: async (ref) => (ref === 'SYSTEMONE_API_KEY' ? { value: 'test-key-123' } : undefined),
    },
  }
  return { ctx, registered, listeners, guards, restrictCalls, restrictAttempts, restrictLifts }
}

const { ctx, registered, listeners, guards } = makeContext()
const config = Config({ endpoint })
apply(ctx, config)

// --- registrations ---------------------------------------------------------
assert.equal(registered.length, 5, 'apply registers five tools')
const ask = registered.find((tool) => tool.name === 'systemone_ask')
const status = registered.find((tool) => tool.name === 'systemone_status')
assert.ok(ask, 'systemone_ask registered')
assert.ok(status, 'systemone_status registered')
assert.ok(listeners.has('agent/pre-step'), 'selection hook installed')
assert.ok(listeners.has('tools/pre-execute'), 'assessment hook installed')
assert.ok(listeners.has('tools/result'), 'loop observation hook installed')
assert.equal(guards.length, 1, 'deterministic loop guard registered')

// --- 1. ask: happy path with all typed questions ---------------------------
const askResult = await ask.execute(
  {
    state: { task: 'Route this incident.', severity: 'medium' },
    questions: {
      urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
      team: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: { billing: 'Payments, invoices, refunds', technical: 'Bugs, outages' },
      },
      clarity: {
        type: 'score',
        instructions: 'How clear are the requirements?',
        criteria: ['unclear', 'partly clear', 'clear'],
      },
    },
  },
  { signal: undefined },
)
assert.equal(askResult.ok, true, 'ask succeeds')
assert.equal(askResult.answers.urgent.type, 'noul')
assert.equal(askResult.answers.urgent.noul, 0.91, 'noul answer normalized')
assert.equal(askResult.answers.team.choice, 'billing', 'choice answer normalized')
assert.equal(askResult.answers.clarity.type, 'score')
assert.equal(typeof askResult.answers.clarity.score, 'number', 'score answer normalized')
assert.deepEqual(askResult.unmatched, [], 'no unmatched answers')
assert.equal(askResult.model, 'decision-model', 'mock echoes the requested model')
assert.equal(typeof askResult.usage.inputTokens, 'number', 'snake_case usage read')
assert.ok(askResult.latencyMs >= 0)

// --- 2. vision: box question over multipart ---------------------------------
const dir = await mkdtemp(join(tmpdir(), 'systemone-selftest-'))
const pngPath = join(dir, 'dot.png')
await writeFile(
  pngPath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)
const image = await loadImage({ path: pngPath }, 0, 4 * 1024 * 1024)
assert.equal(image.mediaType, 'image/png')
assert.equal(image.alias, 'dot', 'alias derived from the file name')

const multipart = buildMultipart({ state: { task: 'x' }, questions: {}, model: 'm' }, [image])
assert.match(multipart.contentType, /^multipart\/form-data; boundary=/)
assert.deepEqual(multipart.assets.dot, { type: 'image', part: 'asset-0' })
const body = Buffer.from(multipart.body)
assert.ok(body.includes(Buffer.from('name="request"')), 'request part present')
assert.ok(body.includes(Buffer.from('name="asset-0"')), 'asset part present')
assert.ok(body.includes(Buffer.from(image.bytes)), 'raw image bytes present')

const boxResult = await ask.execute(
  {
    state: { task: 'Locate the dot in <photo>.' },
    questions: { dot: { type: 'box', instructions: 'Locate the dark dot' } },
    images: [{ path: pngPath, name: 'photo' }],
  },
  { signal: undefined },
)
assert.equal(boxResult.ok, true, 'multipart ask succeeds against a multipart-capable endpoint')
assert.equal(boxResult.answers.dot.type, 'box')
assert.equal(boxResult.answers.dot.box.top, 0.1, 'box answer normalized')

await assert.rejects(
  () => ask.execute(
    { state: 'x', questions: { a: { type: 'box', instructions: 'locate it' } } },
    { signal: undefined },
  ),
  /require "images"/,
  'box without images fails fast',
)
await writeFile(join(dir, 'bad.png'), Buffer.from('not an image'))
await assert.rejects(
  () => loadImage({ path: join(dir, 'bad.png') }, 0, 1024),
  /not PNG or JPEG/,
  'non-image bytes rejected',
)

// --- 3. status: config, credential state, layer snapshot, probe ------------
const statusResult = await status.execute({ probe: true }, { signal: undefined })
assert.equal(statusResult.ok, true)
assert.equal(statusResult.endpoint, endpoint)
assert.equal(statusResult.auth, 'credential configured', 'credential seen as configured')
assert.equal(statusResult.layer.mode, 'shadow', 'layer reports its mode')
assert.equal(statusResult.layer.endpoint, endpoint)
assert.equal(statusResult.layer.features.selection, true)
assert.equal(statusResult.layer.features.assessment, true)
assert.ok(statusResult.probe, 'probe ran')
assert.equal(statusResult.probe.ok, true, 'probe answered')
assert.equal(typeof statusResult.probe.answers.probe.noul, 'number')
assert.ok(statusResult.lastCall, 'lastCall recorded')

// --- 4. decision layer: decide() and status() ------------------------------
const runtime = createDecisionRuntime(ctx, Config({ endpoint }))
assert.equal(runtime.settings.mode, 'shadow')
const decided = await runtime.decide(
  { task: 'Connectivity self-test.' },
  { probe: { type: 'noul', instructions: 'Does 2 plus 2 equal 4?' } },
  undefined,
)
assert.equal(decided.ok, true, 'layer decide succeeds')
assert.equal(decided.answers.probe, 0.91, 'layer decide normalizes a noul to a number')
assert.equal(runtime.status().mode, 'shadow')
assert.deepEqual(runtime.status().recent, [], 'no decisions recorded before any hook runs')

const presetRuntime = createDecisionRuntime(
  ctx,
  Config({ endpoint, presets: { reviewer: { mode: 'enforce' } } }),
)
assert.deepEqual(presetRuntime.status().presetOverrides, ['reviewer'], 'preset overrides reported')

// --- 4b. panel snapshot: swarm members, personas, counters ------------------
const panelRuntime = createDecisionRuntime(ctx, Config({ endpoint }))
const panelAgent = { session: { id: 'session-panel-selftest' }, inject: () => {} }
panelRuntime.swarm.enter(panelAgent)
const panel = panelRuntime.panel()
assert.equal(panel.ok, true, 'panel snapshot answers')
assert.equal(panel.swarm.active, 1, 'panel reports one swarm session')
assert.deepEqual(panel.swarm.members, [{ sessionId: 'session-panel-selftest' }], 'panel member session id')
assert.ok(Array.isArray(panel.swarm.personas) && panel.swarm.personas.length >= 5, 'panel persona catalog')
assert.equal(typeof panel.engine.mode, 'string', 'panel engine mode')
assert.equal(typeof panel.stats, 'object', 'panel counters')
assert.ok(Array.isArray(panel.recent), 'panel recent decisions')
assert.equal(typeof panel.generatedAt, 'string', 'panel timestamp')
panelRuntime.swarm.exit(panelAgent)
assert.equal(panelRuntime.panel().swarm.active, 0, 'panel returns to zero after exit')

// --- 5. connection failure is a structured domain outcome ------------------
const { ctx: ctx2, registered: registered2 } = makeContext()
apply(ctx2, Config({ endpoint: 'http://127.0.0.1:1/systemone' }))
const failingAsk = registered2.find((tool) => tool.name === 'systemone_ask')
const failResult = await failingAsk.execute(
  { state: 'x', questions: { a: { type: 'noul', instructions: 'yes?' } } },
  { signal: undefined },
)
assert.equal(failResult.ok, false, 'unreachable endpoint reported, not thrown')
assert.match(failResult.error, /connection|refused|failed/, 'error mentions the connection')
assert.equal(Object.keys(failResult.answers).length, 0)

// --- 6. validation throws before any request -------------------------------
await assert.rejects(
  () => ask.execute({ state: 'x', questions: {} }, { signal: undefined }),
  /at least one entry/,
)
await assert.rejects(
  () => ask.execute({ state: 'x', questions: { a: { type: 'wat', instructions: '?' } } }, { signal: undefined }),
  /expected one of/,
)
await assert.rejects(
  () => ask.execute({ state: 'x', questions: { a: { type: 'choice', instructions: '?' } } }, { signal: undefined }),
  /criteria/,
)
await assert.rejects(
  () => ask.execute(
    { state: 'x', questions: { a: { type: 'score', instructions: '?', criteria: ['only'] } } },
    { signal: undefined },
  ),
  /at least two/,
)

// --- 7. oversized request rejected before sending --------------------------
const { ctx: ctx3, registered: registered3 } = makeContext()
apply(ctx3, Config({ endpoint, maxRequestChars: 10 }))
const tinyAsk = registered3.find((tool) => tool.name === 'systemone_ask')
await assert.rejects(
  () => tinyAsk.execute({ state: 'x', questions: { a: { type: 'noul', instructions: 'yes?' } } }, { signal: undefined }),
  /maximum/,
)

// --- 8. enforce: selection trims scope-local names, then applies ------------
const enforced = makeContext()
apply(
  enforced.ctx,
  Config({
    endpoint,
    mode: 'enforce',
    selection: {
      enabled: true,
      alwaysAllow: ['bash', 'edit'],
      categories: {
        files: 'Reading, writing, or editing workspace files',
        search: 'Searching the workspace for paths or content',
        shell: 'Running shell commands',
        web: 'Searching or fetching content from the web',
        plan: 'Tracking work with the todo list',
      },
      toolCategories: {
        read: ['files'],
        write: ['files'],
        edit: ['files'],
        bash: ['shell'],
        glob: ['search'],
        grep: ['search'],
        ask_user_question: ['plan'],
        web_search: ['web'],
      },
    },
  }),
)
const preStep = enforced.listeners.get('agent/pre-step')[0]
const fakeAgent = {
  ctx: { tools: { restrict: (filter) => enforced.ctx.tools.restrict(filter) } },
}
const decision = await preStep(
  {
    agent: fakeAgent,
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the task.' }] }],
    step: 1,
    turn: 0,
    signal: undefined,
  },
  async () => ({ kind: 'step' }),
)
assert.equal(decision.kind, 'step', 'pre-step decision passes through')
assert.equal(enforced.restrictAttempts.length, 2, 'rejected filter retried once after trimming')
assert.ok(
  enforced.restrictAttempts[0].some((name) => SCOPED_TOOLS.includes(name)),
  'first attempt names a scope-local tool, which the registry rejects',
)
assert.equal(enforced.restrictCalls.length, 1, 'second attempt applies the trimmed restriction')
const restriction = enforced.restrictCalls[0].allow
assert.ok(!restriction.some((name) => SCOPED_TOOLS.includes(name)), 'scope-local tools are never named')
assert.ok(restriction.includes('bash') && restriction.includes('edit'), 'escape-hatch tools kept')
assert.ok(restriction.includes('read') && restriction.includes('write'), 'selected tools kept')
assert.ok(restriction.includes('skill'), 'uncategorized agent-plane tool kept visible')
assert.ok(!restriction.includes('web_search'), 'unselected tool (web p=0.1) is narrowed away')
assert.ok(restriction.length >= 8, 'allow-list is the real selection, not a 4-tool remnant')

const enforcedStatus = enforced.registered.find((tool) => tool.name === 'systemone_status')
const enforcedReport = await enforcedStatus.execute({}, { signal: undefined })
assert.equal(enforcedReport.layer.mode, 'enforce')
assert.equal(enforcedReport.layer.stats.selectionApplied, 1, 'selection applied after the trim')
assert.equal(enforcedReport.layer.stats.failures, 0, 'no recorded failure')
assert.equal(enforcedReport.layer.recent.at(-1).decision, 'selection')
assert.ok(enforcedReport.layer.recent.at(-1).allow >= 8, 'recorded allow count is the full selection')

// --- 9. persona policy: deterministic path and command rules ---------------
const { compileGlob, evaluatePolicy } = await import('../lib/policy.js')

assert.ok(compileGlob('**/samples/**').test('/w/samples/a.csv'), 'glob crosses directories')
assert.ok(compileGlob('**/samples/**').test('/w/samples/nested/deep.csv'), 'nested path matches')
assert.ok(!compileGlob('**/samples/**').test('/w/src/a.ts'), 'unrelated path does not match')
assert.ok(compileGlob('**/*.csv').test('/w/x.csv'), 'extension glob matches')
assert.ok(!compileGlob('**/*.csv').test('/w/x.csv.bak'), 'extension glob is anchored')

const reviewerPolicy = {
  default: 'allow',
  tools: {
    write: {
      paths: {
        allow: ['**/samples/**', '**/fixtures/**', '**/*.csv'],
        deny: ['**/src/**', '**/*.ts', '**/*.js'],
      },
    },
    edit: { paths: { allow: ['**/samples/**'], deny: ['**/*.ts'] } },
    bash: { commands: { deny: ['(?:>|>>|tee\\s+)\\s*[^\\s;&|]*\\.(?:ts|js|py)'] } },
    web_fetch: { deny: true },
  },
}
const policyCall = (name, args) => ({ name, arguments: args })
assert.equal(evaluatePolicy(reviewerPolicy, policyCall('write', { file_path: '/w/samples/a.csv' })).decision, 'allow')
assert.equal(evaluatePolicy(reviewerPolicy, policyCall('write', { file_path: '/w/src/app.ts' })).decision, 'deny')
assert.equal(evaluatePolicy(reviewerPolicy, policyCall('write', { file_path: '/w/docs/readme.md' })).decision, 'deny', 'outside the allow-list is denied')
assert.equal(evaluatePolicy(reviewerPolicy, policyCall('edit', { file_path: '/w/samples/b.json' })).decision, 'allow')
assert.equal(evaluatePolicy(reviewerPolicy, policyCall('edit', { file_path: '/w/src/x.ts' })).decision, 'deny')
assert.equal(evaluatePolicy(reviewerPolicy, policyCall('bash', { command: 'echo hi > src/app.ts' })).decision, 'deny', 'redirection into source denied')
assert.equal(evaluatePolicy(reviewerPolicy, policyCall('bash', { command: 'npm test' })).decision, 'allow')
assert.equal(evaluatePolicy(reviewerPolicy, policyCall('web_fetch', { url: 'http://x' })).decision, 'deny')
assert.equal(evaluatePolicy(reviewerPolicy, policyCall('read', { file_path: '/w/src/a.ts' })).decision, 'allow', 'unlisted tool untouched')
assert.equal(evaluatePolicy(reviewerPolicy, policyCall('write', {})).decision, 'deny', 'path rule without a path fails closed')
assert.equal(evaluatePolicy({ default: 'deny', allow: ['read'] }, policyCall('bash', { command: 'ls' })).decision, 'deny')
assert.equal(evaluatePolicy({ default: 'deny', allow: ['read'] }, policyCall('read', { file_path: '/x' })).decision, 'allow')

// --- 10. persona policy through the pre-execute hook -----------------------
const guarded = makeContext({ presetId: 'reviewer' })
const guardedPolicy = {
  default: 'allow',
  tools: {
    write: { paths: { allow: ['**/samples/**'], deny: ['**/src/**', '**/*.ts'] } },
    bash: { commands: { deny: ['(?:>|>>)\\s*[^\\s;&|]*\\.(?:ts|js)'] } },
  },
}
apply(
  guarded.ctx,
  Config({
    endpoint,
    mode: 'enforce',
    assessment: { enabled: false },
    presets: { reviewer: { policy: guardedPolicy } },
  }),
)
const fakeReviewer = { session: 's1', ctx: { tools: { restrict: () => () => {} } } }
const preExecute = guarded.listeners.get('tools/pre-execute')[0]
const blocked = await preExecute(
  { name: 'write', arguments: { file_path: '/w/src/app.ts' }, agent: fakeReviewer },
  async () => ({ kind: 'allow' }),
)
assert.equal(blocked.kind, 'deny', 'source write denied for the verifier persona')
assert.match(blocked.reason, /denied|outside/)
const allowed = await preExecute(
  { name: 'write', arguments: { file_path: '/w/samples/a.csv' }, agent: fakeReviewer },
  async () => ({ kind: 'allow' }),
)
assert.equal(allowed.kind, 'allow', 'sample data write allowed')
const blockedBash = await preExecute(
  { name: 'bash', arguments: { command: 'echo x >> src/a.ts' }, agent: fakeReviewer },
  async () => ({ kind: 'allow' }),
)
assert.equal(blockedBash.kind, 'deny', 'source write through the shell denied')
const allowedRead = await preExecute(
  { name: 'read', arguments: { file_path: '/w/src/a.ts' }, agent: fakeReviewer },
  async () => ({ kind: 'allow' }),
)
assert.equal(allowedRead.kind, 'allow', 'read stays untouched')

const shadowPolicy = makeContext({ presetId: 'reviewer' })
apply(
  shadowPolicy.ctx,
  Config({
    endpoint,
    mode: 'shadow',
    assessment: { enabled: false },
    presets: { reviewer: { policy: guardedPolicy } },
  }),
)
const shadowPre = shadowPolicy.listeners.get('tools/pre-execute')[0]
const shadowVerdict = await shadowPre(
  { name: 'write', arguments: { file_path: '/w/src/a.ts' }, agent: fakeReviewer },
  async () => ({ kind: 'allow' }),
)
assert.equal(shadowVerdict.kind, 'allow', 'shadow records the deny without applying it')
const shadowStatus = shadowPolicy.registered.find((tool) => tool.name === 'systemone_status')
const shadowReport = await shadowStatus.execute({}, { signal: undefined })
assert.ok(
  shadowReport.layer.recent.some((entry) => entry.decision === 'policy' && entry.action === 'deny'),
  'shadow run recorded the policy denial',
)

// --- 11. swarm MODE: session-scoped, orchestrated, assigned by the model ----
const swarmCtx = makeContext({ presetId: 'reviewer' })
apply(
  swarmCtx.ctx,
  Config({
    endpoint,
    mode: 'swarm',
    presets: { reviewer: { judge: { instructions: 'The verifier must not write source code.' } } },
  }),
)
const swarmTool = (name) => swarmCtx.registered.find((tool) => tool.name === name)
const swarmInjected = []
const swarmAgent = {
  session: 's-swarm',
  ctx: { tools: { restrict: (filter) => swarmCtx.ctx.tools.restrict(filter) } },
  inject: (message) => swarmInjected.push(message),
}
const swarmPreExecute = swarmCtx.listeners.get('tools/pre-execute')[0]
const swarmPreStep = swarmCtx.listeners.get('agent/pre-step')[0]

// A session that has not entered swarm mode is inert even in swarm mode.
const hitsBeforeSwarm = mock.hits
const inert = await swarmPreExecute(
  { name: 'write', arguments: { file_path: '/w/src/app.ts' }, agent: swarmAgent },
  async () => ({ kind: 'allow' }),
)
assert.equal(inert.kind, 'allow', 'a session not in swarm mode is inert')
assert.equal(mock.hits, hitsBeforeSwarm, 'inactive session makes no model call')

// Enter swarm mode: orchestrator policy + enforcement for this session.
const entered = await swarmTool('swarm_enter').execute({}, { agent: swarmAgent, signal: undefined })
assert.equal(entered.active, true)
assert.ok(entered.personas.includes('orchestrator'), 'persona catalog exposed')
assert.equal(swarmInjected.length, 1, 'orchestrator policy injected as a per-agent notice')
assert.match(JSON.stringify(swarmInjected[0]), /SWARM MODE/)
assert.match(JSON.stringify(swarmInjected[0]), /never does the work/)

// Assignment: Mammoth picks the persona for a workplan stage.
const assignment = await swarmTool('swarm_assign').execute(
  { stage: 'Verify the change and reproduce the defect with a sample dataset', needs: 'independent checks' },
  { agent: swarmAgent, signal: undefined },
)
assert.equal(assignment.ok, true, 'assignment answers')
assert.equal(assignment.persona, 'orchestrator', 'mock choice returns the first persona')
assert.ok(assignment.instructions.length > 0, 'persona instructions returned')

// A swarm session's tool call is now judged by the decision model.
await swarmPreStep(
  {
    agent: swarmAgent,
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the workplan.' }] }],
    step: 1,
    turn: 0,
    signal: undefined,
  },
  async () => ({ kind: 'step' }),
)
const orchestratorAllow = swarmCtx.restrictCalls.at(-1).allow
assert.ok(orchestratorAllow.includes('subagent') && orchestratorAllow.includes('todo_write'), 'coordination tools kept')
assert.ok(orchestratorAllow.includes('swarm_assign'), 'assignment tool kept')
assert.ok(orchestratorAllow.includes('read'), 'context reading kept')
assert.ok(!orchestratorAllow.includes('write'), 'write hidden from the orchestrator')
assert.ok(!orchestratorAllow.includes('edit'), 'edit hidden from the orchestrator')
assert.ok(!orchestratorAllow.includes('bash'), 'bash hidden from the orchestrator')
const judged = await swarmPreExecute(
  { name: 'write', arguments: { file_path: '/w/src/app.ts' }, agent: swarmAgent },
  async () => ({ kind: 'allow' }),
)
assert.equal(judged.kind, 'ask', 'swarm mode applies the model-judged gate')
assert.match(judged.reason, /persona rule violation/)
const swarmStatus = swarmTool('systemone_status')
const swarmReport = await swarmStatus.execute({}, { signal: undefined })
assert.equal(swarmReport.layer.mode, 'swarm')
assert.ok(swarmReport.layer.swarm.active >= 1, 'status reports an active swarm session')
assert.equal(swarmReport.layer.stats.failures, 0, 'entering swarm mode recorded no failure')

// The mode's own control tools are never gated: a session can always leave.
const exitVerdict = await swarmPreExecute(
  { name: 'swarm_exit', arguments: {}, agent: swarmAgent },
  async () => ({ kind: 'allow' }),
)
assert.equal(exitVerdict.kind, 'allow', 'swarm_exit is never blocked by the gate')

// Leaving restores an inert session and lifts the orchestrator restriction.
await swarmTool('swarm_exit').execute({}, { agent: swarmAgent, signal: undefined })
assert.equal(swarmCtx.restrictLifts.length, 1, 'exit lifts the orchestrator restriction')
const afterExit = await swarmPreExecute(
  { name: 'write', arguments: { file_path: '/w/src/app.ts' }, agent: swarmAgent },
  async () => ({ kind: 'allow' }),
)
assert.equal(afterExit.kind, 'allow', 'exit restores an inert session')

mock.close()
console.log('\nAll selftests passed.')
console.log(`(mock answered on ${endpoint} during the run)`)
