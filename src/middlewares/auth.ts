import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { verifyToken, COOKIE_NAME } from '../utils/jwt'
import { errorResponse } from '../utils/response'
import type { AppEnv } from '../types/bindings'

/**
 * Middleware de autenticação: extrai o token do cookie (ou header Authorization),
 * valida a assinatura/expiração e injeta o payload do usuário no contexto.
 * Deve ser aplicado em todas as rotas privadas (/api/* exceto /api/public/*).
 */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cookieToken = getCookie(c, COOKIE_NAME)
  const headerToken = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')
  const token = cookieToken || headerToken

  if (!token) {
    return errorResponse(c, 401, 'Não autenticado. Faça login para continuar.')
  }

  try {
    const payload = await verifyToken(token, c.env.JWT_SECRET)
    c.set('user', payload)
    await next()
  } catch (err) {
    return errorResponse(c, 401, 'Sessão inválida ou expirada. Faça login novamente.')
  }
}
