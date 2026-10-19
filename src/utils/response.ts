import type { Context } from 'hono'

export function errorResponse(c: Context, status: 400 | 401 | 403 | 404 | 409 | 422 | 500, message: string) {
  return c.json({ ok: false, error: message }, status)
}

export function okResponse<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ ok: true, data }, status)
}

/**
 * Verifica se um valor obtido de FormData.get() é um arquivo (File), sem usar
 * `instanceof File` diretamente — os tipos do Cloudflare Workers tratam `File`
 * de forma que `instanceof` falha na checagem estrita do TypeScript em alguns
 * cenários de build. Em runtime, um valor de arquivo em multipart/form-data
 * sempre expõe `name`, `size` e `arrayBuffer()`.
 */
export function isFormDataFile(value: unknown): value is File {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as any).arrayBuffer === 'function' &&
    typeof (value as any).name === 'string' &&
    typeof (value as any).size === 'number'
  )
}
