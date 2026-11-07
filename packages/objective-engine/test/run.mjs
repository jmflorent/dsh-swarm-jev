/**
 * Self-test for @local/objective-engine: journal fold and restart, admission,
 * verification gate, budgets, classification tags, tools, and the driver pump.
 *
 * Uses a fake Cordis context and a temp journal directory; no harness is needed.
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../lib/engine.js'
import { createPump } from '../lib/pump.js'
import { createClassifier } from '../lib/classify.js'
import { buildTools } from '../lib/tools.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const makeCtx = () => {
  const listeners = new Map()
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'systemone') return ctx.systemone
      return undefined
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((entry) => entry !== handler))
      }
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args)
    },
    effect(fn) {
      return fn()
    },
    provide() {},
    tools: { register: () => () => {} },
    systemone: undefined,
  }
}

const actor = (sessionId, preset) => ({ sessionId, ...(preset === undefined ? {} : { preset }) })
const tempJournal = () => join(mkdtempSync(join(tmpdir(), 'objective-engine-')), 'journal.jsonl')

const config = (overrides = {}) => ({
  enabled: true,
  maxActiveObjectives: 2,
  maxQueuedObjectives: 2,
  maxRoundsPerObjective: 4,
  minWakeGapMs: 1,
  progressIntervalMs: 3_600_000,
  tickMs: 3_600_000,
  classification: { enabled: true },
  ...overrides,
})

// --- 1. boot, create, idempotency, admission -------------------------------
{
  const journalFile = tempJournal()
  const engine = createEngine({ config: config(), journalFile })
  assert.equal(engine.paused, true, 'boots paused')
  assert.equal(engine.status().engine.counts.active, 0)

  const missing = engine.create({ statement: 'x', criteria: [] }, actor('s1'))
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'criteria-required')

  const a = engine.create({ statement: 'A', criteria: ['A done'], idempotencyKey: 'k1' }, actor('s1'))
  assert.equal(a.ok, true)
  assert.equal(a.objective.state, 'active')
  const again = engine.create({ statement: 'A', criteria: ['A done'], idempotencyKey: 'k1' }, actor('s1'))
  assert.equal(again.ok, true)
  assert.equal(again.deduplicated, true, 'idempotent create')

  const b = engine.create({ statement: 'B', criteria: ['B done'] }, actor('s1'))
  assert.equal(b.objective.state, 'active')
  const c = engine.create({ statement: 'C', criteria: ['C done'] }, actor('s1'))
  assert.equal(c.objective.state, 'queued', 'admission queues past the active limit')
  const d = engine.create({ statement: 'D', criteria: ['D done'] }, actor('s1'))
  assert.equal(d.objective.state, 'queued')
  const e = engine.create({ statement: 'E', criteria: ['E done'] }, actor('s1'))
  assert.equal(e.ok, false)
  assert.equal(e.code, 'admission-full')

  engine.close()
}

// --- 2. progress, verifier gate, completion, queue promotion ---------------
{
  const journalFile = tempJournal()
  const engine = createEngine({ config: config(), journalFile })
  const a = engine.create({ statement: 'Ship login', criteria: ['tests pass', 'reviewer approves'] }, actor('owner'))
  const b = engine.create({ statement: 'Second', criteria: ['x'] }, actor('owner'))
  const c = engine.create({ statement: 'Queued', criteria: ['y'] }, actor('owner'))

  const plan = engine.plan({ objectiveId: a.objective.id, text: 'Implement token refresh' }, actor('owner'))
  assert.equal(plan.ok, true)
  assert.equal(plan.item.state, 'ready')
  const report = engine.report({ objectiveId: a.objective.id, text: 'Wired the endpoint' }, actor('owner'))
  assert.equal(report.ok, true)

  const early = engine.complete({ objectiveId: a.objective.id }, actor('owner'))
  assert.equal(early.ok, false)
  assert.equal(early.code, 'verification-required')

  const self = engine.verdict({ objectiveId: a.objective.id, verdict: 'pass', evidence: 'ran it' }, actor('owner'))
  assert.equal(self.ok, false)
  assert.equal(self.code, 'self-verification', 'the producer cannot verify its own objective')

  const pass = engine.verdict({ objectiveId: a.objective.id, verdict: 'pass', evidence: 'pnpm test exited 0' }, actor('verifier', 'reviewer'))
  assert.equal(pass.ok, true)

  const done = engine.complete({ objectiveId: a.objective.id, note: 'shipped' }, actor('owner'))
  assert.equal(done.ok, true)
  assert.equal(done.objective.state, 'completed')
  assert.deepEqual(done.promoted, [c.objective.id], 'completion promotes the queued objective')

  const status = engine.status()
  assert.equal(status.engine.counts.active, 2)
  assert.equal(status.engine.counts.queued, 0)
  assert.equal(status.engine.counts.completed, 1)

  // Cancel is owner-only while running.
  const wrong = engine.cancel({ objectiveId: b.objective.id }, actor('someone-else'))
  assert.equal(wrong.ok, false)
  const cancelled = engine.cancel({ objectiveId: b.objective.id, reason: 'superseded' }, actor('owner'))
  assert.equal(cancelled.ok, true)

  engine.close()
}

// --- 3. budget blocks instead of looping ----------------------------------
{
  const journalFile = tempJournal()
  const engine = createEngine({ config: config({ maxRoundsPerObjective: 2 }), journalFile })
  const a = engine.create({ statement: 'Budgeted', criteria: ['done'] }, actor('s'))
  assert.equal(engine.claimable('s').length, 1)
  assert.equal(engine.spendRound(a.objective.id).budget.rounds.used, 1)
  assert.equal(engine.spendRound(a.objective.id).budget.rounds.used, 2)
  assert.equal(engine.claimable('s').length, 0, 'no prompt beyond the budget')
  assert.equal(engine.spendRound(a.objective.id), undefined)
  const blocked = engine.state.objectives.get(a.objective.id)
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.blockedReason, 'budget-exhausted')
  engine.close()
}

// --- 4. advisory classification -------------------------------------------
{
  const journalFile = tempJournal()
  const ctx = makeCtx()
  const engine = createEngine({ config: config(), journalFile })
  engine.create({ statement: 'Objective one', criteria: ['done'] }, actor('owner'))
  let received = 0
  const classifier = createClassifier({
    engine,
    log() {},
    decide: async (state, questions) => {
      received += 1
      assert.ok(questions.kind, 'choice question sent')
      assert.ok(questions.newObjective, 'noul question sent')
      assert.match(state.task, /login/i)
      return { ok: true, answers: { kind: 'progress', newObjective: 0.31 }, model: 'test' }
    },
  })
  const classified = await classifier.classify({ sessionId: 'owner', text: 'add login validation to the form' })
  assert.equal(classified.ok, true)
  assert.equal(classified.tag.choice, 'progress')
  assert.equal(received, 1)
  assert.equal(engine.status().tags.length, 1)
  assert.equal(engine.status().objectives[0].state, 'active', 'classification never mutates objectives')

  classifier.onPreStep({
    agent: { session: { id: 'owner' } },
    messages: [{ id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'please add login' }] }],
  })
  await sleep(30)
  assert.equal(received, 2, 'incoming user messages are classified automatically')
  assert.equal(engine.status().tags.length, 2)
  engine.close()
}

// --- 5. restart fold and torn-tail repair ----------------------------------
{
  const journalFile = tempJournal()
  const first = createEngine({ config: config(), journalFile })
  const created = first.create({ statement: 'Persist me', criteria: ['done'] }, actor('s'))
  first.plan({ objectiveId: created.objective.id, text: 'step one' }, actor('s'))
  first.close()

  const second = createEngine({ config: config(), journalFile })
  assert.equal(second.paused, true, 'restart boots paused')
  assert.equal(second.status().objectives.length, 1)
  assert.equal(second.status().objectives[0].id, created.objective.id)
  assert.equal(second.status().progress.length, 1)
  second.close()

  appendFileSync(journalFile, '{"v":1,"seq":99,"type":"objective/upsert","data":')
  const repaired = createEngine({ config: config(), journalFile })
  const repairedText = readFileSync(journalFile, 'utf8')
  assert.equal(repairedText.includes('"seq":99'), false, 'torn tail truncated')
  assert.equal(repairedText.endsWith('\n'), true)
  assert.equal(repaired.status().objectives.length, 1)
  repaired.close()
  void statSync
}

// --- 6. tools are registry-ready and callable -----------------------------
{
  const journalFile = tempJournal()
  const ctx = makeCtx()
  const engine = createEngine({ config: config(), journalFile })
  const pump = { kick() {} }
  const classifier = { classify: async () => ({ ok: false, code: 'classifier-unavailable' }) }
  const tools = buildTools({ ctx, engine, classifier, pump })
  const names = tools.map((definition) => definition.name)
  assert.deepEqual(names, [
    'objective_create',
    'objective_status',
    'objective_plan',
    'objective_report',
    'objective_verify',
    'objective_complete',
    'objective_cancel',
    'objective_classify',
    'objective_system',
  ])
  for (const definition of tools) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.ok(definition.parameters !== undefined)
  }
  const exec = { agent: { session: { id: 'owner' } } }
  const created = await tools.find((tool) => tool.name === 'objective_create').execute(
    { statement: 'Tool-created', criteria: ['done'] },
    exec,
  )
  assert.equal(created.ok, true)
  const status = await tools.find((tool) => tool.name === 'objective_status').execute({}, exec)
  assert.equal(status.ok, true)
  assert.equal(status.objectives.length, 1)
  engine.close()
}

// --- 7. pump: paused by default, resumes with one prompt per idle edge -----
{
  const journalFile = tempJournal()
  const ctx = makeCtx()
  const engine = createEngine({ config: config({ maxRoundsPerObjective: 2 }), journalFile })
  const sent = []
  const pump = createPump({ ctx, engine, log() {} })
  const detach = pump.attach()
  pump.start()
  const agent = {
    session: { id: 'owner' },
    status: 'idle',
    followup(input) {
      sent.push(input)
    },
  }
  engine.create({ statement: 'Drive me', criteria: ['done'] }, actor('owner'))

  ctx.emit('agent/status', { status: 'idle', agent })
  await sleep(650)
  assert.equal(sent.length, 0, 'paused engine sends no progress prompts')

  engine.resume()
  ctx.emit('agent/status', { status: 'idle', agent })
  await sleep(650)
  assert.equal(sent.length, 1, 'resumed engine delivers one progress prompt')
  assert.equal(sent[0].source.kind, 'plugin:objective-engine')
  assert.match(sent[0].content[0].text, /progress prompt/)
  assert.match(sent[0].content[0].text, /Budget: 1 progress prompt\(s\) remain/)

  // One round remains: the next idle edge sends one more, then the budget blocks.
  ctx.emit('agent/status', { status: 'idle', agent })
  await sleep(800)
  assert.equal(sent.length, 2, 'second prompt within budget')
  ctx.emit('agent/status', { status: 'idle', agent })
  await sleep(800)
  assert.equal(sent.length, 2, 'no prompt beyond the budget')
  const objective = [...engine.state.objectives.values()][0]
  assert.equal(objective.state, 'blocked')
  assert.equal(objective.blockedReason, 'budget-exhausted')

  pump.dispose()
  detach()
  engine.close()
}

console.log('objective-engine selftests passed')
