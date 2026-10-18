import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import type { CharacterConfig, Emotion } from '../shared/types'

/**
 * "Add a character": takes a model the user picked (a .vrm, a Live2D .model3.json or its folder, a .pmx, a rigged
 * .fbx / .glb / .dae, or a .zip holding one of those), copies it into <user data>/character/<id>/model/, and writes a
 * character.json with sensible defaults (expressions mapped from the model's own names, pose toggles, licence from VRM
 * metadata) and a neutral starter persona.md. No Electron in here, so it runs under `npm test`.
 */

export type ModelKind = 'vrm' | 'live2d' | 'mmd' | 'rig'

export interface ImportResult {
  id: string
  dir: string
  config: CharacterConfig
  /** things the user should know: a licence that keeps the avatar to its author, files left behind */
  warnings: string[]
  /** the licence keeps the avatar to its author (or people the author names) */
  restricted: boolean
}

const MODEL_EXTS: [ModelKind, RegExp][] = [
  ['vrm', /\.vrm$/i],
  ['live2d', /\.model3\.json$/i],
  ['mmd', /\.pmx$/i],
  ['rig', /\.(?:fbx|glb|gltf|dae)$/i]
]

export function modelKind(file: string): ModelKind | null {
  return MODEL_EXTS.find(([, re]) => re.test(file))?.[0] ?? null
}

// ---- expression names → emotions

type Table = Record<Emotion, string>
const EMPTY: Table = { neutral: '', happy: '', flirty: '', surprised: '', annoyed: '', angry: '', sad: '', smug: '', shy: '' }

/**
 * What Live2D expression files tend to be called, per emotion, most telling first: English names from VTube Studio
 * rigs, the pinyin and Chinese of Bilibili models, the Japanese of nizima / Booth ones. Matched against the name
 * lower-cased, as a whole word or a prefix/suffix, never in the middle of another word.
 */
const LIVE2D_WORDS: Record<Exclude<Emotion, 'neutral'>, string[]> = {
  happy: ['happy', 'smile', 'joy', 'laugh', 'grin', 'xiao', 'kaixin', 'stareyes', 'stareye', 'star', 'sparkle', '笑', '开心', '高兴', '喜', '笑顔', 'えがお', '星星眼', '星眼'],
  flirty: ['hearteyes', 'hearteye', 'heart', 'loveeye', 'love', 'aixin', 'wink', 'kiss', '爱心', '心心眼', '比心', 'ハート', 'ウインク', '飞吻'],
  surprised: ['surprised', 'surprise', 'shock', 'shocked', 'amazed', 'jingya', 'chijing', 'astonish', '惊讶', '吃惊', '惊', '震惊', '驚き', '驚く', 'びっくり', 'おどろき'],
  annoyed: ['annoyed', 'eyeroll', 'pout', 'sulk', 'speechless', 'wuyu', 'baiyan', 'bored', 'tired', 'black', '无语', '白眼', '嫌弃', '不满', 'ジト目', 'じと目', '呆れ', 'むすっ'],
  angry: ['angry', 'anger', 'mad', 'rage', 'shengqi', 'blackface', 'black', 'heilian', '生气', '怒', '黑脸', '黑线', '怒り', 'おこ', 'いかり'],
  sad: ['sad', 'cry', 'crying', 'tears', 'tear', 'sob', 'gloom', 'shangxin', 'ku', '哭', '伤心', '难过', '泪', '悲しい', '泣き', '涙', 'かなしい', 'なみだ'],
  smug: ['smug', 'smirk', 'proud', 'moneyeye', 'money', 'doya', 'deyi', '得意', 'ドヤ', 'どや', '坏笑'],
  shy: ['shy', 'shyness', 'blush', 'blushing', 'red', 'lianhong', 'haixiu', 'embarrassed', '脸红', '害羞', '红晕', '紅潮', '照れ', 'てれ', '赤面', '頬染め']
}

/** Pose toggles (VTube Studio "expressions" that are really poses), by what they are called. */
const POSE_WORDS = {
  base: ['watermark', 'shuiyin', 'logo', 'wm', 'sign', 'signature', '水印', '透かし', 'ウォーターマーク'],
  sit: ['sit', 'sitting', 'seated', 'zuo', '坐', '坐下', '座り', 'すわり'],
  lie: ['lie', 'lying', 'liedown', 'laydown', '躺', '躺下', '寝そべり', 'うつぶせ'],
  sleep: ['sleep', 'sleeping', 'asleep', 'shui', 'shuijiao', 'zzz', 'eyesclosed', '睡', '睡觉', '寝る', '眠り', 'ねむり'],
  point: ['point', 'pointing', 'zhi', '指', '指さし']
} as const

/** "hand_love" → ["hand", "love", "hand_love"]; Chinese/Japanese names are matched by containment instead. */
function nameWords(name: string): string[] {
  const lower = name.toLowerCase().replace(/\.exp3\.json$/, '')
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  // camelCase ("HeartEyes") and digits ("smile2") split too
  const camel = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean)
  return [...new Set([lower.replace(/[^\p{L}\p{N}]+/gu, ''), ...words, ...camel, ...words.map((w) => w.replace(/\d+$/, ''))])]
}

function matches(name: string, word: string): boolean {
  if (/[^\x00-\x7f]/.test(word)) return name.includes(word)
  return nameWords(name).includes(word)
}

/** How well a name fits a list of words: earlier words count more; 0 = not at all. */
function score(name: string, words: readonly string[]): number {
  const i = words.findIndex((w) => matches(name, w))
  return i < 0 ? 0 : words.length - i
}

/**
 * Live2D: emotions → expression names, and the pose toggles among them. A toggle that is plainly a pose (a watermark,
 * sitting) is never used as a face; each expression serves the emotion it fits best, and close relatives fill the gaps
 * (annoyed borrows angry, flirty borrows shy or happy, smug borrows happy).
 */
export function mapLive2DExpressions(names: string[]): { expressions: Table; poses: NonNullable<CharacterConfig['poses']> } {
  const poses: NonNullable<CharacterConfig['poses']> = {}
  const used = new Set<string>()
  const base = names.filter((n) => POSE_WORDS.base.some((w) => matches(n, w)))
  if (base.length) poses.base = base
  base.forEach((n) => used.add(n))
  for (const key of ['sit', 'lie', 'sleep', 'point'] as const) {
    const hit = names.find((n) => !used.has(n) && POSE_WORDS[key].some((w) => matches(n, w)))
    if (hit) {
      poses[key] = hit
      used.add(hit)
    }
  }
  const faces = names.filter((n) => !used.has(n))
  const expressions: Table = { ...EMPTY }
  // Pick per emotion, strongest claims first, so "black" goes to angry before annoyed takes it, unless angry has better.
  const claims: { emotion: Exclude<Emotion, 'neutral'>; name: string; s: number }[] = []
  for (const emotion of Object.keys(LIVE2D_WORDS) as Exclude<Emotion, 'neutral'>[]) {
    for (const n of faces) {
      const s = score(n, LIVE2D_WORDS[emotion])
      if (s) claims.push({ emotion, name: n, s })
    }
  }
  claims.sort((a, b) => b.s - a.s)
  const taken = new Set<string>()
  for (const c of claims) {
    if (expressions[c.emotion] || taken.has(c.name)) continue
    expressions[c.emotion] = c.name
    taken.add(c.name)
  }
  // Second pass: a name may serve two emotions when one would otherwise be blank (black → angry and annoyed).
  for (const c of claims) if (!expressions[c.emotion]) expressions[c.emotion] = c.name
  const fill: [Emotion, Emotion[]][] = [
    ['annoyed', ['angry', 'sad']],
    ['angry', ['annoyed']],
    ['flirty', ['shy', 'happy']],
    ['shy', ['flirty']],
    ['smug', ['happy', 'flirty']],
    ['happy', ['flirty', 'smug']]
  ]
  for (const [emotion, from] of fill) {
    if (expressions[emotion]) continue
    const src = from.find((e) => expressions[e])
    if (src) expressions[emotion] = expressions[src]
  }
  return { expressions, poses }
}

/** VRM: emotion → expression names joined with '+'. three-vrm names VRM 0.x presets the VRM 1.0 way (joy → happy). */
export function mapVrmExpressions(names: string[]): Table {
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]))
  const find = (...want: string[]): string => {
    for (const w of want) {
      const hit = lower.get(w)
      if (hit) return hit
    }
    // a custom expression called e.g. "Blush_01" or "Smile"
    for (const w of want) {
      const hit = names.find((n) => matches(n, w))
      if (hit) return hit
    }
    return ''
  }
  const happy = find('happy', 'joy', 'smile', 'fun')
  const relaxed = find('relaxed', 'fun', 'calm')
  const angry = find('angry', 'anger', 'mad')
  const sad = find('sad', 'sorrow', 'cry')
  const surprised = find('surprised', 'surprise', 'shock')
  const blush = find('blush', 'shy', 'embarrassed', '照れ')
  const join = (...parts: string[]): string => [...new Set(parts.filter(Boolean))].join('+')
  return {
    neutral: '',
    happy,
    flirty: join(happy, relaxed) || blush,
    surprised,
    annoyed: angry,
    angry,
    sad,
    smug: relaxed || happy,
    shy: blush || join(happy, sad)
  }
}

// ---- reading models

/** Three-vrm's names for VRM 0.x preset blend shapes. */
const VRM0_PRESETS: Record<string, string> = { joy: 'happy', angry: 'angry', sorrow: 'sad', fun: 'relaxed', surprised: 'surprised', a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh', blink: 'blink', blink_l: 'blinkLeft', blink_r: 'blinkRight', lookup: 'lookUp', lookdown: 'lookDown', lookleft: 'lookLeft', lookright: 'lookRight', neutral: 'neutral' }

export interface VrmInfo {
  version: '0' | '1'
  name: string | null
  author: string | null
  expressions: string[]
  /** a line for character.json → license */
  license: string
  /** avatar use limited to the author (or people they name) */
  restricted: boolean
}

/** The JSON chunk of a .glb / .vrm: the glTF document with the VRM extension in it. */
export function readGlbJson(file: string): Record<string, unknown> {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(20)
    readSync(fd, head, 0, 20, 0)
    if (head.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a glTF binary (.vrm / .glb)')
    const len = head.readUInt32LE(12)
    if (head.readUInt32LE(16) !== 0x4e4f534a || len > 64 * 1024 * 1024) throw new Error('no JSON chunk')
    const json = Buffer.alloc(len)
    readSync(fd, json, 0, len, 20)
    return JSON.parse(json.toString('utf8')) as Record<string, unknown>
  } finally {
    closeSync(fd)
  }
}

type Obj = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function vrmInfo(gltf: Obj): VrmInfo {
  const ext = (gltf.extensions ?? {}) as Obj
  const v1 = ext.VRMC_vrm as Obj | undefined
  if (v1) {
    const meta = (v1.meta ?? {}) as Obj
    const ex = (v1.expressions ?? {}) as { preset?: Obj; custom?: Obj }
    const expressions = [...Object.keys(ex.preset ?? {}), ...Object.keys(ex.custom ?? {})]
    const perm = str(meta.avatarPermission) ?? 'onlyAuthor'
    const authors = Array.isArray(meta.authors) ? (meta.authors as unknown[]).map(str).filter(Boolean).join(', ') : null
    const parts = [
      `avatar use: ${perm === 'everyone' ? 'everyone' : perm === 'onlySeparatelyLicensedPerson' ? 'only people the author licenses' : 'the author only'}`,
      `commercial: ${str(meta.commercialUsage) ?? 'personalNonProfit'}`,
      `redistribution: ${meta.allowRedistribution ? 'allowed' : 'not allowed'}`,
      `modification: ${str(meta.modification) ?? 'prohibited'}`,
      str(meta.licenseUrl) ? `licence: ${str(meta.licenseUrl)}` : null,
      str(meta.otherLicenseUrl) ? `other terms: ${str(meta.otherLicenseUrl)}` : null
    ].filter(Boolean)
    const name = str(meta.name)
    return { version: '1', name, author: authors || null, expressions, license: `${name ?? 'VRM model'}${authors ? ` by ${authors}` : ''} (VRM 1.0 metadata): ${parts.join('; ')}`, restricted: perm !== 'everyone' }
  }
  const v0 = ext.VRM as Obj | undefined
  if (!v0) throw new Error('no VRM extension: a plain glTF, not a VRM avatar')
  const meta = (v0.meta ?? {}) as Obj
  const groups = (((v0.blendShapeMaster ?? {}) as Obj).blendShapeGroups ?? []) as { name?: string; presetName?: string }[]
  const expressions = groups
    .map((g) => {
      const preset = (g.presetName ?? '').toLowerCase()
      return preset && preset !== 'unknown' ? VRM0_PRESETS[preset] ?? preset : (g.name ?? '')
    })
    .filter(Boolean)
  const allowed = str(meta.allowedUserName) ?? 'OnlyAuthor'
  const licence = str(meta.licenseName) ?? 'Redistribution_Prohibited'
  const parts = [
    `avatar use: ${allowed === 'Everyone' ? 'everyone' : allowed === 'ExplicitlyLicensedPerson' ? 'only people the author licenses' : 'the author only'}`,
    `violence: ${str(meta.violentUssageName) ?? 'Disallow'}`,
    `sexual: ${str(meta.sexualUssageName) ?? 'Disallow'}`,
    `commercial: ${str(meta.commercialUssageName) ?? 'Disallow'}`,
    `licence: ${licence === 'Other' ? (str(meta.otherLicenseUrl) ?? 'other') : licence}`
  ]
  const name = str(meta.title)
  const author = str(meta.author)
  return { version: '0', name, author, expressions: [...new Set(expressions)], license: `${name ?? 'VRM model'}${author ? ` by ${author}` : ''} (VRM 0.x metadata): ${parts.join('; ')}`, restricted: allowed !== 'Everyone' }
}

interface Model3 {
  FileReferences?: {
    Moc?: string
    Textures?: string[]
    Physics?: string
    Pose?: string
    DisplayInfo?: string
    UserData?: string
    Expressions?: { Name: string; File: string }[]
    Motions?: Record<string, { File?: string; Sound?: string }[]>
  }
}

export function live2dInfo(model3File: string): { expressions: string[]; groups: string[]; files: string[] } {
  const m = JSON.parse(readFileSync(model3File, 'utf8').replace(/^﻿/, '')) as Model3
  const r = m.FileReferences ?? {}
  if (!r.Moc) throw new Error('not a Cubism 3+ model (.model3.json without a Moc)')
  const motions = Object.values(r.Motions ?? {}).flat()
  const files = [r.Moc, ...(r.Textures ?? []), r.Physics, r.Pose, r.DisplayInfo, r.UserData, ...(r.Expressions ?? []).map((e) => e.File), ...motions.map((x) => x.File), ...motions.map((x) => x.Sound)].filter(
    (f): f is string => typeof f === 'string' && f.length > 0
  )
  return { expressions: (r.Expressions ?? []).map((e) => e.Name), groups: Object.keys(r.Motions ?? {}), files: [...new Set(files)] }
}

/** A PMX model's own name (English when it has one), from the file header. */
export function pmxName(file: string): string | null {
  try {
    const buf = readFileSync(file).subarray(0, 4096)
    if (buf.toString('ascii', 0, 4) !== 'PMX ') return null
    const globals = buf[8]
    const utf8 = buf[9] === 1
    let at = 9 + globals
    const text = (): string => {
      const n = buf.readInt32LE(at)
      at += 4
      const s = buf.subarray(at, at + n).toString(utf8 ? 'utf8' : 'utf16le')
      at += n
      return s.trim()
    }
    const local = text()
    const english = text()
    return english || local || null
  } catch {
    return null
  }
}

// ---- ids, persona, defaults

/** "Hatsune Miku NT (v2).vrm" → "hatsune-miku-nt-v2"; names in other scripts keep their letters. */
export function slugify(name: string): string {
  const s = name
    .replace(/\.(?:vrm|pmx|fbx|glb|gltf|dae|zip|model3\.json)$/i, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'character'
}

export function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`
}

/** A neutral starting persona: friendly, short spoken lines, no invented backstory. They make her their own in Setup. */
export function starterPersona(name: string): string {
  return `You are ${name}, a desk companion who lives on the user's screen.

- Warm, curious and easy to talk to; a little playful, never mean.
- You speak in short, natural spoken lines: one to three sentences, no lists, no emoji.
- You notice what the user is doing and care how their work is going; you cheer them on and keep them company.
- You are honest: if you do not know something, you say so. You never invent things about the user.
- You do not pretend to be a real person; you are their companion on the desktop.

(This is a starter personality. Edit it in Setup → Characters to give ${name} her own voice, history and quirks.)
`
}

function prettyName(raw: string): string {
  const s = raw.replace(/\.(?:vrm|pmx|fbx|glb|gltf|dae|zip|model3\.json)$/i, '').replace(/[_]+/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'New character'
}

// ---- finding and copying files

const SKIP_DIRS = /^(?:__MACOSX|\.git|node_modules)$/

/** Every model file under a folder (not too deep), most usable kind first: VRM, Live2D, PMX, rigged. */
export function findModels(root: string, depth = 4): string[] {
  const found: string[] = []
  const walk = (dir: string, d: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.test(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (d < depth) walk(p, d + 1)
      } else if (modelKind(e.name)) found.push(p)
    }
  }
  walk(root, 0)
  const rank = (f: string): number => MODEL_EXTS.findIndex(([, re]) => re.test(f))
  return found.sort((a, b) => rank(a) - rank(b) || a.split(sep).length - b.split(sep).length)
}

const LICENSE_FILE = /^(?:readme|license|licence|copying|terms|利用規約|規約|说明|說明|使用说明|使用規約|注意事項|read ?me).*\.(?:txt|md|html?|pdf|rtf)$|^(?:readme|license|licence)$/i
const IMAGE = /\.(?:png|jpe?g|bmp|tga|dds|gif|webp|spa|sph|toon)$/i
const TEXTURE_DIR = /^(?:tex|texture|textures|tex\w*|img|image|images|toon|spa|sph|貼図|贴图|テクスチャ|材质|材質)$/i

function folderSize(dir: string, limit: { bytes: number; files: number }): { bytes: number; files: number } {
  const total = { bytes: 0, files: 0 }
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (total.bytes > limit.bytes || total.files > limit.files) return
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        total.files++
        total.bytes += statSync(p).size
      }
    }
  }
  walk(dir)
  return total
}

/** Folders that are never copied whole: a model saved straight into Downloads must not drag Downloads along. */
function isBroadFolder(dir: string): boolean {
  const home = homedir()
  const r = resolve(dir)
  return r === home || r === resolve(home, '..') || r === '/' || ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Movies', 'Music'].some((d) => r === join(home, d))
}

function safeJoin(root: string, rel: string): string | null {
  const p = resolve(root, rel)
  return p === root || p.startsWith(root + sep) ? p : null
}

/** Extracts a .zip into a fresh temporary folder (unzip on macOS and Linux, tar on Windows); both refuse ../ paths. */
export function extractZip(zip: string): string {
  const out = mkdtempSync(join(tmpdir(), 'deskmate-import-'))
  try {
    if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', out], { timeout: 120_000, stdio: 'ignore' })
    else execFileSync('unzip', ['-qq', '-o', zip, '-d', out], { timeout: 120_000, stdio: 'ignore' })
  } catch (err) {
    // unzip exits 1 on warnings (an odd file name) with everything else extracted
    if (!findModels(out).length) {
      rmSync(out, { recursive: true, force: true })
      throw new Error(`could not unpack ${basename(zip)}: ${(err as Error).message.split('\n')[0]}`)
    }
  }
  return out
}

// ---- the import

export interface ImportOptions {
  /** where characters the user adds live: <user data>/character */
  root: string
  /** an id already in use (shipped or added) */
  taken(id: string): boolean
  /** for tests: when the import ran */
  now?: Date
}

/**
 * Imports a model file, a Live2D model folder, or a zip, as a new character. Throws with a plain message when there is
 * no model in it.
 */
export function importCharacter(src: string, opts: ImportOptions): ImportResult {
  if (!existsSync(src)) throw new Error(`${src} does not exist`)
  let temp: string | null = null
  try {
    let model = src
    if (statSync(src).isDirectory() || /\.zip$/i.test(src)) {
      const folder = statSync(src).isDirectory() ? src : (temp = extractZip(src))
      const models = findModels(folder)
      if (!models.length) throw new Error(`no model in ${basename(src)}: looking for a .vrm, .model3.json, .pmx or rigged .fbx`)
      model = models[0]
    }
    const kind = modelKind(model)
    if (!kind) throw new Error(`${basename(model)} is not a model Deskmate can load (.vrm, .model3.json, .pmx, .fbx, .glb, .dae)`)
    return importModel(model, kind, src, opts)
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
}

function importModel(model: string, kind: ModelKind, picked: string, opts: ImportOptions): ImportResult {
  const warnings: string[] = []
  let restricted = false
  let name = prettyName(basename(model))
  let license: string | undefined
  let expressions: Table = { ...EMPTY }
  let poses: CharacterConfig['poses']
  let motions: CharacterConfig['motions'] = { idle: 'Idle', react: 'Idle' }
  let live2d: ReturnType<typeof live2dInfo> | null = null

  if (kind === 'vrm') {
    const info = vrmInfo(readGlbJson(model))
    if (info.name) name = info.name
    expressions = mapVrmExpressions(info.expressions)
    license = info.license
    restricted = info.restricted
    if (restricted) warnings.push(`${name}'s licence keeps this avatar to ${info.author ?? 'its author'}${/licenses/.test(info.license) ? ' and the people they license' : ''}. Use it only if that is you.`)
  } else if (kind === 'live2d') {
    live2d = live2dInfo(model)
    const mapped = mapLive2DExpressions(live2d.expressions)
    expressions = mapped.expressions
    if (Object.keys(mapped.poses).length) poses = mapped.poses
    const g = live2d.groups
    const idle = g.find((x) => /^idle$/i.test(x)) ?? g.find((x) => /idle/i.test(x)) ?? g[0] ?? 'Idle'
    const walk = g.find((x) => /walk/i.test(x))
    motions = { idle, react: g.find((x) => /tap|react|touch/i.test(x)) ?? idle, ...(walk ? { walk } : {}) }
    // A model3.json is often named after nothing much ("model", "runtime", "免费模型…"): the folder they picked, or
    // the model's own folder when the file name is generic, says more.
    const picked_ = existsSync(picked) && statSync(picked).isDirectory() ? basename(picked) : null
    if (picked_) name = prettyName(picked_)
    else if (/^(?:model|runtime|live2d|\d+)$/i.test(name)) name = prettyName(basename(dirname(model)))
  } else if (kind === 'mmd') {
    name = pmxName(model) ?? name
  }

  const id = uniqueId(slugify(name), (x) => opts.taken(x) || existsSync(join(opts.root, x)))
  const dir = join(opts.root, id)
  const modelDir = join(dir, 'model')
  mkdirSync(modelDir, { recursive: true })
  try {
    const srcDir = dirname(model)
    let rel: string
    if (kind === 'vrm') {
      rel = basename(model)
      copyFileSync(model, join(modelDir, rel))
    } else if (kind === 'live2d' && live2d) {
      // exactly the files the model names, at the same relative paths
      rel = basename(model)
      copyFileSync(model, join(modelDir, rel))
      for (const f of live2d.files) {
        const from = safeJoin(srcDir, f)
        const to = safeJoin(modelDir, normalize(f))
        if (!from || !to) {
          warnings.push(`left out ${f}: it is outside the model's folder`)
          continue
        }
        if (!existsSync(from)) {
          warnings.push(`the model names ${f}, but it is not there`)
          continue
        }
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(from, to)
      }
    } else {
      // PMX and rigged models name their textures inside the binary: take the folder, unless it is huge or is
      // somewhere like Downloads, then the model, its images and texture folders.
      rel = basename(model)
      const size = isBroadFolder(srcDir) ? null : folderSize(srcDir, { bytes: 800e6, files: 5000 })
      if (size && size.bytes <= 800e6 && size.files <= 5000) {
        cpSync(srcDir, modelDir, { recursive: true, filter: (p) => !SKIP_DIRS.test(basename(p)) && !/\.zip$/i.test(p) })
      } else {
        copyFileSync(model, join(modelDir, rel))
        for (const e of readdirSync(srcDir, { withFileTypes: true })) {
          const p = join(srcDir, e.name)
          if (e.isFile() && IMAGE.test(e.name)) copyFileSync(p, join(modelDir, e.name))
          else if (e.isDirectory() && TEXTURE_DIR.test(e.name)) cpSync(p, join(modelDir, e.name), { recursive: true })
        }
        warnings.push(`copied ${basename(model)} with the images beside it, not the whole of ${basename(srcDir)}`)
      }
    }
    // A readme or licence beside the model comes along, and the licence line points at it.
    for (const e of readdirSync(srcDir, { withFileTypes: true })) {
      if (!e.isFile() || !LICENSE_FILE.test(e.name)) continue
      const to = join(modelDir, e.name)
      if (!existsSync(to)) copyFileSync(join(srcDir, e.name), to)
      license ??= `Check the creator's terms: see model/${e.name}`
    }
    license ??= "Unknown: check the creator's terms before you use or share it"

    const config: CharacterConfig = {
      id,
      name,
      renderer: kind === 'live2d' ? 'live2d' : kind === 'mmd' ? 'mmd' : 'vrm',
      // relative: inside this character's folder (served to the renderer as deskmate://character/<id>/…)
      model: `model/${rel.split(sep).join('/')}`,
      license,
      expressions,
      motions,
      voice: { kokoro: 'af_heart', speed: 1, say: 'Samantha' },
      physics: { sway: 1, bounce: kind === 'live2d' ? 1.3 : 1.4 },
      ...(kind === 'live2d' ? {} : { camera: { fov: 24, yOffset: 0 }, dance: { bpm: 118 } }),
      ...(poses ? { poses } : {}),
      imported: { from: basename(picked), at: (opts.now ?? new Date()).toISOString() }
    }
    writeFileSync(join(dir, 'character.json'), JSON.stringify(config, null, 2) + '\n')
    writeFileSync(join(dir, 'persona.md'), starterPersona(name))
    return { id, dir, config, warnings, restricted }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

/** Every relative asset path in a character (model, outfits, clips) → the URL the renderer loads it by. */
export function resolveCharacterAssets(c: CharacterConfig, base: string): CharacterConfig {
  const fix = (p: string | undefined): string | undefined => (p && !/^(?:[a-z][\w+.-]*:|\/)/i.test(p) ? `${base}/${p.replace(/^\.\//, '')}` : p)
  return {
    ...c,
    model: fix(c.model) as string,
    ...(c.outfits ? { outfits: c.outfits.map((o) => ({ ...o, model: fix(o.model) })) } : {}),
    ...(c.animations ? { animations: c.animations.map((a) => ({ ...a, file: fix(a.file) as string })) } : {})
  }
}

/** A path under a character's folder for deskmate://character/<id>/<path>, or null when it reaches outside it. */
export function characterFile(dir: string, path: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(path).replace(/^\/+/, '')
  } catch {
    return null
  }
  const p = safeJoin(resolve(dir), rel)
  return p && relative(resolve(dir), p) && !rel.split('/').includes('..') ? p : null
}
