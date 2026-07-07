// Tipos globais de bindings do Cloudflare disponíveis no contexto Hono

export type Role = 'admin' | 'coord_geral' | 'coord_nucleo' | 'articulador'

export interface JwtPayload {
  sub: number // user id
  nome: string
  email: string
  roles: Array<{ role: Role; escopo_id: number | null }>
  exp: number
}

export type Bindings = {
  DB: D1Database
  R2: R2Bucket
  JWT_SECRET: string
}

export type Variables = {
  user: JwtPayload
}

export type AppEnv = {
  Bindings: Bindings
  Variables: Variables
}
