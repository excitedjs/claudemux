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
import { BROKER_SUBCOMMAND, parseBrokerArgv } from './engines/claude/stream-json/launch'
import { brokerMain } from './engines/claude/stream-json/broker'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  // The detached Claude stream-json broker re-enters this same entrypoint under
  // the hidden `__claude-broker` subcommand (so it inherits the identical Node
  // runtime — type-stripped source or `dist/tm.mjs`). It is a long-lived loop,
  // not an atomic verb, so it never reaches `runCli`.
  if (argv[0] === BROKER_SUBCOMMAND) {
    const params = parseBrokerArgv(argv.slice(1))
    if ('error' in params) {
      process.stderr.write(`[broker] ${params.error}\n`)
      process.exitCode = 2
      return
    }
    process.exitCode = await brokerMain(params)
    return
  }

  const result = await runCli(argv, productionEnv())
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.code
}

main().catch((err) => {
  process.stderr.write(`[tm] ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
