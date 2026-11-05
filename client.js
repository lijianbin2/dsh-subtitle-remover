/**
 * dsh-subtitle-remover — Client half (Web UI).
 *
 * Left-sidebar entry plus the page it opens: pick a video, see a frame, draw one
 * or more subtitle regions on it (or let the engine propose them), then start the
 * job or run the whole thing automatically.
 *
 * Contract notes:
 *  - `sidebar.panellist` is the global panel list at the top of the left column;
 *    its row id is also the `main` slot key the shell dispatches when clicked.
 *  - The Host exposes `/dsh-subtitle-remover/api/*` on the GUI's own origin;
 *    frames come back as image bytes from `/frame`, regions from `/detect`.
 *  - Text goes through the locale service; registering the slot with `locale`
 *    lets the framework re-render on language change.
 */
window.__ModuleLoader__.load({
  id: 'dsh-subtitle-remover',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const NS = 'dsh-subtitle-remover'
    const PANEL_ID = 'subtitle-remover'
    const API = '/dsh-subtitle-remover/api'
    const STORAGE_KEY = 'dsh-subtitle-remover.form.v2'
    const MAX_AREAS = 6

    const MODES = ['sttn-auto', 'sttn-det', 'lama', 'propainter', 'opencv']
    const MODE_LABEL_KEY = {
      'sttn-auto': 'mode.sttn-auto',
      'sttn-det': 'mode.sttn-det',
      lama: 'mode.lama',
      propainter: 'mode.propainter',
      opencv: 'mode.opencv',
    }

    // -----------------------------------------------------------------------
    // Text
    // -----------------------------------------------------------------------

    const I18N = {
      zh: {
        nav: '字幕擦除',
        'page.title': '视频字幕擦除',
        'page.subtitle': '看画面框出字幕区（可多个），或者让插件自动识别后一键跑完。',
        'env.ready': '引擎就绪',
        'env.broken': '引擎未就绪',
        'env.vsr': '引擎',
        'env.python': '解释器',
        'env.probe': '探测',
        'env.hint': '自动探测失败时，在插件配置里填 vsrRoot 或 pythonPath。',
        'editor.title': '画面与字幕区域',
        'editor.hint': '在画面上拖拽框出一个区域；拖框内可移动，拖右下角可缩放。可以框多个。',
        'editor.emptyHint': '选好视频后这里会显示画面',
        'editor.noFrame': '拿不到画面帧（需要 ffmpeg）',
        'editor.frameLoading': '画面加载中…',
        'editor.start': '开始',
        'editor.end': '结束',
        'editor.frame': '查看帧',
        'editor.startFrame': '开始帧',
        'editor.endFrame': '结束帧',
        'editor.fullRange': '全片',
        'editor.rangeHint': '只处理这一段，区间外的画面原样保留。',
        'editor.areas': '区域',
        'editor.add': '添加区域',
        'editor.clear': '清空',
        'editor.delete': '删除',
        'editor.none': '还没有区域：在画面上拖一个，或点「自动识别」。',
        'editor.yMin': '上',
        'editor.yMax': '下',
        'editor.xMin': '左',
        'editor.xMax': '右',
        'auto.title': '自动',
        'auto.detect': '自动识别字幕区',
        'auto.detecting': '识别中 {p}%',
        'auto.full': '全自动处理',
        'auto.found': '识别到 {n} 个区域',
        'auto.none': '没识别到字幕区，请手动框选',
        'auto.failed': '识别失败：{message}',
        'auto.cancel': '取消识别',
        'auto.needVideo': '先选一个视频',
        'auto.model': '决策模型',
        'auto.modelFollow': '跟随 DSH（{model}）',
        'auto.modelOff': '不使用模型（只用启发式）',
        'auto.modelNone': '没有可用的对话模型',
        'auto.deciding': '模型判断中…',
        'auto.byModel': '模型选了 {n} 个区域 · {mode}：{reason}',
        'auto.modelFailed': '模型判断失败，改用启发式结果：{message}',
        'form.title': '参数',
        'form.video': '视频文件',
        'form.videoPlaceholder': '输入完整路径，或点「浏览」挑一个视频',
        'form.browse': '浏览…',
        'form.mode': '擦除算法',
        'form.detect': '字幕检测模型',
        'form.detectHint': '只有带检测的算法会用到；STTN 智能擦除直接按选好的区域擦。',
        'form.saveDir': '输出目录',
        'form.collision': '同名文件',
        'form.collisionOverwrite': '直接覆盖（默认）',
        'form.collisionRename': '自动改名（加序号）',
        'form.collisionHint': '覆盖会替换同名成片；自动改名保留旧文件，新文件加 (2)、(3)。',
        'form.saveDirPlaceholder': '留空 = 与视频同目录',
        'form.submit': '开始擦除',
        'form.submitting': '提交中…',
        'form.busy': '已有任务在运行',
        'form.probing': '读取视频信息…',
        'form.probe': '{w}×{h} · {fps} fps · {frames} 帧 · {duration}',
        'form.probeFailed': '探测失败：{message}',
        'mode.sttn-auto': 'STTN 智能擦除（推荐）',
        'mode.sttn-det': 'STTN + 字幕检测',
        'mode.lama': 'LaMa（动画/静态背景）',
        'mode.propainter': 'ProPainter（运动剧烈，吃显存）',
        'mode.opencv': 'OpenCV（最快，效果一般）',
        'detect.server': '精准（PP-OCRv5 server）',
        'detect.mobile': '快速（PP-OCRv5 mobile）',
        'job.title': '任务',
        'job.empty': '还没有任务',
        'job.emptyHint': '选好视频、框好区域后点「开始擦除」，或直接「全自动处理」。',
        'job.frames': '帧',
        'job.elapsed': '已用',
        'job.eta': '预计剩余',
        'job.speed': '速度',
        'job.output': '输出文件',
        'job.openFile': '打开文件',
        'job.openFolder': '所在文件夹',
        'job.range': '区间',
        'job.preview': '实时对比',
        'job.previewBefore': '原片',
        'job.previewAfter': '擦除后',
        'job.previewWaiting': '开始处理后会在这里实时对比',
        'job.previewFrame': '第 {n} 帧 · {p}%',
        'notice.openFailed': '打开失败：{message}',
        'job.outputMissing': '输出文件已不在原处',
        'job.copy': '复制路径',
        'job.copied': '路径已复制',
        'job.cancel': '取消任务',
        'job.remove': '删除记录',
        'job.log': '运行日志（{n} 行）',
        'job.logEmpty': '暂无日志',
        'job.mode': '算法',
        'job.area': '区域',
        'job.areaValue': '{n} 个',
        'stage.queued': '排队中',
        'stage.starting': '启动中',
        'stage.loading': '加载引擎',
        'stage.running': '正在擦除',
        'stage.done': '已完成',
        'stage.failed': '失败',
        'stage.cancelled': '已取消',
        'history.title': '任务记录',
        'history.empty': '暂无记录',
        'browse.videoTitle': '选择视频文件',
        'browse.dirTitle': '选择输出目录',
        'browse.up': '上一级',
        'browse.empty': '这个文件夹里没有视频文件',
        'browse.pickDir': '使用此文件夹',
        'browse.loading': '读取中…',
        'browse.drives': '磁盘',
        'browse.dirs': '文件夹',
        'browse.files': '视频',
        'notice.started': '任务已开始',
        'notice.cancelled': '任务已取消',
        'notice.removed': '记录已删除',
        'notice.copyFailed': '复制失败，请手动选择路径',
        'notice.offline': '连不上插件后端：{message}',
        'notice.busy': '已有任务在运行，先完成或取消它',
        'notice.needVideo': '先选一个视频',
        'notice.needArea': '先框选至少一个区域，或点「自动识别」',
        'common.refresh': '刷新',
        'common.close': '关闭',
        'common.cancel': '取消',
        'unit.sec': '{n} 秒',
        'unit.min': '{m} 分 {s} 秒',
        'unit.hour': '{h} 小时 {m} 分',
        'unit.framesPerSecond': '{n} 帧/秒',
      },
      en: {
        nav: 'Subtitle Remover',
        'page.title': 'Video Subtitle Remover',
        'page.subtitle': 'Mark subtitle regions on a video frame (several are fine), or let the plugin detect them and run the whole job in one click.',
        'env.ready': 'Engine ready',
        'env.broken': 'Engine not ready',
        'env.vsr': 'Engine',
        'env.python': 'Python',
        'env.probe': 'Probe',
        'env.hint': 'When detection fails, set vsrRoot or pythonPath in the plugin config.',
        'editor.title': 'Frame and subtitle regions',
        'editor.hint': 'Drag on the frame to add a region; drag inside to move it, drag its bottom-right corner to resize. Several regions are allowed.',
        'editor.emptyHint': 'Pick a video and its frame appears here',
        'editor.noFrame': 'Cannot read a frame (needs ffmpeg)',
        'editor.frameLoading': 'Loading frame…',
        'editor.start': 'Start',
        'editor.end': 'End',
        'editor.frame': 'Frame',
        'editor.startFrame': 'Start frame',
        'editor.endFrame': 'End frame',
        'editor.fullRange': 'Whole video',
        'editor.rangeHint': 'Only this span is processed; frames outside it stay untouched.',
        'editor.areas': 'Regions',
        'editor.add': 'Add region',
        'editor.clear': 'Clear',
        'editor.delete': 'Delete',
        'editor.none': 'No region yet: drag on the frame, or press Detect.',
        'editor.yMin': 'Top',
        'editor.yMax': 'Bottom',
        'editor.xMin': 'Left',
        'editor.xMax': 'Right',
        'auto.title': 'Automatic',
        'auto.detect': 'Detect subtitle regions',
        'auto.detecting': 'Detecting {p}%',
        'auto.full': 'Run automatically',
        'auto.found': 'Found {n} region(s)',
        'auto.none': 'No subtitle region found — mark one manually',
        'auto.failed': 'Detection failed: {message}',
        'auto.cancel': 'Stop detecting',
        'auto.needVideo': 'Pick a video first',
        'auto.model': 'Decision model',
        'auto.modelFollow': 'Follow DSH ({model})',
        'auto.modelOff': 'No model (heuristics only)',
        'auto.modelNone': 'No chat model available',
        'auto.deciding': 'Model is deciding…',
        'auto.byModel': 'Model picked {n} region(s) · {mode}: {reason}',
        'auto.modelFailed': 'Model decision failed, using heuristics: {message}',
        'form.title': 'Settings',
        'form.video': 'Video file',
        'form.videoPlaceholder': 'Type a full path, or browse for a video',
        'form.browse': 'Browse…',
        'form.mode': 'Inpainting model',
        'form.detect': 'Subtitle detector',
        'form.detectHint': 'Used only by detecting modes; STTN auto inpaints exactly the regions you marked.',
        'form.saveDir': 'Output folder',
        'form.collision': 'Existing file',
        'form.collisionOverwrite': 'Overwrite (default)',
        'form.collisionRename': 'Rename with a number',
        'form.collisionHint': 'Overwrite replaces the existing result; rename keeps it and adds (2), (3).',
        'form.saveDirPlaceholder': 'Empty = next to the video',
        'form.submit': 'Start removing',
        'form.submitting': 'Submitting…',
        'form.busy': 'A job is already running',
        'form.probing': 'Reading video info…',
        'form.probe': '{w}×{h} · {fps} fps · {frames} frames · {duration}',
        'form.probeFailed': 'Probe failed: {message}',
        'mode.sttn-auto': 'STTN auto (recommended)',
        'mode.sttn-det': 'STTN + subtitle detection',
        'mode.lama': 'LaMa (animation / static background)',
        'mode.propainter': 'ProPainter (fast motion, heavy VRAM)',
        'mode.opencv': 'OpenCV (fastest, roughest)',
        'detect.server': 'Precise (PP-OCRv5 server)',
        'detect.mobile': 'Fast (PP-OCRv5 mobile)',
        'job.title': 'Job',
        'job.empty': 'No job yet',
        'job.emptyHint': 'Choose a video, mark the regions, then start — or just Run automatically.',
        'job.frames': 'Frames',
        'job.elapsed': 'Elapsed',
        'job.eta': 'Remaining',
        'job.speed': 'Speed',
        'job.output': 'Output file',
        'job.openFile': 'Open file',
        'job.openFolder': 'Show in folder',
        'job.range': 'Range',
        'job.preview': 'Live comparison',
        'job.previewBefore': 'Original',
        'job.previewAfter': 'After removal',
        'job.previewWaiting': 'The comparison appears here once processing starts',
        'job.previewFrame': 'frame {n} · {p}%',
        'notice.openFailed': 'Could not open: {message}',
        'job.outputMissing': 'The output file is gone',
        'job.copy': 'Copy path',
        'job.copied': 'Path copied',
        'job.cancel': 'Cancel job',
        'job.remove': 'Remove record',
        'job.log': 'Run log ({n} lines)',
        'job.logEmpty': 'No log yet',
        'job.mode': 'Model',
        'job.area': 'Regions',
        'job.areaValue': '{n}',
        'stage.queued': 'Queued',
        'stage.starting': 'Starting',
        'stage.loading': 'Loading engine',
        'stage.running': 'Removing',
        'stage.done': 'Done',
        'stage.failed': 'Failed',
        'stage.cancelled': 'Cancelled',
        'history.title': 'History',
        'history.empty': 'Nothing yet',
        'browse.videoTitle': 'Choose a video',
        'browse.dirTitle': 'Choose an output folder',
        'browse.up': 'Up',
        'browse.empty': 'No video files in this folder',
        'browse.pickDir': 'Use this folder',
        'browse.loading': 'Loading…',
        'browse.drives': 'Drives',
        'browse.dirs': 'Folders',
        'browse.files': 'Videos',
        'notice.started': 'Job started',
        'notice.cancelled': 'Job cancelled',
        'notice.removed': 'Record removed',
        'notice.copyFailed': 'Copy failed — select the path manually',
        'notice.offline': 'Cannot reach the plugin backend: {message}',
        'notice.busy': 'A job is already running; finish or cancel it first',
        'notice.needVideo': 'Pick a video first',
        'notice.needArea': 'Mark at least one region, or press Detect',
        'common.refresh': 'Refresh',
        'common.close': 'Close',
        'common.cancel': 'Cancel',
        'unit.sec': '{n}s',
        'unit.min': '{m}m {s}s',
        'unit.hour': '{h}h {m}m',
        'unit.framesPerSecond': '{n} fps',
      },
    }

    function interpolate(text, params) {
      if (!params) return String(text)
      return String(text).replace(/\{(\w+)\}/g, (whole, name) => (
        params[name] === undefined || params[name] === null ? whole : String(params[name])
      ))
    }

    function fallbackT(key, params) {
      const text = I18N.zh[key] !== undefined ? I18N.zh[key] : (I18N.en[key] !== undefined ? I18N.en[key] : key)
      return interpolate(text, params)
    }

    // -----------------------------------------------------------------------
    // Host calls and small utilities
    // -----------------------------------------------------------------------

    async function api(pathname, body) {
      const init = body === undefined
        ? { method: 'GET', credentials: 'same-origin', cache: 'no-store' }
        : {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      const response = await fetch(API + pathname, init)
      let data = null
      try { data = await response.json() } catch { data = null }
      if (!response.ok) {
        throw new Error(data && data.error ? data.error : `HTTP ${response.status}`)
      }
      return data || {}
    }

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
    const round1 = (value) => Math.round(value * 10) / 10

    function fmtDuration(t, seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      if (total < 60) return t('unit.sec', { n: total })
      if (total < 3600) return t('unit.min', { m: Math.floor(total / 60), s: total % 60 })
      return t('unit.hour', { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60) })
    }

    function fmtBytes(n) {
      const value = Number(n) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
      return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
    }

    function fmtClock(ts) {
      if (!ts) return ''
      try {
        return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    function stageKey(job) {
      const stage = job && job.stage ? String(job.stage) : 'queued'
      return ['queued', 'starting', 'loading', 'running', 'done', 'failed', 'cancelled'].includes(stage) ? stage : 'running'
    }

    function statusTone(job) {
      if (!job) return 'idle'
      if (job.status === 'done') return 'ok'
      if (job.status === 'failed') return 'err'
      if (job.status === 'running' || job.status === 'queued') return 'busy'
      return 'idle'
    }

    // Shared with the sidebar icon so it can pulse while a job runs.
    const activity = { running: false, percent: 0, listeners: new Set() }
    function publishActivity(running, percent) {
      const nextPercent = clamp(Math.round(Number(percent) || 0), 0, 100)
      if (activity.running === running && activity.percent === nextPercent) return
      activity.running = running
      activity.percent = nextPercent
      for (const listener of activity.listeners) {
        try { listener() } catch { /* never break the page */ }
      }
    }
    function useActivity() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((x) => x + 1)
        activity.listeners.add(listener)
        return () => { activity.listeners.delete(listener) }
      }, [])
      return activity
    }

    // -----------------------------------------------------------------------
    // Icons
    // -----------------------------------------------------------------------

    function PanelIcon(props) {
      const size = props.size || 16
      const live = props.activity
      return h('span', { className: 'vsr-nav-icon', style: { width: size, height: size } },
        h('svg', {
          width: size, height: size, viewBox: '0 0 64 64', fill: 'none',
          'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
        },
        h('rect', { x: 7, y: 9, width: 50, height: 38, rx: 8, stroke: 'currentColor', strokeWidth: 4.5 }),
        h('rect', { x: 17, y: 32, width: 22, height: 6, rx: 3, fill: 'currentColor' }),
        h('path', { d: 'M17 53h30', stroke: 'currentColor', strokeWidth: 4.5, strokeLinecap: 'round' }),
        h('path', { d: 'M36 26.5 52 44', stroke: 'var(--dsw-alias-state-error-primary)', strokeWidth: 4.5, strokeLinecap: 'round' }),
        ),
        live && live.running ? h('span', { className: 'vsr-nav-pulse', title: `${live.percent}%` }) : null,
      )
    }

    function FolderGlyph() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', className: 'vsr-glyph',
      },
      h('path', {
        d: 'M1.75 4.25A1.25 1.25 0 0 1 3 3h3.1c.33 0 .64.13.87.36l.94.94c.23.23.54.36.87.36H13A1.25 1.25 0 0 1 14.25 5v6.75A1.25 1.25 0 0 1 13 13H3a1.25 1.25 0 0 1-1.25-1.25z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }))
    }

    function FilmGlyph() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', className: 'vsr-glyph',
      },
      h('rect', { x: 1.75, y: 3.75, width: 12.5, height: 8.5, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', { d: 'M5 3.9v8.2M11 3.9v8.2', stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.55 }))
    }

    // -----------------------------------------------------------------------
    // Building blocks
    // -----------------------------------------------------------------------

    function Field(props) {
      return h('div', { className: props.className || 'vsr-field' },
        h('label', { className: 'vsr-label' }, props.label),
        props.children,
        props.hint ? h('div', { className: 'vsr-hint' }, props.hint) : null,
      )
    }

    function StatusBadge(props) {
      return h('span', { className: `vsr-badge tone-${statusTone(props.job)}` }, props.t(`stage.${stageKey(props.job)}`))
    }

    // -----------------------------------------------------------------------
    // Region editor: frame + draggable rectangles
    // -----------------------------------------------------------------------

    function RegionEditor(props) {
      const { t, src, areas, selected, onSelect, onChange } = props
      const frameRef = useRef(null)
      const dragRef = useRef(null)
      const [draft, setDraft] = useState(null)
      const [frameError, setFrameError] = useState(false)
      const [frameLoaded, setFrameLoaded] = useState(false)

      useEffect(() => {
        setFrameError(false)
        setFrameLoaded(false)
      }, [src])

      const positionOf = (event) => {
        const box = frameRef.current.getBoundingClientRect()
        return {
          x: clamp(((event.clientX - box.left) / box.width) * 100, 0, 100),
          y: clamp(((event.clientY - box.top) / box.height) * 100, 0, 100),
        }
      }

      const beginDrag = (event) => {
        if (!src || event.button !== 0) return
        const point = positionOf(event)
        let hit = -1
        for (let index = areas.length - 1; index >= 0; index -= 1) {
          const area = areas[index]
          if (point.x < area.xMin || point.x > area.xMax) continue
          if (point.y < area.yMin || point.y > area.yMax) continue
          hit = index
          break
        }
        if (hit >= 0) {
          const area = areas[hit]
          const corner = point.x >= area.xMax - 3.5 && point.y >= area.yMax - 3.5
          onSelect(hit)
          dragRef.current = {
            kind: corner ? 'resize' : 'move',
            index: hit,
            start: point,
            origin: { ...area },
          }
        } else {
          onSelect(-1)
          dragRef.current = { kind: 'new', start: point }
          setDraft({ xMin: point.x, xMax: point.x, yMin: point.y, yMax: point.y })
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* older engines */ }
      }

      const moveDrag = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const point = positionOf(event)
        if (drag.kind === 'new') {
          setDraft({
            xMin: Math.min(drag.start.x, point.x),
            xMax: Math.max(drag.start.x, point.x),
            yMin: Math.min(drag.start.y, point.y),
            yMax: Math.max(drag.start.y, point.y),
          })
          return
        }
        const next = areas.slice()
        if (drag.kind === 'move') {
          const origin = drag.origin
          const width = origin.xMax - origin.xMin
          const height = origin.yMax - origin.yMin
          const xMin = clamp(origin.xMin + (point.x - drag.start.x), 0, 100 - width)
          const yMin = clamp(origin.yMin + (point.y - drag.start.y), 0, 100 - height)
          next[drag.index] = {
            yMin: round1(yMin), yMax: round1(yMin + height),
            xMin: round1(xMin), xMax: round1(xMin + width),
          }
        } else {
          const origin = drag.origin
          next[drag.index] = {
            yMin: origin.yMin, xMin: origin.xMin,
            yMax: round1(clamp(point.y, origin.yMin + 1, 100)),
            xMax: round1(clamp(point.x, origin.xMin + 1, 100)),
          }
        }
        onChange(next)
      }

      const endDrag = () => {
        const drag = dragRef.current
        dragRef.current = null
        if (!drag) return
        if (drag.kind === 'new' && draft) {
          if (draft.xMax - draft.xMin >= 1 && draft.yMax - draft.yMin >= 1 && areas.length < MAX_AREAS) {
            onChange(areas.concat([{
              yMin: round1(draft.yMin), yMax: round1(draft.yMax),
              xMin: round1(draft.xMin), xMax: round1(draft.xMax),
            }]))
          }
          setDraft(null)
        }
      }

      const rectStyle = (area) => ({
        left: `${area.xMin}%`,
        top: `${area.yMin}%`,
        width: `${Math.max(0, area.xMax - area.xMin)}%`,
        height: `${Math.max(0, area.yMax - area.yMin)}%`,
      })

      return h('div', { className: 'vsr-frame-wrap' },
        src
          ? h('div', {
            className: 'vsr-frame',
            ref: frameRef,
            onPointerDown: beginDrag,
            onPointerMove: moveDrag,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            role: 'application',
            'aria-label': t('editor.title'),
          },
          h('img', {
            src,
            alt: '',
            draggable: false,
            onLoad: () => { setFrameLoaded(true); setFrameError(false) },
            onError: () => { setFrameError(true); setFrameLoaded(false) },
          }),
          frameError
            ? h('div', { className: 'vsr-frame-overlay-msg' }, t('editor.noFrame'))
            : (!frameLoaded ? h('div', { className: 'vsr-frame-overlay-msg' }, t('editor.frameLoading')) : null),
          areas.map((area, index) => h('div', {
            key: `area-${index}`,
            className: `vsr-rect${index === selected ? ' on' : ''}`,
            style: rectStyle(area),
          },
          h('span', { className: 'vsr-rect-index' }, String(index + 1)),
          h('span', { className: 'vsr-rect-handle' }),
          )),
          draft
            ? h('div', { className: 'vsr-rect draft', style: rectStyle(draft) })
            : null,
          )
          : h('div', { className: 'vsr-frame-empty' },
            h('div', { className: 'vsr-empty-title' }, t('editor.emptyHint')),
            h('div', { className: 'vsr-hint' }, t('editor.hint')))
      )
    }

    // -----------------------------------------------------------------------
    // Directory picker
    // -----------------------------------------------------------------------

    function BrowseDialog(props) {
      const t = props.t
      const isDirMode = props.mode === 'dir'
      const [listing, setListing] = useState(null)
      const [pathText, setPathText] = useState(props.initialPath || '')
      const [target, setTarget] = useState(props.initialPath || '')
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const dialogRef = useRef(null)

      useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError('')
        api('/browse' + (target ? `?path=${encodeURIComponent(target)}` : ''))
          .then((data) => {
            if (cancelled) return
            setListing(data)
            setPathText(data.path)
          })
          .catch((e) => { if (!cancelled) setError(String(e && e.message ? e.message : e)) })
          .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
      }, [target])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            props.onCancel()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [props.onCancel])

      useEffect(() => {
        if (dialogRef.current && dialogRef.current.focus) dialogRef.current.focus()
      }, [])

      const drives = (listing && listing.drives) || []
      const dirs = (listing && listing.dirs) || []
      const files = (listing && listing.files) || []

      return h('div', {
        className: 'vsr-overlay',
        onMouseDown: (event) => { if (event.target === event.currentTarget) props.onCancel() },
      },
      h('div', {
        className: 'vsr-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': isDirMode ? t('browse.dirTitle') : t('browse.videoTitle'),
        tabIndex: -1,
        ref: dialogRef,
      },
      h('div', { className: 'vsr-dialog-head' },
        h('div', { className: 'vsr-card-title' }, isDirMode ? t('browse.dirTitle') : t('browse.videoTitle')),
        h('button', { type: 'button', className: 'vsr-btn', onClick: props.onCancel }, t('common.close')),
      ),
      h('div', { className: 'vsr-dialog-bar' },
        h('button', {
          type: 'button',
          className: 'vsr-btn',
          disabled: !(listing && listing.parent),
          onClick: () => { if (listing && listing.parent) setTarget(listing.parent) },
        }, t('browse.up')),
        h('input', {
          className: 'vsr-input',
          value: pathText,
          spellCheck: false,
          onChange: (event) => setPathText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              setTarget(pathText)
            }
          },
        }),
        h('button', { type: 'button', className: 'vsr-btn', onClick: () => setTarget(pathText) }, t('common.refresh')),
      ),
      drives.length > 1
        ? h('div', { className: 'vsr-drives' },
          h('span', { className: 'vsr-hint' }, t('browse.drives')),
          drives.map((drive) => h('button', {
            key: drive,
            type: 'button',
            className: 'vsr-chip-btn',
            onClick: () => setTarget(drive),
          }, drive)))
        : null,
      h('div', { className: 'vsr-dialog-body' },
        loading ? h('div', { className: 'vsr-empty' }, t('browse.loading'))
          : error ? h('div', { className: 'vsr-empty vsr-error' }, error)
            : h(React.Fragment, null,
              dirs.length
                ? h('div', { className: 'vsr-group' },
                  h('div', { className: 'vsr-group-title' }, t('browse.dirs')),
                  dirs.map((dir) => h('button', {
                    key: dir.path,
                    type: 'button',
                    className: 'vsr-row-btn',
                    title: dir.path,
                    onClick: () => setTarget(dir.path),
                  }, h(FolderGlyph), h('span', { className: 'vsr-row-name' }, dir.name))))
                : null,
              files.length
                ? h('div', { className: 'vsr-group' },
                  h('div', { className: 'vsr-group-title' }, t('browse.files')),
                  files.map((file) => h('button', {
                    key: file.path,
                    type: 'button',
                    className: 'vsr-row-btn',
                    title: file.path,
                    onClick: () => { if (!isDirMode) props.onPick(file.path) },
                  }, h(FilmGlyph), h('span', { className: 'vsr-row-name' }, file.name),
                  h('span', { className: 'vsr-row-meta' }, fmtBytes(file.size)))))
                : null,
              !dirs.length && !files.length ? h('div', { className: 'vsr-empty' }, t('browse.empty')) : null,
            ),
      ),
      h('div', { className: 'vsr-dialog-foot' },
        isDirMode
          ? h('button', {
            type: 'button',
            className: 'vsr-btn primary',
            disabled: !listing,
            onClick: () => props.onPick(listing ? listing.path : pathText),
          }, t('browse.pickDir'))
          : null,
        h('button', { type: 'button', className: 'vsr-btn', onClick: props.onCancel }, t('common.cancel')),
      ),
      ))
    }

    // -----------------------------------------------------------------------
    // Page
    // -----------------------------------------------------------------------

    function Page(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT

      const [env, setEnv] = useState(null)
      const [jobs, setJobs] = useState([])
      const [active, setActive] = useState('')
      const [detail, setDetail] = useState(null)
      const [offline, setOffline] = useState('')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [selectedId, setSelectedId] = useState('')
      const [reloadKey, setReloadKey] = useState(0)
      const [probe, setProbe] = useState(null)
      const [probing, setProbing] = useState(false)
      const [browse, setBrowse] = useState(null)
      const [form, setForm] = useState(loadForm)
      const [selectedArea, setSelectedArea] = useState(-1)
      const [detecting, setDetecting] = useState(false)
      const [detectTask, setDetectTask] = useState(null)
      const [frameTime, setFrameTime] = useState(0)
      const [viewSide, setViewSide] = useState('start')
      const [catalogue, setCatalogue] = useState(null)
      const lastProbedPath = useRef('')

      useEffect(() => {
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form)) } catch { /* private mode */ }
      }, [form])

      const viewTime = viewSide === 'end' ? Number(form.rangeEnd) || 0 : Number(form.rangeStart) || 0

      // Debounce the sample time so scrubbing does not spawn a frame per pixel.
      useEffect(() => {
        const timer = setTimeout(() => setFrameTime(viewTime), 220)
        return () => clearTimeout(timer)
      }, [viewTime])

      // Poll state; a chained timeout never overlaps two requests.
      useEffect(() => {
        let stopped = false
        let timer = null
        const tick = async () => {
          try {
            const state = await api('/state')
            if (stopped) return
            setEnv(state.env || null)
            setJobs(Array.isArray(state.jobs) ? state.jobs : [])
            setActive(state.active || '')
            setOffline('')
            const watch = selectedId || state.active || (state.jobs && state.jobs[0] ? state.jobs[0].id : '')
            if (watch) {
              const picked = await api(`/jobs/${encodeURIComponent(watch)}`)
              if (!stopped) setDetail(picked.job || null)
            } else if (!stopped) {
              setDetail(null)
            }
          } catch (e) {
            if (!stopped) setOffline(String(e && e.message ? e.message : e))
          } finally {
            if (!stopped) timer = setTimeout(tick, 1500)
          }
        }
        tick()
        return () => { stopped = true; if (timer) clearTimeout(timer) }
      }, [selectedId, reloadKey])

      const running = Boolean(active) || Boolean(detail && (detail.status === 'running' || detail.status === 'queued'))
      const livePercent = detail && detail.status === 'running' ? detail.percent : 0
      useEffect(() => { publishActivity(running, livePercent) }, [running, livePercent])
      useEffect(() => () => publishActivity(false, 0), [])

      // Probe the chosen file (debounced).
      useEffect(() => {
        const value = form.videoPath.trim()
        if (!value) { setProbe(null); setProbing(false); return undefined }
        let cancelled = false
        setProbing(true)
        const timer = setTimeout(() => {
          api(`/probe?path=${encodeURIComponent(value)}`)
            .then((data) => {
              if (cancelled) return
              setProbe(data || null)
              if (data && data.ok && lastProbedPath.current !== value) {
                lastProbedPath.current = value
                const duration = Number(data.duration) || 0
                setForm((current) => Object.assign({}, current, {
                  rangeStart: 0,
                  rangeEnd: duration > 0 ? round1(duration) : 0,
                }))
                setViewSide('start')
              }
            })
            .catch((e) => { if (!cancelled) setProbe({ ok: false, message: String(e && e.message ? e.message : e) }) })
            .finally(() => { if (!cancelled) setProbing(false) })
        }, 450)
        return () => { cancelled = true; clearTimeout(timer); setProbing(false) }
      }, [form.videoPath])

      const update = useCallback((patch) => { setForm((current) => Object.assign({}, current, patch)) }, [])

      // Models DSH can call right now; the default entry follows the current DSH
      // selection, so "全自动" uses the model the user already picked.
      useEffect(() => {
        let cancelled = false
        let timer = null
        let attempts = 0
        const load = async () => {
          attempts += 1
          try {
            const data = await api('/models')
            if (cancelled) return
            const value = data && Array.isArray(data.models) ? data : { selected: null, models: [] }
            setCatalogue(value)
            if (!value.models.length && attempts < 3) timer = setTimeout(load, 2500)
          } catch {
            if (cancelled) return
            if (attempts < 3) { timer = setTimeout(load, 2500); return }
            setCatalogue({ selected: null, models: [] })
          }
        }
        load()
        return () => { cancelled = true; if (timer) clearTimeout(timer) }
      }, [])

      const chooseModel = useCallback(() => {
        if (!catalogue) return null
        if (!form.modelKey) return catalogue.selected || null
        const slash = form.modelKey.indexOf('/')
        if (slash <= 0) return null
        return { provider: form.modelKey.slice(0, slash), model: form.modelKey.slice(slash + 1) }
      }, [catalogue, form.modelKey])
      const reload = useCallback(() => setReloadKey((key) => key + 1), [])

      const setAreas = useCallback((areas) => {
        update({ areas: areas.slice(0, MAX_AREAS) })
        setSelectedArea(areas.length ? Math.min(selectedArea, areas.length - 1) : -1)
      }, [update, selectedArea])

      const updateArea = useCallback((index, field, raw) => {
        const value = Number(raw)
        setForm((current) => {
          const areas = current.areas.slice()
          const area = Object.assign({}, areas[index])
          if (!area) return current
          if (Number.isFinite(value)) area[field] = clamp(round1(value), 0, 100)
          areas[index] = area
          return Object.assign({}, current, { areas })
        })
      }, [])

      const addArea = useCallback(() => {
        setForm((current) => {
          if (current.areas.length >= MAX_AREAS) return current
          const offset = Math.min(4, current.areas.length * 2)
          return Object.assign({}, current, {
            areas: current.areas.concat([{
              yMin: clamp(85 - offset, 0, 99),
              yMax: clamp(99 - offset, 1, 100),
              xMin: 10,
              xMax: 90,
            }]),
          })
        })
      }, [])

      const removeArea = useCallback((index) => {
        setForm((current) => Object.assign({}, current, {
          areas: current.areas.filter((_, i) => i !== index),
        }))
        setSelectedArea((current) => (current === index ? -1 : (current > index ? current - 1 : current)))
      }, [])

      const runDetect = useCallback(async () => {
        const videoPath = form.videoPath.trim()
        if (!videoPath) {
          setNotice({ kind: 'error', text: t('auto.needVideo') })
          return null
        }
        const selection = chooseModel()
        setDetecting(true)
        setNotice(null)
        try {
          const body = { videoPath, samples: 14, maxRegions: 4 }
          if (selection) body.decide = selection
          const started = await api('/detect', body)
          let task = started.task
          setDetectTask(task)
          const deadline = Date.now() + 300000
          while (task && (task.status === 'running' || task.status === 'deciding') && Date.now() < deadline) {
            await wait(1200)
            const polled = await api(`/detect/${encodeURIComponent(task.id)}`)
            task = polled.task
            setDetectTask(task)
          }
          if (!task) throw new Error('识别任务丢失')
          if (task.status !== 'done') {
            if (task.status !== 'cancelled') {
              setNotice({ kind: 'error', text: t('auto.failed', { message: task.message || task.status }) })
            }
            return null
          }
          const regions = Array.isArray(task.regions) ? task.regions : []
          const decision = task.decision
          if (decision && decision.ok === false) {
            setNotice({ kind: 'error', text: t('auto.modelFailed', { message: decision.error }) })
          }
          if (task.mode && MODES.includes(task.mode)) update({ mode: task.mode })
          const areas = regions.map((region) => ({
            yMin: round1(clamp(Number(region.yMin), 0, 100)),
            yMax: round1(clamp(Number(region.yMax), 0, 100)),
            xMin: round1(clamp(Number(region.xMin), 0, 100)),
            xMax: round1(clamp(Number(region.xMax), 0, 100)),
          }))
          setForm((current) => Object.assign({}, current, { areas }))
          setSelectedArea(areas.length ? 0 : -1)
          const decisionNote = decision && decision.ok
            ? t('auto.byModel', { n: areas.length, mode: task.mode || form.mode, reason: decision.reason || '' })
            : ''
          if (!decision || decision.ok !== false) {
            if (decisionNote) setNotice({ kind: 'ok', text: decisionNote })
            else if (areas.length) setNotice({ kind: 'ok', text: t('auto.found', { n: areas.length }) })
            else setNotice({ kind: 'error', text: t('auto.none') })
          }
          return {
            areas,
            mode: task.mode && MODES.includes(task.mode) ? task.mode : form.mode,
            note: decisionNote,
          }
        } catch (e) {
          setNotice({ kind: 'error', text: String(e && e.message ? e.message : e) })
          return null
        } finally {
          setDetecting(false)
        }
      }, [form.videoPath, form.mode, chooseModel, t, update])

      const cancelDetect = useCallback(async () => {
        if (!detectTask || (detectTask.status !== 'running' && detectTask.status !== 'deciding')) return
        try { await api(`/detect/${encodeURIComponent(detectTask.id)}/cancel`, {}) } catch { /* ignore */ }
      }, [detectTask])

      const startJob = useCallback(async (areasOverride, modeOverride) => {
        const videoPath = form.videoPath.trim()
        if (!videoPath) {
          setNotice({ kind: 'error', text: t('notice.needVideo') })
          return false
        }
        const areas = areasOverride || form.areas
        if (!areas.length) {
          setNotice({ kind: 'error', text: t('notice.needArea') })
          return false
        }
        setBusy(true)
        setNotice(null)
        try {
          const probeDuration = probe && probe.ok ? Number(probe.duration) || 0 : 0
          const rangeStart = Math.max(0, Number(form.rangeStart) || 0)
          const rangeEnd = Number(form.rangeEnd) || 0
          const range = probeDuration > 0 && rangeEnd - rangeStart >= 0.2
            ? { start: rangeStart, end: rangeEnd }
            : undefined
          const result = await api('/jobs', {
            videoPath,
            mode: modeOverride || form.mode,
            detectMode: form.detectMode,
            saveDir: form.saveDir.trim(),
            collision: form.collision,
            areas,
            range,
          })
          if (result && result.job && result.job.id) setSelectedId(result.job.id)
          setNotice({ kind: 'ok', text: t('notice.started') })
          reload()
          return true
        } catch (e) {
          setNotice({ kind: 'error', text: String(e && e.message ? e.message : e) })
          return false
        } finally {
          setBusy(false)
        }
      }, [form, probe, t, reload])

      const autoRun = useCallback(async () => {
        if (running) {
          setNotice({ kind: 'error', text: t('notice.busy') })
          return
        }
        let picked = form.areas.length ? { areas: form.areas, mode: form.mode } : null
        if (!picked) {
          picked = await runDetect()
          if (!picked || !picked.areas.length) return
        }
        await startJob(picked.areas, picked.mode)
        if (picked.note) setNotice({ kind: 'ok', text: picked.note })
      }, [form.areas, form.mode, running, runDetect, startJob, t])

      const cancelJob = async (id) => {
        try {
          await api(`/jobs/${encodeURIComponent(id)}/cancel`, {})
          setNotice({ kind: 'ok', text: t('notice.cancelled') })
          reload()
        } catch (e) {
          setNotice({ kind: 'error', text: String(e && e.message ? e.message : e) })
        }
      }

      const removeJob = async (id) => {
        try {
          await api(`/jobs/${encodeURIComponent(id)}/remove`, {})
          if (selectedId === id) setSelectedId('')
          setNotice({ kind: 'ok', text: t('notice.removed') })
          reload()
        } catch (e) {
          setNotice({ kind: 'error', text: String(e && e.message ? e.message : e) })
        }
      }

      const copyPath = async (value) => {
        try {
          await navigator.clipboard.writeText(value)
          setNotice({ kind: 'ok', text: t('job.copied') })
        } catch {
          setNotice({ kind: 'error', text: t('notice.copyFailed') })
        }
      }

      const openOutput = async (id, target) => {
        try {
          await api(`/jobs/${encodeURIComponent(id)}/open`, { target })
        } catch (e) {
          setNotice({ kind: 'error', text: t('notice.openFailed', { message: String(e && e.message ? e.message : e) }) })
        }
      }

      const shown = detail || null
      const envReady = env && env.ready
      const envTone = !env ? 'idle' : envReady ? 'ok' : 'err'
      const modeOptions = MODES.map((mode) => ({ value: mode, label: t(MODE_LABEL_KEY[mode]) }))
      const modelList = catalogue && Array.isArray(catalogue.models) ? catalogue.models : []
      const followModelLabel = catalogue && catalogue.selected
        ? t('auto.modelFollow', { model: catalogue.selected.model })
        : t('auto.modelOff')
      const duration = probe && probe.ok ? Number(probe.duration) || 0 : 0
      const frameUrl = form.videoPath.trim()
        ? `${API}/frame?path=${encodeURIComponent(form.videoPath.trim())}&t=${frameTime}`
        : ''
      const autoBusy = detecting || running || busy

      return h('div', { className: 'vsr-root' },
        h('div', { className: 'vsr-inner' },

          h('header', { className: 'vsr-head' },
            h('div', { className: 'vsr-head-main' },
              h('h1', { className: 'vsr-title' }, t('page.title')),
              h('p', { className: 'vsr-sub' }, t('page.subtitle')),
            ),
            h('div', { className: 'vsr-env' },
              h('span', { className: 'vsr-chip' },
                h('i', { className: `vsr-dot ${envTone}` }),
                !env ? t('env.probe') : envReady ? t('env.ready') : t('env.broken')),
              env && env.vsrRoot
                ? h('div', { className: 'vsr-env-line', title: env.vsrRoot }, `${t('env.vsr')} · ${env.vsrRoot}`)
                : null,
              env && env.pythonPath
                ? h('div', { className: 'vsr-env-line', title: env.pythonPath }, `${t('env.python')} · ${env.pythonPath}`)
                : null,
              env && !envReady && env.problems && env.problems.length
                ? h('div', { className: 'vsr-env-hint' }, env.problems.join('；'), h('div', { className: 'vsr-hint' }, t('env.hint')))
                : null,
            ),
          ),

          notice ? h('div', { className: `vsr-notice ${notice.kind}` }, notice.text) : null,
          offline ? h('div', { className: 'vsr-notice error' }, t('notice.offline', { message: offline })) : null,

          // Source + editor ------------------------------------------------
          h('section', { className: 'vsr-card' },
            h('div', { className: 'vsr-card-head' },
              h('div', { className: 'vsr-card-title' }, t('editor.title')),
              h('div', { className: 'vsr-card-tools' },
                h('label', { className: 'vsr-model' },
                  h('span', { className: 'vsr-hint' }, t('auto.model')),
                  h('select', {
                    className: 'vsr-select small',
                    value: form.modelKey,
                    disabled: !modelList.length && !(catalogue && catalogue.selected),
                    title: modelList.length ? '' : t('auto.modelNone'),
                    onChange: (event) => update({ modelKey: event.target.value }),
                  },
                  h('option', { value: '' }, followModelLabel),
                  modelList.map((entry) => h('option', {
                    key: `${entry.provider}/${entry.model}`,
                    value: `${entry.provider}/${entry.model}`,
                  }, entry.label)),
                  ),
                ),
                detecting
                  ? h('button', { type: 'button', className: 'vsr-btn', onClick: cancelDetect }, t('auto.cancel'))
                  : null,
                h('button', {
                  type: 'button',
                  className: 'vsr-btn',
                  disabled: autoBusy || !form.videoPath.trim(),
                  onClick: () => { runDetect() },
                }, detecting
                  ? (detectTask && detectTask.status === 'deciding'
                    ? t('auto.deciding')
                    : t('auto.detecting', { p: detectTask && detectTask.percent ? detectTask.percent : 0 }))
                  : t('auto.detect')),
                h('button', {
                  type: 'button',
                  className: 'vsr-btn primary',
                  disabled: autoBusy || !envReady || !form.videoPath.trim(),
                  onClick: () => { autoRun() },
                }, t('auto.full')),
              ),
            ),

            h('div', { className: 'vsr-row vsr-source-row' },
              h('span', { className: 'vsr-label vsr-source-label' }, t('form.video')),
              h('input', {
                className: 'vsr-input',
                value: form.videoPath,
                spellCheck: false,
                placeholder: t('form.videoPlaceholder'),
                onChange: (event) => update({ videoPath: event.target.value }),
              }),
              h('button', {
                type: 'button',
                className: 'vsr-btn',
                onClick: () => setBrowse({ mode: 'video', initialPath: form.videoPath.trim() }),
              }, t('form.browse')),
            ),
            probing
              ? h('div', { className: 'vsr-hint vsr-source-meta' }, t('form.probing'))
              : probe && probe.ok
                ? h('div', { className: 'vsr-hint vsr-source-meta' }, t('form.probe', {
                  w: probe.width,
                  h: probe.height,
                  fps: Number(probe.fps || 0).toFixed(2).replace(/\.00$/, ''),
                  frames: probe.frames || 0,
                  duration: fmtDuration(t, probe.duration),
                }))
                : probe && probe.ok === false
                  ? h('div', { className: 'vsr-hint vsr-source-meta vsr-error' }, t('form.probeFailed', { message: probe.message || '' }))
                  : null,

            h('div', { className: 'vsr-stage' },
              h(RegionEditor, {
                t,
                src: frameUrl,
                areas: form.areas,
                selected: selectedArea,
                onSelect: setSelectedArea,
                onChange: setAreas,
              }),
              h('div', { className: 'vsr-area-side' },
                h('div', { className: 'vsr-area-head' },
                  h('div', { className: 'vsr-card-title' }, `${t('editor.areas')} ${form.areas.length}`),
                  h('div', { className: 'vsr-area-head-actions' },
                    h('button', {
                      type: 'button',
                      className: 'vsr-btn small',
                      disabled: form.areas.length >= MAX_AREAS,
                      onClick: addArea,
                    }, t('editor.add')),
                    form.areas.length
                      ? h('button', {
                        type: 'button',
                        className: 'vsr-btn small',
                        onClick: () => { setAreas([]); setSelectedArea(-1) },
                      }, t('editor.clear'))
                      : null,
                  ),
                ),
                form.areas.length
                  ? h('div', { className: 'vsr-area-list' },
                    form.areas.map((area, index) => h('div', {
                      key: `row-${index}`,
                      className: `vsr-area-row${index === selectedArea ? ' on' : ''}`,
                      onMouseDown: () => setSelectedArea(index),
                    },
                    h('div', { className: 'vsr-area-row-head' },
                      h('span', { className: 'vsr-area-index' }, `#${index + 1}`),
                      h('button', {
                        type: 'button',
                        className: 'vsr-icon-btn',
                        title: t('editor.delete'),
                        onClick: (event) => { event.stopPropagation(); removeArea(index) },
                      }, '×'),
                    ),
                    h('div', { className: 'vsr-area-inputs' },
                      h('div', { className: 'vsr-num' },
                        h('span', null, t('editor.yMin')),
                        h('input', {
                          className: 'vsr-mini', type: 'number', min: 0, max: 100, step: 0.5,
                          value: area.yMin, onChange: (event) => updateArea(index, 'yMin', event.target.value),
                        })),
                      h('div', { className: 'vsr-num' },
                        h('span', null, t('editor.yMax')),
                        h('input', {
                          className: 'vsr-mini', type: 'number', min: 0, max: 100, step: 0.5,
                          value: area.yMax, onChange: (event) => updateArea(index, 'yMax', event.target.value),
                        })),
                      h('div', { className: 'vsr-num' },
                        h('span', null, t('editor.xMin')),
                        h('input', {
                          className: 'vsr-mini', type: 'number', min: 0, max: 100, step: 0.5,
                          value: area.xMin, onChange: (event) => updateArea(index, 'xMin', event.target.value),
                        })),
                      h('div', { className: 'vsr-num' },
                        h('span', null, t('editor.xMax')),
                        h('input', {
                          className: 'vsr-mini', type: 'number', min: 0, max: 100, step: 0.5,
                          value: area.xMax, onChange: (event) => updateArea(index, 'xMax', event.target.value),
                        })),
                    ))))
                  : h('div', { className: 'vsr-hint' }, t('editor.none')),
                h('div', { className: 'vsr-hint vsr-area-tip' }, t('editor.hint')),
              ),
            ),

            h('div', { className: 'vsr-range' },
              h('div', { className: 'vsr-time' },
                h('span', { className: 'vsr-label' }, t('editor.start')),
                h('input', {
                  type: 'range',
                  min: 0,
                  max: Math.max(0.1, duration || 1),
                  step: 0.1,
                  value: Number(form.rangeStart) || 0,
                  disabled: !duration,
                  onChange: (event) => {
                    const next = Number(event.target.value)
                    update({ rangeStart: round1(clamp(next, 0, Math.max(0, (Number(form.rangeEnd) || duration) - 0.2))) })
                  },
                }),
                h('span', { className: 'vsr-time-value' }, `${(Number(form.rangeStart) || 0).toFixed(1)}s`),
              ),
              h('div', { className: 'vsr-time' },
                h('span', { className: 'vsr-label' }, t('editor.end')),
                h('input', {
                  type: 'range',
                  min: 0,
                  max: Math.max(0.1, duration || 1),
                  step: 0.1,
                  value: Number(form.rangeEnd) || 0,
                  disabled: !duration,
                  onChange: (event) => {
                    const next = Number(event.target.value)
                    update({ rangeEnd: round1(clamp(next, (Number(form.rangeStart) || 0) + 0.2, duration || next)) })
                  },
                }),
                h('span', { className: 'vsr-time-value' }, `${(Number(form.rangeEnd) || 0).toFixed(1)}s`),
              ),
              h('div', { className: 'vsr-range-foot' },
                h('div', { className: 'vsr-view-tabs' },
                  h('span', { className: 'vsr-hint' }, t('editor.frame')),
                  h('button', {
                    type: 'button',
                    className: `vsr-tab${viewSide === 'start' ? ' on' : ''}`,
                    onClick: () => setViewSide('start'),
                  }, t('editor.startFrame')),
                  h('button', {
                    type: 'button',
                    className: `vsr-tab${viewSide === 'end' ? ' on' : ''}`,
                    onClick: () => setViewSide('end'),
                  }, t('editor.endFrame')),
                ),
                h('div', { className: 'vsr-range-actions' },
                  h('span', { className: 'vsr-hint' }, t('editor.rangeHint')),
                  h('button', {
                    type: 'button',
                    className: 'vsr-btn small',
                    disabled: !duration,
                    onClick: () => update({ rangeStart: 0, rangeEnd: round1(duration) }),
                  }, t('editor.fullRange')),
                ),
              ),
            ),
          ),

          // Settings -------------------------------------------------------
          h('section', { className: 'vsr-card' },
            h('div', { className: 'vsr-card-head' },
              h('div', { className: 'vsr-card-title' }, t('form.title')),
              running ? h('span', { className: 'vsr-badge tone-busy' }, t('form.busy')) : null,
            ),
            h('div', { className: 'vsr-settings' },
              h(Field, { label: t('form.mode') },
                h('select', {
                  className: 'vsr-select',
                  value: form.mode,
                  onChange: (event) => update({ mode: event.target.value }),
                }, modeOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
              ),
              h(Field, { label: t('form.detect'), hint: t('form.detectHint') },
                h('select', {
                  className: 'vsr-select',
                  value: form.detectMode,
                  onChange: (event) => update({ detectMode: event.target.value }),
                },
                h('option', { value: 'server' }, t('detect.server')),
                h('option', { value: 'mobile' }, t('detect.mobile')),
                ),
              ),
              h(Field, { label: t('form.saveDir') },
                h('div', { className: 'vsr-row' },
                  h('input', {
                    className: 'vsr-input',
                    value: form.saveDir,
                    spellCheck: false,
                    placeholder: t('form.saveDirPlaceholder'),
                    onChange: (event) => update({ saveDir: event.target.value }),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'vsr-btn',
                    onClick: () => setBrowse({ mode: 'dir', initialPath: form.saveDir.trim() || form.videoPath.trim() }),
                  }, t('form.browse')),
                ),
              ),
              h(Field, {
                label: t('form.collision'),
                hint: t('form.collisionHint'),
              },
              h('select', {
                className: 'vsr-select',
                value: form.collision,
                onChange: (event) => update({ collision: event.target.value === 'rename' ? 'rename' : 'overwrite' }),
              },
              h('option', { value: 'overwrite' }, t('form.collisionOverwrite')),
              h('option', { value: 'rename' }, t('form.collisionRename')),
              ),
              ),
            ),
            h('div', { className: 'vsr-actions' },
              h('button', {
                type: 'button',
                className: 'vsr-btn primary block',
                disabled: busy || running || detecting || !envReady || !form.videoPath.trim(),
                onClick: () => { startJob() },
              }, busy ? t('form.submitting') : running ? t('form.busy') : t('form.submit')),
            ),
          ),

          // Job + history --------------------------------------------------
          h('div', { className: 'vsr-grid' },
            h('section', { className: 'vsr-card vsr-job-card' },
              h('div', { className: 'vsr-card-head' },
                h('div', { className: 'vsr-card-title' }, t('job.title')),
                shown ? h(StatusBadge, { job: shown, t }) : null,
              ),
              shown
                ? h(JobBody, { job: shown, t, onCancel: cancelJob, onRemove: removeJob, onCopy: copyPath, onOpen: openOutput })
                : h('div', { className: 'vsr-empty' },
                  h('div', { className: 'vsr-empty-title' }, t('job.empty')),
                  h('div', { className: 'vsr-hint' }, t('job.emptyHint'))),
            ),
            h('section', { className: 'vsr-card' },
              h('div', { className: 'vsr-card-head' },
                h('div', { className: 'vsr-card-title' }, t('history.title')),
                h('div', { className: 'vsr-card-count' }, String(jobs.length)),
              ),
              jobs.length
                ? h('div', { className: 'vsr-list' },
                  jobs.map((job) => h('div', {
                    key: job.id,
                    className: `vsr-item${job.id === (shown && shown.id) ? ' on' : ''}`,
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => { setSelectedId(job.id); reload() },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedId(job.id)
                        reload()
                      }
                    },
                  },
                  h('i', { className: `vsr-dot ${statusTone(job) === 'ok' ? 'ok' : statusTone(job) === 'err' ? 'err' : statusTone(job) === 'busy' ? 'warn' : ''}` }),
                  h('span', { className: 'vsr-item-name', title: job.videoPath }, job.videoName),
                  job.status === 'running' ? h('span', { className: 'vsr-item-progress' }, `${job.percent}%`) : null,
                  h('span', { className: 'vsr-badge subtle' }, t(`stage.${stageKey(job)}`)),
                  job.status === 'done' && job.outputExists
                    ? h('button', {
                      type: 'button',
                      className: 'vsr-open-btn',
                      title: t('job.openFile'),
                      onClick: (event) => { event.stopPropagation(); openOutput(job.id, 'file') },
                    }, '↗')
                    : null,
                  h('span', { className: 'vsr-item-time' }, fmtClock(job.createdAt)),
                  )))
                : h('div', { className: 'vsr-empty' }, t('history.empty')),
            ),
          ),
        ),

        browse
          ? h(BrowseDialog, {
            t,
            mode: browse.mode,
            initialPath: browse.initialPath,
            onCancel: () => setBrowse(null),
            onPick: (picked) => {
              if (browse.mode === 'dir') update({ saveDir: picked })
              else update({ videoPath: picked })
              setBrowse(null)
            },
          })
          : null,
      )
    }

    function JobBody(props) {
      const { job, t, onCancel, onRemove, onCopy } = props
      const percent = clamp(Number(job.percent) || 0, 0, 100)
      const startedAt = job.startedAt || job.createdAt || 0
      const until = job.finishedAt || Date.now()
      const elapsed = startedAt ? Math.max(0, (until - startedAt) / 1000) : 0
      const eta = job.status === 'running' && percent > 0 && percent < 100
        ? Math.max(0, (elapsed / percent) * (100 - percent))
        : 0
      const speed = elapsed > 0 && job.total && percent > 0 ? (job.total * percent) / 100 / elapsed : 0
      const areas = Array.isArray(job.areas) ? job.areas : []
      const live = job.status === 'running' || job.status === 'queued'
      const previewSeq = Number(job.previewSeq) || 0
      const showPreview = previewSeq > 0 || live
      const previewFrame = job.total && previewSeq
        ? Math.round((job.total * (Number(job.previewPercent) || 0)) / 100)
        : 0
      return h('div', { className: 'vsr-job' },
        h('div', { className: 'vsr-job-title', title: job.videoPath }, job.videoName),
        h('div', { className: 'vsr-progress-row' },
          h('div', { className: 'vsr-progress' }, h('i', { style: { width: `${percent}%` } })),
          h('span', { className: 'vsr-progress-value' }, `${Math.round(percent)}%`),
        ),
        h('div', { className: 'vsr-hint' }, job.message || ''),
        showPreview
          ? h('div', { className: 'vsr-preview' },
            h('div', { className: 'vsr-preview-head' },
              h('span', { className: 'vsr-preview-title' }, t('job.preview')),
              previewSeq
                ? h('span', { className: 'vsr-hint' }, t('job.previewFrame', {
                  n: previewFrame || '—',
                  p: Math.round(Number(job.previewPercent) || 0),
                }))
                : null,
            ),
            h('div', { className: 'vsr-preview-panes' },
              h('div', { className: 'vsr-preview-pane' },
                h('span', { className: 'vsr-preview-label' }, t('job.previewBefore')),
                previewSeq
                  ? h('img', {
                    src: `${API}/jobs/${encodeURIComponent(job.id)}/preview/left?seq=${previewSeq}`,
                    alt: t('job.previewBefore'),
                  })
                  : h('div', { className: 'vsr-preview-empty' }, t('job.previewWaiting'))),
              h('div', { className: 'vsr-preview-pane' },
                h('span', { className: 'vsr-preview-label' }, t('job.previewAfter')),
                previewSeq
                  ? h('img', {
                    src: `${API}/jobs/${encodeURIComponent(job.id)}/preview/right?seq=${previewSeq}`,
                    alt: t('job.previewAfter'),
                  })
                  : h('div', { className: 'vsr-preview-empty' }, '—')),
            ),
          )
          : null,
        h('dl', { className: 'vsr-meta' },
          h('div', null, h('dt', null, t('job.frames')), h('dd', null,
            job.total ? `${job.frames || 0} / ${job.total}` : '—')),
          h('div', null, h('dt', null, t('job.elapsed')), h('dd', null, fmtDuration(t, elapsed))),
          h('div', null, h('dt', null, t('job.eta')), h('dd', null, live && eta ? fmtDuration(t, eta) : '—')),
          h('div', null, h('dt', null, t('job.speed')),
            h('dd', null, live && speed ? t('unit.framesPerSecond', { n: speed.toFixed(2) }) : '—')),
          h('div', null, h('dt', null, t('job.mode')), h('dd', null, t(MODE_LABEL_KEY[job.mode] || 'job.mode'))),
          h('div', null, h('dt', null, t('job.area')), h('dd', null, t('job.areaValue', { n: areas.length }))),
          job.range
            ? h('div', null, h('dt', null, t('job.range')),
              h('dd', null, `${Number(job.range.start).toFixed(1)}–${Number(job.range.end).toFixed(1)}s`))
            : null,
        ),
        areas.length
          ? h('div', { className: 'vsr-job-areas' },
            areas.map((area, index) => h('span', { key: index, className: 'vsr-area-chip' },
              `#${index + 1} ${area.yMin}–${area.yMax}% · ${area.xMin}–${area.xMax}%`)))
          : null,
        job.outputPath
          ? h('div', { className: 'vsr-out' },
            h('span', { className: 'vsr-out-label' }, t('job.output')),
            h('code', { title: job.outputPath }, job.outputPath),
            job.status === 'done' && job.outputExists === false
              ? h('span', { className: 'vsr-hint vsr-error' }, t('job.outputMissing'))
              : null,
            h('button', { type: 'button', className: 'vsr-btn', onClick: () => onCopy(job.outputPath) }, t('job.copy')),
          )
          : null,
        h('div', { className: 'vsr-job-actions' },
          job.status === 'done' && job.outputExists
            ? h('button', { type: 'button', className: 'vsr-btn primary', onClick: () => onOpen(job.id, 'file') }, t('job.openFile'))
            : null,
          job.status === 'done' && job.outputExists
            ? h('button', { type: 'button', className: 'vsr-btn', onClick: () => onOpen(job.id, 'folder') }, t('job.openFolder'))
            : null,
          live
            ? h('button', { type: 'button', className: 'vsr-btn danger', onClick: () => onCancel(job.id) }, t('job.cancel'))
            : h('button', { type: 'button', className: 'vsr-btn', onClick: () => onRemove(job.id) }, t('job.remove')),
        ),
        h('details', { className: 'vsr-log' },
          h('summary', null, t('job.log', { n: job.logLines || (job.log ? job.log.length : 0) })),
          job.log && job.log.length
            ? h('pre', null, job.log.join('\n'))
            : h('div', { className: 'vsr-hint' }, t('job.logEmpty')),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Form persistence
    // -----------------------------------------------------------------------

    function defaultForm() {
      return {
        videoPath: '',
        mode: 'sttn-auto',
        detectMode: 'server',
        areas: [],
        saveDir: '',
        collision: 'overwrite',
        rangeStart: 0,
        rangeEnd: 0,
        modelKey: '',
      }
    }

    function sanitizeArea(raw) {
      if (!raw || typeof raw !== 'object') return null
      const pick = (value, fallback) => {
        const n = Number(value)
        return Number.isFinite(n) ? round1(clamp(n, 0, 100)) : fallback
      }
      const area = {
        yMin: pick(raw.yMin, 85), yMax: pick(raw.yMax, 99),
        xMin: pick(raw.xMin, 10), xMax: pick(raw.xMax, 90),
      }
      if (area.yMax - area.yMin < 0.5 || area.xMax - area.xMin < 0.5) return null
      return area
    }

    function loadForm() {
      const base = defaultForm()
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return base
        const saved = JSON.parse(raw)
        if (!saved || typeof saved !== 'object') return base
        const areas = Array.isArray(saved.areas)
          ? saved.areas.map(sanitizeArea).filter(Boolean).slice(0, MAX_AREAS)
          : []
        return {
          videoPath: typeof saved.videoPath === 'string' ? saved.videoPath : '',
          mode: MODES.includes(saved.mode) ? saved.mode : base.mode,
          detectMode: saved.detectMode === 'mobile' ? 'mobile' : 'server',
          areas,
          saveDir: typeof saved.saveDir === 'string' ? saved.saveDir : '',
          collision: saved.collision === 'rename' ? 'rename' : 'overwrite',
          rangeStart: Number.isFinite(Number(saved.rangeStart))
            ? Math.max(0, Number(saved.rangeStart))
            : (Number.isFinite(Number(saved.frameTime)) ? Math.max(0, Number(saved.frameTime)) : 0),
          rangeEnd: Number.isFinite(Number(saved.rangeEnd)) ? Math.max(0, Number(saved.rangeEnd)) : 0,
          modelKey: typeof saved.modelKey === 'string' ? saved.modelKey : '',
        }
      } catch {
        return base
      }
    }

    // -----------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------

    const CSS = `
.vsr-root { height: 100%; min-height: 0; overflow: auto; padding: 20px 24px 48px; box-sizing: border-box; color: var(--dsw-alias-label-primary); }
.vsr-inner { max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.vsr-head { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.vsr-head-main { min-width: 0; }
.vsr-title { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; letter-spacing: .2px; }
.vsr-sub { margin: 6px 0 0; font-size: 13px; line-height: 1.6; max-width: 62ch; color: var(--dsw-alias-label-secondary); }
.vsr-env { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; min-width: 0; }
.vsr-chip { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vsr-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.vsr-dot.ok { background: var(--dsw-alias-state-success-primary); }
.vsr-dot.warn { background: var(--dsw-alias-state-warn-primary); }
.vsr-dot.err { background: var(--dsw-alias-state-error-primary); }
.vsr-env-line { font-size: 11px; color: var(--dsw-alias-label-secondary); max-width: 56ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.vsr-env-hint { max-width: 52ch; text-align: right; font-size: 11px; color: var(--dsw-alias-state-warn-primary); line-height: 1.5; }
.vsr-notice { padding: 8px 12px; border-radius: 9px; font-size: 12.5px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.vsr-notice.ok { border-color: var(--dsw-alias-state-success-primary); }
.vsr-notice.error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.vsr-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px; box-sizing: border-box; min-width: 0; }
.vsr-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.vsr-card-title { font-size: 13px; font-weight: 600; }
.vsr-card-count { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vsr-card-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.vsr-field { display: flex; flex-direction: column; gap: 6px; }
.vsr-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vsr-hint { font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.vsr-error { color: var(--dsw-alias-state-error-primary); }
.vsr-input, .vsr-select { height: 32px; min-width: 0; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); padding: 0 10px; font-size: 13px; font-family: inherit; outline: none; box-sizing: border-box; }
.vsr-select { padding-right: 6px; }
.vsr-select.small { height: 28px; font-size: 12px; max-width: 250px; }
.vsr-model { display: flex; align-items: center; gap: 6px; min-width: 0; }
.vsr-model > .vsr-hint { white-space: nowrap; }
.vsr-input:focus, .vsr-select:focus, .vsr-mini:focus { border-color: var(--dsw-alias-brand-primary); }
.vsr-row { display: flex; gap: 8px; align-items: center; min-width: 0; }
.vsr-row > .vsr-input { flex: 1 1 auto; }
.vsr-btn { height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12.5px; font-family: inherit; cursor: pointer; white-space: nowrap; flex: none; }
.vsr-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.vsr-btn:disabled { opacity: .5; cursor: not-allowed; }
.vsr-btn.small { height: 26px; padding: 0 8px; font-size: 11.5px; border-radius: 7px; }
.vsr-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
.vsr-btn.danger { color: var(--dsw-alias-state-error-primary); }
.vsr-btn.block { width: 100%; height: 36px; }
.vsr-icon-btn { width: 22px; height: 22px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 1; cursor: pointer; font-family: inherit; padding: 0; }
.vsr-icon-btn:hover { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-border-l1); }
.vsr-source-row { margin-bottom: 6px; }
.vsr-source-label { flex: none; }
.vsr-source-meta { margin: 0 0 12px; }
.vsr-stage { display: flex; gap: 12px; align-items: stretch; margin-top: 10px; }
.vsr-frame-wrap { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; justify-content: center; padding: 8px; border-radius: 10px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); min-height: 180px; }
.vsr-frame { position: relative; display: inline-block; line-height: 0; cursor: crosshair; touch-action: none; user-select: none; }
.vsr-frame img { display: block; max-width: 100%; max-height: 380px; width: auto; height: auto; min-width: 260px; min-height: 150px; object-fit: contain; user-select: none; -webkit-user-drag: none; }
.vsr-frame-empty { padding: 28px 18px; text-align: center; max-width: 46ch; }
.vsr-frame-overlay-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 12px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); }
.vsr-rect { position: absolute; border: 1.5px solid var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); border-radius: 3px; pointer-events: none; box-sizing: border-box; }
.vsr-rect.on { border-color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); }
.vsr-rect.draft { border-style: dashed; }
.vsr-rect-index { position: absolute; top: -9px; left: -1px; min-width: 16px; height: 16px; padding: 0 3px; border-radius: 4px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 10px; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }
.vsr-rect-handle { position: absolute; right: -4px; bottom: -4px; width: 8px; height: 8px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.vsr-area-side { flex: 0 0 264px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.vsr-area-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.vsr-area-head-actions { display: flex; gap: 6px; }
.vsr-area-list { display: flex; flex-direction: column; gap: 6px; max-height: 280px; overflow: auto; }
.vsr-area-row { padding: 6px 7px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); cursor: pointer; }
.vsr-area-row.on { border-color: var(--dsw-alias-brand-primary); }
.vsr-area-row-head { display: flex; align-items: center; justify-content: space-between; }
.vsr-area-index { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.vsr-area-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 6px; margin-top: 4px; }
.vsr-num { display: flex; align-items: center; gap: 4px; min-width: 0; }
.vsr-num span { flex: none; width: 18px; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.vsr-mini { flex: 1 1 auto; min-width: 0; height: 24px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 11px; font-family: inherit; text-align: right; padding: 0 5px; box-sizing: border-box; outline: none; }
.vsr-area-tip { margin-top: auto; }
.vsr-time { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.vsr-time input[type=range] { flex: 1 1 auto; min-width: 0; accent-color: var(--dsw-alias-brand-primary); }
.vsr-time-value { flex: none; font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; min-width: 48px; text-align: right; }
.vsr-range { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
.vsr-range .vsr-time { margin-top: 0; }
.vsr-range-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
.vsr-view-tabs { display: flex; align-items: center; gap: 6px; }
.vsr-tab { height: 24px; padding: 0 9px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-family: inherit; cursor: pointer; }
.vsr-tab.on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.vsr-range-actions { display: flex; align-items: center; gap: 8px; }
.vsr-range-actions .vsr-hint { max-width: 36ch; }
.vsr-preview { margin-top: 12px; padding: 8px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.vsr-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px 6px; }
.vsr-preview-title { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vsr-preview-panes { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.vsr-preview-pane { position: relative; min-width: 0; min-height: 92px; display: flex; align-items: center; justify-content: center; border-radius: 7px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); }
.vsr-preview-pane img { display: block; width: 100%; height: auto; max-height: 220px; object-fit: contain; }
.vsr-preview-label { position: absolute; top: 4px; left: 4px; z-index: 1; padding: 1px 6px; border-radius: 4px; background: rgba(0, 0, 0, .55); color: #fff; font-size: 10px; }
.vsr-preview-empty { padding: 16px 8px; text-align: center; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vsr-open-btn { flex: none; width: 22px; height: 22px; padding: 0; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1; font-family: inherit; cursor: pointer; }
.vsr-open-btn:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.vsr-settings { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; }
.vsr-actions { display: flex; gap: 8px; margin-top: 14px; }
.vsr-progress-row { display: flex; align-items: center; gap: 10px; margin: 4px 0 8px; }
.vsr-progress { flex: 1 1 auto; height: 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.vsr-progress > i { display: block; height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width .45s ease; }
.vsr-progress-value { flex: none; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); min-width: 38px; text-align: right; }
.vsr-job-title { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vsr-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 12px 16px; margin: 14px 0 0; }
.vsr-meta dt { margin: 0 0 3px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vsr-meta dd { margin: 0; font-size: 13px; font-variant-numeric: tabular-nums; }
.vsr-job-areas { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.vsr-area-chip { font-size: 11px; padding: 2px 7px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.vsr-out { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding: 8px 10px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); min-width: 0; }
.vsr-out-label { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vsr-out code { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.vsr-job-actions { display: flex; gap: 8px; margin-top: 14px; }
.vsr-log { margin-top: 12px; }
.vsr-log summary { cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vsr-log pre { margin: 8px 0 0; max-height: 220px; overflow: auto; padding: 10px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.vsr-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.vsr-list { display: flex; flex-direction: column; gap: 2px; }
.vsr-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border-radius: 9px; border: 1px solid transparent; background: transparent; color: inherit; font-family: inherit; text-align: left; cursor: pointer; }
.vsr-item:hover { background: var(--dsw-alias-bg-layer-2); }
.vsr-item.on { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.vsr-item-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.vsr-item-progress { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-brand-primary); }
.vsr-item-time { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.vsr-badge { flex: none; font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.vsr-badge.tone-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.vsr-badge.tone-err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.vsr-badge.tone-busy { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.vsr-badge.subtle { border-color: transparent; }
.vsr-empty { padding: 26px 12px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.vsr-empty-title { font-size: 13px; color: var(--dsw-alias-label-primary); margin-bottom: 6px; }
.vsr-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .34); }
.vsr-dialog { display: flex; flex-direction: column; width: min(720px, 100%); max-height: min(78vh, 660px); border-radius: 14px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); box-shadow: 0 24px 64px rgba(0, 0, 0, .32); overflow: hidden; outline: none; }
.vsr-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px 10px; }
.vsr-dialog-bar { display: flex; align-items: center; gap: 8px; padding: 0 16px 10px; }
.vsr-dialog-bar .vsr-input { flex: 1 1 auto; }
.vsr-drives { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 0 16px 10px; }
.vsr-chip-btn { height: 24px; padding: 0 9px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-family: inherit; cursor: pointer; }
.vsr-dialog-body { flex: 1 1 auto; overflow: auto; padding: 4px 10px 10px; min-height: 160px; }
.vsr-group { padding: 4px 0 8px; }
.vsr-group-title { padding: 4px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vsr-row-btn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 0; border-radius: 7px; background: transparent; color: inherit; font-family: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }
.vsr-row-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.vsr-glyph { flex: none; color: var(--dsw-alias-label-secondary); }
.vsr-row-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vsr-row-meta { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.vsr-dialog-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.vsr-nav-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; color: inherit; }
.vsr-nav-pulse { position: absolute; right: -2px; bottom: -2px; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px var(--dsw-specific-sidebar-fill); animation: vsr-pulse 1.4s ease-in-out infinite; }
@keyframes vsr-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.8); } }
@media (max-width: 980px) {
  .vsr-grid { grid-template-columns: minmax(0, 1fr); }
  .vsr-stage { flex-direction: column; }
  .vsr-area-side { flex: 1 1 auto; }
}
`

    // -----------------------------------------------------------------------
    // Apply
    // -----------------------------------------------------------------------

    function PanelEntryIcon() {
      const live = useActivity()
      return h(PanelIcon, { size: 16, activity: live })
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      let locale = null
      try {
        const candidate = ctx.get('locale')
        if (candidate && typeof candidate.register === 'function') locale = candidate
      } catch { locale = null }

      if (locale) {
        try {
          ctx.effect(() => locale.register(NS, { zh: I18N.zh, en: I18N.en }))
        } catch {
          try { ctx.effect(() => locale.register(NS, 'zh', I18N.zh)) } catch { /* already registered */ }
          try { ctx.effect(() => locale.register(NS, 'en', I18N.en)) } catch { /* already registered */ }
        }
      }

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-plugin', NS)
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { if (tag.parentNode) tag.parentNode.removeChild(tag) }
      })

      const label = () => {
        if (locale && typeof locale.bind === 'function') {
          try {
            const translate = locale.bind(NS)
            const value = translate('nav')
            if (value && value !== 'nav') return value
          } catch { /* fall back */ }
        }
        return I18N.zh.nav
      }

      const rowMeta = { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label }
      if (locale) rowMeta.locale = NS
      slots.inject('sidebar.panellist', () => slots.register(rowMeta, function SidebarEntry() {
        return h(PanelEntryIcon, null)
      }))

      const pageMeta = { name: 'main', key: PANEL_ID }
      if (locale) pageMeta.locale = NS
      slots.inject('main', () => slots.register(pageMeta, function MainPanel(ownerProps) {
        return h(Page, Object.assign({}, ownerProps, { t: typeof ownerProps.t === 'function' ? ownerProps.t : fallbackT }))
      }))
    }

    return { name: NS, inject: ['slots'], apply }
  },
})
