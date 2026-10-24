export interface CardRow {
  id: number
  name: string
  name_kana: string
  company: string
  department: string
  position: string
  email: string
  phone: string
  mobile: string
  website: string
  address: string
  tags: string
  memo: string
  favorite: number
  met_at: string
  created_at: string
  updated_at: string
}

export interface Card {
  id: number
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
  createdAt: string
  updatedAt: string
}

/**
 * D1 の exec() は SQL を行単位で分割実行するため、複数行の DDL は使えない。
 * 文ごとに分割し、batch() で順番に実行する。
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_kana TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  memo TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  met_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  'CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name)',
  'CREATE INDEX IF NOT EXISTS idx_cards_company ON cards(company)',
  'CREATE INDEX IF NOT EXISTS idx_cards_favorite ON cards(favorite)',
  'CREATE INDEX IF NOT EXISTS idx_cards_updated ON cards(updated_at)',
]

export function toCard(row: CardRow): Card {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(row.tags || '[]')
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    tags = []
  }
  return {
    id: row.id,
    name: row.name,
    nameKana: row.name_kana,
    company: row.company,
    department: row.department,
    position: row.position,
    email: row.email,
    phone: row.phone,
    mobile: row.mobile,
    website: row.website,
    address: row.address,
    tags,
    memo: row.memo,
    favorite: row.favorite === 1,
    metAt: row.met_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

type Sample = {
  name: string
  kana: string
  company: string
  dept: string
  position: string
  email: string
  phone: string
  mobile: string
  website: string
  address: string
  tags: string[]
  memo: string
  favorite?: boolean
  metAt: string
}

const SAMPLES: Sample[] = [
  {
    name: '鈴木 一郎', kana: 'すずき いちろう', company: '株式会社ライトスピード',
    dept: '営業本部', position: '執行役員 本部長', email: 'ichiro.suzuki@lightspeed.co.jp',
    phone: '03-6455-1200', mobile: '090-1234-5678', website: 'https://lightspeed.co.jp',
    address: '東京都渋谷区道玄坂1-2-3 渋谷ビル 8F', tags: ['営業', '決裁者', 'SaaS'],
    memo: '2026年4月の展示会で名刺交換。新規プロジェクトの意思決定者。返信が早い。',
    favorite: true, metAt: '2026-04-12',
  },
  {
    name: '田中 美咲', kana: 'たなか みさき', company: 'ネクストデザイン株式会社',
    dept: 'ブランドデザイン部', position: 'シニアデザイナー', email: 'misaki.tanaka@nextdesign.jp',
    phone: '03-5321-8890', mobile: '', website: 'https://nextdesign.jp',
    address: '東京都港区南青山3-5-7 南青山オフィス 4F', tags: ['デザイン', 'クリエイティブ'],
    memo: 'ロゴ制作の相談候補。ポートフォリオの完成度が高い。', metAt: '2026-05-08',
  },
  {
    name: '佐藤 健太', kana: 'さとう けんた', company: '富士テックソリューションズ株式会社',
    dept: 'システム開発部', position: 'マネージャー', email: 'kenta.sato@fujitech-sol.co.jp',
    phone: '044-233-7700', mobile: '080-9988-7766', website: '',
    address: '神奈川県川崎市中原区上小田中4-1-1', tags: ['エンジニア', 'パートナー'],
    memo: 'API連携の技術検証を担当。Slackでのやり取りがスムーズ。', metAt: '2026-03-21',
  },
  {
    name: '高橋 由紀', kana: 'たかはし ゆき', company: '株式会社グリーンフィールド',
    dept: '人事部', position: '採用チームリーダー', email: 'yuki.takahashi@greenfield.jp',
    phone: '06-6123-4455', mobile: '', website: 'https://greenfield.jp',
    address: '大阪府大阪市北区梅田2-4-9 ブリーゼタワー 12F', tags: ['人事', '採用'],
    memo: '中途採用のカジュアル面談を打診中。', metAt: '2026-06-02',
  },
  {
    name: '伊藤 大輔', kana: 'いとう だいすけ', company: 'ソラリス商事株式会社',
    dept: '海外事業部', position: '課長', email: 'daisuke.ito@solaris-trading.com',
    phone: '03-3502-6600', mobile: '070-1122-3344', website: 'https://solaris-trading.com',
    address: '東京都中央区日本橋2-7-1 東京日本橋タワー 18F', tags: ['海外', '商社', '決裁者'],
    memo: '東南アジア向けの代理店開拓を検討中。英語対応可。', metAt: '2026-02-17',
  },
  {
    name: '渡辺 彩', kana: 'わたなべ あや', company: '株式会社アトリエ・ルミエール',
    dept: '広報・マーケティング', position: 'PRマネージャー', email: 'aya.watanabe@atelier-lumiere.co.jp',
    phone: '03-6804-2211', mobile: '', website: 'https://atelier-lumiere.co.jp',
    address: '東京都目黒区中目黒1-8-4', tags: ['マーケティング', '広報', 'SNS'],
    memo: 'プレスリリースの配信先。メディア露出の相談が可能。', metAt: '2026-07-04',
  },
  {
    name: '山本 拓海', kana: 'やまもと たくみ', company: 'クラウドワークス・イノベーション',
    dept: 'プロダクト部', position: 'プロダクトマネージャー', email: 'takumi.yamamoto@cwi.jp',
    phone: '03-4588-9012', mobile: '090-5566-7788', website: 'https://cwi.jp',
    address: '東京都千代田区丸の内1-6-5 丸の内北口ビル 9F', tags: ['プロダクト', 'SaaS', '決裁者'],
    memo: 'β版のフィードバックを実施。次回アップデートのヒアリング希望。',
    favorite: true, metAt: '2026-08-19',
  },
  {
    name: '中村 智子', kana: 'なかむら ともこ', company: '一般社団法人デジタル人材協会',
    dept: '事務局', position: '事務局長', email: 'tomoko.nakamura@dhr-assoc.or.jp',
    phone: '03-6206-3300', mobile: '', website: 'https://dhr-assoc.or.jp',
    address: '東京都港区新橋4-1-1 新虎通りビル 6F', tags: ['団体', 'セミナー'],
    memo: '社員向け研修プログラムの共同企画を検討。', metAt: '2026-01-23',
  },
  {
    name: '小林 亮', kana: 'こばやし りょう', company: '株式会社ミナト物流',
    dept: '営業第二部', position: '主任', email: 'ryo.kobayashi@minato-log.co.jp',
    phone: '045-212-5566', mobile: '', website: '',
    address: '神奈川県横浜市西区みなとみらい3-6-1', tags: ['物流', '営業'],
    memo: '配送拠点のDX化に関心。現場ヒアリングの日程調整中。', metAt: '2026-05-30',
  },
  {
    name: '加藤 恵', kana: 'かとう めぐみ', company: '株式会社ブライトパス会計事務所',
    dept: '税務コンサルティング', position: '公認会計士', email: 'megumi.kato@brightpath-ac.jp',
    phone: '03-3548-7788', mobile: '080-2211-4433', website: 'https://brightpath-ac.jp',
    address: '東京都中央区銀座6-10-1 GINZA SIX 11F', tags: ['士業', '財務'],
    memo: '決算期前の相談先として継続接点を持ちたい。', metAt: '2026-06-25',
  },
  {
    name: '吉田 隼人', kana: 'よしだ はやと', company: '株式会社スカイライン・モビリティ',
    dept: '事業開発部', position: '事業開発マネージャー', email: 'hayato.yoshida@skylinemobility.jp',
    phone: '03-6773-1100', mobile: '', website: 'https://skylinemobility.jp',
    address: '東京都港区虎ノ門4-3-13 ヒルズビル 20F', tags: ['モビリティ', '事業開発', '決裁者'],
    memo: 'MaaS領域の協業可能性を協議。次回は役員同席予定。',
    favorite: true, metAt: '2026-09-05',
  },
  {
    name: '松本 千尋', kana: 'まつもと ちひろ', company: '株式会社ハーバーラボ',
    dept: 'カスタマーサクセス', position: 'リーダー', email: 'chihiro.matsumoto@harborlab.io',
    phone: '03-4455-2233', mobile: '', website: 'https://harborlab.io',
    address: '東京都品川区大崎2-1-1 ThinkPark Tower 17F', tags: ['CS', 'SaaS'],
    memo: 'オンボーディング事例のヒアリングが可能。', metAt: '2026-08-02',
  },
]

/**
 * 初回起動時にテーブルを作成し、空ならサンプルデータを投入する。
 * isolate 単位で一度だけ実行されるよう Promise をキャッシュする。
 */
let initPromise: Promise<void> | null = null

export function ensureDatabase(db: D1Database): Promise<void> {
  if (!initPromise) {
    initPromise = initDatabase(db).catch((err) => {
      initPromise = null // 失敗時は次回リトライできるようにする
      throw err
    })
  }
  return initPromise
}

async function initDatabase(db: D1Database): Promise<void> {
  await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)))
  const count = await db.prepare('SELECT COUNT(*) AS n FROM cards').first<{ n: number }>()
  if (!count || count.n > 0) return

  const statements = SAMPLES.map((s) =>
    db
      .prepare(
        `INSERT INTO cards (name, name_kana, company, department, position, email, phone, mobile, website, address, tags, memo, favorite, met_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        s.name,
        s.kana,
        s.company,
        s.dept,
        s.position,
        s.email,
        s.phone,
        s.mobile,
        s.website,
        s.address,
        JSON.stringify(s.tags),
        s.memo,
        s.favorite ? 1 : 0,
        s.metAt
      )
  )
  await db.batch(statements)
}
