/**
 * dsh-subtitle-remover — Host half.
 *
 * Owns the actual work: it spawns the runners in `runner/` against a local
 * video-subtitle-remover checkout, turns their JSON progress lines into job
 * records, extracts preview frames, and exposes a small same-origin HTTP surface
 * under `/dsh-subtitle-remover/api` that the Client page calls.
 *
 * Why an HTTP route instead of a package-private call: the page is a static
 * `dsh.client` bundle, and the Host side of such a bundle has no RPC entry
 * point of its own. The Host's webServer is the documented carrier, needs no
 * second port, and keeps the page on the GUI's own origin.
 *
 * Two runners:
 *  - `vsr_runner.py` removes subtitles (`/jobs`);
 *  - `vsr_detect.py` proposes subtitle bands from sampled frames (`/detect`),
 *    which is what makes the automatic path possible.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER_DIR = path.join(HERE, 'runner')
const API = '/dsh-subtitle-remover/api'
const CHANNEL = '@@VSR@@'
const MAX_LOG = 400
const MAX_AREAS = 6
const FRAME_CACHE_LIMIT = 12

const MODES = ['sttn-auto', 'sttn-det', 'lama', 'propainter', 'opencv']
const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.mov', '.avi', '.flv', '.webm', '.ts',
  '.mpg', '.mpeg', '.wmv', '.rmvb', '.3gp', '.png', '.jpg', '.jpeg', '.bmp', '.webp',
])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp'])

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
function fail(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  return {
    vsrRoot: str(c.vsrRoot),
    pythonPath: str(c.pythonPath),
    ffprobePath: str(c.ffprobePath),
    ffmpegPath: str(c.ffmpegPath),
    defaultDir: str(c.defaultDir),
    defaultMode: MODES.includes(c.defaultMode) ? c.defaultMode : 'sttn-auto',
    defaultDetect: c.defaultDetect === 'mobile' ? 'mobile' : 'server',
  }
}

/**
 * Resolve the engine, its interpreter, ffmpeg and ffprobe on every call: the page
 * can show a live verdict, and installing the engine while the GUI is open does
 * not require a restart.
 */
function resolveEnv(cfg) {
  const rootCandidates = []
  if (cfg.vsrRoot) rootCandidates.push(cfg.vsrRoot)
  if (process.env.DSH_SUBTITLE_REMOVER_ROOT) rootCandidates.push(process.env.DSH_SUBTITLE_REMOVER_ROOT)
  // <workspace>/plugins/dsh-subtitle-remover -> <workspace>/vsr
  rootCandidates.push(path.resolve(HERE, '..', '..', 'vsr'))
  rootCandidates.push(path.join(process.cwd(), 'vsr'))

  let vsrRoot = ''
  for (const candidate of rootCandidates) {
    if (candidate && isFile(path.join(candidate, 'backend', 'main.py'))) {
      vsrRoot = path.resolve(candidate)
      break
    }
  }

  const pythonCandidates = []
  if (cfg.pythonPath) pythonCandidates.push(cfg.pythonPath)
  if (vsrRoot) {
    pythonCandidates.push(path.join(vsrRoot, '..', 'vsr-env', 'Scripts', 'python.exe'))
    pythonCandidates.push(path.join(vsrRoot, '..', 'vsr-env', 'bin', 'python'))
  }
  pythonCandidates.push(path.resolve(HERE, '..', '..', 'vsr-env', 'Scripts', 'python.exe'))
  pythonCandidates.push('python')

  let pythonPath = 'python'
  for (const candidate of pythonCandidates) {
    if (candidate === 'python') { pythonPath = 'python'; break }
    if (isFile(candidate)) { pythonPath = candidate; break }
  }

  const resolveBinary = (explicit, bundledName, fallback) => {
    const candidates = []
    if (explicit) candidates.push(explicit)
    if (vsrRoot) candidates.push(path.join(vsrRoot, 'backend', 'ffmpeg', 'win_x64', bundledName))
    candidates.push(fallback)
    for (const candidate of candidates) {
      if (candidate === fallback) return { path: fallback, found: false }
      if (isFile(candidate)) return { path: candidate, found: true }
    }
    return { path: fallback, found: false }
  }

  const ffmpeg = resolveBinary(cfg.ffmpegPath, 'ffmpeg.exe', 'ffmpeg')
  const ffprobe = resolveBinary(cfg.ffprobePath, 'ffprobe.exe', 'ffprobe')

  const runnerReady = isFile(path.join(RUNNER_DIR, 'vsr_runner.py')) && isFile(path.join(RUNNER_DIR, 'vsr_detect.py'))
  const engineReady = Boolean(vsrRoot)
  const problems = []
  if (!engineReady) problems.push('找不到 video-subtitle-remover 目录（需要其中的 backend/main.py）')
  if (!runnerReady) problems.push('插件缺少 runner/vsr_runner.py 或 runner/vsr_detect.py')
  if (!engineReady) problems.push('可以设置 config.vsrRoot 指向引擎目录')

  return {
    vsrRoot,
    pythonPath,
    pythonFound: pythonPath === 'python' ? null : isFile(pythonPath),
    ffmpegPath: ffmpeg.path,
    ffmpegFound: ffmpeg.found,
    ffprobePath: ffprobe.path,
    ffprobeFound: ffprobe.found,
    runnerPath: RUNNER_DIR,
    runnerReady,
    engineReady,
    ready: engineReady && runnerReady && pythonPath !== '',
    problems,
  }
}

function listDrives() {
  if (process.platform !== 'win32') return []
  const drives = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    if (isDir(root)) drives.push(root)
  }
  return drives
}

// ---------------------------------------------------------------------------
// Runner process plumbing
// ---------------------------------------------------------------------------

/**
 * Spawn one runner and route its lines: `@@VSR@@ {...}` becomes an event, every
 * other line becomes log text. Returns the child (or null after reporting).
 */
function launch(cfg, options) {
  const { script, args, onEvent, onLog, onError, onClose } = options
  const env = resolveEnv(cfg)
  if (!env.engineReady) {
    onError(fail(`引擎环境未就绪：${env.problems.join('；')}`, 400))
    return null
  }
  let child = null
  try {
    child = spawn(env.pythonPath, [path.join(RUNNER_DIR, script), ...args], {
      cwd: env.vsrRoot,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    onError(error)
    return null
  }

  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      if (line.startsWith(CHANNEL)) {
        let event = null
        try { event = JSON.parse(line.slice(CHANNEL.length).trim()) } catch { event = null }
        if (event) onEvent(event)
        else onLog(line.slice(CHANNEL.length).trim())
      } else {
        onLog(line)
      }
      index = buffer.indexOf('\n')
    }
    if (buffer.length > 16384) {
      onLog(buffer)
      buffer = ''
    }
  })
  child.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) onLog(line)
  })
  child.on('error', (error) => {
    child.errorReported = true
    onError(error)
  })
  child.on('close', (code) => {
    if (!child.errorReported) onClose(code)
  })
  return child
}

function killTree(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* already gone */ }
  } else {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Preview frames
// ---------------------------------------------------------------------------

const frameCache = new Map()

function rememberFrame(key, value) {
  frameCache.set(key, value)
  while (frameCache.size > FRAME_CACHE_LIMIT) {
    const oldest = frameCache.keys().next().value
    frameCache.delete(oldest)
  }
}

async function readFrame(cfg, rawPath, rawTime) {
  const env = resolveEnv(cfg)
  const file = path.resolve(String(rawPath || '').trim())
  if (!file || !isFile(file)) throw fail('找不到这个视频文件', 400)

  const ext = path.extname(file).toLowerCase()
  if (IMAGE_EXT.has(ext)) {
    return {
      buffer: await fsp.readFile(file),
      contentType: ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg'),
    }
  }

  const seconds = clamp(num(rawTime, 0), 0, 24 * 3600)
  let stat = null
  try { stat = fs.statSync(file) } catch { throw fail('无法读取文件信息', 400) }
  const key = `${file}|${stat.mtimeMs}|${stat.size}|${Math.round(seconds * 2)}`
  const cached = frameCache.get(key)
  if (cached) return cached

  let lastError = ''
  const buffer = await new Promise((resolve, reject) => {
    let child = null
    try {
      child = spawn(env.ffmpegPath, [
        '-v', 'error',
        '-ss', String(seconds),
        '-i', file,
        '-frames:v', '1',
        '-vf', 'scale=min(1280\\,iw):-2',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '4',
        'pipe:1',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(fail(`无法启动 ffmpeg：${error && error.message ? error.message : error}`, 500))
      return
    }
    const chunks = []
    let size = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish(fail('截取画面超时', 504))
    }, 20000)
    if (timer.unref) timer.unref()
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 16 * 1024 * 1024) {
        killTree(child)
        finish(fail('画面太大', 500))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => { lastError = (lastError + String(chunk)).slice(-400) })
    child.on('error', (error) => finish(fail(`ffmpeg 不可用：${error && error.message ? error.message : error}`, 500)))
    child.on('close', (code) => {
      if (code !== 0 || !chunks.length) {
        finish(fail(`截取画面失败${lastError ? `：${lastError.trim()}` : `（ffmpeg 退出码 ${code}）`}`, 500))
        return
      }
      finish(null, Buffer.concat(chunks))
    })
  })

  const value = { buffer, contentType: 'image/jpeg' }
  rememberFrame(key, value)
  return value
}

// ---------------------------------------------------------------------------
// Video inspection
// ---------------------------------------------------------------------------

function parseRate(value) {
  if (!value || typeof value !== 'string') return 0
  const [numText, denText] = value.split('/')
  const a = Number(numText)
  const b = Number(denText)
  if (!Number.isFinite(a)) return 0
  if (!Number.isFinite(b) || b === 0) return a
  return a / b
}

function probeVideo(cfg, rawPath) {
  const env = resolveEnv(cfg)
  const file = String(rawPath || '').trim()
  if (!file) return Promise.resolve({ ok: false, message: '没有给出视频路径' })
  const resolved = path.resolve(file)
  if (!isFile(resolved)) return Promise.resolve({ ok: false, message: '文件不存在' })

  return new Promise((resolve) => {
    let child = null
    try {
      child = spawn(env.ffprobePath, [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', resolved,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, message: `无法启动 ffprobe：${error && error.message ? error.message : error}` })
      return
    }
    let out = ''
    let err = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish({ ok: false, message: 'ffprobe 超时' })
    }, 15000)
    if (timer.unref) timer.unref()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, message: `ffprobe 不可用：${error && error.message ? error.message : error}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        finish({ ok: false, message: (err || '').trim().split(/\r?\n/).slice(-2).join(' ') || `ffprobe 退出码 ${code}` })
        return
      }
      try {
        const info = JSON.parse(out)
        const video = (info.streams || []).find((s) => s.codec_type === 'video') || {}
        const fps = parseRate(video.avg_frame_rate || video.r_frame_rate)
        const duration = num(info.format && info.format.duration) || num(video.duration)
        const frames = num(video.nb_frames) || (fps && duration ? Math.round(fps * duration) : 0)
        finish({
          ok: true,
          name: path.basename(resolved),
          width: num(video.width),
          height: num(video.height),
          fps,
          duration,
          frames,
          codec: String(video.codec_name || ''),
          size: num(info.format && info.format.size),
        })
      } catch {
        finish({ ok: false, message: '无法解析 ffprobe 输出' })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Area normalisation
// ---------------------------------------------------------------------------

function normalizeArea(raw, label) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const area = {
    yMin: num(source.yMin, Number.NaN),
    yMax: num(source.yMax, Number.NaN),
    xMin: num(source.xMin, Number.NaN),
    xMax: num(source.xMax, Number.NaN),
  }
  for (const key of Object.keys(area)) {
    if (!Number.isFinite(area[key])) throw fail(`字幕区域${label ? ` ${label}` : ''}缺少或不是数字：${key}`, 400)
    if (area[key] < 0 || area[key] > 100) throw fail(`字幕区域${label ? ` ${label}` : ''}的 ${key} 必须在 0 到 100 之间`, 400)
  }
  if (area.yMax - area.yMin < 0.3) throw fail(`字幕区域${label ? ` ${label}` : ''}的上边界必须小于下边界`, 400)
  if (area.xMax - area.xMin < 0.3) throw fail(`字幕区域${label ? ` ${label}` : ''}的左边界必须小于右边界`, 400)
  return {
    yMin: Math.round(area.yMin * 10) / 10,
    yMax: Math.round(area.yMax * 10) / 10,
    xMin: Math.round(area.xMin * 10) / 10,
    xMax: Math.round(area.xMax * 10) / 10,
  }
}

function normalizeAreas(raw) {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : [])
  if (!list.length) throw fail('请先框选至少一个字幕区域，或先点「自动识别」', 400)
  if (list.length > MAX_AREAS) throw fail(`最多支持 ${MAX_AREAS} 个区域`, 400)
  return list.map((area, index) => normalizeArea(area, `#${index + 1}`))
}

function normalizeRange(raw) {
  if (!raw || typeof raw !== 'object') return null
  const start = num(raw.start, Number.NaN)
  const end = num(raw.end, Number.NaN)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0) throw fail('处理区间的开始时间不能是负数', 400)
  if (end <= start) throw fail('处理区间的结束时间必须晚于开始时间', 400)
  if (end - start < 0.2) throw fail('处理区间太短，至少 0.2 秒', 400)
  return { start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 }
}

function removeDirQuietly(dir) {
  if (!dir) return
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

/** Preview folders are per job under the temp dir; drop yesterday's leftovers. */
function sweepStalePreviews() {
  const day = 24 * 3600 * 1000
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('dsh-vsr-preview-')) continue
      const full = path.join(os.tmpdir(), name)
      try {
        const stat = fs.statSync(full)
        if (stat.isDirectory() && Date.now() - stat.mtimeMs > day) fs.rmSync(full, { recursive: true, force: true })
      } catch { /* a concurrent job may be using it */ }
    }
  } catch { /* temp dir unreadable: previews are optional */ }
}

function openPath(file, target) {
  const opener = process.platform === 'win32'
    ? { command: 'explorer.exe', args: target === 'folder' ? [`/select,${file}`] : [file] }
    : process.platform === 'darwin'
      ? { command: 'open', args: target === 'folder' ? ['-R', file] : [file] }
      : { command: 'xdg-open', args: [target === 'folder' ? path.dirname(file) : file] }
  const child = spawn(opener.command, opener.args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => { /* the OS refused; the page still shows the path */ })
  child.unref()
}

// ---------------------------------------------------------------------------
// Subtitle removal jobs
// ---------------------------------------------------------------------------

function publicJob(job, withLog) {
  const value = {
    id: job.id,
    videoPath: job.videoPath,
    videoName: path.basename(job.videoPath),
    outputPath: job.outputPath,
    outputName: path.basename(job.outputPath),
    mode: job.mode,
    detectMode: job.detectMode,
    areas: job.areas,
    areaCount: job.areas.length,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    total: job.total,
    width: job.width,
    height: job.height,
    fps: job.fps,
    range: job.range,
    collision: job.collision,
    previewSeq: job.previewSeq || 0,
    previewPercent: job.previewPercent || 0,
    message: job.message,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    logLines: job.log.length,
    outputExists: job.status === 'done' ? isFile(job.outputPath) : false,
  }
  if (withLog) value.log = job.log.slice(-MAX_LOG)
  return value
}

function createJobStore(cfg) {
  const jobs = new Map()
  let activeId = null
  let seq = 0

  function pushLog(job, line) {
    const text = String(line == null ? '' : line).replace(/\s+$/, '')
    if (!text) return
    job.log.push(text)
    if (job.log.length > MAX_LOG * 2) job.log.splice(0, job.log.length - MAX_LOG)
  }

  function settle(job, status, message) {
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return
    let finalStatus = status
    let finalMessage = message || ''
    if (finalStatus === 'done') {
      job.percent = 100
      if (!isFile(job.outputPath)) {
        finalStatus = 'failed'
        finalMessage = '进程已结束，但没有找到输出文件（详见日志）'
      }
    }
    job.status = finalStatus
    job.stage = finalStatus
    job.message = finalMessage
    job.finishedAt = Date.now()
    if (activeId === job.id) activeId = null
    if (finalMessage) pushLog(job, finalMessage)
  }

  function applyEvent(job, event) {
    const type = String(event && event.type || '')
    if (type === 'stage') {
      job.stage = String(event.stage || job.stage)
      if (event.message) {
        job.message = String(event.message)
        pushLog(job, job.message)
      }
      return
    }
    if (type === 'video') {
      job.width = num(event.width)
      job.height = num(event.height)
      job.total = num(event.frames || event.total)
      job.fps = num(event.fps)
      return
    }
    if (type === 'progress') {
      job.percent = clamp(Math.round(num(event.percent)), 0, 100)
      const total = num(event.total)
      if (total) job.total = total
      if (job.total) {
        const frames = Math.round((job.total * job.percent) / 100)
        if (frames > job.frames) job.frames = frames
      }
      return
    }
    if (type === 'note') {
      if (event.message) pushLog(job, event.message)
      return
    }
    if (type === 'preview') {
      job.previewSeq = num(event.seq)
      job.previewPercent = clamp(Math.round(num(event.percent)), 0, 100)
      return
    }
    if (type === 'done') {
      if (event.outputPath) job.outputPath = String(event.outputPath)
      if (num(event.frames)) job.total = num(event.frames)
      settle(job, 'done', '')
      return
    }
    if (type === 'failed') {
      if (event.message) pushLog(job, `错误：${event.message}`)
      if (event.detail) {
        for (const line of String(event.detail).split(/\r?\n/).slice(-40)) pushLog(job, line)
      }
      settle(job, 'failed', String(event.message || '处理失败'))
    }
  }

  function startProcess(job) {
    const areaArgs = []
    for (const area of job.areas) {
      areaArgs.push('--area', [area.yMin, area.yMax, area.xMin, area.xMax].join(','))
    }
    const rangeArgs = job.range ? ['--start', String(job.range.start), '--end', String(job.range.end)] : []
    const child = launch(cfg, {
      script: 'vsr_runner.py',
      args: [
        '--vsr-root', resolveEnv(cfg).vsrRoot,
        '--video', job.videoPath,
        '--output', job.outputPath,
        '--mode', job.mode,
        '--detect', job.detectMode,
        '--preview-dir', job.previewDir,
        ...rangeArgs,
        ...areaArgs,
      ],
      onEvent: (event) => applyEvent(job, event),
      onLog: (line) => pushLog(job, line),
      onError: (error) => {
        job.child = null
        settle(job, 'failed', error && error.message ? error.message : String(error))
      },
      onClose: (code) => {
        job.child = null
        if (job.status === 'running') {
          settle(job, code === 0 ? 'done' : 'failed', code === 0 ? '' : `进程退出码 ${code}（详见日志）`)
        }
      },
    })
    if (!child) return
    job.child = child
    job.pid = child.pid
    job.status = 'running'
    job.stage = 'starting'
    job.startedAt = Date.now()
    job.percent = 0
    activeId = job.id
  }

  function defaultOutputPath(videoPath, saveDir) {
    const ext = path.extname(videoPath) || '.mp4'
    const dir = saveDir && String(saveDir).trim() ? path.resolve(String(saveDir).trim()) : path.dirname(videoPath)
    const stem = path.basename(videoPath, path.extname(videoPath))
    return path.join(dir, `${stem}_no_sub${ext}`)
  }

  /** "name (2).mp4", "name (3).mp4", … for the auto-rename collision mode. */
  function uniqueOutputPath(basePath) {
    const dir = path.dirname(basePath)
    const ext = path.extname(basePath)
    const stem = path.basename(basePath, ext)
    for (let index = 2; index < 1000; index += 1) {
      const candidate = path.join(dir, `${stem} (${index})${ext}`)
      if (!fs.existsSync(candidate)) return candidate
    }
    return path.join(dir, `${stem} (${Date.now().toString(36)})${ext}`)
  }

  function create(input) {
    const body = input && typeof input === 'object' ? input : {}
    const env = resolveEnv(cfg)
    if (!env.ready) throw fail(`引擎环境未就绪：${env.problems.join('；')}`, 400)
    if (activeId) {
      const current = jobs.get(activeId)
      if (current && (current.status === 'running' || current.status === 'queued')) {
        throw fail('已有任务正在运行，完成或取消后再开始新的任务', 409)
      }
    }

    const rawPath = String(body.videoPath || '').trim()
    if (!rawPath) throw fail('请先选择视频文件', 400)
    const videoPath = path.resolve(rawPath)
    if (!isFile(videoPath)) throw fail(`找不到视频文件：${videoPath}`, 400)
    const ext = path.extname(videoPath).toLowerCase()
    if (!VIDEO_EXT.has(ext)) throw fail(`不支持的文件类型：${ext || '(无扩展名)'}`, 400)

    const mode = MODES.includes(body.mode) ? body.mode : cfg.defaultMode
    const detectMode = body.detectMode === 'mobile' ? 'mobile' : (body.detectMode === 'server' ? 'server' : cfg.defaultDetect)
    const areas = normalizeAreas(body.areas !== undefined ? body.areas : body.area)
    const range = normalizeRange(body.range)
    const collision = body.collision === 'rename' ? 'rename' : 'overwrite'

    const explicitOutput = String(body.outputPath || '').trim()
    let outputPath = explicitOutput ? path.resolve(explicitOutput) : defaultOutputPath(videoPath, body.saveDir)
    if (!path.extname(outputPath)) outputPath += ext
    const outputDir = path.dirname(outputPath)
    if (!isDir(outputDir)) {
      try {
        fs.mkdirSync(outputDir, { recursive: true })
      } catch {
        throw fail(`无法创建输出目录：${outputDir}`, 400)
      }
    }
    if (path.resolve(outputPath) === videoPath) throw fail('输出路径不能和源文件相同', 400)
    let renamedFrom = ''
    if (collision === 'rename' && fs.existsSync(outputPath)) {
      renamedFrom = outputPath
      outputPath = uniqueOutputPath(outputPath)
    }

    seq += 1
    const id = `${Date.now().toString(36)}${seq.toString(36)}`
    const previewDir = path.join(os.tmpdir(), `dsh-vsr-preview-${id}`)
    try {
      fs.mkdirSync(previewDir, { recursive: true })
    } catch { /* previews are optional */ }
    const job = {
      id,
      videoPath,
      outputPath,
      mode,
      detectMode,
      areas,
      range,
      collision,
      previewDir,
      previewSeq: 0,
      previewPercent: 0,
      status: 'queued',
      stage: 'queued',
      percent: 0,
      frames: 0,
      total: 0,
      width: 0,
      height: 0,
      fps: 0,
      message: '',
      log: [],
      child: null,
      pid: 0,
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      cancelRequested: false,
    }
    jobs.set(job.id, job)
    pushLog(job, `任务 ${job.id}：${path.basename(videoPath)} → ${outputPath}`)
    if (renamedFrom) pushLog(job, `同名文件已存在，自动改名：${path.basename(renamedFrom)} → ${path.basename(outputPath)}`)
    pushLog(job, `算法 ${mode}，${areas.length} 个区域：` + areas.map((a, i) => `#${i + 1} y ${a.yMin}–${a.yMax}% / x ${a.xMin}–${a.xMax}%`).join('；'))
    if (range) pushLog(job, `处理区间：${range.start}s – ${range.end}s（区间外原样保留）`)
    startProcess(job)
    return job
  }

  function cancel(id) {
    const job = jobs.get(String(id || ''))
    if (!job) throw fail('任务不存在', 404)
    if (job.status !== 'running' && job.status !== 'queued') return job
    job.cancelRequested = true
    job.status = 'cancelled'
    job.stage = 'cancelled'
    job.message = '已取消'
    job.finishedAt = Date.now()
    if (activeId === job.id) activeId = null
    pushLog(job, '用户取消任务')
    const child = job.child
    job.child = null
    killTree(child)
    // A cancelled run leaves a partial file behind; drop it only when this run
    // is demonstrably the one that created it.
    const output = job.outputPath
    const startedAt = job.startedAt
    const timer = setTimeout(() => {
      try {
        if (!isFile(output)) return
        if (fs.statSync(output).mtimeMs >= startedAt) fs.unlinkSync(output)
      } catch { /* best effort */ }
    }, 1500)
    if (timer.unref) timer.unref()
    return job
  }

  function remove(id) {
    const key = String(id || '')
    const job = jobs.get(key)
    if (!job) throw fail('任务不存在', 404)
    if (job.status === 'running' || job.status === 'queued') cancel(key)
    jobs.delete(key)
    removeDirQuietly(job.previewDir)
    return true
  }

  function list() {
    return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((job) => publicJob(job, false))
  }

  function detail(id) {
    const job = jobs.get(String(id || ''))
    if (!job) throw fail('任务不存在', 404)
    return publicJob(job, true)
  }

  function raw(id) {
    return jobs.get(String(id || '')) || null
  }

  /** Absolute path of one preview image, or null when it has not been written yet. */
  function previewTarget(id, side) {
    const job = jobs.get(String(id || ''))
    if (!job || !job.previewDir) return null
    if (side !== 'left' && side !== 'right') return null
    const file = path.join(job.previewDir, `${side}.jpg`)
    return isFile(file) ? file : null
  }

  function dispose() {
    for (const job of jobs.values()) {
      killTree(job.child)
      removeDirQuietly(job.previewDir)
    }
    jobs.clear()
    activeId = null
  }

  return { list, detail, raw, previewTarget, create, cancel, remove, dispose, active: () => activeId }
}

// ---------------------------------------------------------------------------
// Model-assisted choice of regions and model
// ---------------------------------------------------------------------------

const MODEL_CACHE_MS = 60000
let catalogueCache = { at: 0, value: null }

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

async function modelCatalogue(llm, defaults) {
  if (!llm) return { selected: null, models: [], reason: '宿主没有提供 llm 服务' }
  if (catalogueCache.value && Date.now() - catalogueCache.at < MODEL_CACHE_MS) return catalogueCache.value

  let providers = []
  try { providers = llm.listProviders() || [] } catch { providers = [] }

  const models = []
  for (const provider of providers) {
    const providerId = firstString(provider && provider.id, provider && provider.provider, provider && provider.name, provider && provider.route)
    if (!providerId) continue
    const providerLabel = firstString(provider && provider.displayName, provider && provider.name, providerId)
    let list = []
    try { list = await llm.listModels(providerId) } catch { list = [] }
    for (const entry of list || []) {
      const modelId = firstString(entry && entry.id, entry && entry.model, entry && entry.name)
      if (!modelId) continue
      models.push({
        provider: providerId,
        model: modelId,
        label: `${firstString(entry && entry.displayName, entry && entry.name, modelId)} · ${providerLabel}`,
        vision: Array.isArray(entry && entry.inputModalities) && entry.inputModalities.includes('image'),
      })
    }
  }

  let selected = null
  try {
    const current = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : null
    const provider = firstString(current && current.provider)
    const model = firstString(current && current.model, current && current.id)
    if (provider && model) selected = { provider, model }
  } catch { selected = null }

  const value = { selected, models }
  catalogueCache = { at: Date.now(), value }
  return value
}

async function modelComplete(llm, selection, prompt, timeoutMs = 60000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (timer.unref) timer.unref()
  let text = ''
  let failure = ''
  try {
    const chunks = llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: controller.signal,
    })
    for await (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'finish' && (chunk.kind === 'error' || chunk.kind === 'aborted')) {
        const detail = chunk.failure
        failure = typeof detail === 'string'
          ? detail
          : firstString(detail && detail.message, detail && detail.code, '模型调用失败')
      }
    }
  } finally {
    clearTimeout(timer)
  }
  if (failure) throw new Error(failure)
  if (!text.trim()) throw new Error('模型没有返回内容')
  return text
}

function buildDecisionPrompt(task) {
  const candidates = (task.candidates || []).slice(0, 8)
  const lines = candidates.map((candidate, index) => {
    const width = Math.round((candidate.xMax - candidate.xMin) * 10) / 10
    const hits = typeof candidate.score === 'number' ? candidate.score : 0
    return `${index + 1}. y ${candidate.yMin}–${candidate.yMax}%  x ${candidate.xMin}–${candidate.xMax}%（宽 ${width}%，命中 ${hits}%）`
  })
  return [
    '你是「视频硬字幕擦除」的决策助手。下面是 OCR 在采样帧上检出的候选文本带（坐标是画面百分比）和视频信息。',
    '',
    `视频：${task.width}×${task.height}，${task.fps || 0} fps。`,
    '候选：',
    ...lines,
    '',
    '请判断哪些候选是真正的硬字幕，忽略 HUD、状态栏、击杀提示、台标、水印、弹幕等画面文字；再选一个最合适的擦除算法：',
    '- sttn-auto：STTN 智能擦除，通用推荐',
    '- sttn-det：STTN + 文本检测，适合字幕时有时无',
    '- lama：静态背景或动画',
    '- propainter：运动剧烈，显存占用大',
    '- opencv：最快，效果最差',
    '',
    '只输出一行 JSON，不要解释、不要代码块：',
    '{"pick":[1],"mode":"sttn-auto","reason":"一句话中文理由"}',
    'pick 是候选编号（从 1 开始），可多选；没有合适候选就输出空数组。',
  ].join('\n')
}

function parseDecision(raw, candidateCount) {
  const text = String(raw || '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON')
  let parsed = null
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('模型输出的 JSON 解析失败')
  }
  const rawPick = Array.isArray(parsed.pick) ? parsed.pick : (parsed.pick === undefined ? [] : [parsed.pick])
  const picked = [...new Set(
    rawPick
      .map((value) => Math.round(Number(value)))
      .filter((value) => Number.isFinite(value) && value >= 1 && value <= candidateCount),
  )]
  return {
    picked,
    mode: MODES.includes(String(parsed.mode || '')) ? String(parsed.mode) : '',
    reason: String(parsed.reason || '').slice(0, 500),
  }
}

// ---------------------------------------------------------------------------
// Automatic subtitle region detection
// ---------------------------------------------------------------------------

function publicDetect(task) {
  if (!task) return null
  return {
    id: task.id,
    videoPath: task.videoPath,
    videoName: path.basename(task.videoPath),
    status: task.status,
    stage: task.stage,
    percent: task.percent,
    sampled: task.sampled,
    regions: task.regions,
    candidates: task.candidates,
    mode: task.mode,
    decision: task.decision,
    message: task.message,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    logLines: task.log.length,
    log: task.log.slice(-60),
  }
}

function createDetectStore(cfg, modelServices) {
  const tasks = new Map()
  let activeId = null
  let seq = 0

  function pushLog(task, line) {
    const text = String(line == null ? '' : line).replace(/\s+$/, '')
    if (!text) return
    task.log.push(text)
    if (task.log.length > 400) task.log.splice(0, task.log.length - 200)
  }

  function settle(task, status, message) {
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return
    task.status = status
    task.stage = status
    task.message = message || ''
    task.finishedAt = Date.now()
    if (status === 'done') task.percent = 100
    if (activeId === task.id) activeId = null
    if (message) pushLog(task, message)
  }

  /** Let the selected DSH model pick among the detected candidate bands. */
  async function decide(task, selection, llm) {
    task.status = 'deciding'
    task.stage = 'deciding'
    task.percent = 100
    task.message = `让 ${selection.model} 判断字幕区与算法…`
    try {
      const raw = await modelComplete(llm, selection, buildDecisionPrompt(task))
      const decision = parseDecision(raw, (task.candidates || []).length)
      const picked = decision.picked.map((index) => task.candidates[index - 1]).filter(Boolean)
      task.decision = {
        ok: true,
        model: `${selection.provider}/${selection.model}`,
        picked: decision.picked,
        mode: decision.mode,
        reason: decision.reason,
      }
      if (picked.length) task.regions = picked
      else task.regions = []
      if (decision.mode) task.mode = decision.mode
      pushLog(task, `模型 ${selection.model}：${decision.reason || '（没有给出理由）'}`)
      pushLog(task, picked.length
        ? '模型选择：' + picked.map((area) => `y ${area.yMin}–${area.yMax}% / x ${area.xMin}–${area.xMax}%`).join('；')
        : '模型没有挑出字幕带')
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      task.decision = { ok: false, model: `${selection.provider}/${selection.model}`, error: message }
      pushLog(task, `模型判断失败，保留启发式结果：${message}`)
    }
    settle(task, 'done', '')
  }

  function start(input) {
    const body = input && typeof input === 'object' ? input : {}
    const env = resolveEnv(cfg)
    if (!env.ready) throw fail(`引擎环境未就绪：${env.problems.join('；')}`, 400)
    if (activeId) {
      const current = tasks.get(activeId)
      if (current && (current.status === 'running' || current.status === 'deciding')) {
        throw fail('已有识别任务在执行，稍等它完成', 409)
      }
    }
    const rawPath = String(body.videoPath || '').trim()
    if (!rawPath) throw fail('请先选择视频文件', 400)
    const videoPath = path.resolve(rawPath)
    if (!isFile(videoPath)) throw fail(`找不到视频文件：${videoPath}`, 400)
    const ext = path.extname(videoPath).toLowerCase()
    if (!VIDEO_EXT.has(ext)) throw fail(`不支持的文件类型：${ext || '(无扩展名)'}`, 400)
    const samples = clamp(Math.round(num(body.samples, 14)), 4, 40)
    const maxRegions = clamp(Math.round(num(body.maxRegions, 4)), 1, MAX_AREAS)

    const services = typeof modelServices === 'function' ? modelServices() : { llm: null, defaults: null }
    let selection = null
    if (body.decide && typeof body.decide === 'object') {
      const provider = firstString(body.decide.provider)
      const model = firstString(body.decide.model)
      if (!provider || !model) throw fail('决策模型参数不完整（需要 provider 和 model）', 400)
      if (!services.llm) throw fail('宿主没有提供对话模型服务，无法让模型判断', 400)
      selection = { provider, model }
    }

    seq += 1
    const task = {
      id: `d${Date.now().toString(36)}${seq.toString(36)}`,
      videoPath,
      status: 'running',
      stage: 'starting',
      percent: 0,
      sampled: 0,
      regions: [],
      candidates: [],
      width: 0,
      height: 0,
      fps: 0,
      mode: '',
      decision: null,
      message: '',
      log: [],
      child: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: 0,
    }
    tasks.set(task.id, task)
    activeId = task.id
    pushLog(task, `识别 ${path.basename(videoPath)}：采样 ${samples} 帧`)
    if (selection) pushLog(task, `检测后交给模型 ${selection.provider}/${selection.model} 判断`)

    const child = launch(cfg, {
      script: 'vsr_detect.py',
      args: ['--vsr-root', env.vsrRoot, '--video', videoPath, '--samples', String(samples), '--max-regions', String(maxRegions)],
      onEvent: (event) => {
        const type = String(event && event.type || '')
        if (type === 'stage') {
          task.stage = String(event.stage || task.stage)
          if (event.message) {
            task.message = String(event.message)
            pushLog(task, task.message)
          }
          return
        }
        if (type === 'progress') {
          task.percent = clamp(Math.round(num(event.percent)), 0, 100)
          if (num(event.sampled)) task.sampled = num(event.sampled)
          if (event.message) pushLog(task, event.message)
          return
        }
        if (type === 'regions') {
          task.regions = Array.isArray(event.regions) ? event.regions : []
          task.candidates = Array.isArray(event.candidates) ? event.candidates : task.regions
          if (num(event.sampled)) task.sampled = num(event.sampled)
          if (num(event.width)) task.width = num(event.width)
          if (num(event.height)) task.height = num(event.height)
          if (num(event.fps)) task.fps = num(event.fps)
          return
        }
        if (type === 'note') {
          if (event.message) pushLog(task, event.message)
          return
        }
        if (type === 'done') {
          if (Array.isArray(event.regions)) task.regions = event.regions
          if (selection) {
            decide(task, selection, services.llm)
            return
          }
          settle(task, 'done', '')
          return
        }
        if (type === 'failed') {
          if (event.message) pushLog(task, `错误：${event.message}`)
          if (event.detail) {
            for (const line of String(event.detail).split(/\r?\n/).slice(-30)) pushLog(task, line)
          }
          settle(task, 'failed', String(event.message || '识别失败'))
        }
      },
      onLog: (line) => pushLog(task, line),
      onError: (error) => {
        task.child = null
        settle(task, 'failed', error && error.message ? error.message : String(error))
      },
      onClose: (code) => {
        task.child = null
        if (task.status === 'running') {
          settle(task, code === 0 ? 'done' : 'failed', code === 0 ? '' : `进程退出码 ${code}（详见日志）`)
        }
      },
    })
    if (!child) {
      if (task.status === 'running') settle(task, 'failed', '无法启动识别进程')
      return task
    }
    task.child = child
    return task
  }

  function cancel(id) {
    const task = tasks.get(String(id || ''))
    if (!task) throw fail('识别任务不存在', 404)
    if (task.status !== 'running' && task.status !== 'deciding') return task
    task.status = 'cancelled'
    task.stage = 'cancelled'
    task.message = '已取消'
    task.finishedAt = Date.now()
    if (activeId === task.id) activeId = null
    pushLog(task, '用户取消识别')
    killTree(task.child)
    task.child = null
    return task
  }

  function get(id) {
    return tasks.get(String(id || '')) || null
  }

  function active() {
    return activeId ? publicDetect(tasks.get(activeId)) : null
  }

  function dispose() {
    for (const task of tasks.values()) killTree(task.child)
    tasks.clear()
    activeId = null
  }

  return { start, cancel, get, active, dispose }
}

// ---------------------------------------------------------------------------
// Directory browsing
// ---------------------------------------------------------------------------

function defaultBrowseDir(cfg) {
  if (cfg.defaultDir && isDir(cfg.defaultDir)) return cfg.defaultDir
  const home = process.env.USERPROFILE || os.homedir()
  return isDir(home) ? home : process.cwd()
}

async function browse(cfg, rawPath) {
  let dir = rawPath && String(rawPath).trim() ? path.resolve(String(rawPath).trim()) : defaultBrowseDir(cfg)
  if (!isDir(dir)) {
    const parent = path.dirname(dir)
    if (isDir(parent)) dir = parent
    else throw fail(`目录不存在：${dir}`, 400)
  }
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw fail(`无法读取目录：${error && error.message ? error.message : error}`, 400)
  }
  const dirs = []
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: full })
      continue
    }
    const ext = path.extname(entry.name).toLowerCase()
    if (!VIDEO_EXT.has(ext)) continue
    let size = 0
    try { size = (await fsp.stat(full)).size } catch { size = 0 }
    files.push({ name: entry.name, path: full, size, image: IMAGE_EXT.has(ext) })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return {
    path: dir,
    parent: path.dirname(dir) === dir ? null : path.dirname(dir),
    dirs: dirs.slice(0, 500),
    files: files.slice(0, 500),
    drives: listDrives(),
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(fail('请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(fail('请求体不是合法 JSON', 400))
      }
    })
    req.on('error', reject)
  })
}

/** Loopback-only, same-origin-only. The route is unauthenticated like the GUI. */
function requestAllowed(req, originOf) {
  const address = req.socket && req.socket.remoteAddress
  if (!(address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')) return false
  const host = String(req.headers.host || '')
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const from = req.headers.origin
  if (!from) return true
  let own = ''
  try { own = originOf() } catch { own = '' }
  if (own && from === own) return true
  try {
    const a = new URL(from)
    const b = new URL(own)
    return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(a.hostname) && a.port === b.port && a.protocol === b.protocol
  } catch {
    return false
  }
}

/**
 * Extra guard for the image routes: a browser page on another origin can embed
 * `<img src="…/frame?path=…">` without CORS and without an Origin header, so it
 * could display arbitrary local pictures. Chromium reports the relationship in
 * `Sec-Fetch-Site`; a cross-site embed is refused, while non-browser callers
 * (curl, the test harness) send nothing and stay allowed.
 */
function embedAllowed(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (!site) return true
  return site === 'same-origin' || site === 'none'
}

function createHandler(cfg, jobs, detects, models, originOf) {
  let modelsLogged = false
  return async function handler(req, res) {
    const send = (code, body) => {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }

    if (!requestAllowed(req, originOf)) return send(403, { error: 'forbidden' })

    let url = null
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      return send(400, { error: 'bad url' })
    }
    const route = url.pathname.slice(API.length) || '/'

    try {
      if (req.method === 'GET') {
        if (route === '/' || route === '/state') {
          return send(200, {
            env: resolveEnv(cfg),
            jobs: jobs.list(),
            active: jobs.active(),
            detect: { active: detects.active() },
          })
        }
        if (route === '/jobs') return send(200, { jobs: jobs.list(), active: jobs.active() })
        const matchDetail = route.match(/^\/jobs\/([^/]+)$/)
        if (matchDetail) return send(200, { job: jobs.detail(decodeURIComponent(matchDetail[1])) })
        const matchPreview = route.match(/^\/jobs\/([^/]+)\/preview\/(left|right)$/)
        if (matchPreview) {
          if (!embedAllowed(req)) return send(403, { error: 'forbidden' })
          const file = jobs.previewTarget(decodeURIComponent(matchPreview[1]), matchPreview[2])
          if (!file) return send(404, { error: '还没有预览帧' })
          let buffer = null
          try {
            buffer = fs.readFileSync(file)
          } catch {
            return send(404, { error: '预览帧已失效' })
          }
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'cache-control': 'no-store',
            'content-length': buffer.length,
            'x-content-type-options': 'nosniff',
          })
          res.end(buffer)
          return
        }
        if (route === '/browse') return send(200, await browse(cfg, url.searchParams.get('path') || ''))
        if (route === '/probe') return send(200, await probeVideo(cfg, url.searchParams.get('path') || ''))
        if (route === '/models') {
          const services = models()
          const catalogue = await modelCatalogue(services.llm, services.defaults)
          if (!modelsLogged) {
            modelsLogged = true
            try {
              const selected = catalogue.selected ? `${catalogue.selected.provider}/${catalogue.selected.model}` : 'none'
              console.info(`[dsh-subtitle-remover] models: ${catalogue.models.length} found, DSH selection=${selected}`)
            } catch { /* best effort */ }
          }
          return send(200, catalogue)
        }
        if (route === '/frame') {
          if (!embedAllowed(req)) return send(403, { error: 'forbidden' })
          const frame = await readFrame(cfg, url.searchParams.get('path') || '', url.searchParams.get('t') || '0')
          res.writeHead(200, {
            'content-type': frame.contentType,
            'cache-control': 'no-store',
            'content-length': frame.buffer.length,
            'x-content-type-options': 'nosniff',
          })
          res.end(frame.buffer)
          return
        }
        const matchDetect = route.match(/^\/detect\/([^/]+)$/)
        if (matchDetect) {
          const task = detects.get(decodeURIComponent(matchDetect[1]))
          if (!task) return send(404, { error: '识别任务不存在' })
          return send(200, { task: publicDetect(task) })
        }
        return send(404, { error: 'no such route' })
      }

      if (req.method === 'POST') {
        const body = await readJson(req)
        if (route === '/jobs') {
          const job = jobs.create(body)
          return send(200, { job: publicJob(job, true), active: jobs.active() })
        }
        const matchCancel = route.match(/^\/jobs\/([^/]+)\/cancel$/)
        if (matchCancel) {
          const job = jobs.cancel(decodeURIComponent(matchCancel[1]))
          return send(200, { job: publicJob(job, true), active: jobs.active() })
        }
        const matchRemove = route.match(/^\/jobs\/([^/]+)\/remove$/)
        if (matchRemove) {
          jobs.remove(decodeURIComponent(matchRemove[1]))
          return send(200, { ok: true, jobs: jobs.list(), active: jobs.active() })
        }
        const matchOpen = route.match(/^\/jobs\/([^/]+)\/open$/)
        if (matchOpen) {
          const job = jobs.raw(decodeURIComponent(matchOpen[1]))
          if (!job) return send(404, { error: '任务不存在' })
          const target = body.target === 'folder' ? 'folder' : 'file'
          if (!isFile(job.outputPath)) return send(409, { error: '输出文件还不存在，等任务完成后再打开' })
          openPath(job.outputPath, target)
          return send(200, { ok: true, path: job.outputPath })
        }
        if (route === '/detect') {
          const task = detects.start(body)
          return send(200, { task: publicDetect(task) })
        }
        const matchDetectCancel = route.match(/^\/detect\/([^/]+)\/cancel$/)
        if (matchDetectCancel) {
          const task = detects.cancel(decodeURIComponent(matchDetectCancel[1]))
          return send(200, { task: publicDetect(task) })
        }
        return send(404, { error: 'no such route' })
      }

      return send(405, { error: 'method not allowed' })
    } catch (error) {
      const code = Number(error && error.statusCode) || 500
      return send(code, { error: String(error && error.message ? error.message : error) })
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  let llm = null
  let defaultModels = null
  const modelServices = () => ({ llm, defaults: defaultModels })

  sweepStalePreviews()

  const jobs = createJobStore(cfg)
  const detects = createDetectStore(cfg, modelServices)

  ctx.effect(() => () => {
    jobs.dispose()
    detects.dispose()
  })

  if (typeof ctx.inject === 'function') {
    // Optional: a profile without model services keeps the heuristic path.
    ctx.inject(['llm', 'agentDefaultModel'], (sub) => {
      if (!sub) return
      llm = sub.llm || null
      defaultModels = sub.agentDefaultModel || null
    })

    ctx.inject(['webServer'], (sub) => {
      if (!sub || !sub.webServer || typeof sub.webServer.register !== 'function') return
      if (typeof sub.effect !== 'function') return
      sub.effect(
        () => sub.webServer.register({
          kind: 'prefix',
          path: API,
          handler: createHandler(cfg, jobs, detects, modelServices, () => {
            try { return sub.webServer.getOrigin() } catch { return '' }
          }),
        }),
        'subtitle-remover: api route',
      )
      try {
        // One line makes the live state diagnosable from the Host log.
        console.info('[dsh-subtitle-remover] api ready: /state /jobs /browse /probe /frame /models /detect /preview /open')
      } catch { /* logging is best effort */ }
    })
  }
}
