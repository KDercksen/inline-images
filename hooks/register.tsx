import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { Pasted } from '../types'

// Draws pictures inline in the terminal transcript, with no command to run:
// - images pasted into a prompt (and image paths typed in it), under that prompt;
// - image paths Claude writes in a reply, under that reply block;
// - screenshots a browser or computer-use (MCP) tool returns, under the result.
// Tool output is never searched for paths: a listing or search stays text.
// Everything is converted to PNG with macOS `sips` into a private cache folder
// and handed to the terminal by file name; nothing leaves the machine.

const MAX_COLUMNS = 80
const MAX_ROWS = 24
/** Pictures drawn under one row; any more ready ones are counted in a "+N more" line. */
const MAX_SHOWN = 12
/** Sources looked at per row (a job each), so a long list of paths stays bounded. */
const MAX_CHECKED = 50
/** Several pictures draw as a grid of thumbnails about this wide, at most this tall. */
const THUMB_COLUMNS = 26
const THUMB_ROWS = 12
const GAP = 2
/** Longest side of the PNG handed to the terminal. */
const MAX_SIDE = 1600
/** Files larger than this are not converted. */
const MAX_FILE_BYTES = 50 * 1024 * 1024
const EXT = 'png|jpe?g|gif|webp|heic|bmp|tiff?'

const pasted = atom({ plugin: 'inline-images', key: 'pasted' } as const, [] as Pasted[], {
  shape: 'pasted-1',
})

/** `file` is the PNG drawn; `original` the file a click opens at full size. */
type Prepared = { file: string; width: number; height: number; original: string }
type Inline = { data: string; mime: string }

// ---------------------------------------------------------------------------
// Preparing pictures: a job per source, remembered for the module's life.

const done = new Map<string, Prepared | null>()
const running = new Map<string, Promise<Prepared | null>>()

/** The prepared picture, null when it cannot be shown, undefined while unknown (a job starts). */
function peek($: EngineInterface, key: string, job: () => Promise<Prepared | null>): Prepared | null | undefined {
  if (done.has(key)) return done.get(key)
  if (!running.has(key)) {
    const run = job()
      .catch(() => null)
      .then(result => {
        done.set(key, result)
        running.delete(key)
        $.ui.invalidate('ui.render')
        return result
      })
    running.set(key, run)
  }
  return undefined
}

let cacheDir: Promise<string> | undefined

function ensureCacheDir($: EngineInterface): Promise<string> {
  cacheDir ??= (async () => {
    const home = (await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout.trim()
    if (home === '') throw new Error('no HOME')
    const dir = `${home}/.cache/claude-inline-images`
    const made = await $.process.run(['sh', '-c', 'mkdir -p "$1" && chmod 700 "$1"', 'sh', dir])
    if (made.exitCode !== 0) throw new Error(made.stderr)
    return dir
  })().catch(error => {
    cacheDir = undefined
    throw error
  })
  return cacheDir
}

async function digest(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(hash.slice(0, 12), b => b.toString(16).padStart(2, '0')).join('')
}

async function probe($: EngineInterface, file: string): Promise<{ width: number; height: number } | null> {
  const out = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file])
  const width = Number(/pixelWidth:\s*(\d+)/.exec(out.stdout)?.[1])
  const height = Number(/pixelHeight:\s*(\d+)/.exec(out.stdout)?.[1])
  return out.exitCode === 0 && width > 0 && height > 0 ? { width, height } : null
}

/** A PNG of `source` no larger than MAX_SIDE, in the cache unless the source already is one. */
async function toPng($: EngineInterface, source: string, name: string): Promise<Prepared | null> {
  const original = source
  const dir = await ensureCacheDir($)
  const out = `${dir}/${name}.png`
  if (await $.fs.exists(out)) {
    const size = await probe($, out)
    return size && { file: out, original, ...size }
  }
  const size = await probe($, source)
  if (!size) return null
  const isPng = /\.png$/i.test(source)
  if (isPng && Math.max(size.width, size.height) <= MAX_SIDE) return { file: source, original, ...size }

  const shrink = Math.max(size.width, size.height) > MAX_SIDE ? ['-Z', String(MAX_SIDE)] : []
  const made = await $.process.run(['sips', '-s', 'format', 'png', ...shrink, source, '--out', out])
  if (made.exitCode !== 0) return null
  const final = await probe($, out)
  return final && { file: out, original, ...final }
}

async function prepareFile($: EngineInterface, path: string): Promise<Prepared | null> {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath
  if (!stat || !real || stat.kind !== 'file' || stat.size === 0 || stat.size > MAX_FILE_BYTES) return null
  if (/^\/(dev|proc|sys)\//.test(real)) return null
  const name = await digest(`${real}\0${stat.size}\0${stat.mtimeMs}`)
  // The cache name says nothing about the source format, so give sips the real path.
  return toPng($, real, name)
}

async function prepareInline($: EngineInterface, image: Inline): Promise<Prepared | null> {
  const name = await digest(image.data)
  const dir = await ensureCacheDir($)
  const ext = image.mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
  const raw = `${dir}/${name}.src.${ext}`
  if (!(await $.fs.exists(raw))) {
    const written = await $.process.run(['sh', '-c', 'base64 -d > "$1"', 'sh', raw], { stdin: image.data })
    if (written.exitCode !== 0) return null
  }
  return toPng($, raw, name)
}

// ---------------------------------------------------------------------------
// Finding pictures.

const BACKTICKED = new RegExp(`\`([^\`\\n]+?\\.(?:${EXT}))\``, 'gi')
const LINKED = new RegExp(`\\]\\(([^)\\s]+?\\.(?:${EXT}))\\)`, 'gi')
const BARE = new RegExp(
  `(?:^|[\\s'"(<\\[=:])((?:file://)?(?:~|\\.{1,2})?/?[^\\s\`'"()<>\\[\\]]+\\.(?:${EXT}))(?=$|[\\s\`'")>\\],;:!?]|\\.(?:\\s|$))`,
  'gim',
)

/** Local image paths a text names, in order, without repeats; URLs are skipped. */
function pathsIn(text: string): string[] {
  const found: string[] = []
  for (const pattern of [BACKTICKED, LINKED, BARE]) {
    for (const match of text.matchAll(pattern)) {
      let path = (match[1] ?? '').trim().replace(/^file:\/\//i, '')
      if (/^[a-z][a-z0-9+.-]*:/i.test(path)) continue
      try {
        path = decodeURIComponent(path)
      } catch {
        // Not percent-encoded: keep as written.
      }
      if (!found.includes(path)) found.push(path)
    }
  }
  return found
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Image blocks in a tool's stored result: Read's, MCP's (`data`), or Messages API's (`source`). */
function imagesIn(output: unknown, depth = 0): Inline[] {
  if (depth > 4) return []
  if (Array.isArray(output)) return output.flatMap(item => imagesIn(item, depth + 1))
  if (!isRecord(output)) return []
  if (output.type === 'image') {
    if (typeof output.data === 'string') {
      return [{ data: output.data, mime: typeof output.mimeType === 'string' ? output.mimeType : 'image/png' }]
    }
    const source = isRecord(output.source) ? output.source : isRecord(output.file) ? output.file : undefined
    const data = source?.data ?? source?.base64
    if (typeof data === 'string') {
      const mime = source?.media_type ?? source?.type
      return [{ data, mime: typeof mime === 'string' && mime.startsWith('image/') ? mime : 'image/png' }]
    }
  }
  return ['content', 'result', 'file'].flatMap(key => imagesIn(output[key], depth + 1))
}

// ---------------------------------------------------------------------------
// Drawing.

type Source = { key: string; label: string; job: () => Promise<Prepared | null> }

function fileSource($: EngineInterface, path: string): Source {
  return { key: `file:${path}`, label: path, job: () => prepareFile($, path) }
}

function inlineSource($: EngineInterface, image: Inline, label: string): Source {
  return {
    key: `inline:${image.data.length}:${image.data.slice(0, 64)}:${image.data.slice(-64)}`,
    label,
    job: () => prepareInline($, image),
  }
}

/** Cells for a picture: aspect kept (a cell is about twice as tall as wide), within the caps. */
function fit(width: number, height: number, maxColumns: number, maxRows: number) {
  const rowsPerColumn = (height / width) * 0.5
  let columns = Math.min(maxColumns, Math.max(8, Math.round(width / 10)))
  let rows = Math.max(1, Math.round(columns * rowsPerColumn))
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.round(rows / rowsPerColumn))
  }
  return { columns: Math.min(255, columns), rows: Math.min(255, rows) }
}

/**
 * The engine's own row with the ready pictures of `sources` under it: one at
 * full size, several as a grid of thumbnails. Sources still converting start a
 * job that redraws; ones that fail (a path that is no image) draw nothing.
 */
async function withPictures(
  $: EngineInterface,
  e: RenderInput,
  row: RenderElement,
  sources: Source[],
  indent: number,
): Promise<RenderElement> {
  const ready = sources
    .slice(0, MAX_CHECKED)
    .map(source => ({ source, picture: peek($, source.key, source.job) }))
    .filter((one): one is { source: Source; picture: Prepared } => !!one.picture)
  if (ready.length === 0) return row

  const { Box, Image, Link, Text } = $.ui.resolve(e) as any
  const room = Math.max(10, Math.min(MAX_COLUMNS, (e.viewport?.columns ?? 100) - indent - 2))
  const shown = ready.slice(0, MAX_SHOWN)
  const hidden = ready.length - shown.length

  const cell = ({ source, picture }: { source: Source; picture: Prepared }, columns: number, rows: number, label: string) => {
    const size = fit(picture.width, picture.height, columns, rows)
    return (
      <Box flexDirection="column" width={columns}>
        <Image source={{ file: picture.file, format: 'png' }} columns={size.columns} rows={size.rows} alt={`[image: ${source.label}]`} />
        <Link href={`file://${encodeURI(picture.original)}`} label={label} />
      </Box>
    )
  }

  let body
  if (shown.length === 1) {
    body = cell(shown[0]!, room, MAX_ROWS, 'open full size')
  } else {
    const perRow = Math.max(1, Math.min(shown.length, Math.floor((room + GAP) / (THUMB_COLUMNS + GAP))))
    const width = Math.floor((room - GAP * (perRow - 1)) / perRow)
    const lines = []
    for (let at = 0; at < shown.length; at += perRow) {
      lines.push(
        <Box flexDirection="row" columnGap={GAP}>
          {shown.slice(at, at + perRow).map(one => cell(one, width, THUMB_ROWS, 'open'))}
        </Box>,
      )
    }
    body = <Box flexDirection="column" rowGap={1}>{lines}</Box>
  }

  return (
    (<Box flexDirection="column">
      {row}
      <Box paddingLeft={indent} flexDirection="column">
        {body}
        {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
      </Box>
    </Box>) as RenderElement
  )
}

/** The prompt's text as both prompt.submit and the drawn row see it. */
function promptKey(text: string): string {
  return text.replace(/\[Image #\d+\]/g, '').replace(/\s+/g, '')
}

export const register: Register = on => {
  // Pasted images are readable only while their prompt is being submitted:
  // copy them to the cache now and remember them under the prompt's text.
  on('prompt.submit', async ($, e, next) => {
    const images = (e.attachments ?? []).filter(a => a.type === 'image' && a.id)
    if (images.length > 0) {
      try {
        const files: string[] = []
        for (const image of images) {
          let data = ''
          let offset: number | undefined
          let mime = image.mediaType ?? 'image/png'
          do {
            const media = await $.prompt.media({ id: image.id!, offset })
            if (media.deny !== undefined || media.unreadable !== undefined) break
            data += media.base64
            mime = media.mediaType
            offset = media.next
          } while (offset !== undefined)
          const picture = data === '' ? null : await prepareInline($, { data, mime })
          if (picture) files.push(picture.file)
        }
        if (files.length > 0) {
          const key = promptKey(e.text)
          await update($, pasted, list => [...list.filter(one => one.key !== key), { key, files }].slice(-50))
        }
      } catch {
        // A picture we cannot copy is simply not drawn; the prompt goes on.
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal') return row
    const key = promptKey(e.props.text)
    const sources: Source[] = []
    if (/\[Image #\d+\]/.test(e.props.text)) {
      const entry = (await read($, pasted)).find(one => one.key === key)
      for (const file of entry?.files ?? []) sources.push(fileSource($, file))
    }
    for (const path of pathsIn(e.props.text)) sources.push(fileSource($, path))
    return withPictures($, e, row, sources, 2)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal') return row
    return withPictures($, e, row, pathsIn(e.props.text).map(path => fileSource($, path)), 2)
  })

  // Screenshots a browser or computer-use tool sends back as image data (an
  // MCP tool's result). Paths in tool output (search, ls, Bash) are never
  // drawn, and neither are Reads of images: only what Claude puts forward in
  // a reply, and these screenshots, which have no path to put forward.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.isErrored || !e.props.tool.startsWith('mcp__')) return row
    const sources = imagesIn(e.props.output).map((image, i) => inlineSource($, image, `screenshot ${i + 1}`))
    return withPictures($, e, row, sources, 5)
  })
}
