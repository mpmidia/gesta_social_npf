import type { MiddlewareHandler } from 'hono'
import { errorResponse } from '../utils/response'
import type { AppEnv, Role } from '../types/bindings'

/**
 * Verifica se o usuário autenticado possui ao menos um dos papéis exigidos,
 * independente de escopo. Use para ações globais (ex.: apenas admin).
 */
export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user')
    const hasRole = user.roles?.some((r) => roles.includes(r.role))
    if (!hasRole) {
      return errorResponse(c, 403, `Acesso negado. Necessário um dos papéis: ${roles.join(', ')}.`)
    }
    await next()
  }
}

/**
 * Verifica acesso a um Núcleo específico:
 * - admin e coord_geral têm acesso irrestrito a qualquer núcleo
 * - articulador tem acesso de LEITURA a qualquer núcleo (institucional/comunicação, sem financeiro)
 * - coord_nucleo só acessa se possuir user_roles.escopo_id === nucleoId
 * O nucleoId é lido do param de rota informado (default 'nucleoId').
 */
export function requireNucleoAccess(paramName = 'nucleoId'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user')
    const nucleoId = Number(c.req.param(paramName))

    const isGlobal = user.roles?.some((r) => r.role === 'admin' || r.role === 'coord_geral')
    const isArticulador = user.roles?.some((r) => r.role === 'articulador')
    if (isGlobal || isArticulador) {
      await next()
      return
    }

    const hasScopedAccess = user.roles?.some(
      (r) => r.role === 'coord_nucleo' && r.escopo_id === nucleoId
    )
    if (!hasScopedAccess) {
      return errorResponse(c, 403, 'Você não tem acesso a este núcleo.')
    }
    await next()
  }
}

/** Helper não-middleware: retorna a lista de nucleo_id que o usuário coord_nucleo pode ver. */
export function getScopedNucleoIds(user: AppEnv['Variables']['user']): number[] {
  return user.roles
    .filter((r) => r.role === 'coord_nucleo' && r.escopo_id !== null)
    .map((r) => r.escopo_id as number)
}

export function isGlobalUser(user: AppEnv['Variables']['user']): boolean {
  return user.roles.some((r) => r.role === 'admin' || r.role === 'coord_geral')
}

export function isAdmin(user: AppEnv['Variables']['user']): boolean {
  return user.roles.some((r) => r.role === 'admin')
}

export function isArticulador(user: AppEnv['Variables']['user']): boolean {
  return user.roles.some((r) => r.role === 'articulador')
}

export function isFinanceiro(user: AppEnv['Variables']['user']): boolean {
  return user.roles.some((r) => r.role === 'financeiro')
}

/**
 * Acesso de LEITURA institucional (Núcleos/Projetos): admin, coord_geral, articulador
 * e financeiro enxergam tudo. coord_nucleo enxerga apenas os núcleos/projetos do seu escopo.
 * Usado para listagens onde o Articulador precisa visualizar núcleos/projetos
 * (para organizar campanhas/comunicação) e o Financeiro precisa ver todos os núcleos/
 * projetos para gerir repasses de qualquer núcleo, mas nenhum dos dois tem CRUD sobre eles.
 */
export function hasBroadReadAccess(user: AppEnv['Variables']['user']): boolean {
  return isGlobalUser(user) || isArticulador(user) || isFinanceiro(user)
}

/**
 * Visão 360° do Financeiro: SOMENTE admin e o papel dedicado "financeiro" enxergam
 * e operam todos os saldos/lançamentos/comprovantes de todos os níveis (Geral/Núcleo/
 * Projeto), independente de escopo.
 *
 * IMPORTANTE: Coordenador Geral NÃO tem nenhum acesso ao módulo financeiro (regra de
 * negócio explícita) — por isso esta função usa isAdmin() em vez de isGlobalUser()
 * (que incluiria coord_geral). O papel "financeiro" é o único, além do admin, que
 * recebe e processa solicitações de repasse/pagamento dos núcleos.
 */
export function hasFinanceiroFullAccess(user: AppEnv['Variables']['user']): boolean {
  return isAdmin(user) || isFinanceiro(user)
}
