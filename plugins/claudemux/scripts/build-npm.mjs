#!/usr/bin/env node
import { chmod, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(pluginRoot, 'dist')

await rm(distDir, { recursive: true, force: true })

await build({
  absWorkingDir: pluginRoot,
  entryPoints: [
    { in: 'src/main.ts', out: 'tm' },
    { in: 'src/engines/codex/ipc-bridge-process.ts', out: 'ipc-bridge-process' },
  ],
  outdir: distDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.7',
  entryNames: '[name]',
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __claudemuxCreateRequire } from 'node:module';",
      'const require = __claudemuxCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
})

await Promise.all([
  chmod(resolve(distDir, 'tm.mjs'), 0o755),
  chmod(resolve(distDir, 'ipc-bridge-process.mjs'), 0o755),
])
