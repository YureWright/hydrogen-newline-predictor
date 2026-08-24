/**
 * 带自动重试的 fetch+json 工具。
 *
 * 背景：服务器在海外 Azure，国内访问跨国链路偶发瞬时抖动——大请求/响应（长路线预测、
 * 报告生成）偶尔被截断，前端表现为 "Failed to fetch" / "Unexpected end of JSON input"，
 * 手动刷新几次又能好。这里对可重试错误自动重试（指数退避），用户无感。
 */
export async function fetchJson<T = any>(
  url: string,
  options?: RequestInit,
  retries = 3,
  baseDelayMs = 900,
): Promise<T> {
  let lastErr: any
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, options)
      const text = await r.text()
      if (!r.ok) throw new Error('HTTP ' + r.status + (text ? ': ' + text.slice(0, 120) : ''))
      if (!text) throw new Error('Unexpected end of JSON input（空响应）')
      return JSON.parse(text) as T
    } catch (e: any) {
      lastErr = e
      const msg = String((e && e.message) || e)
      const retriable = /Failed to fetch|Unexpected end of JSON input|network|ECONN|socket hang up|AbortError|fetch failed/i.test(msg)
      if (attempt < retries && retriable) {
        await new Promise((res) => setTimeout(res, baseDelayMs * (attempt + 1)))
        continue
      }
      throw e
    }
  }
  throw lastErr
}
