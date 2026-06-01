/**
 * The process entrypoint — `tm`'s `argv` → `runCli` → `process` streams + exit code.
 *
 * Kept separate from [`cli.ts`](./cli.ts) so the library (`runCli`,
 * `productionEnv`) imports cleanly into tests and harnesses without a side
 * effect at module-load time. The `bin/tm` launcher execs Node against this
 * file under `--experimental-transform-types`, so there is no build step
 * between source and runtime.
 */

import { productionEnv, runCli } from './cli'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const result = await runCli(argv, productionEnv())
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.code
}

main().catch((err) => {
  process.stderr.write(`[tm] ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
