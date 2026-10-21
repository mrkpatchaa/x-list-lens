import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import manifest from './manifest.config.ts'

export default defineConfig({
    plugins: [
        tailwindcss(),
        crx({ manifest })
    ],
    build: {
        rollupOptions: {
            // Not referenced by the manifest: the popup opens it in a tab.
            input: { export: 'export.html' },
        },
    },
})
