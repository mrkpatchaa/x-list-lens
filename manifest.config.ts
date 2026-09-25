// manifest.config.ts
import { defineManifest } from '@crxjs/vite-plugin'
import packageJson from './package.json' with { type: 'json' }

export default defineManifest({
    manifest_version: 3,
    name: 'ListLens for X',
    version: packageJson.version,
    description: 'Instantly see who is in your lists on X/Twitter.',
    minimum_chrome_version: '111',
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
        default_icon: {
            '16': 'listlens-16.png',
            '32': 'listlens-32.png',
        },
    },
    icons: {
        '16': 'listlens-16.png',
        '32': 'listlens-32.png',
        '48': 'listlens-48.png',
        '128': 'listlens.png',
    },
})
