import { sign, verify } from 'hono/jwt'
import type { JwtPayload } from '../types/bindings'

const TOKEN_TTL_SECONDS = 60 * 60 * 12 // 12 horas

export async function createToken(payload: Omit<JwtPayload, 'exp'>, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  return sign({ ...payload, exp }, secret)
}

export async function verifyToken(token: string, secret: string): Promise<JwtPayload> {
  const decoded = await verify(token, secret, 'HS256')
  return decoded as unknown as JwtPayload
}

export const COOKIE_NAME = 'nfp_session'
