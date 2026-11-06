/**
 * Integration check for the subtitle-remover plugin Host half.
 *
 * Drives the real `apply()` from this bundle with a stub Cordis context, captures
 * the HTTP route it registers on webServer, and exercises the whole API against
 * real engine runs: state, browse, probe, preview frame, automatic region
 * detection, multi-region job creation, progress polling and security gates.
 * Needs the local video-subtitle-remover checkout.
 *
 *     node test/host-api.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ORIGIN = 'http://127.0.0.1:65441'
const CLIP = path.join(HERE, 'fixtures', 'clip.mp4')
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vsr-host-api-'))
// Isolate the saved engine settings so the test never touches the user's file.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vsr-home-'))
process.env.DSH_HOME = TEST_HOME

const { apply } = await import('../index.js')

let route = null
const disposers = []

// Stand-in for the Host model services, so the decision path is covered without
// spending tokens: it always answers "candidate 1, mode lama".
const fakeLlm = {
  listProviders: () => [{ id: 'fake-provider', displayName: 'Fake Provider' }],
  listModels: async (provider) => (provider === 'fake-provider'
    ? [{ id: 'fake-model', displayName: 'Fake Model', inputModalities: ['text'] }]
    : []),
  stream: () => (async function* fake() {
    yield { type: 'text-delta', text: '{"pick":[1],"mode":"lama","reason":"测试：选第一个候选"}' }
    yield { type: 'finish', kind: 'ok' }
  })(),
}
const fakeDefaults = { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }

const ctx = {
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  inject(services, callback) {
    const scope = { effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) } }
    if (services.includes('llm')) {
      scope.llm = fakeLlm
      scope.agentDefaultModel = fakeDefaults
    }
    if (services.includes('webServer')) {
      scope.webServer = {
        register(candidate) { route = candidate; return () => { route = null } },
        getOrigin: () => ORIGIN,
      }
    }
    callback(scope)
    return () => {}
  },
}

apply(ctx, {})

function call(method, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body
    const headers = { host: '127.0.0.1:65441', ...(options.headers || {}) }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const req = {
      method,
      url: pathname,
      headers,
      socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
      destroyed: false,
      on(event, listener) {
        if (event === 'data' && body !== undefined) listener(Buffer.from(JSON.stringify(body)))
        if (event === 'end') listener()
        return req
      },
      destroy() { req.destroyed = true },
    }
    const res = {
      statusCode: 0,
      responseHeaders: {},
      writeHead(code, responseHeaders) {
        this.statusCode = code
        this.responseHeaders = responseHeaders || {}
      },
      end(payload) {
        if (options.raw) {
          resolve({ status: this.statusCode, headers: this.responseHeaders, body: payload })
          return
        }
        let parsed = null
        try { parsed = JSON.parse(String(payload || '')) } catch { parsed = String(payload) }
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
  check('route registered', Boolean(route && route.kind === 'prefix' && route.path === '/dsh-subtitle-remover/api'), route && `${route.kind} ${route.path}`)
  check('fixture exists', fs.existsSync(CLIP), CLIP)

  // Security gates ---------------------------------------------------------
  const forbidden = await call('GET', '/dsh-subtitle-remover/api/state', { remoteAddress: '192.168.1.5' })
  check('non-loopback denied', forbidden.status === 403, `status ${forbidden.status}`)
  const crossOrigin = await call('GET', '/dsh-subtitle-remover/api/state', { headers: { origin: 'http://evil.local' } })
  check('cross-origin denied', crossOrigin.status === 403, `status ${crossOrigin.status}`)
  const ownOrigin = await call('GET', '/dsh-subtitle-remover/api/state', { headers: { origin: ORIGIN } })
  check('same-origin allowed', ownOrigin.status === 200, `status ${ownOrigin.status}`)

  // State + environment ----------------------------------------------------
  const state = await call('GET', '/dsh-subtitle-remover/api/state')
  check('state 200', state.status === 200)
  check('engine detected', Boolean(state.body.env && state.body.env.ready === true), JSON.stringify(state.body.env))
  check('python resolved', /python/i.test(state.body.env.pythonPath), state.body.env.pythonPath)
  check('jobs list is array', Array.isArray(state.body.jobs))

  // Engine setup routes ----------------------------------------------------
  const scan = await call('GET', '/dsh-subtitle-remover/api/env/scan')
  check('scan 200', scan.status === 200)
  check('scan finds the engine', Boolean(scan.body.found && scan.body.found.some((entry) => entry.root === state.body.env.vsrRoot)),
    JSON.stringify((scan.body.found || []).map((entry) => entry.root)))
  check('scan suggests a target', Boolean(scan.body.suggestedTarget), scan.body.suggestedTarget)

  const badRoot = await call('POST', '/dsh-subtitle-remover/api/env/validate', { body: { vsrRoot: path.join(WORK_DIR, 'nope') } })
  check('validate rejects a missing folder', badRoot.status === 200 && badRoot.body.vsrOk === false && badRoot.body.problems.length > 0,
    JSON.stringify(badRoot.body.problems))

  const goodRoot = await call('POST', '/dsh-subtitle-remover/api/env/validate', { body: { vsrRoot: state.body.env.vsrRoot } })
  check('validate accepts the engine', goodRoot.body.vsrOk === true, JSON.stringify(goodRoot.body.modelsMissing))

  const saved = await call('POST', '/dsh-subtitle-remover/api/env/save', {
    body: { vsrRoot: state.body.env.vsrRoot, pythonPath: state.body.env.pythonPath },
  })
  check('save persists settings', saved.status === 200 && saved.body.env.vsrSource === 'settings' && saved.body.env.pythonSource === 'settings',
    `${saved.body.env && saved.body.env.vsrSource}/${saved.body.env && saved.body.env.pythonSource}`)

  const afterSave = await call('GET', '/dsh-subtitle-remover/api/state')
  check('state reflects saved settings', afterSave.body.env.vsrSource === 'settings')

  const cleared = await call('POST', '/dsh-subtitle-remover/api/env/save', {
    body: { vsrRoot: state.body.env.vsrRoot, pythonPath: '' },
  })
  check('empty python clears the saved interpreter', cleared.status === 200 && cleared.body.env.pythonSource !== 'settings', cleared.body.env && cleared.body.env.pythonSource)

  const barePython = await call('POST', '/dsh-subtitle-remover/api/env/validate', {
    body: { vsrRoot: state.body.env.vsrRoot, pythonPath: 'python' },
  })
  check('bare command name is not path-resolved', barePython.body.pythonPath === 'python' && barePython.body.pythonOk === true,
    `${barePython.body.pythonPath} ok=${barePython.body.pythonOk}`)

  check('state exposes install slots', Boolean(state.body.install && 'active' in state.body.install && 'last' in state.body.install))

  const reset = await call('POST', '/dsh-subtitle-remover/api/env/reset', { body: {} })
  check('reset returns to auto-detect', reset.status === 200 && reset.body.env.vsrSource === 'auto', reset.body.env && reset.body.env.vsrSource)

  const badInstall = await call('POST', '/dsh-subtitle-remover/api/env/install', { body: { targetDir: HERE } })
  check('install refuses a non-empty target', badInstall.status === 400 && /不为空/.test(badInstall.body.error), `${badInstall.status} ${badInstall.body.error}`)

  if (process.platform === 'win32') {
    const systemInstall = await call('POST', '/dsh-subtitle-remover/api/env/install', { body: { targetDir: 'C:\\Windows\\Temp\\vsr-install-test' } })
    check('install refuses a system folder', systemInstall.status === 400 && /系统目录/.test(systemInstall.body.error), `${systemInstall.status} ${systemInstall.body.error}`)
  }

  const unknownCancel = await call('POST', '/dsh-subtitle-remover/api/env/install/nope/cancel', { body: {} })
  check('cancel unknown install is 404', unknownCancel.status === 404)

  // Browse -----------------------------------------------------------------
  const browse = await call('GET', `/dsh-subtitle-remover/api/browse?path=${encodeURIComponent(HERE)}`)
  check('browse 200', browse.status === 200)
  check('browse lists fixtures', Boolean(browse.body.dirs && browse.body.dirs.some((d) => d.name === 'fixtures')), `${browse.body.dirs.length} dirs`)

  // Probe + frame ----------------------------------------------------------
  const probe = await call('GET', `/dsh-subtitle-remover/api/probe?path=${encodeURIComponent(CLIP)}`)
  check('probe ok', probe.status === 200 && probe.body.ok === true, JSON.stringify(probe.body))
  check('probe geometry', probe.body.width === 320 && probe.body.height === 240 && probe.body.frames === 60, `${probe.body.width}x${probe.body.height} ${probe.body.frames}f`)

  const frame = await call('GET', `/dsh-subtitle-remover/api/frame?path=${encodeURIComponent(CLIP)}&t=1`, { raw: true })
  const frameBuffer = Buffer.isBuffer(frame.body) ? frame.body : Buffer.from(frame.body || [])
  check('frame 200', frame.status === 200, String(frame.status))
  check('frame is jpeg', /image\/jpeg/.test(String(frame.headers['content-type'])) && frameBuffer.length > 1000 && frameBuffer[0] === 0xff && frameBuffer[1] === 0xd8,
    `${frame.headers['content-type']} ${frameBuffer.length}B`)

  const embedded = await call('GET', `/dsh-subtitle-remover/api/frame?path=${encodeURIComponent(CLIP)}&t=1`, {
    raw: true,
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  check('cross-site frame embed denied', embedded.status === 403, String(embedded.status))
  const sameSite = await call('GET', `/dsh-subtitle-remover/api/frame?path=${encodeURIComponent(CLIP)}&t=1`, {
    raw: true,
    headers: { 'sec-fetch-site': 'same-origin' },
  })
  check('same-origin frame embed allowed', sameSite.status === 200, String(sameSite.status))

  // Automatic region detection --------------------------------------------
  const detectStarted = await call('POST', '/dsh-subtitle-remover/api/detect', { body: { videoPath: CLIP, samples: 10 } })
  check('detect started', detectStarted.status === 200 && Boolean(detectStarted.body.task), `${detectStarted.status} ${detectStarted.body.task && detectStarted.body.task.id}`)
  let detectTask = detectStarted.body.task
  const detectDeadline = Date.now() + 240000
  while (detectTask && detectTask.status === 'running' && Date.now() < detectDeadline) {
    await sleep(1500)
    const polled = await call('GET', `/dsh-subtitle-remover/api/detect/${encodeURIComponent(detectTask.id)}`)
    detectTask = polled.body.task
  }
  check('detect finished', Boolean(detectTask && detectTask.status === 'done'), detectTask ? `${detectTask.status} ${detectTask.message || ''}` : 'timeout')
  const detected = (detectTask && detectTask.regions) || []
  console.log(`      detected regions: ${JSON.stringify(detected)}`)
  check('detect returns regions array', Array.isArray(detected))
  check('detected regions are percentages', detected.every((region) => (
    ['yMin', 'yMax', 'xMin', 'xMax'].every((key) => Number.isFinite(Number(region[key])) && Number(region[key]) >= 0 && Number(region[key]) <= 100)
  )), `${detected.length} regions`)

  // Model catalogue + model-assisted decision ------------------------------
  const models = await call('GET', '/dsh-subtitle-remover/api/models')
  check('models 200', models.status === 200)
  check('models lists provider model', Boolean(models.body.models && models.body.models.some((entry) => entry.provider === 'fake-provider' && entry.model === 'fake-model')), JSON.stringify(models.body.models))
  check('models default follows DSH selection', Boolean(models.body.selected && models.body.selected.model === 'fake-model'), JSON.stringify(models.body.selected))

  const decideStarted = await call('POST', '/dsh-subtitle-remover/api/detect', {
    body: { videoPath: CLIP, samples: 6, decide: { provider: 'fake-provider', model: 'fake-model' } },
  })
  check('decide detect started', decideStarted.status === 200 && Boolean(decideStarted.body.task), String(decideStarted.status))
  let decided = decideStarted.body.task
  const decideDeadline = Date.now() + 240000
  while (decided && (decided.status === 'running' || decided.status === 'deciding') && Date.now() < decideDeadline) {
    await sleep(1200)
    const polled = await call('GET', `/dsh-subtitle-remover/api/detect/${encodeURIComponent(decided.id)}`)
    decided = polled.body.task
  }
  check('decide detect finished', Boolean(decided && decided.status === 'done'), decided && decided.status)
  check('model decision recorded', Boolean(decided && decided.decision && decided.decision.ok === true), JSON.stringify(decided && decided.decision))
  check('model mode applied', Boolean(decided && decided.mode === 'lama'), decided && decided.mode)
  check('model pick applied', Boolean(decided && decided.regions && decided.regions.length === 1), JSON.stringify(decided && decided.regions))

  // Validation -------------------------------------------------------------
  const bad = await call('POST', '/dsh-subtitle-remover/api/jobs', { body: { videoPath: path.join(WORK_DIR, 'missing.mp4'), areas: [{ yMin: 80, yMax: 95, xMin: 5, xMax: 95 }] } })
  check('missing file rejected', bad.status === 400 && /找不到/.test(bad.body.error), `${bad.status} ${bad.body.error}`)
  const noArea = await call('POST', '/dsh-subtitle-remover/api/jobs', { body: { videoPath: CLIP } })
  check('missing areas rejected', noArea.status === 400 && /框选/.test(noArea.body.error), `${noArea.status} ${noArea.body.error}`)
  const tooMany = await call('POST', '/dsh-subtitle-remover/api/jobs', {
    body: { videoPath: CLIP, areas: Array.from({ length: 7 }, () => ({ yMin: 80, yMax: 95, xMin: 5, xMax: 95 })) },
  })
  check('too many areas rejected', tooMany.status === 400, `${tooMany.status} ${tooMany.body.error}`)
  const badRange = await call('POST', '/dsh-subtitle-remover/api/jobs', {
    body: { videoPath: CLIP, areas: [{ yMin: 80, yMax: 95, xMin: 5, xMax: 95 }], range: { start: 1.6, end: 0.4 } },
  })
  check('inverted range rejected', badRange.status === 400 && /结束时间/.test(badRange.body.error), `${badRange.status} ${badRange.body.error}`)

  // Create a job with two regions -----------------------------------------
  const areas = [
    { yMin: 78, yMax: 92, xMin: 5, xMax: 95 },
    { yMin: 92, yMax: 100, xMin: 5, xMax: 95 },
  ]
  const placeholder = path.join(WORK_DIR, 'clip_no_sub.mp4')
  fs.writeFileSync(placeholder, 'placeholder')
  const created = await call('POST', '/dsh-subtitle-remover/api/jobs', {
    body: {
      videoPath: CLIP,
      mode: 'sttn-auto',
      areas,
      saveDir: WORK_DIR,
      range: { start: 0.2, end: 1.6 },
      collision: 'rename',
    },
  })
  check('job created', created.status === 200 && Boolean(created.body.job) && created.body.job.status === 'running', `${created.status} ${created.body.job && created.body.job.id}`)
  const jobId = created.body.job && created.body.job.id
  check('job keeps both regions', Boolean(created.body.job) && created.body.job.areaCount === 2, JSON.stringify(created.body.job && created.body.job.areas))
  check('output inside requested folder', Boolean(created.body.job) && created.body.job.outputPath.startsWith(WORK_DIR), created.body.job && created.body.job.outputPath)
  check('job keeps the range', Boolean(created.body.job && created.body.job.range && created.body.job.range.start === 0.2 && created.body.job.range.end === 1.6), JSON.stringify(created.body.job && created.body.job.range))
  check('rename collision keeps the old file and picks a new name', Boolean(created.body.job) && created.body.job.collision === 'rename' && /clip_no_sub \(2\)\.mp4$/.test(created.body.job.outputPath),
    created.body.job && created.body.job.outputPath)

  const openEarly = await call('POST', `/dsh-subtitle-remover/api/jobs/${jobId}/open`, { body: { target: 'file' } })
  check('open before output rejected', openEarly.status === 409, `${openEarly.status} ${openEarly.body.error}`)

  const busy = await call('POST', '/dsh-subtitle-remover/api/jobs', { body: { videoPath: CLIP, areas } })
  check('second job rejected while running', busy.status === 409, `${busy.status} ${busy.body.error}`)

  // Poll progress ----------------------------------------------------------
  let final = null
  const seenPercents = new Set()
  const deadline = Date.now() + 300000
  while (Date.now() < deadline) {
    await sleep(2000)
    const detail = await call('GET', `/dsh-subtitle-remover/api/jobs/${jobId}`)
    if (detail.status !== 200) throw new Error(`detail ${detail.status}`)
    const job = detail.body.job
    seenPercents.add(job.percent)
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') { final = job; break }
  }

  check('job finished', Boolean(final && final.status === 'done'), final ? `${final.status} ${final.message || ''}` : 'timeout')
  check('progress advanced', seenPercents.size > 1, `percents: ${[...seenPercents].slice(0, 12).join(',')}`)
  check('percent 100', Boolean(final && final.percent === 100), final && String(final.percent))
  check('output file exists', Boolean(final && fs.existsSync(final.outputPath)), final && final.outputPath)
  check('log lists both regions', Boolean(final && final.log && final.log.some((line) => /2 个区域/.test(line))), final && `${final.logLines} lines`)
  check('log lists the range', Boolean(final && final.log && final.log.some((line) => /处理区间/.test(line))))
  check('log mentions the rename', Boolean(final && final.log && final.log.some((line) => /自动改名/.test(line))))
  check('log captured engine output', Boolean(final && final.log && final.log.some((line) => /Subtitle Removing/.test(line))))
  check('stage done', Boolean(final && final.stage === 'done'), final && final.stage)
  check('preview frames recorded', Boolean(final && final.previewSeq > 0), final && `seq ${final.previewSeq} @ ${final.previewPercent}%`)

  const leftFrame = await call('GET', `/dsh-subtitle-remover/api/jobs/${jobId}/preview/left?seq=${final.previewSeq}`, { raw: true })
  const rightFrame = await call('GET', `/dsh-subtitle-remover/api/jobs/${jobId}/preview/right?seq=${final.previewSeq}`, { raw: true })
  const leftBuffer = Buffer.isBuffer(leftFrame.body) ? leftFrame.body : Buffer.from(leftFrame.body || [])
  const rightBuffer = Buffer.isBuffer(rightFrame.body) ? rightFrame.body : Buffer.from(rightFrame.body || [])
  check('preview left is jpeg', leftFrame.status === 200 && /image\/jpeg/.test(String(leftFrame.headers['content-type'])) && leftBuffer[0] === 0xff && leftBuffer[1] === 0xd8,
    `${leftFrame.status} ${leftBuffer.length}B`)
  check('preview right is jpeg', rightFrame.status === 200 && rightBuffer[0] === 0xff && rightBuffer[1] === 0xd8, `${rightFrame.status} ${rightBuffer.length}B`)
  check('preview shows a difference', leftBuffer.length > 0 && Buffer.compare(leftBuffer, rightBuffer) !== 0, `${leftBuffer.length}B vs ${rightBuffer.length}B`)

  // Default collision mode is overwrite ------------------------------------
  const defaulted = await call('POST', '/dsh-subtitle-remover/api/jobs', { body: { videoPath: CLIP, areas } })
  check('collision defaults to overwrite', defaulted.status === 200 && defaulted.body.job.collision === 'overwrite', defaulted.body.job && defaulted.body.job.collision)
  if (defaulted.status === 200) {
    await call('POST', `/dsh-subtitle-remover/api/jobs/${defaulted.body.job.id}/cancel`, { body: {} })
    await call('POST', `/dsh-subtitle-remover/api/jobs/${defaulted.body.job.id}/remove`, { body: {} })
  }

  // Remove ----------------------------------------------------------------
  const removed = await call('POST', `/dsh-subtitle-remover/api/jobs/${jobId}/remove`, { body: {} })
  check('job removed', removed.status === 200 && removed.body.jobs.every((job) => job.id !== jobId))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('failed:', failed.map((r) => r.name).join(' | '))
    process.exitCode = 1
  }
  for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exitCode = 1
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})
