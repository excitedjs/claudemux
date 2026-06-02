function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringProp(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  return typeof value === 'string' ? value : null
}

function textFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    if (!isPlainObject(item)) continue
    const type = item['type']
    if (type !== 'input_text' && type !== 'output_text' && type !== 'text') continue
    const text = stringProp(item, 'text')
    if (text !== null) parts.push(text)
  }
  return parts.length === 0 ? null : parts.join(' ')
}

function firstNonEmptyLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trimStart() ?? ''
}

function isAgentsInstructionsPrompt(text: string): boolean {
  // Codex writes the bootstrap AGENTS instructions as the only synthetic
  // user message before the first real prompt in current rollout history.
  return firstNonEmptyLine(text).startsWith('# AGENTS.md instructions for ')
}

function codexUserPromptFromEntry(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null
  const payload = entry['payload']
  if (!isPlainObject(payload)) return null

  if (payload['type'] === 'user_message' || payload['type'] === 'userMessage') {
    return stringProp(payload, 'message') ?? stringProp(payload, 'text')
  }
  if (entry['type'] === 'response_item' && payload['type'] === 'message' && payload['role'] === 'user') {
    return textFromContent(payload['content'])
  }
  return null
}

export function codexHistoryPromptFromEntry(entry: unknown): string | null {
  const prompt = codexUserPromptFromEntry(entry)
  if (prompt === null || isAgentsInstructionsPrompt(prompt)) return null
  return prompt
}
