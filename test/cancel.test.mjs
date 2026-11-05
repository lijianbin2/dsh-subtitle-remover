/**
 * Cancellation check for the subtitle-remover plugin Host half.
 *
 * Starts a job long enough to interrupt, cancels it through the API, and verifies
 * that the job reports `cancelled`, the partial output file is cleaned up, and a
 * new job can start afterwards. Needs the local video-subtitle-remover checkout.
 *
 *     node test/cancel.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ORIGIN = 'http://127.0.0.1:65441'
const CLIP = path.join(HERE, 'fixtures', 'clip-long.mp4')
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vsr-cancel-'))

let route = null
const disposers = []
const ctx = {
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
  inject(services, callback) {
    callback({
      webServer: { register(candidate) { route = candidate; return () => { route = null } }, getOrigin: () => ORIGIN },
      effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    })
    return () => {}
  },
}
apply(ctx, {})

function call(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url: pathname,
      headers: { host: '127.0.0.1:65441', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, listener) {
        if (event === 'data' && body !== undefined) listener(Buffer.from(JSON.stringify(body)))
        if (event === 'end') listener()
        return req
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code },
      end(text) {
        let parsed = null
        try { parsed = JSON.parse(String(text || '')) } catch { parsed = String(text) }
        resolve({ status: this.statusCode, body: parsed })
      },
    }
    if (!route) return reject(new Error('no route registered'))
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

async function main() {
  check('route registered', Boolean(route))
  check('long fixture exists', fs.existsSync(CLIP), CLIP)

  const created = await call('POST', '/dsh-subtitle-remover/api/jobs', {
    videoPath: CLIP,
    mode: 'sttn-auto',
    areas: [{ yMin: 78, yMax: 100, xMin: 5, xMax: 95 }],
    saveDir: WORK_DIR,
  })
  check('job created', created.status === 200, String(created.status))
  const job = created.body.job
  const outputPath = job.outputPath

  // Let the engine load and start writing frames before interrupting it.
  await sleep(9000)
  const before = await call('GET', `/dsh-subtitle-remover/api/jobs/${job.id}`)
  check('still running before cancel', before.body.job.status === 'running', `${before.body.job.status} ${before.body.job.percent}%`)

  const cancelled = await call('POST', `/dsh-subtitle-remover/api/jobs/${job.id}/cancel`, {})
  check('cancel accepted', cancelled.status === 200 && cancelled.body.job.status === 'cancelled', cancelled.body.job && cancelled.body.job.status)

  await sleep(4000)
  const after = await call('GET', `/dsh-subtitle-remover/api/jobs/${job.id}`)
  check('job stays cancelled', after.body.job.status === 'cancelled', after.body.job.status)
  check('partial output removed', !fs.existsSync(outputPath), outputPath)
  check('no active job', !after.body.active, String(after.body.active))

  const fresh = await call('POST', '/dsh-subtitle-remover/api/jobs', {
    videoPath: CLIP,
    areas: [{ yMin: 78, yMax: 100, xMin: 5, xMax: 95 }],
  })
  check('new job allowed after cancel', fresh.status === 200, String(fresh.status))
  if (fresh.status === 200) await call('POST', `/dsh-subtitle-remover/api/jobs/${fresh.body.job.id}/cancel`, {})

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
  for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
  await sleep(3000)
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exitCode = 1
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})
