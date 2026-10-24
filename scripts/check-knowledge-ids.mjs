#!/usr/bin/env node
/**
 * 知识档案稳定 ID 冲突检查工具。
 *
 * 只做「报告」，不做任何改写 / 删除 / 重编号。它扫描 book/、proposals/ 中的知识实体文件，
 * 找出被多个实体复用的稳定 ID（违反 harness/data-contract.md「ID 不复用」约定），
 * 并检测索引表内同一 ID 是否映射到多个不同含义的实体，最后列出冲突 ID 被其它文件引用的位置，
 * 以及一份仅供作者确认的 ID 映射建议（不自动执行）。
 *
 * 用法：
 *   node scripts/check-knowledge-ids.mjs            # 报告到 stdout，默认退出码 0（仅报告）
 *   node scripts/check-knowledge-ids.mjs --json     # 输出 JSON
 *   node scripts/check-knowledge-ids.mjs --fail     # 存在冲突时退出码 1（未来 CI 阻断开关）
 *
 * 说明：历史冲突已由作者确认并修复；CI 使用 --fail 防止新增文件级或索引级冲突。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const JSON_MODE = process.argv.includes('--json')
const FAIL_MODE = process.argv.includes('--fail')

// 稳定 ID 前缀（与 harness/data-contract.md 一致，另含本仓库实际用到的 INTENT/SOURCE）
const ID_PREFIX = '(?:P|CHAR|WORLD|THREAD|EVENT|CH|REF|INTENT|SOURCE)'
const FILENAME_ID_RE = new RegExp(`^(${ID_PREFIX}-\\d+)`)
const ID_FIELD_RE = /^ID\s*:\s*(\S+)\s*$/m
const TITLE_RE = /^#\s+(.+)$/m
const STATUS_RE = /^status\s*:\s*(.+)$/m
const UPDATED_RE = /^updated\s*:\s*(.+)$/m
const SOURCE_RE = /^source\s*:\s*(.+)$/m

// 无 H1 标题的实体文件的显示名（静态提示，仅用于报告可读性，不参与冲突判定）
const DISPLAY_NAME = {
  'book/world/WORLD-002.md': '开篇社会',
  'book/world/WORLD-003.md': '最终真相',
  'book/characters/CHAR-001.md': '未命名主角',
}

const SCAN_DIRS = ['book', 'proposals']
const REF_DIRS = ['book', 'proposals', 'decisions', 'harness', 'notes', 'state']
const INDEX_FILES = ['book/index.md', 'book/world/index.md', 'book/characters/index.md']

function walk(dir) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  const out = []
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry)
    if (statSync(full).isDirectory()) out.push(...walk(join(dir, entry)))
    else if (entry.endsWith('.md')) out.push(join(dir, entry))
  }
  return out
}

function parseEntity(rel) {
  const text = readFileSync(join(ROOT, rel), 'utf8')
  const name = rel.split('/').pop().replace(/\.md$/, '')
  const declaredId = text.match(ID_FIELD_RE)?.[1] ?? null
  const filenameId = name.match(FILENAME_ID_RE)?.[0] ?? null
  const id = declaredId ?? filenameId
  const title = (text.match(TITLE_RE)?.[1] ?? DISPLAY_NAME[rel] ?? name).trim()
  return {
    file: rel,
    id,
    filenameId,
    declaredId,
    title,
    status: text.match(STATUS_RE)?.[1]?.trim() ?? null,
    updated: text.match(UPDATED_RE)?.[1]?.trim() ?? null,
    source: text.match(SOURCE_RE)?.[1]?.trim() ?? null,
  }
}

// 解析索引表里 `| ID | 名称 | ... | 路径 | 状态 |` 形式的行。
function parseIndexRows(rel) {
  const text = readFileSync(join(ROOT, rel), 'utf8')
  const rows = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*([A-Za-z]+-\d+)\s*\|(.+)\|$/)
    if (!m) continue
    const id = m[1]
    const cells = m[2].split('|').map((c) => c.trim())
    const name = cells.find((c) => c && !/\.md|proposals\//.test(c)) ?? ''
    const path = cells.find((c) => /\.md|proposals\//.test(c)) ?? ''
    rows.push({ id, name, path, file: rel })
  }
  return rows
}

const entityFiles = []
for (const dir of SCAN_DIRS) for (const f of walk(dir)) entityFiles.push(parseEntity(f))

// 1) 文件级冲突：同一稳定 ID 被多个实体文件使用
const byId = new Map()
for (const e of entityFiles) {
  if (!e.id) continue
  if (!byId.has(e.id)) byId.set(e.id, [])
  byId.get(e.id).push(e)
}
const fileCollisions = [...byId.entries()].filter(([, list]) => list.length > 1)

// 2) 索引内冲突：同一 ID 在索引表中映射到多个不同名称或路径（「两套 ID 定义」）
const indexRows = []
for (const f of INDEX_FILES) if (existsSync(join(ROOT, f))) indexRows.push(...parseIndexRows(f))
const idxById = new Map()
for (const row of indexRows) {
  if (!idxById.has(row.id)) idxById.set(row.id, [])
  idxById.get(row.id).push(row)
}
const indexConflicts = [...idxById.entries()]
  .filter(([, rows]) => new Set(rows.map((r) => r.name)).size > 1 || new Set(rows.map((r) => r.path)).size > 1)
  .map(([id, rows]) => ({ id, rows }))

// 3) 被其它文件引用的位置（排除冲突实体自身的定义文件）
function findReferences(id, ownFiles) {
  const exclude = new Set(ownFiles)
  const refs = []
  for (const dir of REF_DIRS) {
    for (const f of walk(dir)) {
      if (exclude.has(f)) continue
      const text = readFileSync(join(ROOT, f), 'utf8')
      text.split('\n').forEach((line, i) => { if (line.includes(id)) refs.push(`${f}:${i + 1}`) })
    }
  }
  return refs
}

// 4) 建议映射（仅供作者确认，不自动执行）：
//    同一 ID 下优先保留 source 含 inbox（作者直接原话确认）的实体为原 ID，其余实体建议顺延改号。
function suggestMapping([id, list]) {
  const keep = list.find((e) => (e.source ?? '').includes('inbox')) ?? list[0]
  const move = list.filter((e) => e !== keep)
  return { id, keep, move }
}

function report() {
  const out = []
  out.push('# 知识档案 ID 冲突检查报告')
  out.push(`扫描实体目录：${SCAN_DIRS.join('、')}；引用目录：${REF_DIRS.join('、')}\n`)

  if (fileCollisions.length === 0) out.push('未发现文件级 ID 冲突。\n')
  for (const collision of fileCollisions) {
    const [id, list] = collision
    out.push(`## 文件级冲突：${id}`)
    for (const e of list) {
      out.push(`- 路径：\`${e.file}\``)
      out.push(`  - 实体名称：${e.title}`)
      out.push(`  - 状态：${e.status ?? '（无）'}；updated：${e.updated ?? '（无）'}`)
      out.push(`  - 来源：${e.source ?? '（无）'}`)
    }
    const refs = findReferences(id, list.map((e) => e.file))
    out.push(`  - 被其它文件引用位置：${refs.length ? refs.join('、') : '（无）'}`)
    const s = suggestMapping(collision)
    out.push(`  - 建议映射（待作者确认，不自动执行）：保留 \`${s.keep.file}\`（${s.keep.title}）为 \`${id}\`，` +
      `将 ${s.move.map((m) => `\`${m.file}\`（${m.title}）`).join('、')} 改号。`)
    out.push('')
  }

  if (indexConflicts.length === 0) out.push('未发现索引内同一 ID 的多重定义。\n')
  for (const c of indexConflicts) {
    out.push(`## 索引内多重定义：${c.id}`)
    for (const r of c.rows) out.push(`- \`${r.file}\`：名称「${r.name}」→ 路径「${r.path}」`)
    out.push('')
  }

  out.push('## 提示')
  out.push('本工具只报告冲突，不修改任何档案。所有「建议映射」都需作者确认后才能执行；')
  out.push('作者确认的历史映射已由维护者应用；CI 使用 --fail 阻止新增文件级或索引级 ID 冲突。')
  return out.join('\n')
}

if (JSON_MODE) {
  const data = {
    fileCollisions: fileCollisions.map(([id, list]) => ({ id, entities: list })),
    indexConflicts,
    references: Object.fromEntries(fileCollisions.map(([id, list]) => [id, findReferences(id, list.map((e) => e.file))])),
    suggestions: fileCollisions.map(suggestMapping),
  }
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
} else {
  process.stdout.write(report() + '\n')
}

// 默认「仅报告」退出码 0；加 --fail 时，存在冲突则退出码 1（用于未来 CI 阻断）。
if (FAIL_MODE && (fileCollisions.length > 0 || indexConflicts.length > 0)) process.exitCode = 1
