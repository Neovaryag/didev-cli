// Approximate token counting without external dependencies
// ~4 chars per token for English/code text
export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function countMessagesTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, m) => sum + countTokens(m.content) + 4, 0);
}

export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 100) + '\n... [truncated]';
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
