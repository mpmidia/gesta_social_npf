import type { Context } from 'hono'
import type { AppEnv } from '../types/bindings'

interface AuditParams {
  userId: number | null
  acao: string
  entidade: string
  entidadeId?: number | null
  payload?: unknown
}

/**
 * Registra uma linha imutável no audit_log. Deve ser chamado explicitamente
 * ao final de toda operação de mutação relevante (financeiro, RBAC, núcleos, projetos).
 * A tabela audit_log não possui rotas de UPDATE/DELETE expostas — é append-only.
 */
export async function logAudit(c: Context<AppEnv>, params: AuditParams): Promise<void> {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
  await c.env.DB.prepare(
    `INSERT INTO audit_log (user_id, acao, entidade, entidade_id, payload_json, ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      params.userId,
      params.acao,
      params.entidade,
      params.entidadeId ?? null,
      params.payload ? JSON.stringify(params.payload) : null,
      ip
    )
    .run()
}
