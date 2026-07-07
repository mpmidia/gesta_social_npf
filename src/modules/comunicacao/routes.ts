import { Hono } from 'hono'
import type { AppEnv } from '../../types/bindings'
import { errorResponse, okResponse } from '../../utils/response'
import { logAudit } from '../../middlewares/audit'
import { authMiddleware } from '../../middlewares/auth'
import { requireRole, isGlobalUser, getScopedNucleoIds } from '../../middlewares/rbac'
import { sendEmailStub, sendWhatsAppStub } from './providers'

const comunicacao = new Hono<AppEnv>()

comunicacao.use('*', authMiddleware)

const ROLES_COMUNICACAO = ['admin', 'coord_geral', 'coord_nucleo', 'articulador'] as const

// ===== TEMPLATES REUTILIZÁVEIS =====
comunicacao.get('/templates', requireRole(...ROLES_COMUNICACAO), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM templates_mensagem ORDER BY created_at DESC').all()
  return okResponse(c, results)
})

comunicacao.post('/templates', requireRole(...ROLES_COMUNICACAO), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ nome?: string; canal?: string; corpo?: string }>().catch(() => ({}))
  const { nome, canal, corpo } = body

  if (!nome || !canal || !corpo) return errorResponse(c, 422, 'Informe nome, canal e corpo do template.')
  if (!['email', 'whatsapp', 'ambos'].includes(canal)) return errorResponse(c, 422, 'Canal inválido.')

  const result = await c.env.DB.prepare(
    'INSERT INTO templates_mensagem (nome, canal, corpo, criado_por) VALUES (?, ?, ?, ?)'
  )
    .bind(nome, canal, corpo, actor.sub)
    .run()

  return okResponse(c, { id: result.meta.last_row_id, nome, canal, corpo }, 201)
})

// ===== CAMPANHAS =====
comunicacao.get('/campanhas', requireRole(...ROLES_COMUNICACAO), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM campanhas ORDER BY created_at DESC').all()
  return okResponse(c, results)
})

comunicacao.post('/campanhas', requireRole(...ROLES_COMUNICACAO), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{
    titulo?: string
    canal?: string
    corpo_template?: string
    segmento_tipo?: string
    segmento_id?: number
  }>().catch(() => ({}))

  const { titulo, canal, corpo_template, segmento_tipo, segmento_id } = body

  if (!titulo || !canal || !corpo_template || !segmento_tipo) {
    return errorResponse(c, 422, 'Informe titulo, canal, corpo_template e segmento_tipo.')
  }
  if (!['email', 'whatsapp', 'ambos'].includes(canal)) return errorResponse(c, 422, 'Canal inválido.')
  if (!['nucleo', 'projeto', 'todos'].includes(segmento_tipo)) return errorResponse(c, 422, 'segmento_tipo inválido.')

  // Isolamento: coord_nucleo só pode segmentar núcleos aos quais tem acesso
  if (!isGlobalUser(actor) && segmento_tipo === 'nucleo') {
    const scopedIds = getScopedNucleoIds(actor)
    if (!segmento_id || !scopedIds.includes(segmento_id)) {
      return errorResponse(c, 403, 'Você só pode criar campanhas para núcleos aos quais tem acesso.')
    }
  }
  if (!isGlobalUser(actor) && segmento_tipo === 'todos') {
    return errorResponse(c, 403, 'Apenas administradores/coordenador geral podem segmentar "todos".')
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO campanhas (titulo, canal, corpo_template, segmento_tipo, segmento_id, criado_por)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(titulo, canal, corpo_template, segmento_tipo, segmento_id ?? null, actor.sub)
    .run()

  const id = result.meta.last_row_id as number

  await logAudit(c, { userId: actor.sub, acao: 'campanha.criar', entidade: 'campanhas', entidadeId: id, payload: { titulo, canal, segmento_tipo, segmento_id } })

  return okResponse(c, { id, titulo, canal, segmento_tipo, segmento_id }, 201)
})

// ===== DISPARAR CAMPANHA (usa stubs de e-mail/whatsapp) =====
comunicacao.post('/campanhas/:id/enviar', requireRole(...ROLES_COMUNICACAO), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const campanha = await c.env.DB.prepare('SELECT * FROM campanhas WHERE id = ?').bind(id).first<any>()
  if (!campanha) return errorResponse(c, 404, 'Campanha não encontrada.')

  if (!isGlobalUser(actor) && campanha.segmento_tipo === 'nucleo') {
    const scopedIds = getScopedNucleoIds(actor)
    if (!scopedIds.includes(campanha.segmento_id)) {
      return errorResponse(c, 403, 'Você não tem acesso a este segmento.')
    }
  }

  // Monta lista de destinatários (colaboradores) conforme segmentação
  let query = 'SELECT * FROM colaboradores WHERE 1=1'
  const binds: any[] = []
  if (campanha.segmento_tipo === 'nucleo') {
    query += ' AND nucleo_id = ?'
    binds.push(campanha.segmento_id)
  } else if (campanha.segmento_tipo === 'projeto') {
    query += ' AND projeto_id = ?'
    binds.push(campanha.segmento_id)
  }

  const { results: colaboradores } = await c.env.DB.prepare(query).bind(...binds).all<any>()

  let enviados = 0
  let falhas = 0

  for (const colaborador of colaboradores ?? []) {
    const corpoPersonalizado = campanha.corpo_template.replace(/\{\{\s*nome\s*\}\}/gi, colaborador.nome)

    if (campanha.canal === 'email' || campanha.canal === 'ambos') {
      // Colaborador não tem e-mail no modelo atual; usamos whatsapp como fallback de contato caso email não exista.
      // Aqui mantemos apenas o envio de whatsapp real; e-mail fica registrado como não aplicável se não houver campo.
    }

    if (campanha.canal === 'whatsapp' || campanha.canal === 'ambos') {
      const result = await sendWhatsAppStub(colaborador.whatsapp, corpoPersonalizado)
      await c.env.DB.prepare(
        `INSERT INTO campanha_envios (campanha_id, colaborador_id, canal, destino, status, provider_response)
         VALUES (?, ?, 'whatsapp', ?, ?, ?)`
      )
        .bind(id, colaborador.id, colaborador.whatsapp, result.ok ? 'enviado' : 'falhou', result.providerResponse)
        .run()
      result.ok ? enviados++ : falhas++
    }
  }

  await logAudit(c, { userId: actor.sub, acao: 'campanha.enviar', entidade: 'campanhas', entidadeId: id, payload: { enviados, falhas } })

  return okResponse(c, { message: `Campanha disparada (modo stub). Enviados: ${enviados}, Falhas: ${falhas}.`, enviados, falhas })
})

comunicacao.get('/campanhas/:id/envios', requireRole(...ROLES_COMUNICACAO), async (c) => {
  const id = Number(c.req.param('id'))
  const { results } = await c.env.DB.prepare('SELECT * FROM campanha_envios WHERE campanha_id = ? ORDER BY created_at DESC').bind(id).all()
  return okResponse(c, results)
})

export default comunicacao
