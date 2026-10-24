import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { CardRow, toCard, ensureDatabase, type Card } from './db'
import { csvToCards, csvCell, duplicateKey, type ParsedRow } from './csv'
import {
  interpret,
  normalizeChanges,
  EDITABLE_FIELDS,
  FIELD_LABELS,
  type Vocabulary,
  type CardChanges,
  type EditableField,
  type TargetHint,
} from './ai'

type Bindings = {
  DB: D1Database
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  AI_MODEL?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const TEXT_FIELDS = [
  'name_kana',
  'company',
  'department',
  'position',
  'email',
  'phone',
  'mobile',
  'website',
  'address',
  'memo',
  'met_at',
] as const

type CardInput = Record<string, unknown>

function s(v: unknown, max = 400): string {
  if (typeof v !== 'string') return ''
  return v.trim().slice(0, max)
}

function normalizeInput(body: CardInput) {
  const name = s(body.name, 120)
  if (!name) return { error: '氏名は必須です' as const }

  const email = s(body.email, 200)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'メールアドレスの形式が正しくありません' as const }
  }

  let website = s(body.website, 300)
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`

  const rawTags = Array.isArray(body.tags) ? body.tags : []
  const tags = Array.from(
    new Set(
      rawTags
        .map((t) => s(t, 24).replace(/[,#]/g, ''))
        .filter((t) => t.length > 0)
    )
  ).slice(0, 12)

  return {
    values: {
      name,
      name_kana: s(body.nameKana, 120),
      company: s(body.company, 160),
      department: s(body.department, 160),
      position: s(body.position, 160),
      email,
      phone: s(body.phone, 60),
      mobile: s(body.mobile, 60),
      website,
      address: s(body.address, 300),
      tags: JSON.stringify(tags),
      memo: s(body.memo, 2000),
      favorite: body.favorite === true || body.favorite === 1 ? 1 : 0,
      met_at: s(body.metAt, 20),
    },
  }
}

async function allTags(db: D1Database): Promise<string[]> {
  const rows = await db.prepare('SELECT tags FROM cards').all<{ tags: string }>()
  const counter = new Map<string, number>()
  for (const row of rows.results ?? []) {
    try {
      const parsed = JSON.parse(row.tags || '[]')
      if (!Array.isArray(parsed)) continue
      for (const t of parsed) {
        if (typeof t !== 'string' || !t) continue
        counter.set(t, (counter.get(t) ?? 0) + 1)
      }
    } catch {
      /* ignore broken tag json */
    }
  }
  return [...counter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).map(([t]) => t)
}

/**
 * AI に渡す語彙。実データに存在する値だけを候補にすることで、
 * モデルが存在しない部署名やタグを捏造するのを防ぐ。
 */
async function getVocabulary(db: D1Database): Promise<Vocabulary> {
  const [total, favorites, deptRow, companyRow, tagList] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM cards').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM cards WHERE favorite = 1').first<{ n: number }>(),
    db
      .prepare("SELECT department FROM cards WHERE department <> '' GROUP BY department ORDER BY department ASC")
      .all<{ department: string }>(),
    db
      .prepare("SELECT company FROM cards WHERE company <> '' GROUP BY company ORDER BY company ASC")
      .all<{ company: string }>(),
    allTags(db),
  ])

  return {
    total: total?.n ?? 0,
    favorites: favorites?.n ?? 0,
    departments: (deptRow.results ?? []).map((r) => r.department),
    companies: (companyRow.results ?? []).map((r) => r.company),
    tags: tagList,
  }
}

type QueryParams = {
  q?: string
  tag?: string
  company?: string
  department?: string
  favorite?: boolean
  sort?: string
}

/** 一覧取得の共通実装（API と AI アシスタントの両方から使う） */
async function queryCards(db: D1Database, params: QueryParams, limit?: number) {
  const q = (params.q ?? '').trim()
  const tag = (params.tag ?? '').trim()
  const company = (params.company ?? '').trim()
  const department = (params.department ?? '').trim()
  const sort = params.sort ?? 'updated'

  const where: string[] = []
  const bind: unknown[] = []

  if (q) {
    for (const term of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
      where.push(
        `(name LIKE ? OR name_kana LIKE ? OR company LIKE ? OR department LIKE ? OR position LIKE ? OR email LIKE ? OR phone LIKE ? OR mobile LIKE ? OR address LIKE ? OR memo LIKE ? OR tags LIKE ?)`
      )
      const like = `%${term}%`
      bind.push(like, like, like, like, like, like, like, like, like, like, like)
    }
  }
  if (tag) {
    where.push('tags LIKE ?')
    bind.push(`%"${tag}"%`)
  }
  if (company) {
    where.push('company = ?')
    bind.push(company)
  }
  if (department) {
    where.push('department LIKE ?')
    bind.push(`%${department}%`)
  }
  if (params.favorite) where.push('favorite = 1')

  const orderBy =
    sort === 'name'
      ? 'name_kana ASC, name ASC'
      : sort === 'company'
        ? 'company ASC, name ASC'
        : sort === 'met'
          ? "CASE WHEN met_at = '' THEN 1 ELSE 0 END, met_at DESC"
          : 'updated_at DESC'

  const limitSql = limit ? ` LIMIT ${Math.max(1, Math.min(limit, 500))}` : ''
  const sql = `SELECT * FROM cards ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy}${limitSql}`
  const result = await db.prepare(sql).bind(...bind).all<CardRow>()
  return (result.results ?? []).map(toCard)
}

/* ------------------------------------------------------------------ */
/* AI edit: 対象の解決 / 差分の生成 / 適用                             */
/*                                                                     */
/* AI は「変更したい内容」を提案するだけで、ここで DB と突き合わせて   */
/* 差分を作り、ユーザーが確認した後にはじめて書き込む。                 */
/* ------------------------------------------------------------------ */

/**
 * 編集可能フィールド → DB のカラム名（camelCase ↔ snake_case の変換表）。
 * 差分の「変更前」は Card から読むので、Card のキー名で持つ。
 */
const FIELD_KEY: Record<EditableField, keyof Card> = {
  name: 'name',
  nameKana: 'nameKana',
  company: 'company',
  department: 'department',
  position: 'position',
  email: 'email',
  phone: 'phone',
  mobile: 'mobile',
  website: 'website',
  address: 'address',
  memo: 'memo',
  metAt: 'metAt',
}

/** 編集可能フィールド → D1 のカラム名（UPDATE 文の組み立てに使う） */
const FIELD_COLUMN: Record<EditableField, string> = {
  name: 'name',
  nameKana: 'name_kana',
  company: 'company',
  department: 'department',
  position: 'position',
  email: 'email',
  phone: 'phone',
  mobile: 'mobile',
  website: 'website',
  address: 'address',
  memo: 'memo',
  metAt: 'met_at',
}

export type FieldDiff = { field: EditableField; label: string; before: string; after: string }

export type EditPreview = {
  cardId: number
  card: Card
  fieldDiffs: FieldDiff[]
  tagsAdd: string[]
  tagsRemove: string[]
  favorite: { before: boolean; after: boolean } | null
  hasChange: boolean
}

/** 「鈴木さん」「鈴木 様」のような敬称を落として照合しやすくする */
function cleanPersonName(value: string): string {
  return value
    .replace(/[\s　]*(さん|様|氏|君|くん|ちゃん)$/u, '')
    .replace(/[\s　]+/g, ' ')
    .trim()
}

type TargetResolution =
  | { status: 'ok'; card: Card }
  | { status: 'ambiguous'; candidates: Card[] }
  | { status: 'not-found' }
  | { status: 'no-target' }

/**
 * 対象の手がかり（氏名・会社名）から名刺を1件に絞り込む。
 * 同点の候補が複数あるときは推測せずに候補を返す。
 */
async function resolveTarget(db: D1Database, target: TargetHint): Promise<TargetResolution> {
  const nameKey = cleanPersonName(target.name).replace(/\s+/g, '').toLowerCase()
  const companyKey = (target.company ?? '').trim().toLowerCase()
  if (!nameKey && !companyKey) return { status: 'no-target' }

  const clauses: string[] = []
  const bind: unknown[] = []
  if (nameKey) {
    clauses.push("LOWER(REPLACE(name, ' ', '')) LIKE ?")
    bind.push(`%${nameKey}%`)
  }
  if (companyKey) {
    clauses.push('LOWER(company) LIKE ?')
    bind.push(`%${companyKey}%`)
  }

  const rows = await db
    .prepare(`SELECT * FROM cards WHERE ${clauses.join(' OR ')} ORDER BY updated_at DESC LIMIT 50`)
    .bind(...bind)
    .all<CardRow>()

  const scored = (rows.results ?? [])
    .map((row) => {
      const card = toCard(row)
      let score = 0
      const cardName = card.name.replace(/\s+/g, '').toLowerCase()
      if (nameKey && cardName === nameKey) score += 6
      else if (nameKey && cardName.includes(nameKey)) score += 3
      const cardCompany = card.company.toLowerCase()
      if (companyKey && cardCompany === companyKey) score += 4
      else if (companyKey && (cardCompany.includes(companyKey) || companyKey.includes(cardCompany))) {
        score += 2
      }
      return { card, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) return { status: 'not-found' }
  if (scored.length === 1 || scored[0].score > scored[1].score) {
    return { status: 'ok', card: scored[0].card }
  }
  return { status: 'ambiguous', candidates: scored.slice(0, 5).map((x) => x.card) }
}

/** 現在値と提案値の差分を作る。変化のない項目は差分に含めない。 */
function buildEditPreview(card: Card, changes: CardChanges): EditPreview {
  const fieldDiffs: FieldDiff[] = []

  for (const field of EDITABLE_FIELDS) {
    const proposed = changes[field]
    if (typeof proposed !== 'string') continue
    const after = proposed.trim()
    if (!after) continue
    const before = String(card[FIELD_KEY[field]] ?? '')
    if (before === after) continue
    fieldDiffs.push({ field, label: FIELD_LABELS[field], before, after })
  }

  const tagsAdd = (changes.addTags ?? []).filter((t) => !card.tags.includes(t))
  const tagsRemove = (changes.removeTags ?? []).filter((t) => card.tags.includes(t))
  const favorite =
    typeof changes.favorite === 'boolean' && changes.favorite !== card.favorite
      ? { before: card.favorite, after: changes.favorite }
      : null

  return {
    cardId: card.id,
    card,
    fieldDiffs,
    tagsAdd,
    tagsRemove,
    favorite,
    hasChange: fieldDiffs.length > 0 || tagsAdd.length > 0 || tagsRemove.length > 0 || favorite !== null,
  }
}

/**
 * 差分を実際に DB へ書き込む。
 * changes は必ず normalizeChanges() を通したものを渡すこと（許可リスト外の項目は無視される）。
 */
async function applyCardChanges(
  db: D1Database,
  card: Card,
  changes: CardChanges
): Promise<Card | null> {
  const sets: string[] = []
  const bind: unknown[] = []

  for (const field of EDITABLE_FIELDS) {
    const proposed = changes[field]
    if (typeof proposed !== 'string') continue
    const value = proposed.trim()
    if (!value) continue
    sets.push(`${FIELD_COLUMN[field]} = ?`)
    bind.push(value.slice(0, field === 'memo' ? 2000 : 300))
  }

  if (changes.addTags?.length || changes.removeTags?.length) {
    let tags = [...card.tags]
    for (const tag of changes.addTags ?? []) if (!tags.includes(tag)) tags.push(tag)
    for (const tag of changes.removeTags ?? []) tags = tags.filter((t) => t !== tag)
    sets.push('tags = ?')
    bind.push(JSON.stringify(tags.slice(0, 20)))
  }

  if (typeof changes.favorite === 'boolean') {
    sets.push('favorite = ?')
    bind.push(changes.favorite ? 1 : 0)
  }

  if (!sets.length) return null

  sets.push("updated_at = datetime('now')")
  await db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).bind(...bind, card.id).run()

  const row = await db.prepare('SELECT * FROM cards WHERE id = ?').bind(card.id).first<CardRow>()
  return row ? toCard(row) : null
}

/** クライアントから来た filters を安全な範囲に丸める */
function sanitizeFilters(raw: unknown): QueryParams {
  const f = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  return {
    q: str(f.q, 120),
    tag: str(f.tag, 40),
    company: str(f.company, 120),
    department: str(f.department, 60),
    favorite: f.favorite === true,
    sort: str(f.sort, 20),
  }
}

async function getCardById(db: D1Database, id: number): Promise<Card | null> {
  const row = await db.prepare('SELECT * FROM cards WHERE id = ?').bind(id).first<CardRow>()
  return row ? toCard(row) : null
}

/* ------------------------------------------------------------------ */
/* list / search                                                       */
/* ------------------------------------------------------------------ */

app.get('/api/cards', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)

  const cards = await queryCards(db, {
    q: c.req.query('q'),
    tag: c.req.query('tag'),
    company: c.req.query('company'),
    department: c.req.query('department'),
    favorite: c.req.query('favorite') === '1',
    sort: c.req.query('sort'),
  })

  return c.json({ cards, total: cards.length })
})

/* ------------------------------------------------------------------ */
/* meta (filters + stats)                                              */
/* ------------------------------------------------------------------ */

app.get('/api/meta', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)

  const [total, favorites, companiesRow, deptRow, tagList] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM cards').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM cards WHERE favorite = 1').first<{ n: number }>(),
    db
      .prepare("SELECT company FROM cards WHERE company <> '' GROUP BY company ORDER BY company ASC")
      .all<{ company: string }>(),
    db
      .prepare(
        "SELECT department, COUNT(*) AS n FROM cards WHERE department <> '' GROUP BY department ORDER BY n DESC, department ASC"
      )
      .all<{ department: string; n: number }>(),
    allTags(db),
  ])

  return c.json({
    total: total?.n ?? 0,
    favorites: favorites?.n ?? 0,
    companies: (companiesRow.results ?? []).map((r) => r.company),
    departments: (deptRow.results ?? []).map((r) => r.department),
    tags: tagList,
  })
})

/* ------------------------------------------------------------------ */
/* single card                                                         */
/* ------------------------------------------------------------------ */

app.get('/api/cards/:id', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)

  const row = await db.prepare('SELECT * FROM cards WHERE id = ?').bind(id).first<CardRow>()
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(toCard(row))
})

/* ------------------------------------------------------------------ */
/* create                                                              */
/* ------------------------------------------------------------------ */

app.post('/api/cards', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)

  let body: CardInput
  try {
    body = (await c.req.json()) as CardInput
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  const parsed = normalizeInput(body)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const v = parsed.values

  const cols = ['name', ...TEXT_FIELDS, 'tags', 'favorite']
  const result = await db
    .prepare(`INSERT INTO cards (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map((col) => (v as Record<string, unknown>)[col]))
    .run()

  const id = Number(result.meta.last_row_id)
  const row = await db.prepare('SELECT * FROM cards WHERE id = ?').bind(id).first<CardRow>()
  return c.json(row ? toCard(row) : { id }, 201)
})

/* ------------------------------------------------------------------ */
/* update                                                              */
/* ------------------------------------------------------------------ */

app.put('/api/cards/:id', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)

  let body: CardInput
  try {
    body = (await c.req.json()) as CardInput
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  const parsed = normalizeInput(body)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const v = parsed.values

  const cols = ['name', ...TEXT_FIELDS, 'tags', 'favorite']
  const result = await db
    .prepare(
      `UPDATE cards SET ${cols.map((col) => `${col} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
    )
    .bind(...cols.map((col) => (v as Record<string, unknown>)[col]), id)
    .run()

  if (result.meta.changes === 0) return c.json({ error: 'not found' }, 404)

  const row = await db.prepare('SELECT * FROM cards WHERE id = ?').bind(id).first<CardRow>()
  return c.json(row ? toCard(row) : { ok: true })
})

/* ------------------------------------------------------------------ */
/* favorite toggle                                                     */
/* ------------------------------------------------------------------ */

app.patch('/api/cards/:id/favorite', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)

  const row = await db.prepare('SELECT favorite FROM cards WHERE id = ?').bind(id).first<{ favorite: number }>()
  if (!row) return c.json({ error: 'not found' }, 404)

  const next = row.favorite === 1 ? 0 : 1
  await db
    .prepare("UPDATE cards SET favorite = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(next, id)
    .run()

  return c.json({ id, favorite: next === 1 })
})

/* ------------------------------------------------------------------ */
/* delete                                                              */
/* ------------------------------------------------------------------ */

app.delete('/api/cards/:id', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)

  const result = await db.prepare('DELETE FROM cards WHERE id = ?').bind(id).run()
  if (result.meta.changes === 0) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

app.get('/api/export.csv', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)

  const result = await db
    .prepare('SELECT * FROM cards ORDER BY name_kana ASC, name ASC')
    .all<CardRow>()

  const header = [
    '氏名', 'ふりがな', '会社名', '部署', '役職', 'メール', '電話', '携帯',
    'Webサイト', '住所', 'タグ', 'メモ', 'お気に入り', '名刺交換日',
  ]
  const lines = [header.map(csvCell).join(',')]
  for (const row of result.results ?? []) {
    const card = toCard(row)
    lines.push(
      [
        card.name, card.nameKana, card.company, card.department, card.position,
        card.email, card.phone, card.mobile, card.website, card.address,
        card.tags.join(' '), card.memo, card.favorite ? '1' : '', card.metAt,
      ]
        .map(csvCell)
        .join(',')
    )
  }

  const filename = `meishi-${new Date().toISOString().slice(0, 10)}.csv`
  return new Response('\uFEFF' + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})

/* ------------------------------------------------------------------ */
/* CSV import                                                          */
/* ------------------------------------------------------------------ */

/** 既存カードの重複判定キーを集合で返す */
async function existingKeys(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare('SELECT name, company FROM cards').all<{ name: string; company: string }>()
  return new Set((rows.results ?? []).map((r) => duplicateKey(r.name, r.company)))
}

type ImportRow = ParsedRow & {
  line: number
  duplicate: boolean
}

const MAX_IMPORT_BYTES = 2 * 1024 * 1024 // 2MB
const MAX_IMPORT_ROWS = 2000

async function readCsvBody(c: { req: { text: () => Promise<string> } }): Promise<string> {
  const text = await c.req.text()
  if (text.length > MAX_IMPORT_BYTES) {
    throw new Error('CSVが大きすぎます（2MBまで）')
  }
  return text
}

app.post('/api/import/preview', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)

  let text: string
  try {
    text = await readCsvBody(c)
  } catch (err) {
    return c.json({ error: (err as Error).message }, 413)
  }

  const parsed = csvToCards(text)
  if (!parsed.rows.length) {
    return c.json({
      rows: [],
      headers: parsed.headers,
      mapping: parsed.mapping,
      skipped: parsed.skipped,
      stats: { total: 0, newCount: 0, duplicateCount: 0, errorCount: parsed.skipped.length },
      error: '取り込める行がありませんでした。1行目がヘッダか確認してください。',
    })
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    return c.json({ error: `一度に取り込めるのは${MAX_IMPORT_ROWS}件までです` }, 413)
  }

  const keys = await existingKeys(db)
  const seen = new Set<string>()
  const rows: ImportRow[] = parsed.rows.map((row, i) => {
    const key = duplicateKey(row.name, row.company)
    const duplicate = keys.has(key) || seen.has(key)
    seen.add(key)
    return { ...row, line: i + 2, duplicate }
  })

  return c.json({
    rows,
    headers: parsed.headers,
    mapping: parsed.mapping,
    skipped: parsed.skipped,
    stats: {
      total: rows.length,
      newCount: rows.filter((r) => !r.duplicate).length,
      duplicateCount: rows.filter((r) => r.duplicate).length,
      errorCount: parsed.skipped.length,
      missingEmail: rows.filter((r) => !r.email).length,
    },
  })
})

app.post('/api/import/commit', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)

  let body: { rows?: unknown; skipDuplicates?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  const incoming = Array.isArray(body.rows) ? body.rows : []
  const skipDuplicates = body.skipDuplicates !== false
  if (!incoming.length) return c.json({ error: '取り込む行がありません' }, 400)
  if (incoming.length > MAX_IMPORT_ROWS) {
    return c.json({ error: `一度に取り込めるのは${MAX_IMPORT_ROWS}件までです` }, 413)
  }

  const keys = await existingKeys(db)
  const seen = new Set<string>()
  const statements: D1PreparedStatement[] = []
  const results: Array<{ name: string; status: 'inserted' | 'skipped'; reason?: string }> = []

  for (const raw of incoming) {
    const r = raw as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 120) : ''
    const company = typeof r.company === 'string' ? r.company.trim().slice(0, 160) : ''
    if (!name) {
      results.push({ name: '(氏名なし)', status: 'skipped', reason: '氏名が空' })
      continue
    }

    const key = duplicateKey(name, company)
    if (skipDuplicates && (keys.has(key) || seen.has(key))) {
      results.push({ name, status: 'skipped', reason: '重複' })
      continue
    }
    seen.add(key)

    const tags = Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 24)).slice(0, 12)
      : []

    statements.push(
      db
        .prepare(
          `INSERT INTO cards (name, name_kana, company, department, position, email, phone, mobile, website, address, tags, memo, favorite, met_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          name,
          String(r.nameKana ?? '').slice(0, 120),
          company,
          String(r.department ?? '').slice(0, 160),
          String(r.position ?? '').slice(0, 160),
          String(r.email ?? '').slice(0, 200),
          String(r.phone ?? '').slice(0, 60),
          String(r.mobile ?? '').slice(0, 60),
          String(r.website ?? '').slice(0, 300),
          String(r.address ?? '').slice(0, 300),
          JSON.stringify(tags),
          String(r.memo ?? '').slice(0, 2000),
          r.favorite === true ? 1 : 0,
          String(r.metAt ?? '').slice(0, 20)
        )
    )
    results.push({ name, status: 'inserted' })
  }

  // D1 のバッチ上限に配慮して分割実行
  const CHUNK = 100
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK))
  }

  return c.json({
    inserted: results.filter((r) => r.status === 'inserted').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  })
})

/* ------------------------------------------------------------------ */
/* AI assistant                                                        */
/* ------------------------------------------------------------------ */

app.post('/api/assistant', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)

  let body: { text?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 300) : ''
  if (!text) return c.json({ error: 'メッセージを入力してください' }, 400)

  const vocab = await getVocabulary(db)
  const result = await interpret(text, vocab, {
    OPENAI_API_KEY: c.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: c.env.OPENAI_BASE_URL,
    AI_MODEL: c.env.AI_MODEL,
  })

  // intent に応じた実データを返す。数字は必ず DB の集計を使う。
  if (result.intent === 'answer') {
    const deptCounts = await db
      .prepare(
        "SELECT department, COUNT(*) AS n FROM cards WHERE department <> '' GROUP BY department ORDER BY n DESC"
      )
      .all<{ department: string; n: number }>()

    return c.json({
      ...result,
      answer: {
        total: vocab.total,
        favorites: vocab.favorites,
        departments: (deptCounts.results ?? []).slice(0, 8),
      },
      cards: [],
      total: 0,
    })
  }

  if (result.intent === 'export') {
    return c.json({ ...result, cards: [], total: vocab.total, exportUrl: '/api/export.csv' })
  }

  if (result.intent === 'help') {
    return c.json({
      ...result,
      cards: [],
      total: 0,
      help: [
        '「広報部署だけまとめて」のように話しかけると、その条件で絞り込みます',
        '「お気に入りだけ」「SaaSの人」「あいうえお順で」なども使えます',
        '「鈴木さんの部署を営業本部に変えて」のように、内容の書き換えもできます',
        '「広報の人に『展示会』タグを付けて」でまとめてタグ付けできます',
        '「名刺は何枚ある？」で件数を集計します',
        '「CSVで出して」でCSVをダウンロードします',
      ],
    })
  }

  /* --- 編集提案（適用はまだしない） --------------------------------- */
  if (result.intent === 'update') {
    const resolution = await resolveTarget(db, result.target)

    if (resolution.status === 'no-target') {
      return c.json({
        ...result,
        cards: [],
        total: 0,
        edit: { status: 'no-target' },
      })
    }

    if (resolution.status === 'not-found') {
      return c.json({
        ...result,
        cards: [],
        total: 0,
        edit: { status: 'not-found', target: result.target },
      })
    }

    if (resolution.status === 'ambiguous') {
      return c.json({
        ...result,
        cards: resolution.candidates,
        total: resolution.candidates.length,
        edit: { status: 'ambiguous', target: result.target, candidates: resolution.candidates },
      })
    }

    const preview = buildEditPreview(resolution.card, result.changes)
    if (!preview.hasChange) {
      return c.json({
        ...result,
        cards: [resolution.card],
        total: 1,
        edit: { status: 'no-change', preview },
      })
    }

    return c.json({
      ...result,
      cards: [resolution.card],
      total: 1,
      edit: {
        status: 'ready',
        preview,
        // 適用時にそのまま送り返してもらう（サーバ側で再検証する）
        proposal: { cardId: resolution.card.id, changes: result.changes },
      },
    })
  }

  if (result.intent === 'bulk_tag') {
    const tag = result.tagOp.tag
    if (!tag) {
      return c.json({
        ...result,
        cards: [],
        total: 0,
        edit: { status: 'no-tag' },
      })
    }

    const targetCards = await queryCards(db, result.filters, 200)

    // 既に付いている／付いていない名刺は対象から外して「実際に変わる件数」を出す
    const affected =
      result.tagOp.op === 'add'
        ? targetCards.filter((card) => !card.tags.includes(tag))
        : targetCards.filter((card) => card.tags.includes(tag))

    return c.json({
      ...result,
      cards: affected,
      total: affected.length,
      edit: {
        status: affected.length ? 'ready' : 'no-change',
        bulk: {
          tag,
          op: result.tagOp.op,
          filters: result.filters,
          affectedIds: affected.map((card) => card.id),
          candidates: targetCards.length,
        },
        proposal: {
          tagOp: { tag, op: result.tagOp.op },
          filters: result.filters,
          cardIds: affected.map((card) => card.id),
        },
      },
    })
  }

  // filter
  const cards = await queryCards(db, result.filters, 200)
  return c.json({ ...result, cards, total: cards.length })
})

/* ------------------------------------------------------------------ */
/* AI edit: 適用                                                       */
/*                                                                     */
/* クライアントから受け取った内容を鵜呑みにせず、必ず再検証してから    */
/* 書き込む。AI の提案と画面の表示がずれていても安全側に倒れる。        */
/* ------------------------------------------------------------------ */

app.post('/api/assistant/apply', async (c) => {
  const db = c.env.DB
  await ensureDatabase(db)

  let body: {
    mode?: unknown
    cardId?: unknown
    changes?: unknown
    tagOp?: unknown
    filters?: unknown
    cardIds?: unknown
    dryRun?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  const mode = body.mode === 'bulk_tag' ? 'bulk_tag' : body.mode === 'update' ? 'update' : ''
  if (!mode) return c.json({ error: 'mode が不正です' }, 400)

  /* --- 1件の編集 ---------------------------------------------------- */
  if (mode === 'update') {
    const id = Number(body.cardId)
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'cardId が不正です' }, 400)

    const card = await getCardById(db, id)
    if (!card) return c.json({ error: '対象の名刺が見つかりません' }, 404)

    const changes = normalizeChanges(body.changes)
    const preview = buildEditPreview(card, changes)

    // 対象が複数あったときの選び直し用。差分だけ返し、書き込みはしない。
    if (body.dryRun === true) {
      return c.json({ ok: true, dryRun: true, card, preview })
    }

    if (!preview.hasChange) {
      return c.json({ ok: true, changed: false, card, preview })
    }

    // 氏名は空にできない（必須項目）
    if (preview.fieldDiffs.some((d) => d.field === 'name' && !d.after)) {
      return c.json({ error: '氏名は空にできません' }, 400)
    }

    const updated = await applyCardChanges(db, card, changes)
    if (!updated) return c.json({ ok: true, changed: false, card, preview })

    return c.json({ ok: true, changed: true, card: updated, preview, applied: preview })
  }

  /* --- 複数件へのタグ一括操作 ---------------------------------------- */
  const tagOpRaw = (body.tagOp ?? {}) as Record<string, unknown>
  const tag = typeof tagOpRaw.tag === 'string' ? tagOpRaw.tag.replace(/^#/, '').replace(/[,#]/g, '').trim().slice(0, 24) : ''
  const op = tagOpRaw.op === 'remove' ? 'remove' : 'add'
  if (!tag) return c.json({ error: 'タグが指定されていません' }, 400)

  // クライアントが対象 ID を送ってきた場合はそれを使う。
  // 送られてこない場合は filters からサーバ側で引き直す（件数の捏造を防ぐ）。
  let ids: number[] = []
  if (Array.isArray(body.cardIds)) {
    ids = Array.from(
      new Set(
        body.cardIds
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0)
      )
    ).slice(0, 500)
  } else {
    ids = (await queryCards(db, sanitizeFilters(body.filters), 200)).map((card) => card.id)
  }

  if (!ids.length) return c.json({ ok: true, changed: false, updated: 0, tag, op })

  const rows = await db
    .prepare(`SELECT * FROM cards WHERE id IN (${ids.map(() => '?').join(', ')})`)
    .bind(...ids)
    .all<CardRow>()
  const cards = (rows.results ?? []).map(toCard)

  const statements = []
  let updated = 0
  for (const card of cards) {
    const has = card.tags.includes(tag)
    if (op === 'add' && has) continue
    if (op === 'remove' && !has) continue

    const next = op === 'add' ? [...card.tags, tag] : card.tags.filter((t) => t !== tag)
    statements.push(
      db
        .prepare("UPDATE cards SET tags = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify(next.slice(0, 20)), card.id)
    )
    updated++
  }

  const CHUNK = 100
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK))
  }

  return c.json({ ok: true, changed: updated > 0, updated, tag, op })
})

/* ------------------------------------------------------------------ */
/* page shell                                                          */
/* ------------------------------------------------------------------ */

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Meishi — 名刺管理</title>
<meta name="description" content="名刺を一元管理。検索・タグ・お気に入り・CSV出力。" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/static/style.css?v=${__ASSET_VERSION__}" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%230f172a'/><rect x='22' y='30' width='56' height='40' rx='6' fill='%2367e8f9'/></svg>" />
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7.5 10.5h4M7.5 14h7"/><circle cx="16.5" cy="10" r="1.4" fill="currentColor" stroke="none"/></svg>
      </span>
      <span class="brand-name">Meishi</span>
      <span class="brand-sub">名刺管理</span>
    </div>
    <div class="topbar-actions">
      <button class="btn btn-ghost" id="export-btn" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        CSV出力
      </button>
      <button class="btn btn-ghost" id="import-btn" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 15V3m0 0 4 4m-4-4L8 7M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        CSV取込
      </button>
      <button class="btn btn-primary" id="new-card-btn" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        名刺を追加
      </button>
    </div>
  </header>

  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <nav aria-label="絞り込み">
        <p class="side-label">表示</p>
        <button class="side-item is-active" data-filter="all" type="button">
          <span class="side-icon">▦</span>すべての名刺<span class="side-count" id="count-all">0</span>
        </button>
        <button class="side-item" data-filter="favorite" type="button">
          <span class="side-icon">★</span>お気に入り<span class="side-count" id="count-fav">0</span>
        </button>

        <p class="side-label">タグ</p>
        <div class="chip-list" id="tag-filters"></div>

        <p class="side-label">部署</p>
        <div class="dept-list" id="dept-filters"></div>

        <p class="side-label">会社</p>
        <div class="company-list" id="company-filters"></div>
      </nav>
    </aside>

    <main class="main">
      <section class="toolbar" aria-label="検索と並び替え">
        <div class="search-wrap">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input
            id="search-input"
            class="search-input"
            type="search"
            placeholder="氏名・会社・タグ・メモで検索…"
            autocomplete="off"
            aria-label="名刺を検索"
          />
          <kbd class="search-kbd">/</kbd>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-ghost btn-icon mobile-filter" id="filter-toggle" type="button" aria-label="絞り込みを開く">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
          </button>
          <label class="sort-wrap">
            <span class="sort-label">並び替え</span>
            <select id="sort-select" class="sort-select" aria-label="並び替え">
              <option value="updated">最近の更新</option>
              <option value="name">氏名（あいうえお順）</option>
              <option value="company">会社名</option>
              <option value="met">名刺交換日</option>
            </select>
          </label>
        </div>
      </section>

      <section class="result-head">
        <h1 class="result-title" id="result-title">すべての名刺</h1>
        <p class="result-count" id="result-count">読み込み中…</p>
      </section>

      <section id="card-grid" class="card-grid" aria-live="polite"></section>
      <div id="empty-state" class="empty-state" hidden>
        <div class="empty-illustration" aria-hidden="true">
          <svg viewBox="0 0 120 120" fill="none"><rect x="22" y="34" width="76" height="52" rx="8" stroke="currentColor" stroke-width="2.5" stroke-dasharray="6 6"/><path d="M40 56h20M40 67h30" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="60" cy="18" r="12" fill="currentColor" opacity=".08"/><path d="M60 12v12M54 18h12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
        </div>
        <h2>該当する名刺がありません</h2>
        <p>検索条件を変えるか、新しい名刺を追加してください。</p>
        <button class="btn btn-primary" id="empty-add-btn" type="button">名刺を追加</button>
      </div>
    </main>
  </div>

  <!-- detail drawer -->
  <div class="overlay" id="drawer-overlay" hidden></div>
  <aside class="drawer" id="detail-drawer" aria-hidden="true" aria-label="名刺の詳細">
    <div id="detail-content"></div>
  </aside>

  <!-- form modal -->
  <div class="modal-backdrop" id="modal-backdrop" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-head">
        <h2 id="modal-title">名刺を追加</h2>
        <button class="icon-btn" id="modal-close" type="button" aria-label="閉じる">✕</button>
      </header>
      <form id="card-form" class="modal-body" novalidate>
        <input type="hidden" id="field-id" />
        <div class="form-grid">
          <label class="field">
            <span>氏名 <em>*</em></span>
            <input id="field-name" name="name" type="text" required placeholder="山田 太郎" />
          </label>
          <label class="field">
            <span>ふりがな</span>
            <input id="field-nameKana" name="nameKana" type="text" placeholder="やまだ たろう" />
          </label>
          <label class="field">
            <span>会社名</span>
            <input id="field-company" name="company" type="text" placeholder="株式会社サンプル" />
          </label>
          <label class="field">
            <span>部署</span>
            <input id="field-department" name="department" type="text" placeholder="営業部" />
          </label>
          <label class="field">
            <span>役職</span>
            <input id="field-position" name="position" type="text" placeholder="課長" />
          </label>
          <label class="field">
            <span>名刺交換日</span>
            <input id="field-metAt" name="metAt" type="date" />
          </label>
          <label class="field">
            <span>メール</span>
            <input id="field-email" name="email" type="email" placeholder="taro@example.com" />
          </label>
          <label class="field">
            <span>電話</span>
            <input id="field-phone" name="phone" type="tel" placeholder="03-0000-0000" />
          </label>
          <label class="field">
            <span>携帯</span>
            <input id="field-mobile" name="mobile" type="tel" placeholder="090-0000-0000" />
          </label>
          <label class="field">
            <span>Webサイト</span>
            <input id="field-website" name="website" type="text" placeholder="example.com" />
          </label>
          <label class="field field-full">
            <span>住所</span>
            <input id="field-address" name="address" type="text" placeholder="東京都…" />
          </label>
          <label class="field field-full">
            <span>タグ <small>（カンマ区切り・最大12個）</small></span>
            <input id="field-tags" name="tags" type="text" placeholder="営業, 決裁者" />
          </label>
          <label class="field field-full">
            <span>メモ</span>
            <textarea id="field-memo" name="memo" rows="3" placeholder="商談の内容や次回のアクションなど"></textarea>
          </label>
          <label class="checkbox field-full">
            <input id="field-favorite" name="favorite" type="checkbox" />
            <span>お気に入りに登録</span>
          </label>
        </div>
        <p class="form-error" id="form-error" hidden></p>
        <footer class="modal-foot">
          <button class="btn btn-ghost" type="button" id="modal-cancel">キャンセル</button>
          <button class="btn btn-primary" type="submit" id="form-submit">保存する</button>
        </footer>
      </form>
    </div>
  </div>

  <div class="toast" id="toast" hidden></div>

  <!-- AI assistant -->
  <button class="ai-fab" id="ai-fab" type="button" aria-label="AIアシスタントを開く" aria-expanded="false">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v2M12 19v2M5 12H3M21 12h-2M7.05 7.05 5.64 5.64M18.36 18.36l-1.41-1.41M7.05 16.95l-1.41 1.41M18.36 5.64l-1.41 1.41"/><circle cx="12" cy="12" r="4"/></svg>
    <span class="ai-fab-label">AI</span>
  </button>

  <section class="ai-panel" id="ai-panel" aria-hidden="true" aria-label="AIアシスタント">
    <header class="ai-head">
      <div class="ai-title">
        <span class="ai-dot" aria-hidden="true"></span>
        <div>
          <strong>AIアシスタント</strong>
          <small>話しかけて絞り込む</small>
        </div>
      </div>
      <button class="icon-btn" id="ai-close" type="button" aria-label="閉じる">✕</button>
    </header>

    <div class="ai-log" id="ai-log" role="log" aria-live="polite"></div>

    <div class="ai-suggest" id="ai-suggest">
      <button type="button" data-suggest="広報部署だけまとめて">広報部署だけまとめて</button>
      <button type="button" data-suggest="お気に入りだけ見せて">お気に入りだけ</button>
      <button type="button" data-suggest="営業の人をあいうえお順で">営業をあいうえお順で</button>
      <button type="button" data-suggest="名刺は何枚ある？">何枚ある？</button>
    </div>

    <form class="ai-form" id="ai-form">
      <input
        id="ai-input"
        class="ai-input"
        type="text"
        placeholder="「広報部署だけまとめて」など"
        autocomplete="off"
        aria-label="AIへの指示"
      />
      <button class="ai-send" type="submit" id="ai-send" aria-label="送信">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 14-7-7 14-2-5-5-2Z"/></svg>
      </button>
    </form>
  </section>

  <!-- CSV import modal -->
  <div class="modal-backdrop" id="import-backdrop" hidden>
    <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <header class="modal-head">
        <h2 id="import-title">CSVを取り込む</h2>
        <button class="icon-btn" id="import-close" type="button" aria-label="閉じる">✕</button>
      </header>
      <div class="modal-body">
        <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="CSVファイルを選択">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 16V4m0 0 4 4m-4-4L8 8"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
          <p class="dz-main">CSVをここにドロップ</p>
          <p class="dz-sub">またはクリックして選択（UTF-8 / 2MBまで）</p>
          <input type="file" id="file-input" accept=".csv,text/csv,text/plain" hidden />
        </div>

        <p class="import-hint">
          1行目をヘッダとして読み取ります。「氏名」「会社名」「部署」「タグ」などの列名は、
          <strong>表記ゆれを自動で吸収</strong>します（例: お名前 / Name / 勤務先）。
        </p>

        <div id="import-result" hidden>
          <div class="import-stats" id="import-stats"></div>
          <div class="import-table-wrap">
            <table class="import-table" id="import-table"></table>
          </div>
          <label class="checkbox import-skip">
            <input type="checkbox" id="skip-duplicates" checked />
            <span>重複している名刺はスキップする</span>
          </label>
        </div>

        <p class="form-error" id="import-error" hidden></p>

        <footer class="modal-foot">
          <button class="btn btn-ghost" type="button" id="import-cancel">キャンセル</button>
          <button class="btn btn-primary" type="button" id="import-commit" disabled>取り込む</button>
        </footer>
      </div>
    </div>
  </div>

  <script src="/static/app.js?v=${__ASSET_VERSION__}"></script>
</body>
</html>`

app.get('/', (c) => c.html(html))

export default app
