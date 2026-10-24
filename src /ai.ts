/**
 * AI アシスタント。
 *
 * 役割は「自然言語 → 検索条件 / 編集案」の変換に限定している。
 * 件数の集計・絞り込み・書き込みの実行は必ずサーバ側で行うため、
 * モデルが数字や対象を捏造しても結果には影響しない。
 *
 * 編集は「提案（diff）」を返すだけで、このモジュールから DB は書き換えない。
 * 実際の適用はユーザーが確認した後、サーバの apply 系エンドポイントが行う。
 */

export type Filters = {
  q: string
  department: string
  company: string
  tag: string
  favorite: boolean
  sort: 'updated' | 'name' | 'company' | 'met'
}

export type Intent = 'filter' | 'answer' | 'export' | 'help' | 'update' | 'bulk_tag'

/** AI が変更を提案できる項目。ここに無いものは絶対に書き換えない。 */
export const EDITABLE_FIELDS = [
  'name',
  'nameKana',
  'company',
  'department',
  'position',
  'email',
  'phone',
  'mobile',
  'website',
  'address',
  'memo',
  'metAt',
] as const

export type EditableField = (typeof EDITABLE_FIELDS)[number]

export const FIELD_LABELS: Record<EditableField, string> = {
  name: '氏名',
  nameKana: 'ふりがな',
  company: '会社名',
  department: '部署',
  position: '役職',
  email: 'メール',
  phone: '電話',
  mobile: '携帯',
  website: 'Webサイト',
  address: '住所',
  memo: 'メモ',
  metAt: '名刺交換日',
}

export type CardChanges = Partial<Record<EditableField, string>> & {
  favorite?: boolean
  addTags?: string[]
  removeTags?: string[]
}

export type TargetHint = { name: string; company: string }

export type TagOp = { tag: string; op: 'add' | 'remove' }

export type AssistantResult = {
  intent: Intent
  filters: Filters
  message: string
  source: 'ai' | 'fallback'
  /** 編集対象の手がかり（サーバが DB と突き合わせて解決する） */
  target: TargetHint
  /** 変更内容（サーバが妥当性を検証してから diff を作る） */
  changes: CardChanges
  /** 一括タグ操作の内容 */
  tagOp: TagOp
}

export const EMPTY_FILTERS: Filters = {
  q: '',
  department: '',
  company: '',
  tag: '',
  favorite: false,
  sort: 'updated',
}

export type Vocabulary = {
  total: number
  favorites: number
  departments: string[]
  companies: string[]
  tags: string[]
}

function buildSystemPrompt(): string {
  return `あなたは名刺管理アプリのアシスタントです。ユーザーの自然言語の指示を、次のJSONに変換してください。

必ず次のJSONのみを出力してください（前後に説明文やコードブロックを付けない）:
{
  "intent": "filter" | "answer" | "export" | "help" | "update" | "bulk_tag",
  "filters": {
    "q": string,
    "department": string,
    "company": string,
    "tag": string,
    "favorite": boolean,
    "sort": "updated" | "name" | "company" | "met"
  },
  "target": { "name": string, "company": string },
  "changes": {
    "name": string, "nameKana": string, "company": string, "department": string,
    "position": string, "email": string, "phone": string, "mobile": string,
    "website": string, "address": string, "memo": string, "metAt": string,
    "favorite": boolean, "addTags": string[], "removeTags": string[]
  },
  "tagOp": { "tag": string, "op": "add" | "remove" },
  "message": string
}

# intent の決め方
- 絞り込み・一覧表示 → "filter"
- 件数や統計 → "answer"
- CSV出力 → "export"
- 使い方の質問 → "help"
- 特定の1人の名刺の内容を書き換える → "update"
- 複数の名刺に同じタグを付け外しする → "bulk_tag"

# update のルール（最重要）
- target に相手を特定する手がかりを入れる。name は氏名（姓だけでもよい）、company は会社名。
- changes には「変更する項目だけ」を入れる。変更しない項目はキーごと省略する（空文字を入れない）。
- 「部署を営業部に変えて」→ changes.department = "営業部"
- 「メールを a@b.com にして」→ changes.email = "a@b.com"
- 「メモに◯◯と追記して」→ 既存メモは不明なので changes.memo に追記内容のみを入れ、message で「追記」と述べる
- 「タグを足して」→ changes.addTags、"タグを外して" → changes.removeTags
- 「お気に入りにして」→ changes.favorite = true
- 対象が曖昧な場合も、決めつけずに target に分かる情報だけ入れる（サーバが候補を出す）

# update で特に気をつけること
- **changes の値はユーザーが言った通りの文字列をそのまま入れる。** 語彙にある別の値に置き換えてはいけない。
  例: ユーザーが「マーケティング部」と言ったら "マーケティング部" を入れる。語彙に「広報・マーケティング」があるからといってそちらに変えない。
- ユーザーがどの項目を変えるか言っていない場合は、changes を空にして intent="help" にする。

# bulk_tag のルール
- filters で対象を絞り、tagOp に tag と op（add/remove）を入れる。
- 例:「営業部の人全員に『展示会』タグを追加」→ filters.department="営業部", tagOp={tag:"展示会", op:"add"}

# 共通ルール
- filters の department / tag / company は必ず語彙にある値を使う（部分一致でよい）。語彙に無い値は無理に作らず空文字にする。
- message は日本語で1文。**件数や数字は書かない**（サーバが実数を付けるため）。
- **update / bulk_tag の message は「これから行う提案」として書く。**「〜に変更しました」「〜しました」のような完了形は使わない。必ず「〜に変更します」「〜を付与します」のように書く（実際の適用はユーザーの確認後）。
- 削除（名刺の削除）は依頼されても実行しない。intent="help" にして断る。
- sort は「あいうえお順」なら "name"、「会社順」なら "company"、「最近会った順」なら "met"、指定が無ければ "updated"。`
}

async function callModel(
  apiKey: string,
  baseUrl: string,
  system: string,
  user: string,
  model: string
): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 1200,
    }),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`AI API ${res.status}: ${detail.slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content ?? ''
}

function pick(value: unknown, allowed: string[]): string {
  if (typeof value !== 'string') return ''
  const v = value.trim()
  if (!v) return ''
  const exact = allowed.find((a) => a === v)
  if (exact) return exact
  const partial = allowed.find((a) => a.includes(v) || v.includes(a))
  return partial ?? ''
}

function normalizeFilters(raw: unknown, vocab: Vocabulary): Filters {
  const f = (raw ?? {}) as Record<string, unknown>
  const sort = ['updated', 'name', 'company', 'met'].includes(String(f.sort))
    ? (String(f.sort) as Filters['sort'])
    : 'updated'

  return {
    q: typeof f.q === 'string' ? f.q.trim().slice(0, 120) : '',
    department: pick(f.department, vocab.departments),
    company: pick(f.company, vocab.companies),
    tag: pick(String(f.tag ?? '').replace(/^#/, ''), vocab.tags),
    favorite: f.favorite === true,
    sort,
  }
}

export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return Array.from(
    new Set(
      raw
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().replace(/^#/, '').replace(/[,#]/g, '').slice(0, 24))
        .filter((t) => t.length > 0)
    )
  ).slice(0, 12)
}

/**
 * 変更内容を許可リストに照らして検証する。
 * AI の出力にも、クライアントから返ってくる適用リクエストにも必ず通すこと。
 */
export function normalizeChanges(raw: unknown): CardChanges {
  const src = (raw ?? {}) as Record<string, unknown>
  const out: CardChanges = {}

  for (const field of EDITABLE_FIELDS) {
    const v = src[field]
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    if (!trimmed) continue
    out[field] = trimmed.slice(0, field === 'memo' ? 2000 : 300)
  }

  if (typeof src.favorite === 'boolean') out.favorite = src.favorite

  const addTags = cleanTags(src.addTags)
  const removeTags = cleanTags(src.removeTags)
  if (addTags.length) out.addTags = addTags
  if (removeTags.length) out.removeTags = removeTags

  return out
}

/** ルールベースのフォールバック。AI が使えない環境でも機能を止めないための保険。 */
export function fallbackInterpret(text: string, vocab: Vocabulary): AssistantResult {
  const t = text.trim()
  const lower = t.toLowerCase()
  const base = {
    filters: { ...EMPTY_FILTERS },
    source: 'fallback' as const,
    target: { name: '', company: '' },
    changes: {} as CardChanges,
    tagOp: { tag: '', op: 'add' as const },
  }

  if (/csv|エクスポート|書き出|ダウンロード/.test(lower)) {
    return { ...base, intent: 'export', message: 'CSVを出力します。' }
  }
  if (/何(枚|件)|件数|何人|いくつ|統計|合計/.test(t)) {
    return { ...base, intent: 'answer', message: '名刺の件数をお答えします。' }
  }
  if (/変えて|変更|修正|編集|付け(て|る)|外し(て|てる)|追加し(て|る)|にして/.test(t)) {
    // AI が無い状態で編集内容を推測するのは危険なので、解釈できなかったと伝える
    return {
      ...base,
      intent: 'update',
      message: 'AIが利用できないため、編集内容を解釈できませんでした。手動で編集してください。',
    }
  }
  if (/使い方|ヘルプ|どうやって|方法/.test(t)) {
    return { ...base, intent: 'help', message: '使い方をご案内します。' }
  }

  const filters: Filters = { ...EMPTY_FILTERS }
  if (/お気に入り|スター|★/.test(t)) filters.favorite = true

  const best = (candidates: string[]): string => {
    let found = ''
    for (const c of candidates) {
      if (c && t.includes(c) && c.length > found.length) found = c
    }
    return found
  }

  filters.department = best(vocab.departments)
  filters.company = best(vocab.companies)
  const rawTag = best(vocab.tags)
  if (rawTag) filters.tag = rawTag

  if (!filters.department) {
    const partial = best(vocab.departments.map((d) => d.slice(0, 2)))
    if (partial) {
      filters.department = vocab.departments.find((d) => d.startsWith(partial)) ?? ''
    }
  }

  if (/あいうえお|名前順|氏名順|五十音/.test(t)) filters.sort = 'name'
  else if (/会社順/.test(t)) filters.sort = 'company'
  else if (/最近会った|新しい順|交換日/.test(t)) filters.sort = 'met'

  return {
    ...base,
    intent: 'filter',
    filters,
    message: filters.favorite && !filters.department && !filters.company && !filters.tag
      ? 'お気に入りの名刺を表示します。'
      : '条件に合う名刺を表示します。',
  }
}

export async function interpret(
  text: string,
  vocab: Vocabulary,
  env: { OPENAI_API_KEY?: string; OPENAI_BASE_URL?: string; AI_MODEL?: string }
): Promise<AssistantResult> {
  const apiKey = env.OPENAI_API_KEY
  const baseUrl = env.OPENAI_BASE_URL
  if (!apiKey || !baseUrl) return fallbackInterpret(text, vocab)

  const userPayload = [
    '# 語彙',
    JSON.stringify({
      departments: vocab.departments,
      companies: vocab.companies,
      tags: vocab.tags,
      total: vocab.total,
      favorites: vocab.favorites,
    }),
    '',
    '# 指示',
    text,
  ].join('\n')

  try {
    const content = await callModel(
      apiKey,
      baseUrl,
      buildSystemPrompt(),
      userPayload,
      env.AI_MODEL || 'gpt-5-nano'
    )
    const parsed = JSON.parse(content) as {
      intent?: string
      filters?: unknown
      target?: unknown
      changes?: unknown
      tagOp?: unknown
      message?: string
    }

    const intents: Intent[] = ['filter', 'answer', 'export', 'help', 'update', 'bulk_tag']
    const intent: Intent = intents.includes(parsed.intent as Intent)
      ? (parsed.intent as Intent)
      : 'filter'

    const targetRaw = (parsed.target ?? {}) as Record<string, unknown>
    const tagOpRaw = (parsed.tagOp ?? {}) as Record<string, unknown>

    return {
      intent,
      filters: normalizeFilters(parsed.filters, vocab),
      message: typeof parsed.message === 'string' ? parsed.message.slice(0, 200) : '',
      source: 'ai',
      target: {
        name: typeof targetRaw.name === 'string' ? targetRaw.name.trim().slice(0, 60) : '',
        company: typeof targetRaw.company === 'string' ? targetRaw.company.trim().slice(0, 80) : '',
      },
      changes: normalizeChanges(parsed.changes),
      tagOp: {
        tag: cleanTags([tagOpRaw.tag])[0] ?? '',
        op: tagOpRaw.op === 'remove' ? 'remove' : 'add',
      },
    }
  } catch (err) {
    // AI が落ちても機能は止めない
    console.error('AI interpret failed:', err)
    return fallbackInterpret(text, vocab)
  }
}
