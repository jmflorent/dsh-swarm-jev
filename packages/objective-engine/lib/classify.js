/**
 * Advisory classifier over the System One decision service (design §3.2).
 *
 * One batched request: `message_type` (choice), `target_objective` (choice,
 * when more than one objective is active), `is_objective` (noul). A
 * deterministic decision rule turns the answers into a proposal that is
 * journaled in the advisory table only. Nothing here can reach the command
 * fold: this module has no access to `core.append`.
 */
import { clampText, mintId, sha256 } from './records.js'

const LABELS = ['new_objective', 'progress', 'objective_update', 'not_work', 'none_fit']

const probabilityOf = (answer, label) => {
  if (answer === undefined || answer === null) return undefined
  if (typeof answer === 'object') {
    const table = answer.probabilities ?? answer.scores
    if (table !== undefined && typeof table[label] === 'number') return table[label]
    if (typeof answer.probability === 'number' && answer.choice === label) return answer.probability
  }
  return undefined
}
const choiceOf = (answer) => (typeof answer === 'string' ? answer : typeof answer?.choice === 'string' ? answer.choice : undefined)
const noulOf = (answer) => (typeof answer === 'number' ? answer : typeof answer?.noul === 'number' ? answer.noul : typeof answer?.probability === 'number' ? answer.probability : undefined)
const confidenceOf = (answer) => (typeof answer?.confidence === 'number' ? answer.confidence : undefined)

/** The deterministic decision rule (design §3.2 table). Pure. */
export const decide = ({ messageType, typeProbability, secondProbability, confidence, target, isObjective, knownIds }, thresholds) => {
  const t = thresholds
  const floorFail = typeof typeProbability === 'number' && typeProbability < t.choiceFloor
  const confidenceFail = typeof confidence === 'number' && confidence < t.confidenceFloor
  const marginFail = typeof typeProbability === 'number' && typeof secondProbability === 'number' && typeProbability - secondProbability < t.margin
  const p = typeof isObjective === 'number' ? isObjective : undefined
  if (messageType === 'none_fit' || messageType === undefined) return { kind: 'none_fit', reason: 'no label fits' }
  if (floorFail || confidenceFail || marginFail) return { kind: 'ambiguous', reason: floorFail ? 'label below choiceFloor' : confidenceFail ? 'confidence below confidenceFloor' : 'top-2 margin too small' }
  if (p !== undefined && p >= 0.4 && p < t.objectiveProbability && messageType !== 'not_work') return { kind: 'ambiguous', reason: 'is_objective in the ambiguous band' }
  if (messageType === 'new_objective') {
    if ((p === undefined || p >= t.objectiveProbability) && (target === undefined || target === 'none')) return { kind: 'new_objective', reason: 'choice+noul agree' }
    return { kind: 'ambiguous', reason: 'new_objective label conflicts with noul or target' }
  }
  if (messageType === 'progress' || messageType === 'objective_update') {
    const known = target !== undefined && target !== 'none' && knownIds.includes(target) ? target : knownIds.length === 1 ? knownIds[0] : undefined
    if (known !== undefined && (p === undefined || p < t.progressProbability)) {
      return { kind: 'attach', targetObjectiveId: known, update: messageType === 'objective_update', reason: 'choice targets a known objective' }
    }
    return { kind: 'ambiguous', reason: known === undefined ? 'no known target objective' : 'noul says objective' }
  }
  if (messageType === 'not_work') {
    if (p === undefined || p <= 0.3) return { kind: 'not_work', reason: 'choice+noul agree' }
    return { kind: 'ambiguous', reason: 'not_work label conflicts with noul' }
  }
  return { kind: 'none_fit', reason: 'unknown label' }
}

export const createClassifier = ({ engine, decideFn, log, now = Date.now }) => {
  const seen = new Map()
  const calls = []
  const perMessage = new Map()
  const breaker = { failures: 0, openedAt: undefined, state: 'closed' }
  let lastFailure
  let lastProposal

  const thresholds = () => engine.settings.classification
  const rateLimited = () => {
    const nowMs = now()
    while (calls.length > 0 && nowMs - calls[0] > 3_600_000) calls.shift()
    return calls.length >= engine.settings.limits.classificationCallsPerHour
  }
  const breakerOpen = () => {
    if (breaker.state !== 'open') return false
    if (now() - breaker.openedAt >= thresholds().breakerCooldownMs) {
      breaker.state = 'half-open'
      return false
    }
    return true
  }
  const recordFailure = (message) => {
    lastFailure = { at: new Date(now()).toISOString(), message }
    breaker.failures += 1
    if (breaker.failures >= thresholds().breakerFailures) {
      breaker.state = 'open'
      breaker.openedAt = now()
    }
  }
  const recordSuccess = () => {
    breaker.failures = 0
    breaker.state = 'closed'
    breaker.openedAt = undefined
  }

  const classify = async ({ sessionId, text: rawText, objectiveId, messageId, auto = false }) => {
    const settings = thresholds()
    if (settings.enabled === false) return { ok: false, code: 'classification-disabled', message: 'classification is disabled in the engine config' }
    if (typeof decideFn !== 'function') return { ok: false, code: 'classifier-unavailable', message: 'the systemone decision service is not composed; explicit tools remain the authoritative boundary' }
    const text = clampText(rawText, 4000)
    if (text === '') return { ok: false, code: 'text-required', message: 'objective_classify needs non-empty text' }
    if (breakerOpen()) return { ok: false, code: 'classifier-circuit-open', message: `classification is paused after ${breaker.failures} consecutive failures; retry after the cooldown`, lastFailure }
    if (rateLimited()) return { ok: false, code: 'classifier-rate-limited', message: `classificationCallsPerHour (${engine.settings.limits.classificationCallsPerHour}) reached` }
    const messageHash = sha256(text)
    const hysteresis = perMessage.get(`${sessionId}:${messageHash}`) ?? []
    if (!auto && hysteresis.length >= 2) return { ok: false, code: 'classifier-hysteresis', message: 'at most two classifications per message; the proposals disagree or were already given', proposals: hysteresis }

    const active = typeof sessionId === 'string' ? engine.activeFor(sessionId) : []
    const listed = active.slice(0, settings.maxActiveObjectivesInPrompt)
    const knownIds = listed.map((objective) => objective.id)
    const known = typeof objectiveId === 'string' && knownIds.includes(objectiveId) ? objectiveId : undefined
    const questions = {
      message_type: {
        type: 'choice',
        instructions:
          'Classify this human message for an objective-tracking system. new_objective means it states a new end state with completion criteria; progress means it advances or reports on an existing objective; objective_update changes an existing objective; not_work is unrelated to any tracked objective; none_fit means none of the labels describes it.',
        criteria: {
          new_objective: 'States a new end state that needs its own acceptance criteria',
          progress: 'Reports or advances work already tracked under an objective',
          objective_update: 'Changes the statement, criteria, priority, or budget of an existing objective',
          not_work: 'Unrelated to any tracked objective',
          none_fit: 'The message does not fit any of these categories',
        },
      },
      is_objective: {
        type: 'noul',
        instructions: 'Is this message stating a new end state (a goal that can be completed and checked), as opposed to a step toward one? Answer with the probability that it is an objective.',
        boundary: {
          true: 'The message states a new end state with an implied or stated completion check',
          false: 'The message only asks for a step, a question, or a fact within existing work',
        },
      },
    }
    if (listed.length > 1 || active.length > listed.length) {
      questions.target_objective = {
        type: 'choice',
        instructions: 'If this message is progress or an objective_update, which objective does it target? Choose none when it targets a new objective or is not_work.',
        criteria: { ...Object.fromEntries(listed.map((objective) => [objective.id, objective.statement.slice(0, 300)])), none: 'No existing objective applies' },
      }
    }
    const state = {
      channel: 'human-message',
      message: text,
      active_objectives: listed.map((objective) => ({ id: objective.id, statement: objective.statement.slice(0, 300), state: objective.state, criteriaCount: objective.criteria.length })),
      ...(known === undefined ? {} : { hinted_objective: known }),
    }
    calls.push(now())
    const requestId = mintId('cls')
    const startedAt = now()
    let result
    try {
      result = await decideFn(state, questions)
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error) }
    }
    const latencyMs = now() - startedAt
    if (result === undefined || result.ok !== true) {
      recordFailure(result?.error ?? 'the decision model did not answer')
      engine.recordProposal({ kind: 'advisory', applied: false, requestId, error: result?.error ?? 'no answer', input: { messageSha256: messageHash, messageChars: text.length, activeObjectiveIds: knownIds }, latencyMs })
      return { ok: false, code: 'classifier-unavailable', message: result?.error ?? 'the decision model did not answer', requestId }
    }
    recordSuccess()
    const answers = result.answers ?? {}
    const messageType = LABELS.includes(choiceOf(answers.message_type)) ? choiceOf(answers.message_type) : undefined
    const typeProbability = probabilityOf(answers.message_type, messageType)
    const others = LABELS.filter((label) => label !== messageType).map((label) => probabilityOf(answers.message_type, label)).filter((value) => typeof value === 'number')
    const secondProbability = others.length === 0 ? undefined : Math.max(...others)
    const target = choiceOf(answers.target_objective)
    const isObjective = noulOf(answers.is_objective)
    const confidence = confidenceOf(answers.message_type) ?? (typeof result.confidence === 'number' ? result.confidence : undefined)
    const proposal = decide({ messageType, typeProbability, secondProbability, confidence, target, isObjective, knownIds: known === undefined ? knownIds : [known, ...knownIds.filter((id) => id !== known)] }, settings)
    if (proposal.kind === 'attach' && known !== undefined && proposal.targetObjectiveId === undefined) proposal.targetObjectiveId = known
    // Hysteresis: two calls on the same message must agree, else ambiguous.
    hysteresis.push({ kind: proposal.kind, targetObjectiveId: proposal.targetObjectiveId ?? null })
    perMessage.set(`${sessionId}:${messageHash}`, hysteresis)
    while (perMessage.size > 200) perMessage.delete(perMessage.keys().next().value)
    if (hysteresis.length === 2 && (hysteresis[0].kind !== hysteresis[1].kind || hysteresis[0].targetObjectiveId !== hysteresis[1].targetObjectiveId)) {
      proposal.kind = 'ambiguous'
      proposal.reason = 'the two classifications of this message disagree'
    }
    const record = {
      kind: 'advisory',
      applied: false,
      requestId,
      sessionId,
      ...(messageId === undefined ? {} : { messageId }),
      auto,
      input: { messageSha256: messageHash, messageChars: text.length, activeObjectiveIds: knownIds, preview: text.slice(0, 160) },
      decisionPlane: {
        ...(typeof result.model === 'string' ? { modelAnswered: result.model } : {}),
        latencyMs,
        answers: { message_type: answers.message_type ?? null, target_objective: answers.target_objective ?? null, is_objective: answers.is_objective ?? null },
        unmatched: Array.isArray(result.unmatched) ? result.unmatched : [],
      },
      thresholds: { objectiveProbability: settings.objectiveProbability, progressProbability: settings.progressProbability, choiceFloor: settings.choiceFloor, confidenceFloor: settings.confidenceFloor, margin: settings.margin },
      proposal: { kind: proposal.kind, targetObjectiveId: proposal.targetObjectiveId ?? null, ...(proposal.update === undefined ? {} : { update: proposal.update }), reason: proposal.reason },
      ambiguity: proposal.kind === 'ambiguous' ? proposal.reason : null,
    }
    lastProposal = { at: new Date(now()).toISOString(), requestId, kind: proposal.kind, targetObjectiveId: proposal.targetObjectiveId ?? null }
    engine.recordProposal(record)
    return {
      ok: true,
      requestId,
      proposal: record.proposal,
      ambiguity: record.ambiguity,
      ...(typeof result.model === 'string' ? { model: result.model } : {}),
      latencyMs,
      advisory: true,
      note:
        proposal.kind === 'new_objective'
          ? 'advisory: a human creates objectives with objective_create; this proposal creates nothing'
          : proposal.kind === 'attach'
            ? 'advisory: attach with objective_plan / objective_report if you agree; nothing was attached'
            : 'advisory: ask the human; a classifier answer never changes state',
    }
  }

  const onPreStep = (payload) => {
    if (thresholds().enabled === false || thresholds().autoTag === false) return
    const sessionId = payload?.agent?.session?.id
    if (typeof sessionId !== 'string' || !engine.hasOwner(sessionId)) return
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const userMessages = messages.filter((message) => message?.source?.kind === 'user' && Array.isArray(message.content))
    const message = userMessages[userMessages.length - 1]
    if (message === undefined) return
    const messageId = typeof message.id === 'string' ? message.id : undefined
    if (messageId !== undefined) {
      if (seen.has(messageId)) return
      seen.set(messageId, now())
      while (seen.size > 200) seen.delete(seen.keys().next().value)
    }
    const text = message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
    if (text.trim() === '') return
    void classify({ sessionId, text, messageId, auto: true }).catch((error) => {
      log('warn', 'auto classification failed', { sessionId, error: String(error?.message ?? error) })
    })
  }

  const status = () => ({
    enabled: thresholds().enabled,
    available: typeof decideFn === 'function',
    breaker: { state: breakerOpen() ? 'open' : breaker.state, failures: breaker.failures },
    callsLastHour: (() => {
      const nowMs = now()
      return calls.filter((at) => nowMs - at <= 3_600_000).length
    })(),
    ...(lastFailure === undefined ? {} : { lastFailure }),
    ...(lastProposal === undefined ? {} : { lastProposal }),
  })

  return { classify, onPreStep, status, decide }
}
