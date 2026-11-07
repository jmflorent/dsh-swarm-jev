/**
 * A small mock of the self-hosted System One decision endpoint.
 *
 * Implements the documented contract: POST /systemone with
 * `{ state, questions: { id: { type, instructions, criteria?, boundary? } }, model? }`
 * and answers `{ answers: { id: <typed answer> }, model, usage }`.
 *
 * Supports both `application/json` and the multipart asset form
 * (`multipart/form-data` with a `request` part plus `asset-N` parts), so the
 * plugin's vision path is exercised rather than skipped.
 *
 * Run directly to listen on 127.0.0.1:8765 (for exercising the installed
 * plugin), or import createMockSystemOne() for in-process tests.
 */

import { createServer } from 'node:http'

export const MOCK_PORT = 8765

/** Parse a multipart/form-data body into its request JSON and assets. */
const parseMultipart = (raw, contentType) => {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim()
  if (boundary === '') return { error: 'multipart body without a boundary' }
  const text = raw.toString('latin1')
  const segments = text.split(`--${boundary}`)
  let payload
  const assets = []
  for (const segment of segments) {
    if (segment.startsWith('--')) break // closing delimiter
    let part = segment
    if (part.startsWith('\r\n')) part = part.slice(2)
    if (part.endsWith('\r\n')) part = part.slice(0, -2)
    const split = part.indexOf('\r\n\r\n')
    if (split === -1) continue
    const headers = part.slice(0, split)
    const body = part.slice(split + 4)
    const disposition = /name="([^"]+)"/.exec(headers)
    if (disposition === null) continue
    const name = disposition[1]
    if (name === 'request') {
      try {
        payload = JSON.parse(body)
      } catch {
        return { error: 'request part was not JSON' }
      }
    } else if (/^asset-\d+$/.test(name)) {
      const mediaType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim()
      assets.push({ part: name, mediaType, bytes: Buffer.from(body, 'latin1').length })
    }
  }
  if (payload === undefined) return { error: 'multipart body without a request part' }
  return { payload, assets }
}

const answerFor = (id, question, assets) => {
  if (!question || typeof question !== 'object') return undefined
  if (question.type === 'noul') {
    // Selection questions ask about declared categories; give them a realistic
    // spread so enforce-mode tests can exercise a partial restriction.
    // Model-judged persona rule: a deterministic stand-in for the decision
    // model's verdict so the gate's plumbing is testable.
    if (id === 'persona') return { noul: 0.95 }
    if (id.startsWith('category_')) {
      const probability = id === 'category_shell' ? 0.05 : id === 'category_web' ? 0.1 : 0.9
      return { noul: probability }
    }
    return { noul: 0.91 }
  }
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria ?? {})
    const probabilities = {}
    keys.forEach((key) => {
      probabilities[key] = Math.round((1 / keys.length) * 100) / 100
    })
    if (keys.length > 0) probabilities[keys[0]] = 0.8
    return { choice: keys[0], probabilities, confidence: 0.72 }
  }
  if (question.type === 'score') {
    const levels = (question.criteria ?? []).map((description, index) => [String(index), description])
    const probabilities = {}
    levels.forEach(([index]) => {
      probabilities[index] = Math.round((1 / levels.length) * 100) / 100
    })
    if (levels.length > 1) probabilities['1'] = 0.6
    return {
      score: 1.05,
      legend: Object.fromEntries(levels),
      probabilities,
      confidence: 0.64,
    }
  }
  if (question.type === 'box') {
    if (assets.length === 0) return undefined
    return { box: { top: 0.1, bottom: 0.5, left: 0.2, right: 0.8 }, confidence: 0.55 }
  }
  return undefined
}

export function createMockSystemOne() {
  const server = createServer((req, res) => {
    server.hits += 1
    if (req.method !== 'POST' || !req.url.startsWith('/systemone')) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found.')
      return
    }
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const contentType = String(req.headers['content-type'] ?? '')
      let payload
      let assets = []
      if (contentType.startsWith('multipart/form-data')) {
        const parsed = parseMultipart(raw, contentType)
        if (parsed.error !== undefined) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: parsed.error }))
          return
        }
        payload = parsed.payload
        assets = parsed.assets
      } else {
        try {
          payload = JSON.parse(raw.toString('utf8'))
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'request body was not JSON' }))
          return
        }
      }
      const answers = {}
      let inputTokens = JSON.stringify(payload.state ?? '').length
      for (const [id, question] of Object.entries(payload.questions ?? {})) {
        inputTokens += JSON.stringify(question).length
        const answer = answerFor(id, question, assets)
        if (answer !== undefined) answers[id] = answer
      }
      const out = {
        answers,
        model: typeof payload.model === 'string' ? payload.model : 'mock-model',
        usage: {
          input_tokens: inputTokens,
          output_tokens: Object.keys(answers).length * 10,
        },
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  server.hits = 0
  return server
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())

if (invokedDirectly) {
  const server = createMockSystemOne()
  server.listen(MOCK_PORT, '127.0.0.1', () => {
    console.log(`[mock-systemone] listening on http://127.0.0.1:${MOCK_PORT}/systemone`)
  })
  const shutdown = () => {
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
