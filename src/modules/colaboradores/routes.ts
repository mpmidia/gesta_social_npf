import { Hono } from 'hono'
import type { AppEnv } from '../../types/bindings'
import type { AppDatabase } from '../../platform/db'
import { errorResponse, okResponse } from '../../utils/response'
import { logAudit } from '../../middlewares/audit'
import { authMiddleware } from '../../middlewares/auth'
import { requireRole, isGlobalUser, isArticulador, getScopedNucleoIds } from '../../middlewares/rbac'

const colaboradores = new Hono<AppEnv>()

function isValidCpf(cpf: string): boolean {
  const digits = cpf.replace(/\D/g, '')
  return digits.length === 11
}

// ===== ROTAS PRIVADAS (listar/validar) =====
colaboradores.use('/gestao/*', authMiddleware)

colaboradores.get('/gestao', requireRole('admin', 'coord_geral', 'coord_nucleo', 'articulador'), async (c) => {
  const user = c.get('user')
  const nucleoIdFilter = c.req.query('nucleo_id')
  const projetoIdFilter = c.req.query('projeto_id')

  let baseQuery = 'SELECT * FROM colaboradores WHERE 1=1'
  const binds: any[] = []

  // Admin, Coordenador Geral e Articulador enxergam os colaboradores de TODOS os
  // núcleos (o Articulador precisa de uma visão ampla para poder articular com
  // todos ou filtrar por núcleo — ver query param nucleo_id abaixo). Coordenador
  // de Núcleo só vê os colaboradores cadastrados no(s) seu(s) núcleo(s).
  if (!isGlobalUser(user) && !isArticulador(user)) {
    const scopedIds = getScopedNucleoIds(user)
    if (scopedIds.length === 0) return okResponse(c, [])
    baseQuery += ` AND nucleo_id IN (${scopedIds.map(() => '?').join(',')})`
    binds.push(...scopedIds)
  }

  if (nucleoIdFilter) {
    baseQuery += ' AND nucleo_id = ?'
    binds.push(Number(nucleoIdFilter))
  }
  if (projetoIdFilter) {
    baseQuery += ' AND projeto_id = ?'
    binds.push(Number(projetoIdFilter))
  }

  baseQuery += ' ORDER BY created_at DESC'

  const { results } = await c.env.DB.prepare(baseQuery).bind(...binds).all()
  return okResponse(c, results)
})

colaboradores.post('/gestao/:id/validar', requireRole('admin', 'coord_geral', 'coord_nucleo'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const colaborador = await c.env.DB.prepare('SELECT * FROM colaboradores WHERE id = ?').bind(id).first<any>()
  if (!colaborador) return errorResponse(c, 404, 'Colaborador não encontrado.')

  if (!isGlobalUser(actor)) {
    const scopedIds = getScopedNucleoIds(actor)
    if (!colaborador.nucleo_id || !scopedIds.includes(colaborador.nucleo_id)) {
      return errorResponse(c, 403, 'Você não tem acesso a este colaborador.')
    }
  }

  await c.env.DB.prepare(
    "UPDATE colaboradores SET validado_por = ?, validado_em = CURRENT_TIMESTAMP WHERE id = ?"
  )
    .bind(actor.sub, id)
    .run()

  await logAudit(c, { userId: actor.sub, acao: 'colaborador.validar', entidade: 'colaboradores', entidadeId: id })

  return okResponse(c, { message: 'Colaborador validado.' })
})

// ===== FORMULÁRIO PÚBLICO (sem login) =====
// Montado separadamente em /api/public/colaborador dentro de publico/routes.ts
export async function criarColaboradorPublico(
  db: AppDatabase,
  data: { nucleo_id?: number; projeto_id?: number; nome: string; cpf: string; whatsapp: string; status_portal_fazenda: string }
) {
  if (!isValidCpf(data.cpf)) {
    throw new Error('CPF inválido.')
  }
  if (!['pleno', 'nao_pleno'].includes(data.status_portal_fazenda)) {
    throw new Error('Status do portal da Fazenda inválido.')
  }
  if (!data.nucleo_id && !data.projeto_id) {
    throw new Error('É necessário vincular a um núcleo ou projeto.')
  }

  const result = await db
    .prepare(
      `INSERT INTO colaboradores (nucleo_id, projeto_id, nome, cpf, whatsapp, status_portal_fazenda)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      data.nucleo_id ?? null,
      data.projeto_id ?? null,
      data.nome,
      data.cpf.replace(/\D/g, ''),
      data.whatsapp,
      data.status_portal_fazenda
    )
    .run()

  return result.meta.last_row_id as number
}

export default colaboradores
