export type ProxyRole = 'dispatcher' | 'session'

export function proxyRole(env: Record<string, string | undefined> = process.env): ProxyRole {
  return env.FEISHU_CHANNEL_PROXY_ROLE === 'dispatcher' ||
    env.FEISHU_CHANNEL_DISPATCHER === '1'
    ? 'dispatcher'
    : 'session'
}
