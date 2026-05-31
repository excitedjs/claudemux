import { existsSync, writeFileSync } from 'node:fs'

import { acquireDaemonLock } from '../../src/daemon-lock'

const [lockPath, socketPath, barrierPath, pidText, holdMsText] = process.argv.slice(2)

if (!lockPath || !socketPath || !barrierPath || !pidText) {
  throw new Error('usage: daemon-lock-racer <lockPath> <socketPath> <barrierPath> <pid> [holdMs]')
}

writeFileSync(`${barrierPath}.${pidText}.ready`, 'ready')

while (!existsSync(barrierPath)) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

const result = await acquireDaemonLock({
  lockPath,
  self: {
    pid: Number(pidText),
    startedAt: Date.now(),
    socketPath,
    daemonVersion: 'test',
  },
  probe: async () => false,
  staleMs: 10_000,
})

if (result.acquired) {
  console.log(JSON.stringify({ acquired: true }))
  await new Promise((resolve) => setTimeout(resolve, Number(holdMsText ?? 3_000)))
  await result.handle.release()
} else {
  console.log(JSON.stringify(result))
}
