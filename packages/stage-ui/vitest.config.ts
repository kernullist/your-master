import { join } from 'node:path'
import { cwd } from 'node:process'

import Vue from '@vitejs/plugin-vue'
import Info from 'unplugin-info/vite'

import { playwright } from '@vitest/browser-playwright'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  return {
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            include: ['src/**/*.test.ts'],
            exclude: ['src/**/*.browser.test.ts'],
            env: loadEnv(mode, join(cwd(), 'packages', 'stage-ui'), ''),
          },
        },
        {
          extends: true,
          plugins: [
            Vue(),
            // Provides the ~build/* virtual modules (git/time metadata) that
            // `composables/use-build-info.ts` imports; the apps register the
            // same plugin in their Vite configs, and without it any browser
            // test that touches the composables barrel fails to import.
            Info(),
          ],
          test: {
            name: 'browser',
            include: ['**/*.browser.{spec,test}.ts'],
            exclude: ['**/node_modules/**'],
            browser: {
              enabled: true,
              provider: playwright(),
              instances: [
                { browser: 'chromium' },
              ],
            },
          },
        },
      ],
    },
  }
})
