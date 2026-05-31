import { existsSync, writeFileSync } from 'node:fs'

import { acquireDaemonLock } from '../../src/daemon-lock'

const [lockPath, socketPath, barrierPath, pidText, releaseModeText] = process.argv.slice(2)

if (!lockPath || !socketPath || !barrierPath || !pidText) {
  throw new Error('usage: daemon-lock-racer <lockPath> <socketPath> <barrierPath> <pid> [release|keep|settle]')
}

writeFileSync(`${barrierPath}.${pidText}.ready`, 'ready')

while (!existsSync(barrierPath)) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

let compromised = false
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
  logError: () => {
    compromised = true
  },
})

if (result.acquired) {
  if (releaseModeText === 'settle') {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    if (compromised) {
      console.log(JSON.stringify({ acquired: false, reason: 'held' }))
      process.exit(0)
    }
  }
  console.log(JSON.stringify({ acquired: true }))
  if (releaseModeText === 'keep' || releaseModeText === 'settle') {
    setInterval(() => {}, 60_000)
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  await result.handle.release()
} else {
  console.log(JSON.stringify(result))
}
