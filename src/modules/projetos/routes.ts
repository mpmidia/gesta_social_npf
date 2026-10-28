import { Hono } from 'hono'
import type { AppEnv } from '../../types/bindings'
import { errorResponse, okResponse, isFormDataFile } from '../../utils/response'
import { slugify, generateRandomKey } from '../../utils/crypto'
import { logAudit } from '../../middlewares/audit'
import { authMiddleware } from '../../middlewares/auth'
import { requireRole, isGlobalUser, hasBroadReadAccess, getScopedNucleoIds } from '../../middlewares/rbac'

const projetos = new Hono<AppEnv>()

projetos.use('*', authMiddleware)

// Acesso de LEITURA: admin, coord_geral, articulador (institucional) + coord_nucleo do escopo
async function userCanReadNucleo(user: any, nucleoId: number): Promise<boolean> {
  if (hasBroadReadAccess(user)) return true
  return getScopedNucleoIds(user).includes(nucleoId)
}

// Acesso de ESCRITA (criar/editar/gerir recursos): admin, coord_geral, coord_nucleo do escopo — NUNCA articulador
async function userCanManageNucleo(user: any, nucleoId: number): Promise<boolean> {
  if (isGlobalUser(user)) return true
  return getScopedNucleoIds(user).includes(nucleoId)
}

// ===== LISTAR PROJETOS (respeitando escopo) =====
// admin, coord_geral e articulador enxergam todos os projetos (leitura institucional).
projetos.get('/', async (c) => {
  const user = c.get('user')
  const nucleoIdFilter = c.req.query('nucleo_id')

  if (hasBroadReadAccess(user)) {
    const query = nucleoIdFilter
      ? c.env.DB.prepare('SELECT * FROM projetos WHERE nucleo_id = ? ORDER BY created_at DESC').bind(Number(nucleoIdFilter))
      : c.env.DB.prepare('SELECT * FROM projetos ORDER BY created_at DESC')
    const { results } = await query.all()
    return okResponse(c, results)
  }

  const scopedIds = getScopedNucleoIds(user)
  if (scopedIds.length === 0) return okResponse(c, [])

  const placeholders = scopedIds.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM projetos WHERE nucleo_id IN (${placeholders}) ORDER BY created_at DESC`
  )
    .bind(...scopedIds)
    .all()
  return okResponse(c, results)
})

// ===== CRIAR PROJETO (admin, coord_geral, coord_nucleo do respectivo núcleo) =====
projetos.post('/', requireRole('admin', 'coord_geral', 'coord_nucleo'), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ nucleo_id?: number; nome?: string; descricao?: string }>().catch(() => ({} as any))
  const { nucleo_id, nome, descricao } = body

  if (!nucleo_id || !nome) {
    return errorResponse(c, 422, 'Informe nucleo_id e nome do projeto.')
  }

  const hasAccess = await userCanManageNucleo(actor, nucleo_id)
  if (!hasAccess) {
    return errorResponse(c, 403, 'Você não tem acesso a este núcleo.')
  }

  const nucleo = await c.env.DB.prepare('SELECT id FROM nucleos WHERE id = ?').bind(nucleo_id).first()
  if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')

  let slug = slugify(nome)
  const existingSlug = await c.env.DB.prepare('SELECT id FROM projetos WHERE slug_publico = ?').bind(slug).first()
  if (existingSlug) {
    slug = `${slug}-${generateRandomKey().slice(0, 6)}`
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO projetos (nucleo_id, nome, descricao, slug_publico, criado_por) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(nucleo_id, nome, descricao ?? null, slug, actor.sub)
    .run()

  const projetoId = result.meta.last_row_id as number

  await logAudit(c, {
    userId: actor.sub,
    acao: 'projeto.criar',
    entidade: 'projetos',
    entidadeId: projetoId,
    payload: { nucleo_id, nome, slug }
  })

  return okResponse(c, { id: projetoId, nucleo_id, nome, descricao, slug_publico: slug }, 201)
})

// ===== DETALHE DO PROJETO =====
projetos.get('/:projetoId', async (c) => {
  const actor = c.get('user')
  const projetoId = Number(c.req.param('projetoId'))

  const projeto = await c.env.DB.prepare('SELECT * FROM projetos WHERE id = ?').bind(projetoId).first<any>()
  if (!projeto) return errorResponse(c, 404, 'Projeto não encontrado.')

  const hasAccess = await userCanReadNucleo(actor, projeto.nucleo_id)
  if (!hasAccess) return errorResponse(c, 403, 'Você não tem acesso a este projeto.')

  const { results: galeria } = await c.env.DB.prepare(
    'SELECT * FROM projeto_galeria WHERE projeto_id = ? ORDER BY ordem ASC'
  )
    .bind(projetoId)
    .all()

  return okResponse(c, { ...projeto, galeria })
})

// ===== ATUALIZAR PROJETO =====
projetos.put('/:projetoId', requireRole('admin', 'coord_geral', 'coord_nucleo'), async (c) => {
  const actor = c.get('user')
  const projetoId = Number(c.req.param('projetoId'))
  const body = await c.req.json<{ nome?: string; descricao?: string; ativo?: boolean }>().catch(() => ({} as any))

  const projeto = await c.env.DB.prepare('SELECT * FROM projetos WHERE id = ?').bind(projetoId).first<any>()
  if (!projeto) return errorResponse(c, 404, 'Projeto não encontrado.')

  const hasAccess = await userCanManageNucleo(actor, projeto.nucleo_id)
  if (!hasAccess) return errorResponse(c, 403, 'Você não tem acesso a este projeto.')

  await c.env.DB.prepare(
    'UPDATE projetos SET nome = COALESCE(?, nome), descricao = COALESCE(?, descricao), ativo = COALESCE(?, ativo) WHERE id = ?'
  )
    .bind(body.nome ?? null, body.descricao ?? null, body.ativo === undefined ? null : (body.ativo ? 1 : 0), projetoId)
    .run()

  await logAudit(c, { userId: actor.sub, acao: 'projeto.atualizar', entidade: 'projetos', entidadeId: projetoId, payload: body })

  return okResponse(c, { message: 'Projeto atualizado.' })
})

// ===== UPLOAD DE IMAGEM PARA GALERIA (multipart/form-data) =====
projetos.post('/:projetoId/galeria', requireRole('admin', 'coord_geral', 'coord_nucleo'), async (c) => {
  const actor = c.get('user')
  const projetoId = Number(c.req.param('projetoId'))

  const projeto = await c.env.DB.prepare('SELECT * FROM projetos WHERE id = ?').bind(projetoId).first<any>()
  if (!projeto) return errorResponse(c, 404, 'Projeto não encontrado.')

  const hasAccess = await userCanManageNucleo(actor, projeto.nucleo_id)
  if (!hasAccess) return errorResponse(c, 403, 'Você não tem acesso a este projeto.')

  const formData = await c.req.formData().catch(() => null)
  const file = formData?.get('imagem')
  const legenda = formData?.get('legenda')?.toString() ?? null

  if (!file || !isFormDataFile(file)) {
    return errorResponse(c, 422, 'Envie um arquivo no campo "imagem".')
  }

  const key = `projetos/${projetoId}/galeria/${generateRandomKey()}-${file.name}`
  await c.env.R2.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type }
  })

  const result = await c.env.DB.prepare(
    'INSERT INTO projeto_galeria (projeto_id, r2_key, legenda) VALUES (?, ?, ?)'
  )
    .bind(projetoId, key, legenda)
    .run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'projeto.galeria.upload',
    entidade: 'projeto_galeria',
    entidadeId: result.meta.last_row_id as number,
    payload: { r2_key: key }
  })

  return okResponse(c, { id: result.meta.last_row_id, r2_key: key, legenda }, 201)
})

// ===== ARQUIVAR OU EXCLUIR PROJETO =====
//
// Mesma regra dos núcleos: um projeto que já teve movimentação financeira
// (repasses recebidos, saídas/pagamentos com comprovantes) precisa ter o
// saldo ZERADO antes de poder ser arquivado — nunca excluído fisicamente,
// para preservar o histórico/comprovantes. Um projeto SEM nenhum lançamento
// financeiro pode ser excluído de verdade.
projetos.delete('/:projetoId', requireRole('admin', 'coord_geral', 'coord_nucleo'), async (c) => {
  const actor = c.get('user')
  const projetoId = Number(c.req.param('projetoId'))

  const projeto = await c.env.DB.prepare('SELECT * FROM projetos WHERE id = ?').bind(projetoId).first<any>()
  if (!projeto) return errorResponse(c, 404, 'Projeto não encontrado.')
  if (projeto.arquivado_em) return errorResponse(c, 409, 'Este projeto já está arquivado.')

  const hasAccess = await userCanManageNucleo(actor, projeto.nucleo_id)
  if (!hasAccess) return errorResponse(c, 403, 'Você não tem acesso a este projeto.')

  const saldoRow = await c.env.DB.prepare('SELECT saldo FROM saldo_projeto WHERE projeto_id = ?')
    .bind(projetoId)
    .first<{ saldo: number }>()
  const saldoAtual = saldoRow?.saldo ?? 0

  const possuiHistoricoFinanceiro = await c.env.DB.prepare(
    'SELECT 1 FROM financeiro_lancamentos WHERE projeto_id = ? LIMIT 1'
  )
    .bind(projetoId)
    .first()

  if (possuiHistoricoFinanceiro) {
    if (saldoAtual !== 0) {
      return errorResponse(
        c,
        422,
        `Este projeto possui saldo de R$ ${saldoAtual.toFixed(2)}. Zere o saldo antes de arquivar. Projetos com histórico financeiro/comprovantes não podem ser excluídos, apenas arquivados.`
      )
    }

    await c.env.DB.prepare(
      'UPDATE projetos SET ativo = 0, arquivado_em = CURRENT_TIMESTAMP, arquivado_por = ? WHERE id = ?'
    )
      .bind(actor.sub, projetoId)
      .run()

    await logAudit(c, {
      userId: actor.sub,
      acao: 'projeto.arquivar',
      entidade: 'projetos',
      entidadeId: projetoId,
      payload: { motivo: 'possui_historico_financeiro' }
    })

    return okResponse(c, {
      message: `Projeto "${projeto.nome}" arquivado. Como possui histórico financeiro, o registro foi mantido de forma inativa para preservar a rastreabilidade.`,
      arquivado: true
    })
  }

  // Colaboradores cadastrados (formulário público) ficam vinculados ao projeto —
  // são dados de pessoas reais, então a exclusão é bloqueada enquanto existirem.
  const possuiColaboradores = await c.env.DB.prepare('SELECT 1 FROM colaboradores WHERE projeto_id = ? LIMIT 1')
    .bind(projetoId)
    .first()
  if (possuiColaboradores) {
    return errorResponse(c, 422, 'Este projeto possui colaboradores cadastrados. Remova-os (ou vincule a outro projeto) antes de excluir.')
  }

  // Sem histórico financeiro: exclusão física (remove galeria e destaques públicos
  // vinculados antes, se houver — mesma causa do erro 500 por FK já corrigida em núcleos).
  await c.env.DB.prepare('DELETE FROM projeto_galeria WHERE projeto_id = ?').bind(projetoId).run()
  await c.env.DB.prepare('DELETE FROM destaques_publicos WHERE projeto_id = ?').bind(projetoId).run()
  await c.env.DB.prepare('DELETE FROM projetos WHERE id = ?').bind(projetoId).run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'projeto.excluir',
    entidade: 'projetos',
    entidadeId: projetoId,
    payload: { nome: projeto.nome }
  })

  return okResponse(c, { message: `Projeto "${projeto.nome}" excluído permanentemente.`, arquivado: false })
})

// ===== SERVIR IMAGEM DA GALERIA (autenticado) =====
projetos.get('/galeria/:imageId/arquivo', async (c) => {
  const imageId = Number(c.req.param('imageId'))
  const img = await c.env.DB.prepare('SELECT r2_key FROM projeto_galeria WHERE id = ?')
    .bind(imageId)
    .first<{ r2_key: string }>()

  if (!img) return errorResponse(c, 404, 'Imagem não encontrada.')

  const object = await c.env.R2.get(img.r2_key)
  if (!object) return errorResponse(c, 404, 'Arquivo não encontrado no armazenamento.')

  return new Response(object.body, {
    headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream' }
  })
})

export default projetos
