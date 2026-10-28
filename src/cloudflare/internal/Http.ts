export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers)
  result.set('content-type', 'application/json')
  result.set('cache-control', 'no-store')
  return new Response(JSON.stringify(value), { status, headers: result })
}

export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
