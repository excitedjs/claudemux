import { existsSync, writeFileSync } from 'node:fs'

import { startDaemon } from '../../src/daemon'
import type { FeishuTransport } from '../../src/feishu'

const [lockPath, socketPath, barrierPath, pidText, accessFile, queueFile] = process.argv.slice(2)

if (!lockPath || !socketPath || !barrierPath || !pidText || !accessFile || !queueFile) {
  throw new Error(
    'usage: daemon-start-racer <lockPath> <socketPath> <barrierPath> <pid> <accessFile> <queueFile>',
  )
}

writeFileSync(`${barrierPath}.${pidText}.ready`, 'ready')

while (!existsSync(barrierPath)) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

const transport: FeishuTransport = {
  appId: 'cli_test',
  botOpenId: undefined,
  start: async () => {},
  sendText: async () => ({ messageIds: [] }),
  addReaction: async () => '',
  removeReaction: async () => {},
  editText: async () => {},
  fetchDocComment: async () => null,
  fetchDocMeta: async () => null,
  close: async () => {},
}

const result = await startDaemon({
  lockPath,
  socketPath,
  daemonVersion: 'test',
  generation: 1,
  self: {
    pid: Number(pidText),
    startedAt: Date.now(),
    socketPath,
    daemonVersion: 'test',
  },
  staleMs: 10_000,
  transport,
  accessFile,
  queueFile,
  logError: () => {},
})

if (result.started) {
  console.log(JSON.stringify({ started: true }))
  setInterval(() => {}, 60_000)
} else {
  console.log(JSON.stringify(result))
}
