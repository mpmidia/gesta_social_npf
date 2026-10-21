// Tipos globais de "bindings" disponíveis no contexto Hono.
// Originalmente eram bindings nativos do Cloudflare Workers (D1Database,
// R2Bucket). Para rodar em Node.js (Hostinger), DB e R2 agora são os
// adaptadores definidos em src/platform/db.ts e src/platform/storage.ts,
// que implementam a mesma interface (prepare/bind/first/all/run/batch
// e put/get) — por isso as rotas não precisaram ser reescritas.

import type { AppDatabase } from '../platform/db'
import type { AppBucket } from '../platform/storage'

export type Role = 'admin' | 'coord_geral' | 'coord_nucleo' | 'articulador'

export interface JwtPayload {
  sub: number // user id
  nome: string
  email: string
  roles: Array<{ role: Role; escopo_id: number | null }>
  exp: number
}

export type Bindings = {
  DB: AppDatabase
  R2: AppBucket
  JWT_SECRET: string
}

export type Variables = {
  user: JwtPayload
}

export type AppEnv = {
  Bindings: Bindings
  Variables: Variables
}
