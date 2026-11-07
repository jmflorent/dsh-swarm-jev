/**
 * Advisory classifier over the System One decision service.
 *
 * Classification never mutates objective state: it journals a tag, and the
 * orchestrator may read or call the classifier through objective_classify.
 * The deterministic boundary (explicit tools) stays authoritative.
 */
import { randomUUID } from 'node:crypto'

const preview = (text) => (text.length <= 200 ? text : `${text.slice(0, 200)}…`)

/**
 * @param {{engine: object, decide?: Function, log: Function}} options
 * @returns classifier API: classify, onPreStep.
 */
export const createClassifier = ({ engine, decide, log }) => {
  const seen = new Map()

  const classify = async ({ sessionId, text: rawText, objectiveId }) => {
    if (engine.settings.classification.enabled === false) {
      return { ok: false, code: 'classification-disabled', message: 'classification is disabled in the engine config' }
    }
    if (typeof decide !== 'function') {
      return {
        ok: false,
        code: 'classifier-unavailable',
        message: 'the systemone decision service is not composed; explicit tools remain the authoritative boundary',
      }
    }
    const text = typeof rawText === 'string' ? rawText.trim().slice(0, 4000) : ''
    if (text === '') return { ok: false, code: 'text-required', message: 'objective_classify needs non-empty text' }
    const active = typeof sessionId === 'string' ? engine.activeFor(sessionId) : []
    const known = typeof objectiveId === 'string' && active.some((objective) => objective.id === objectiveId) ? objectiveId : undefined
    const questions = {
      kind: {
        type: 'choice',
        instructions:
          'Classify the incoming orchestrator message: is it a new objective, progress toward the existing objective(s), or not engineering work at all?',
        criteria: {
          'new-objective': 'The message states a new goal for the body of work, not incremental work toward the listed objective.',
          progress: 'The message asks for incremental work toward one of the listed existing objectives (a step, fix, review, or status question).',
          'not-work': 'The message is conversation, a question, or clarification that does not begin or advance work.',
        },
      },
      newObjective: {
        type: 'noul',
        instructions: 'Does this message define a new objective rather than progress on the listed existing objectives?',
        boundary: {
          true: 'The message defines a goal of its own, whose completion would be judged separately from the listed objective.',
          false: 'The message continues, narrows, or questions work toward the listed objective.',
        },
      },
    }
    const task = JSON.stringify({
      message: text,
      objectiveId: known,
      activeObjectives: active.map((objective) => ({ id: objective.id, statement: objective.statement.slice(0, 240) })),
    })
    let result
    try {
      result = await decide({ task }, questions)
    } catch (error) {
      return { ok: false, code: 'classifier-failed', message: String(error?.message ?? error) }
    }
    if (result === undefined || result.ok !== true) {
      return { ok: false, code: 'classifier-failed', message: result?.error ?? 'the decision model did not answer' }
    }
    const answers = result.answers ?? {}
    const choice = answers.kind === 'new-objective' || answers.kind === 'progress' || answers.kind === 'not-work' ? answers.kind : 'not-work'
    const tag = {
      id: `tag-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      sessionId,
      textPreview: preview(text),
      choice,
      ...(typeof answers.newObjective === 'number' ? { newObjectiveP: answers.newObjective } : {}),
      ...(known === undefined ? {} : { objectiveId: known }),
      ...(typeof result.model === 'string' ? { model: result.model } : {}),
    }
    engine.recordTag(tag)
    return { ok: true, tag }
  }

  const onPreStep = (payload) => {
    if (engine.settings.classification.enabled === false) return
    const sessionId = payload?.agent?.session?.id
    if (typeof sessionId !== 'string' || !engine.hasOwner(sessionId)) return
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const userMessages = messages.filter((message) => message?.source?.kind === 'user' && Array.isArray(message.content))
    const message = userMessages[userMessages.length - 1]
    if (message === undefined) return
    if (typeof message.id === 'string') {
      if (seen.has(message.id)) return
      seen.set(message.id, Date.now())
      while (seen.size > 200) seen.delete(seen.keys().next().value)
    }
    const text = message.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text.trim() === '') return
    void classify({ sessionId, text }).catch((error) => {
      log('warn', 'classification failed', { sessionId, error: String(error?.message ?? error) })
    })
  }

  return { classify, onPreStep }
}
