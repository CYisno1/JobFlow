import { defineConfig, type Plugin } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

// The chrome-extension:// scheme doesn't support CORS fetch, but Vite adds a
// crossorigin attribute to <script type="module">, which makes Chrome fetch the
// JS in CORS mode and fail with application/octet-stream.
// This plugin strips the attribute from the built HTML.
function removeCrossoriginPlugin(): Plugin {
  return {
    name: 'remove-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<script\s+type="module"\s+crossorigin(\s+src=)/g, '<script type="module"$1')
        .replace(/\s+crossorigin(\s+href=)/g, '$1')
    },
  }
}

export default defineConfig({
  plugins: [
    crx({ manifest }),
    removeCrossoriginPlugin(),
  ],
  build: {
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        sidebar: 'src/sidebar/index.html',
      },
    },
  },
})
