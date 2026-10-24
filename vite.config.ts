import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * 静的アセットの内容ハッシュをビルド時に埋め込み、URL に ?v= を付ける。
 * これがないと CSS/JS を修正してもブラウザキャッシュが使われ続け、
 * 「直したのに反映されない」状態になる。
 */
function assetVersion(paths: string[]): string {
  const h = createHash('sha1')
  for (const p of paths) {
    try {
      h.update(readFileSync(p))
    } catch {
      h.update('missing:' + p)
    }
  }
  return h.digest('hex').slice(0, 10)
}

const VERSION = assetVersion(['public/static/style.css', 'public/static/app.js'])

export default defineConfig({
  define: {
    __ASSET_VERSION__: JSON.stringify(VERSION),
  },
  plugins: [
    build(),
    devServer({
      adapter,
      entry: 'src/index.tsx',
    }),
  ],
})
