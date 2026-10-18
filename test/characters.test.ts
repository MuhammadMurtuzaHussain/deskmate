// "Add a character": expression mapping and the import, on small synthetic models in a temp folder. Run with `npm test`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  characterFile,
  importCharacter,
  mapLive2DExpressions,
  mapVrmExpressions,
  pmxName,
  resolveCharacterAssets,
  slugify,
  vrmInfo
} from '../src/main/characters.ts'

const tmp = mkdtempSync(join(tmpdir(), 'deskmate-characters-test-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

/** A .vrm is a glTF binary: a JSON chunk (with the VRM extension) and a BIN chunk. */
function glb(json: object): Buffer {
  let j = Buffer.from(JSON.stringify(json))
  if (j.length % 4) j = Buffer.concat([j, Buffer.alloc(4 - (j.length % 4), 0x20)])
  const bin = Buffer.alloc(4)
  const head = Buffer.alloc(12)
  head.write('glTF', 0, 'ascii')
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8)
  const jh = Buffer.alloc(8)
  jh.writeUInt32LE(j.length, 0)
  jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8)
  bh.writeUInt32LE(bin.length, 0)
  bh.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([head, jh, j, bh, bin])
}

const VRM1 = {
  asset: { version: '2.0' },
  extensions: {
    VRMC_vrm: {
      meta: { name: 'Rin', authors: ['Kyn'], avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit', allowRedistribution: false, modification: 'prohibited', licenseUrl: 'https://vrm.dev/licenses/1.0/' },
      expressions: { preset: { happy: {}, angry: {}, sad: {}, relaxed: {}, surprised: {}, aa: {}, blink: {} }, custom: { Blush: {} } }
    }
  }
}
const VRM0 = {
  asset: { version: '2.0' },
  extensions: {
    VRM: {
      meta: { title: 'Sample Girl', author: 'VRoid', allowedUserName: 'Everyone', violentUssageName: 'Disallow', sexualUssageName: 'Disallow', commercialUssageName: 'Allow', licenseName: 'CC0' },
      blendShapeMaster: {
        blendShapeGroups: [
          { name: 'Joy', presetName: 'joy' },
          { name: 'Angry', presetName: 'angry' },
          { name: 'Sorrow', presetName: 'sorrow' },
          { name: 'Fun', presetName: 'fun' },
          { name: 'Surprised', presetName: 'unknown' },
          { name: 'A', presetName: 'a' }
        ]
      }
    }
  }
}

test('VRM expressions: presets, VRM 0.x names as three-vrm loads them, custom blush', () => {
  const t = mapVrmExpressions(['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'blink', 'Blush'])
  assert.equal(t.neutral, '')
  assert.equal(t.happy, 'happy')
  assert.equal(t.flirty, 'happy+relaxed')
  assert.equal(t.surprised, 'surprised')
  assert.equal(t.annoyed, 'angry')
  assert.equal(t.sad, 'sad')
  assert.equal(t.smug, 'relaxed')
  assert.equal(t.shy, 'Blush')
  // no relaxed, no blush: flirty is happy, shy is happy+sad
  const u = mapVrmExpressions(['happy', 'sad', 'Surprised'])
  assert.equal(u.flirty, 'happy')
  assert.equal(u.shy, 'happy+sad')
  assert.equal(u.surprised, 'Surprised')
  assert.equal(u.angry, '')
})

test('VRM metadata: licence line and the author-only warning, both versions', () => {
  const one = vrmInfo(VRM1)
  assert.equal(one.version, '1')
  assert.equal(one.name, 'Rin')
  assert.equal(one.restricted, true)
  assert.match(one.license, /Rin by Kyn/)
  assert.match(one.license, /avatar use: the author only/)
  assert.deepEqual(one.expressions.slice(-1), ['Blush'])
  const zero = vrmInfo(VRM0)
  assert.equal(zero.version, '0')
  assert.equal(zero.restricted, false)
  assert.match(zero.license, /avatar use: everyone/)
  assert.match(zero.license, /licence: CC0/)
  assert.deepEqual(zero.expressions, ['happy', 'angry', 'sad', 'relaxed', 'Surprised', 'aa'])
  assert.throws(() => vrmInfo({ asset: {} }), /not a VRM/)
})

test('Live2D: English, pinyin and Chinese names; watermark and sitting are poses, not faces', () => {
  // Ellen (Bilibili): black, red, shock, a hand toggle, the watermark, a lollipop
  const ellen = mapLive2DExpressions(['black', 'red', 'shock', 'shou', 'shuiyin', 'tang'])
  assert.deepEqual(ellen.poses, { base: ['shuiyin'] })
  assert.equal(ellen.expressions.angry, 'black')
  assert.equal(ellen.expressions.annoyed, 'black')
  assert.equal(ellen.expressions.shy, 'red')
  assert.equal(ellen.expressions.flirty, 'red')
  assert.equal(ellen.expressions.surprised, 'shock')
  assert.equal(ellen.expressions.neutral, '')
  // Nicole (VTube Studio style)
  const nicole = mapLive2DExpressions(['loveeye', 'moneyeye', 'blackface', 'cry', 'shyness', 'sitting', 'hand_love', 'hand_money', 'milktea'])
  assert.equal(nicole.poses.sit, 'sitting')
  assert.equal(nicole.expressions.flirty, 'loveeye')
  assert.equal(nicole.expressions.smug, 'moneyeye')
  assert.equal(nicole.expressions.angry, 'blackface')
  assert.equal(nicole.expressions.sad, 'cry')
  assert.equal(nicole.expressions.shy, 'shyness')
  assert.ok(!Object.values(nicole.expressions).includes('sitting'))
  // Jian
  const jian = mapLive2DExpressions(['gloom', 'blush', 'nosebleed', 'angry', 'stareyes', 'eyeroll', 'tears', 'hearteyes', 'righthand', 'lefthand'])
  assert.equal(jian.expressions.happy, 'stareyes')
  assert.equal(jian.expressions.flirty, 'hearteyes')
  assert.equal(jian.expressions.annoyed, 'eyeroll')
  assert.equal(jian.expressions.angry, 'angry')
  assert.equal(jian.expressions.sad, 'tears')
  assert.equal(jian.expressions.shy, 'blush')
  // Chinese and Japanese names
  const zh = mapLive2DExpressions(['开心', '生气', '哭哭', '脸红', '惊讶', '水印', '坐下', '睡觉'])
  assert.equal(zh.expressions.happy, '开心')
  assert.equal(zh.expressions.angry, '生气')
  assert.equal(zh.expressions.sad, '哭哭')
  assert.equal(zh.expressions.shy, '脸红')
  assert.equal(zh.expressions.surprised, '惊讶')
  assert.deepEqual(zh.poses, { base: ['水印'], sit: '坐下', sleep: '睡觉' })
  const ja = mapLive2DExpressions(['笑顔', '怒り', '泣き', '照れ', 'びっくり', 'ジト目'])
  assert.equal(ja.expressions.happy, '笑顔')
  assert.equal(ja.expressions.angry, '怒り')
  assert.equal(ja.expressions.sad, '泣き')
  assert.equal(ja.expressions.shy, '照れ')
  assert.equal(ja.expressions.surprised, 'びっくり')
  assert.equal(ja.expressions.annoyed, 'ジト目')
  // numbered sample faces (Haru's f00…f07) say nothing: every emotion stays plain
  assert.deepEqual(Object.values(mapLive2DExpressions(['f00', 'f01', 'f02']).expressions), ['', '', '', '', '', '', '', '', ''])
})

test('ids: slugs, and a number when the name is taken', () => {
  assert.equal(slugify('Hatsune Miku NT (v2).vrm'), 'hatsune-miku-nt-v2')
  assert.equal(slugify('免费模型艾莲.model3.json'), '免费模型艾莲')
  assert.equal(slugify('...'), 'character')
})

test('import a VRM: copied under model/, character.json with mapped expressions, licence warning, persona', () => {
  const src = join(tmp, 'Rin_v1.vrm')
  writeFileSync(src, glb(VRM1))
  const root = join(tmp, 'ud-vrm')
  const r = importCharacter(src, { root, taken: (id) => id === 'mika', now: new Date('2026-10-18T12:00:00Z') })
  assert.equal(r.id, 'rin')
  assert.equal(r.restricted, true)
  assert.match(r.warnings.join(' '), /keeps this avatar to Kyn/)
  assert.ok(existsSync(join(root, 'rin', 'model', 'Rin_v1.vrm')))
  const cfg = JSON.parse(readFileSync(join(root, 'rin', 'character.json'), 'utf8'))
  assert.equal(cfg.renderer, 'vrm')
  assert.equal(cfg.model, 'model/Rin_v1.vrm')
  assert.equal(cfg.expressions.shy, 'Blush')
  assert.equal(cfg.voice.kokoro, 'af_heart')
  assert.deepEqual(cfg.imported, { from: 'Rin_v1.vrm', at: '2026-10-18T12:00:00.000Z' })
  assert.match(readFileSync(join(root, 'rin', 'persona.md'), 'utf8'), /You are Rin/)
  // the same model again gets its own id
  const again = importCharacter(src, { root, taken: () => false })
  assert.equal(again.id, 'rin-2')
})

/** A Live2D model folder: model3.json naming moc, textures, physics, expressions and motions, plus a stray file. */
function live2dFolder(dir: string): string {
  mkdirSync(join(dir, 'tex'), { recursive: true })
  mkdirSync(join(dir, 'exp'), { recursive: true })
  mkdirSync(join(dir, 'mtn'), { recursive: true })
  for (const f of ['ellen.moc3', 'tex/texture_00.png', 'ellen.physics3.json', 'exp/red.exp3.json', 'exp/shuiyin.exp3.json', 'exp/shock.exp3.json', 'mtn/idle.motion3.json', 'unrelated.psd', 'ReadMe.txt']) {
    writeFileSync(join(dir, f), f)
  }
  const model3 = {
    Version: 3,
    FileReferences: {
      Moc: 'ellen.moc3',
      Textures: ['tex/texture_00.png'],
      Physics: 'ellen.physics3.json',
      Expressions: [
        { Name: 'red', File: 'exp/red.exp3.json' },
        { Name: 'shuiyin', File: 'exp/shuiyin.exp3.json' },
        { Name: 'shock', File: 'exp/shock.exp3.json' }
      ],
      Motions: { Idle: [{ File: 'mtn/idle.motion3.json' }], TapBody: [{ File: 'mtn/missing.motion3.json' }] }
    }
  }
  const file = join(dir, 'model.model3.json')
  writeFileSync(file, JSON.stringify(model3))
  return file
}

test('import a Live2D folder: only the files the model names, poses, motions, readme as licence', () => {
  // the folder they picked names her, not the model3.json inside
  const src = join(tmp, 'Ellen Joe')
  live2dFolder(src)
  const root = join(tmp, 'ud-l2d')
  const r = importCharacter(src, { root, taken: () => false })
  assert.equal(r.id, 'ellen-joe')
  const m = join(root, 'ellen-joe', 'model')
  for (const f of ['model.model3.json', 'ellen.moc3', 'tex/texture_00.png', 'exp/red.exp3.json', 'mtn/idle.motion3.json', 'ReadMe.txt']) assert.ok(existsSync(join(m, f)), f)
  assert.ok(!existsSync(join(m, 'unrelated.psd')))
  assert.match(r.warnings.join(' '), /mtn\/missing\.motion3\.json/)
  const cfg = r.config
  assert.equal(cfg.renderer, 'live2d')
  assert.equal(cfg.model, 'model/model.model3.json')
  assert.deepEqual(cfg.poses, { base: ['shuiyin'] })
  assert.equal(cfg.expressions.shy, 'red')
  assert.deepEqual(cfg.motions, { idle: 'Idle', react: 'TapBody' })
  assert.match(cfg.license ?? '', /model\/ReadMe\.txt/)
  assert.equal(r.restricted, false)
})

test('import a zip: unpacked, and the best model inside found', { skip: process.platform === 'win32' }, () => {
  const inner = join(tmp, 'zip-src', 'Some Pack', 'live2d')
  live2dFolder(inner)
  writeFileSync(join(tmp, 'zip-src', 'Some Pack', 'Rin.vrm'), glb(VRM0))
  const zip = join(tmp, 'pack.zip')
  execFileSync('zip', ['-qr', zip, 'Some Pack'], { cwd: join(tmp, 'zip-src') })
  const root = join(tmp, 'ud-zip')
  const r = importCharacter(zip, { root, taken: () => false })
  // a VRM wins over the Live2D model in the same pack
  assert.equal(r.config.renderer, 'vrm')
  assert.equal(r.config.name, 'Sample Girl')
  assert.equal(r.config.expressions.surprised, 'Surprised')
  assert.equal(r.config.imported?.from, 'pack.zip')
  assert.throws(() => importCharacter(join(tmp, 'ReadMe-only.zip'), { root, taken: () => false }), /does not exist/)
})

test('a folder with no model in it says so; nothing is left behind', () => {
  const empty = join(tmp, 'nothing')
  mkdirSync(empty)
  writeFileSync(join(empty, 'notes.txt'), 'hi')
  const root = join(tmp, 'ud-empty')
  assert.throws(() => importCharacter(empty, { root, taken: () => false }), /no model in nothing/)
  assert.ok(!existsSync(join(root, 'nothing')))
})

test('import a PMX: its own English name, the folder with its textures', () => {
  const src = join(tmp, 'pmx-src')
  mkdirSync(join(src, 'tex'), { recursive: true })
  const text = (s: string): Buffer => {
    const b = Buffer.from(s, 'utf16le')
    const n = Buffer.alloc(4)
    n.writeInt32LE(b.length)
    return Buffer.concat([n, b])
  }
  const head = Buffer.from([0x50, 0x4d, 0x58, 0x20, 0, 0, 0, 0x40, 8, 0, 0, 4, 4, 4, 4, 4, 4])
  writeFileSync(join(src, 'ani.pmx'), Buffer.concat([head, text('アニ'), text('Ani'), text(''), text('')]))
  writeFileSync(join(src, 'tex', 'body.png'), 'png')
  assert.equal(pmxName(join(src, 'ani.pmx')), 'Ani')
  const r = importCharacter(join(src, 'ani.pmx'), { root: join(tmp, 'ud-pmx'), taken: () => false })
  assert.equal(r.id, 'ani')
  assert.equal(r.config.renderer, 'mmd')
  assert.ok(existsSync(join(r.dir, 'model', 'tex', 'body.png')))
})

test('asset paths: relative ones resolve into the character folder; nothing escapes it', () => {
  const c = resolveCharacterAssets(
    { id: 'rin', name: 'Rin', model: 'model/rin.vrm', expressions: {} as never, motions: { idle: 'Idle', react: 'Idle' }, voice: {}, animations: [{ name: 'idle', file: 'clips/idle.vrma' }, { name: 'x', file: '/models/x.fbx' }] },
    'deskmate://character/rin'
  )
  assert.equal(c.model, 'deskmate://character/rin/model/rin.vrm')
  assert.equal(c.animations?.[0].file, 'deskmate://character/rin/clips/idle.vrma')
  assert.equal(c.animations?.[1].file, '/models/x.fbx')
  const dir = join(tmp, 'ud-vrm', 'rin')
  assert.equal(characterFile(dir, '/model/Rin_v1.vrm'), join(dir, 'model', 'Rin_v1.vrm'))
  assert.equal(characterFile(dir, '/model/..%2F..%2Fsecret'), null)
  assert.equal(characterFile(dir, '/../rin-2/character.json'), null)
})
