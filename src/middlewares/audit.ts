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
  // X-Forwarded-For pode trazer a cadeia inteira de proxies ("cliente, proxy1, proxy2");
  // fica só o primeiro e corta em 64 (tamanho de audit_log.ip) para o INSERT nunca falhar.
  const xff = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
  const ip = (c.req.header('CF-Connecting-IP') || xff || 'unknown').slice(0, 64)
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
