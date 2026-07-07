import { Hono } from 'hono'
import type { AppEnv } from '../../types/bindings'
import { errorResponse, okResponse } from '../../utils/response'
import { slugify, generateRandomKey } from '../../utils/crypto'
import { logAudit } from '../../middlewares/audit'
import { authMiddleware } from '../../middlewares/auth'
import { requireRole, requireNucleoAccess, isGlobalUser, getScopedNucleoIds } from '../../middlewares/rbac'

const nucleos = new Hono<AppEnv>()

nucleos.use('*', authMiddleware)

// ===== LISTAR NÚCLEOS (respeitando escopo) =====
nucleos.get('/', async (c) => {
  const user = c.get('user')

  if (isGlobalUser(user)) {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM nucleos ORDER BY created_at DESC'
    ).all()
    return okResponse(c, results)
  }

  const scopedIds = getScopedNucleoIds(user)
  if (scopedIds.length === 0) {
    return okResponse(c, [])
  }
  const placeholders = scopedIds.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM nucleos WHERE id IN (${placeholders}) ORDER BY created_at DESC`
  )
    .bind(...scopedIds)
    .all()
  return okResponse(c, results)
})

// ===== CRIAR NÚCLEO (admin, coord_geral) =====
nucleos.post('/', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ nome?: string; descricao?: string }>().catch(() => ({}))
  const { nome, descricao } = body

  if (!nome) {
    return errorResponse(c, 422, 'Informe o nome do núcleo.')
  }

  let slug = slugify(nome)
  const existingSlug = await c.env.DB.prepare('SELECT id FROM nucleos WHERE slug_publico = ?')
    .bind(slug)
    .first()
  if (existingSlug) {
    slug = `${slug}-${generateRandomKey().slice(0, 6)}`
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO nucleos (nome, descricao, slug_publico, criado_por) VALUES (?, ?, ?, ?)'
  )
    .bind(nome, descricao ?? null, slug, actor.sub)
    .run()

  const nucleoId = result.meta.last_row_id as number

  await logAudit(c, {
    userId: actor.sub,
    acao: 'nucleo.criar',
    entidade: 'nucleos',
    entidadeId: nucleoId,
    payload: { nome, slug }
  })

  return okResponse(c, { id: nucleoId, nome, descricao, slug_publico: slug }, 201)
})

// ===== DETALHE DO NÚCLEO =====
nucleos.get('/:nucleoId', requireNucleoAccess(), async (c) => {
  const nucleoId = Number(c.req.param('nucleoId'))
  const nucleo = await c.env.DB.prepare('SELECT * FROM nucleos WHERE id = ?')
    .bind(nucleoId)
    .first()

  if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')

  const { results: coordenadores } = await c.env.DB.prepare(
    `SELECT u.id, u.nome, u.email FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     WHERE ur.role = 'coord_nucleo' AND ur.escopo_id = ?`
  )
    .bind(nucleoId)
    .all()

  const { results: projetos } = await c.env.DB.prepare(
    'SELECT * FROM projetos WHERE nucleo_id = ? ORDER BY created_at DESC'
  )
    .bind(nucleoId)
    .all()

  return okResponse(c, { ...nucleo, coordenadores, projetos })
})

// ===== ATUALIZAR NÚCLEO (admin, coord_geral) =====
nucleos.put('/:nucleoId', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const nucleoId = Number(c.req.param('nucleoId'))
  const body = await c.req.json<{ nome?: string; descricao?: string; ativo?: boolean }>().catch(() => ({}))

  const nucleo = await c.env.DB.prepare('SELECT id FROM nucleos WHERE id = ?').bind(nucleoId).first()
  if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')

  await c.env.DB.prepare(
    'UPDATE nucleos SET nome = COALESCE(?, nome), descricao = COALESCE(?, descricao), ativo = COALESCE(?, ativo) WHERE id = ?'
  )
    .bind(body.nome ?? null, body.descricao ?? null, body.ativo === undefined ? null : (body.ativo ? 1 : 0), nucleoId)
    .run()

  await logAudit(c, { userId: actor.sub, acao: 'nucleo.atualizar', entidade: 'nucleos', entidadeId: nucleoId, payload: body })

  return okResponse(c, { message: 'Núcleo atualizado.' })
})

// ===== CADASTRAR COORDENADOR DE NÚCLEO (admin, coord_geral) =====
nucleos.post('/:nucleoId/coordenadores', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const nucleoId = Number(c.req.param('nucleoId'))
  const body = await c.req.json<{ user_id?: number }>().catch(() => ({}))
  const { user_id } = body

  if (!user_id) return errorResponse(c, 422, 'Informe user_id do coordenador.')

  const nucleo = await c.env.DB.prepare('SELECT id FROM nucleos WHERE id = ?').bind(nucleoId).first()
  if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(user_id).first()
  if (!user) return errorResponse(c, 404, 'Usuário não encontrado.')

  const already = await c.env.DB.prepare(
    "SELECT id FROM user_roles WHERE user_id = ? AND role = 'coord_nucleo' AND escopo_id = ?"
  )
    .bind(user_id, nucleoId)
    .first()
  if (already) return errorResponse(c, 409, 'Usuário já é coordenador deste núcleo.')

  await c.env.DB.prepare(
    "INSERT INTO user_roles (user_id, role, escopo_tipo, escopo_id) VALUES (?, 'coord_nucleo', 'nucleo', ?)"
  )
    .bind(user_id, nucleoId)
    .run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'nucleo.coordenador.adicionar',
    entidade: 'nucleos',
    entidadeId: nucleoId,
    payload: { user_id }
  })

  return okResponse(c, { message: 'Coordenador vinculado ao núcleo.' }, 201)
})

export default nucleos
