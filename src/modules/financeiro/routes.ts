import { Hono } from 'hono'
import type { AppEnv } from '../../types/bindings'
import { errorResponse, okResponse } from '../../utils/response'
import { generateRandomKey } from '../../utils/crypto'
import { logAudit } from '../../middlewares/audit'
import { authMiddleware } from '../../middlewares/auth'
import { requireRole, isGlobalUser, getScopedNucleoIds, isAdmin } from '../../middlewares/rbac'

const financeiro = new Hono<AppEnv>()

financeiro.use('*', authMiddleware)

async function userCanAccessNucleo(user: any, nucleoId: number): Promise<boolean> {
  if (isGlobalUser(user)) return true
  return getScopedNucleoIds(user).includes(nucleoId)
}

async function getNucleoIdFromProjeto(db: D1Database, projetoId: number): Promise<number | null> {
  const row = await db.prepare('SELECT nucleo_id FROM projetos WHERE id = ?').bind(projetoId).first<{ nucleo_id: number }>()
  return row?.nucleo_id ?? null
}

async function uploadComprovanteFile(
  r2: R2Bucket,
  lancamentoId: number,
  tipo: 'bancario' | 'fiscal',
  file: File
): Promise<string> {
  const key = `comprovantes/${lancamentoId}/${tipo}/${generateRandomKey()}-${file.name}`
  await r2.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } })
  return key
}

// ================= PAINEL GERAL =================

// Entrada de recurso NFP (admin, coord_geral) — lançamento direto, já executado
financeiro.post('/geral/entradas', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ valor?: number; finalidade?: string }>().catch(() => ({}))
  const { valor, finalidade } = body

  if (!valor || valor <= 0) return errorResponse(c, 422, 'Informe um valor positivo.')

  const result = await c.env.DB.prepare(
    `INSERT INTO financeiro_lancamentos (nivel, tipo, valor, status, finalidade, solicitado_por, executado_por, executado_em)
     VALUES ('geral', 'entrada_nfp', ?, 'executado', ?, ?, ?, CURRENT_TIMESTAMP)`
  )
    .bind(valor, finalidade ?? 'Repasse recebido do programa Nota Fiscal Paulista', actor.sub, actor.sub)
    .run()

  const id = result.meta.last_row_id as number

  await logAudit(c, { userId: actor.sub, acao: 'financeiro.entrada_nfp.lancar', entidade: 'financeiro_lancamentos', entidadeId: id, payload: { valor } })

  return okResponse(c, { id, valor, status: 'executado' }, 201)
})

financeiro.get('/geral/saldo', requireRole('admin', 'coord_geral'), async (c) => {
  const row = await c.env.DB.prepare('SELECT saldo FROM saldo_geral').first<{ saldo: number }>()
  return okResponse(c, { saldo: row?.saldo ?? 0 })
})

financeiro.get('/geral/lancamentos', requireRole('admin', 'coord_geral'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM financeiro_lancamentos WHERE nivel = 'geral' ORDER BY created_at DESC`
  ).all()
  return okResponse(c, results)
})

// ================= PAINEL DO NÚCLEO =================

financeiro.get('/nucleo/:nucleoId/saldo', async (c) => {
  const actor = c.get('user')
  const nucleoId = Number(c.req.param('nucleoId'))
  if (!(await userCanAccessNucleo(actor, nucleoId))) return errorResponse(c, 403, 'Sem acesso a este núcleo.')

  const row = await c.env.DB.prepare('SELECT saldo FROM saldo_nucleo WHERE nucleo_id = ?')
    .bind(nucleoId)
    .first<{ saldo: number }>()
  return okResponse(c, { saldo: row?.saldo ?? 0 })
})

financeiro.get('/nucleo/:nucleoId/lancamentos', async (c) => {
  const actor = c.get('user')
  const nucleoId = Number(c.req.param('nucleoId'))
  if (!(await userCanAccessNucleo(actor, nucleoId))) return errorResponse(c, 403, 'Sem acesso a este núcleo.')

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM financeiro_lancamentos WHERE nucleo_id = ? ORDER BY created_at DESC`
  )
    .bind(nucleoId)
    .all()
  return okResponse(c, results)
})

// ================= PAINEL DO PROJETO =================

financeiro.get('/projeto/:projetoId/saldo', async (c) => {
  const actor = c.get('user')
  const projetoId = Number(c.req.param('projetoId'))
  const nucleoId = await getNucleoIdFromProjeto(c.env.DB, projetoId)
  if (!nucleoId) return errorResponse(c, 404, 'Projeto não encontrado.')
  if (!(await userCanAccessNucleo(actor, nucleoId))) return errorResponse(c, 403, 'Sem acesso a este projeto.')

  const row = await c.env.DB.prepare('SELECT saldo FROM saldo_projeto WHERE projeto_id = ?')
    .bind(projetoId)
    .first<{ saldo: number }>()
  return okResponse(c, { saldo: row?.saldo ?? 0 })
})

financeiro.get('/projeto/:projetoId/lancamentos', async (c) => {
  const actor = c.get('user')
  const projetoId = Number(c.req.param('projetoId'))
  const nucleoId = await getNucleoIdFromProjeto(c.env.DB, projetoId)
  if (!nucleoId) return errorResponse(c, 404, 'Projeto não encontrado.')
  if (!(await userCanAccessNucleo(actor, nucleoId))) return errorResponse(c, 403, 'Sem acesso a este projeto.')

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM financeiro_lancamentos WHERE projeto_id = ? ORDER BY created_at DESC`
  )
    .bind(projetoId)
    .all()
  return okResponse(c, results)
})

// Saída de pagamento no Projeto — SOMENTE ADMIN, com comprovante bancário E fiscal obrigatórios
financeiro.post('/projeto/:projetoId/saidas', requireRole('admin'), async (c) => {
  const actor = c.get('user')
  const projetoId = Number(c.req.param('projetoId'))

  const projeto = await c.env.DB.prepare('SELECT id, nucleo_id FROM projetos WHERE id = ?').bind(projetoId).first<any>()
  if (!projeto) return errorResponse(c, 404, 'Projeto não encontrado.')

  const formData = await c.req.formData().catch(() => null)
  if (!formData) return errorResponse(c, 422, 'Envie os dados via multipart/form-data.')

  const valorRaw = formData.get('valor')?.toString()
  const finalidade = formData.get('finalidade')?.toString()
  const comprovanteBancario = formData.get('comprovante_bancario')
  const comprovanteFiscal = formData.get('comprovante_fiscal')

  const valor = valorRaw ? parseFloat(valorRaw) : NaN

  if (!valor || valor <= 0) return errorResponse(c, 422, 'Informe um valor positivo.')
  if (!finalidade) return errorResponse(c, 422, 'Informe a finalidade/prestação de contas do pagamento.')
  if (!(comprovanteBancario instanceof File)) {
    return errorResponse(c, 422, 'Comprovante bancário é obrigatório para toda saída financeira.')
  }
  if (!(comprovanteFiscal instanceof File)) {
    return errorResponse(c, 422, 'Comprovante fiscal é obrigatório para toda saída financeira.')
  }

  // Verifica saldo suficiente no projeto antes de executar a saída
  const saldoRow = await c.env.DB.prepare('SELECT saldo FROM saldo_projeto WHERE projeto_id = ?')
    .bind(projetoId)
    .first<{ saldo: number }>()
  const saldoAtual = saldoRow?.saldo ?? 0
  if (valor > saldoAtual) {
    return errorResponse(c, 422, `Saldo insuficiente no projeto. Saldo atual: R$ ${saldoAtual.toFixed(2)}.`)
  }

  // 1) Insere o lançamento (executado diretamente, pois só admin lança e já com comprovantes em mãos)
  const insertLancamento = await c.env.DB.prepare(
    `INSERT INTO financeiro_lancamentos (nivel, projeto_id, nucleo_id, tipo, valor, status, finalidade, executado_por, executado_em)
     VALUES ('projeto', ?, ?, 'saida_pagamento', ?, 'executado', ?, ?, CURRENT_TIMESTAMP)`
  )
    .bind(projetoId, projeto.nucleo_id, valor, finalidade, actor.sub)
    .run()

  const lancamentoId = insertLancamento.meta.last_row_id as number

  // 2) Upload dos arquivos para R2 (fora da transação D1, mas obrigatórios antes de finalizar)
  const bancarioKey = await uploadComprovanteFile(c.env.R2, lancamentoId, 'bancario', comprovanteBancario)
  const fiscalKey = await uploadComprovanteFile(c.env.R2, lancamentoId, 'fiscal', comprovanteFiscal)

  // 3) Insere os dois comprovantes atomicamente via batch
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO comprovantes (lancamento_id, tipo, r2_key, nome_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?)'
    ).bind(lancamentoId, 'bancario', bancarioKey, comprovanteBancario.name, actor.sub),
    c.env.DB.prepare(
      'INSERT INTO comprovantes (lancamento_id, tipo, r2_key, nome_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?)'
    ).bind(lancamentoId, 'fiscal', fiscalKey, comprovanteFiscal.name, actor.sub)
  ])

  await logAudit(c, {
    userId: actor.sub,
    acao: 'financeiro.saida_pagamento.executar',
    entidade: 'financeiro_lancamentos',
    entidadeId: lancamentoId,
    payload: { projetoId, valor, finalidade }
  })

  return okResponse(c, { id: lancamentoId, valor, status: 'executado' }, 201)
})

// ================= REPASSES: SOLICITAÇÃO / APROVAÇÃO / EXECUÇÃO =================

// Solicitar repasse Geral -> Núcleo (admin, coord_geral)
financeiro.post('/repasses/geral-nucleo', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ nucleo_id?: number; valor?: number; finalidade?: string }>().catch(() => ({}))
  const { nucleo_id, valor, finalidade } = body

  if (!nucleo_id || !valor || valor <= 0) return errorResponse(c, 422, 'Informe nucleo_id e valor positivo.')

  const nucleo = await c.env.DB.prepare('SELECT id FROM nucleos WHERE id = ?').bind(nucleo_id).first()
  if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')

  const saldoGeral = await c.env.DB.prepare('SELECT saldo FROM saldo_geral').first<{ saldo: number }>()
  if ((saldoGeral?.saldo ?? 0) < valor) {
    return errorResponse(c, 422, `Saldo geral insuficiente. Saldo atual: R$ ${(saldoGeral?.saldo ?? 0).toFixed(2)}.`)
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO financeiro_lancamentos (nivel, nucleo_id, tipo, valor, status, finalidade, solicitado_por)
     VALUES ('nucleo', ?, 'repasse_geral_nucleo', ?, 'pendente', ?, ?)`
  )
    .bind(nucleo_id, valor, finalidade ?? null, actor.sub)
    .run()

  const id = result.meta.last_row_id as number
  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse_geral_nucleo.solicitar', entidade: 'financeiro_lancamentos', entidadeId: id, payload: { nucleo_id, valor } })

  return okResponse(c, { id, status: 'pendente' }, 201)
})

// Solicitar repasse Núcleo -> Projeto (coord_nucleo do respectivo núcleo, coord_geral, admin)
financeiro.post('/repasses/nucleo-projeto', requireRole('admin', 'coord_geral', 'coord_nucleo'), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ projeto_id?: number; valor?: number; finalidade?: string }>().catch(() => ({}))
  const { projeto_id, valor, finalidade } = body

  if (!projeto_id || !valor || valor <= 0) return errorResponse(c, 422, 'Informe projeto_id e valor positivo.')
  if (!finalidade) return errorResponse(c, 422, 'Informe a finalidade do repasse (obrigatório).')

  const projeto = await c.env.DB.prepare('SELECT id, nucleo_id FROM projetos WHERE id = ?').bind(projeto_id).first<any>()
  if (!projeto) return errorResponse(c, 404, 'Projeto não encontrado.')

  if (!(await userCanAccessNucleo(actor, projeto.nucleo_id))) {
    return errorResponse(c, 403, 'Você não tem acesso ao núcleo deste projeto.')
  }

  const saldoNucleo = await c.env.DB.prepare('SELECT saldo FROM saldo_nucleo WHERE nucleo_id = ?')
    .bind(projeto.nucleo_id)
    .first<{ saldo: number }>()
  if ((saldoNucleo?.saldo ?? 0) < valor) {
    return errorResponse(c, 422, `Saldo do núcleo insuficiente. Saldo atual: R$ ${(saldoNucleo?.saldo ?? 0).toFixed(2)}.`)
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO financeiro_lancamentos (nivel, nucleo_id, projeto_id, tipo, valor, status, finalidade, solicitado_por)
     VALUES ('projeto', ?, ?, 'repasse_nucleo_projeto', ?, 'pendente', ?, ?)`
  )
    .bind(projeto.nucleo_id, projeto_id, valor, finalidade, actor.sub)
    .run()

  const id = result.meta.last_row_id as number
  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse_nucleo_projeto.solicitar', entidade: 'financeiro_lancamentos', entidadeId: id, payload: { projeto_id, valor, finalidade } })

  return okResponse(c, { id, status: 'pendente' }, 201)
})

// Aprovar repasse (admin, coord_geral) — vale para geral->nucleo e nucleo->projeto
financeiro.post('/repasses/:id/aprovar', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const lancamento = await c.env.DB.prepare('SELECT * FROM financeiro_lancamentos WHERE id = ?').bind(id).first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')
  if (!['repasse_geral_nucleo', 'repasse_nucleo_projeto'].includes(lancamento.tipo)) {
    return errorResponse(c, 400, 'Este lançamento não é um repasse aprovável.')
  }
  if (lancamento.status !== 'pendente') {
    return errorResponse(c, 409, `Lançamento já está com status "${lancamento.status}".`)
  }

  await c.env.DB.prepare(
    `UPDATE financeiro_lancamentos SET status = 'aprovado', aprovado_por = ?, aprovado_em = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(actor.sub, id)
    .run()

  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse.aprovar', entidade: 'financeiro_lancamentos', entidadeId: id })

  return okResponse(c, { message: 'Repasse aprovado. Aguardando execução pelo administrador.' })
})

// Rejeitar repasse (admin, coord_geral)
financeiro.post('/repasses/:id/rejeitar', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ motivo?: string }>().catch(() => ({}))

  const lancamento = await c.env.DB.prepare('SELECT * FROM financeiro_lancamentos WHERE id = ?').bind(id).first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')
  if (!['pendente', 'aprovado'].includes(lancamento.status)) {
    return errorResponse(c, 409, `Não é possível rejeitar um lançamento com status "${lancamento.status}".`)
  }

  await c.env.DB.prepare(
    `UPDATE financeiro_lancamentos SET status = 'rejeitado', rejeitado_em = CURRENT_TIMESTAMP, motivo_rejeicao = ? WHERE id = ?`
  )
    .bind(body.motivo ?? null, id)
    .run()

  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse.rejeitar', entidade: 'financeiro_lancamentos', entidadeId: id, payload: { motivo: body.motivo } })

  return okResponse(c, { message: 'Repasse rejeitado.' })
})

// Executar repasse (SOMENTE ADMIN) — exige comprovante bancário, multipart/form-data
financeiro.post('/repasses/:id/executar', requireRole('admin'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const lancamento = await c.env.DB.prepare('SELECT * FROM financeiro_lancamentos WHERE id = ?').bind(id).first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')
  if (!['repasse_geral_nucleo', 'repasse_nucleo_projeto'].includes(lancamento.tipo)) {
    return errorResponse(c, 400, 'Este lançamento não é um repasse executável.')
  }
  if (lancamento.status !== 'aprovado') {
    return errorResponse(c, 409, 'O repasse precisa estar aprovado antes de ser executado.')
  }

  const formData = await c.req.formData().catch(() => null)
  const comprovanteBancario = formData?.get('comprovante_bancario')
  if (!(comprovanteBancario instanceof File)) {
    return errorResponse(c, 422, 'Comprovante bancário é obrigatório para executar o repasse.')
  }

  const bancarioKey = await uploadComprovanteFile(c.env.R2, id, 'bancario', comprovanteBancario)

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE financeiro_lancamentos SET status = 'executado', executado_por = ?, executado_em = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(actor.sub, id),
    c.env.DB.prepare(
      'INSERT INTO comprovantes (lancamento_id, tipo, r2_key, nome_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, 'bancario', bancarioKey, comprovanteBancario.name, actor.sub)
  ])

  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse.executar', entidade: 'financeiro_lancamentos', entidadeId: id })

  return okResponse(c, { message: 'Repasse executado com sucesso.' })
})

// ================= COMPROVANTES =================

financeiro.get('/lancamentos/:id/comprovantes', async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const lancamento = await c.env.DB.prepare('SELECT * FROM financeiro_lancamentos WHERE id = ?').bind(id).first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')

  if (lancamento.nucleo_id && !(await userCanAccessNucleo(actor, lancamento.nucleo_id))) {
    return errorResponse(c, 403, 'Sem acesso a este lançamento.')
  }
  if (lancamento.nivel === 'geral' && !isGlobalUser(actor)) {
    return errorResponse(c, 403, 'Sem acesso a este lançamento.')
  }

  const { results } = await c.env.DB.prepare('SELECT * FROM comprovantes WHERE lancamento_id = ?').bind(id).all()
  return okResponse(c, results)
})

financeiro.get('/comprovantes/:id/arquivo', async (c) => {
  const id = Number(c.req.param('id'))
  const comprovante = await c.env.DB.prepare('SELECT * FROM comprovantes WHERE id = ?').bind(id).first<any>()
  if (!comprovante) return errorResponse(c, 404, 'Comprovante não encontrado.')

  const object = await c.env.R2.get(comprovante.r2_key)
  if (!object) return errorResponse(c, 404, 'Arquivo não encontrado no armazenamento.')

  return new Response(object.body, {
    headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream' }
  })
})

export default financeiro
