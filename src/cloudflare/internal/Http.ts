/**
 * JSON response and header helpers of the Cloudflare runtime.
 *
 * @module
 */

/** Returns an uncached JSON response. */
export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers)
  result.set('content-type', 'application/json')
  result.set('cache-control', 'no-store')
  return new Response(JSON.stringify(value), { status, headers: result })
}

/** Serializes `value` as JSON with every non-ASCII character escaped, as a header value requires. */
export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
