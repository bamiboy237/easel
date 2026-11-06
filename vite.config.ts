import { fileURLToPath } from 'url'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { zodLocalePlugin } from './scripts/vite-zod-locale-plugin.js'

// https://vitejs.dev/config/
export default defineConfig(() => {
	return {
		server: {
			// The local render service (render/server.ts), reached through the page's own origin.
			proxy: { '/render': `http://127.0.0.1:${process.env.EASEL_RENDER_PORT || 8790}` },
		},
		plugins: [
			zodLocalePlugin(fileURLToPath(new URL('./scripts/zod-locales-shim.js', import.meta.url))),
			cloudflare(),
			react(),
		],
	}
})
