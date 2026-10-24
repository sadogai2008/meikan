/**
 * CSV の読み書き。
 * 名刺管理ツール（Excel / Google スプレッドシート / 他社アプリ）から出した
 * CSV は列名も文字コードもバラバラなので、ヘッダ名を正規化して吸収する。
 */

export type ParsedRow = {
  name: string
  nameKana: string
  company: string
  department: string
  position: string
  email: string
  phone: string
  mobile: string
  website: string
  address: string
  tags: string[]
  memo: string
  favorite: boolean
  metAt: string
}

export type ParseResult = {
  rows: ParsedRow[]
  /** 1行目から判定したヘッダ（デバッグ・プレビュー表示用） */
  headers: string[]
  /** どの列をどのフィールドに割り当てたか */
  mapping: Record<string, string>
  skipped: Array<{ line: number; reason: string }>
}

/**
 * RFC4180 準拠の CSV を行の配列にする。
 * 引用符内のカンマ・改行・"" エスケープを正しく扱う。
 */
export function parseCsv(text: string): string[][] {
  // BOM 除去
  let src = text.replace(/^\uFEFF/, '')

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < src.length) {
    const ch = src[i]

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r') {
      // CRLF / CR の両対応
      if (src[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += ch
    i += 1
  }

  // 最終行（改行なしで終わる場合）
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** ヘッダ名の表記ゆれを吸収する（日本語・英語・記号違い） */
const HEADER_ALIASES: Record<keyof ParsedRow, string[]> = {
  name: ['氏名', '姓名', '名前', 'お名前', 'name', 'fullname', 'full name', '担当者', '担当者名'],
  nameKana: ['ふりがな', 'フリガナ', 'よみがな', 'ヨミガナ', 'かな', 'namekana', 'kana', 'reading'],
  company: ['会社名', '会社', '企業名', 'company', 'organization', '組織', '勤務先', '会社名称'],
  department: ['部署', '部署名', '所属', '部門', 'department', 'division', 'team'],
  position: ['役職', '肩書', '肩書き', 'position', 'title', 'jobtitle', 'job title'],
  email: ['メール', 'メールアドレス', 'e-mail', 'email', 'mail', 'メアド'],
  phone: ['電話', '電話番号', 'tel', 'phone', 'telephone', '固定電話'],
  mobile: ['携帯', '携帯電話', 'mobile', 'cell', 'cellphone', '携帯番号'],
  website: ['webサイト', 'ウェブサイト', 'website', 'url', 'ホームページ', 'hp', 'site'],
  address: ['住所', '所在地', 'address', 'location'],
  tags: ['タグ', 'tags', 'tag', 'ラベル', 'label', 'labels'],
  memo: ['メモ', '備考', 'memo', 'note', 'notes', 'メモ欄', 'コメント'],
  favorite: ['お気に入り', 'favorite', 'fav', '★'],
  metAt: ['名刺交換日', '交換日', '取得日', 'metat', 'met at', 'metdate', 'received'],
}

function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）()【】\[\]:：]/g, '')
    .toLowerCase()
}

function buildMapping(headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {}
  const normalized = headers.map(normalizeHeader)

  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<
    [keyof ParsedRow, string[]]
  >) {
    for (const alias of aliases) {
      const target = normalizeHeader(alias)
      const idx = normalized.findIndex((h) => h === target)
      if (idx !== -1 && mapping[field] === undefined) {
        mapping[field] = idx
        break
      }
    }
  }

  // 完全一致で見つからない場合は部分一致で救済（例:「会社名（正式）」）
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<
    [keyof ParsedRow, string[]]
  >) {
    if (mapping[field] !== undefined) continue
    for (const alias of aliases) {
      const target = normalizeHeader(alias)
      if (target.length < 2) continue
      const idx = normalized.findIndex((h) => h.includes(target))
      if (idx !== -1) {
        mapping[field] = idx
        break
      }
    }
  }

  return mapping
}

function cleanDate(value: string): string {
  const v = value.trim()
  if (!v) return ''
  // 2026/4/12, 2026-04-12, 2026.4.12, 2026年4月12日
  const m = v.match(/(\d{4})\s*[\/\-\.年]\s*(\d{1,2})\s*[\/\-\.月]\s*(\d{1,2})/)
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  }
  const iso = v.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  return ''
}

/**
 * CSV テキストを名刺行に変換する。
 * 1行目をヘッダとして扱い、氏名が空の行はスキップする。
 */
export function csvToCards(text: string): ParseResult {
  const rows = parseCsv(text)
  if (rows.length === 0) {
    return { rows: [], headers: [], mapping: {}, skipped: [] }
  }

  const headers = rows[0].map((h) => h.trim())
  const mapping = buildMapping(headers)
  const mappingNames = Object.fromEntries(
    Object.entries(mapping).map(([field, idx]) => [field, headers[idx] ?? ''])
  )

  const out: ParsedRow[] = []
  const skipped: Array<{ line: number; reason: string }> = []

  // 「氏名」列が全く見つからない場合は、ヘッダ無しCSVとみなして先頭行もデータ扱いにする
  const hasHeader = mapping.name !== undefined
  const dataRows = hasHeader ? rows.slice(1) : rows
  const get = (row: string[], field: keyof ParsedRow): string => {
    const idx = mapping[field]
    if (idx === undefined) return ''
    return (row[idx] ?? '').trim()
  }

  dataRows.forEach((row, i) => {
    const line = hasHeader ? i + 2 : i + 1
    const name = get(row, 'name')
    if (!name) {
      if (row.some((c) => c.trim())) skipped.push({ line, reason: '氏名が空のためスキップ' })
      return
    }

    const rawTags = get(row, 'tags')
    const tags = Array.from(
      new Set(
        rawTags
          .split(/[,、;；|/]/)
          .map((t) => t.trim().replace(/^#/, '').replace(/[,#]/g, ''))
          .filter((t) => t.length > 0 && t.length <= 24)
      )
    ).slice(0, 12)

    const favRaw = get(row, 'favorite').toLowerCase()
    const favorite = ['1', 'true', 'yes', 'y', '○', 'o', '★', 'on'].includes(favRaw)

    out.push({
      name: name.slice(0, 120),
      nameKana: get(row, 'nameKana').slice(0, 120),
      company: get(row, 'company').slice(0, 160),
      department: get(row, 'department').slice(0, 160),
      position: get(row, 'position').slice(0, 160),
      email: get(row, 'email').slice(0, 200),
      phone: get(row, 'phone').slice(0, 60),
      mobile: get(row, 'mobile').slice(0, 60),
      website: (() => {
        let w = get(row, 'website').slice(0, 300)
        if (w && !/^https?:\/\//i.test(w)) w = `https://${w}`
        return w
      })(),
      address: get(row, 'address').slice(0, 300),
      tags,
      memo: get(row, 'memo').slice(0, 2000),
      favorite,
      metAt: cleanDate(get(row, 'metAt')),
    })
  })

  return { rows: out, headers, mapping: mappingNames, skipped }
}

/** CSV 出力用のエスケープ */
export function csvCell(value: unknown): string {
  const str = String(value ?? '')
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

/** 重複判定用のキー（氏名 + 会社名を正規化） */
export function duplicateKey(name: string, company: string): string {
  const norm = (v: string) =>
    v
      .replace(/[\s\u3000]/g, '')
      .replace(/株式会社|有限会社|合同会社|\(株\)|（株）/g, '')
      .toLowerCase()
  return `${norm(name)}::${norm(company)}`
}
