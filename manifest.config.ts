// manifest.config.ts
import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
    manifest_version: 3,
    name: 'ListLens for X',
    version: '1.0.0',
    description: 'Instantly see who is in your lists on X/Twitter.',
    permissions: ['storage', 'cookies'],
    host_permissions: ['*://*.twitter.com/*', '*://*.x.com/*'],
    background: {
        service_worker: 'src/background.ts',
        type: 'module',
    },
    content_scripts: [
        {
            matches: ['*://*.twitter.com/*', '*://*.x.com/*'],
            js: ['src/content.ts'],
            run_at: 'document_idle',
        },
        {
            matches: ['*://*.twitter.com/*', '*://*.x.com/*'],
            js: ['src/intercept.ts'],
            run_at: 'document_start',
            world: 'MAIN',
        }
    ],
    action: {
        default_popup: 'index.html',
    },
})
