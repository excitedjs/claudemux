import { existsSync } from 'node:fs'

import { acquireDaemonLock } from '../../src/daemon-lock'

const [lockPath, socketPath, barrierPath, pidText] = process.argv.slice(2)

if (!lockPath || !socketPath || !barrierPath || !pidText) {
  throw new Error('usage: daemon-lock-racer <lockPath> <socketPath> <barrierPath> <pid>')
}

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
  await new Promise((resolve) => setTimeout(resolve, 200))
  await result.handle.release()
} else {
  console.log(JSON.stringify(result))
}
