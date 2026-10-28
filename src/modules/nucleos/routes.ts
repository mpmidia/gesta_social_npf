import { Hono } from 'hono'
import type { AppEnv } from '../../types/bindings'
import { errorResponse, okResponse } from '../../utils/response'
import { slugify, generateRandomKey } from '../../utils/crypto'
import { hashPassword } from '../../utils/crypto'
import { logAudit } from '../../middlewares/audit'
import { authMiddleware } from '../../middlewares/auth'
import { requireRole, requireNucleoAccess, hasBroadReadAccess, getScopedNucleoIds, isAdmin } from '../../middlewares/rbac'

const nucleos = new Hono<AppEnv>()

nucleos.use('*', authMiddleware)

// ===== LISTAR NÚCLEOS (respeitando escopo) =====
// admin, coord_geral e articulador enxergam todos os núcleos (leitura institucional).
// coord_nucleo enxerga apenas os núcleos aos quais está vinculado.
nucleos.get('/', async (c) => {
  const user = c.get('user')

  if (hasBroadReadAccess(user)) {
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
  const body = await c.req.json<{ nome?: string; descricao?: string }>().catch(() => ({} as any))
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
  const body = await c.req.json<{ nome?: string; descricao?: string; ativo?: boolean }>().catch(() => ({} as any))

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
//
// O Coordenador Geral cadastra o Coordenador de Núcleo diretamente pelo
// painel do próprio núcleo (não precisa passar pela tela de Usuários &
// Permissões, que agora é exclusiva do Administrador). Dois modos:
//
//   modo 'novo': cria um usuário novo (nome/email/senha) já com o papel
//   coord_nucleo escopado a este núcleo.
//
//   modo 'existente': reaproveita um usuário já cadastrado (localizado
//   pelo e-mail) e REATRIBUI o papel dele para coord_nucleo deste núcleo
//   — como cada usuário tem exatamente um papel (user_roles.user_id é
//   UNIQUE), isso substitui qualquer papel anterior. Por segurança, só o
//   Administrador pode fazer essa reatribuição quando o usuário já é
//   admin, coord_geral ou financeiro (um Coordenador Geral não pode
//   "rebaixar" esses papéis sem querer).
nucleos.post('/:nucleoId/coordenadores', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const nucleoId = Number(c.req.param('nucleoId'))
  const body = await c.req.json<{
    modo?: 'novo' | 'existente'
    nome?: string
    email?: string
    senha?: string
  }>().catch(() => ({} as any))
  const { modo, nome, email, senha } = body

  const nucleo = await c.env.DB.prepare('SELECT id, nome FROM nucleos WHERE id = ?').bind(nucleoId).first<any>()
  if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')

  if (modo === 'existente') {
    if (!email) return errorResponse(c, 422, 'Informe o e-mail do usuário existente.')

    const user = await c.env.DB.prepare(
      'SELECT id, nome FROM users WHERE email = ? AND excluido_em IS NULL'
    )
      .bind(email.toLowerCase().trim())
      .first<{ id: number; nome: string }>()
    if (!user) return errorResponse(c, 404, 'Não existe usuário ativo com este e-mail.')

    const currentRole = await c.env.DB.prepare('SELECT role FROM user_roles WHERE user_id = ?')
      .bind(user.id)
      .first<{ role: string }>()

    if (currentRole && ['admin', 'coord_geral', 'financeiro'].includes(currentRole.role) && !isAdmin(actor)) {
      return errorResponse(
        c,
        403,
        `Apenas o Administrador pode reatribuir o papel de um usuário que já é ${currentRole.role}.`
      )
    }

    if (currentRole?.role === 'coord_nucleo') {
      const mesmoNucleo = await c.env.DB.prepare(
        "SELECT id FROM user_roles WHERE user_id = ? AND escopo_id = ?"
      ).bind(user.id, nucleoId).first()
      if (mesmoNucleo) return errorResponse(c, 409, 'Este usuário já é coordenador deste núcleo.')
    }

    await c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(user.id).run()
    await c.env.DB.prepare(
      "INSERT INTO user_roles (user_id, role, escopo_tipo, escopo_id) VALUES (?, 'coord_nucleo', 'nucleo', ?)"
    )
      .bind(user.id, nucleoId)
      .run()

    await logAudit(c, {
      userId: actor.sub,
      acao: 'nucleo.coordenador.adicionar',
      entidade: 'nucleos',
      entidadeId: nucleoId,
      payload: { user_id: user.id, modo: 'existente', papelAnterior: currentRole?.role ?? null }
    })

    return okResponse(c, { message: `${user.nome} agora é coordenador(a) de "${nucleo.nome}".` }, 201)
  }

  // modo 'novo' (padrão): cria um usuário já como coordenador deste núcleo.
  if (!nome || !email || !senha) {
    return errorResponse(c, 422, 'Informe nome, e-mail e senha do novo coordenador.')
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND excluido_em IS NULL')
    .bind(email.toLowerCase().trim())
    .first()
  if (existing) {
    return errorResponse(c, 409, 'Já existe um usuário com este e-mail. Use a opção "usuário existente" para reaproveitá-lo.')
  }

  const senhaHash = await hashPassword(senha)
  const insertUser = await c.env.DB.prepare('INSERT INTO users (nome, email, senha_hash) VALUES (?, ?, ?)')
    .bind(nome, email.toLowerCase().trim(), senhaHash)
    .run()
  const novoUserId = insertUser.meta.last_row_id as number

  await c.env.DB.prepare(
    "INSERT INTO user_roles (user_id, role, escopo_tipo, escopo_id) VALUES (?, 'coord_nucleo', 'nucleo', ?)"
  )
    .bind(novoUserId, nucleoId)
    .run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'nucleo.coordenador.adicionar',
    entidade: 'nucleos',
    entidadeId: nucleoId,
    payload: { user_id: novoUserId, modo: 'novo', nome, email }
  })

  return okResponse(c, { message: `${nome} cadastrado(a) como coordenador(a) de "${nucleo.nome}".` }, 201)
})

// ===== REMOVER COORDENADOR DE NÚCLEO (admin, coord_geral) =====
// Remove o vínculo de coordenação (user_roles com role='coord_nucleo' e escopo_id=nucleoId).
// Não exclui o usuário — apenas o papel/escopo neste núcleo específico. Para "substituir"
// um coordenador, o frontend chama esta rota seguida de POST .../coordenadores com o novo user_id.
nucleos.delete('/:nucleoId/coordenadores/:userId', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const nucleoId = Number(c.req.param('nucleoId'))
  const userId = Number(c.req.param('userId'))

  const vinculo = await c.env.DB.prepare(
    "SELECT id FROM user_roles WHERE user_id = ? AND role = 'coord_nucleo' AND escopo_id = ?"
  )
    .bind(userId, nucleoId)
    .first()
  if (!vinculo) return errorResponse(c, 404, 'Este usuário não é coordenador deste núcleo.')

  await c.env.DB.prepare(
    "DELETE FROM user_roles WHERE user_id = ? AND role = 'coord_nucleo' AND escopo_id = ?"
  )
    .bind(userId, nucleoId)
    .run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'nucleo.coordenador.remover',
    entidade: 'nucleos',
    entidadeId: nucleoId,
    payload: { user_id: userId }
  })

  return okResponse(c, { message: 'Coordenador removido do núcleo.' })
})

// ===== ARQUIVAR OU EXCLUIR NÚCLEO (admin, coord_geral) =====
//
// Regra de negócio: um núcleo que já teve QUALQUER movimentação financeira
// (repasses recebidos, saldo diferente de zero, lançamentos históricos) não
// pode ser excluído fisicamente — precisa ter o saldo ZERADO e então é
// ARQUIVADO (arquivado_em/arquivado_por), preservando todo o histórico.
// Um núcleo SEM nenhum lançamento financeiro histórico pode ser excluído
// de verdade (DELETE), desde que também não tenha projetos nem coordenadores
// vinculados (evita deixar registros órfãos).
//
// Arquivar também desativa o núcleo (ativo=0), removendo-o das landing pages
// públicas automaticamente.
nucleos.delete('/:nucleoId', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const nucleoId = Number(c.req.param('nucleoId'))

  const nucleo = await c.env.DB.prepare('SELECT * FROM nucleos WHERE id = ?').bind(nucleoId).first<any>()
  if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')
  if (nucleo.arquivado_em) return errorResponse(c, 409, 'Este núcleo já está arquivado.')

  const saldoRow = await c.env.DB.prepare('SELECT saldo FROM saldo_nucleo WHERE nucleo_id = ?')
    .bind(nucleoId)
    .first<{ saldo: number }>()
  const saldoAtual = saldoRow?.saldo ?? 0

  const possuiHistoricoFinanceiro = await c.env.DB.prepare(
    'SELECT 1 FROM financeiro_lancamentos WHERE nucleo_id = ? LIMIT 1'
  )
    .bind(nucleoId)
    .first()

  if (possuiHistoricoFinanceiro) {
    // Já teve movimentação financeira: só pode ser ARQUIVADO, nunca excluído,
    // e somente depois de o saldo estar zerado.
    if (saldoAtual !== 0) {
      return errorResponse(
        c,
        422,
        `Este núcleo possui saldo de R$ ${saldoAtual.toFixed(2)}. Zere o saldo (repasse/transfira todo o valor) antes de arquivar. Núcleos com histórico financeiro não podem ser excluídos, apenas arquivados.`
      )
    }

    await c.env.DB.prepare(
      'UPDATE nucleos SET ativo = 0, arquivado_em = CURRENT_TIMESTAMP, arquivado_por = ? WHERE id = ?'
    )
      .bind(actor.sub, nucleoId)
      .run()

    await logAudit(c, {
      userId: actor.sub,
      acao: 'nucleo.arquivar',
      entidade: 'nucleos',
      entidadeId: nucleoId,
      payload: { motivo: 'possui_historico_financeiro' }
    })

    return okResponse(c, {
      message: `Núcleo "${nucleo.nome}" arquivado. Como possui histórico financeiro, o registro foi mantido de forma inativa para preservar a rastreabilidade.`,
      arquivado: true
    })
  }

  // Sem histórico financeiro: verifica se há projetos vinculados (mesmo que
  // os projetos também não tenham histórico, é mais seguro exigir que sejam
  // removidos/arquivados primeiro, individualmente).
  const possuiProjetos = await c.env.DB.prepare('SELECT 1 FROM projetos WHERE nucleo_id = ? LIMIT 1')
    .bind(nucleoId)
    .first()
  if (possuiProjetos) {
    return errorResponse(c, 422, 'Este núcleo possui projetos vinculados. Remova ou arquive os projetos antes de excluir o núcleo.')
  }

  // Colaboradores cadastrados (formulário público) ficam vinculados ao núcleo —
  // são dados de pessoas reais (CPF, WhatsApp), então a exclusão do núcleo é
  // bloqueada enquanto existirem, em vez de apagá-los silenciosamente junto.
  const possuiColaboradores = await c.env.DB.prepare('SELECT 1 FROM colaboradores WHERE nucleo_id = ? LIMIT 1')
    .bind(nucleoId)
    .first()
  if (possuiColaboradores) {
    return errorResponse(c, 422, 'Este núcleo possui colaboradores cadastrados. Remova-os (ou vincule a outro núcleo) antes de excluir.')
  }

  // Exclusão física: remove destaques públicos (chamadas/campanhas da landing
  // page, sem valor de auditoria), coordenadores vinculados e o núcleo.
  // IMPORTANTE: sem este DELETE em destaques_publicos, a exclusão falhava com
  // erro 500 (FK constraint fk_destaques_nucleo) sempre que o núcleo tivesse
  // algum destaque público cadastrado (ex.: o núcleo de exemplo do seed).
  await c.env.DB.prepare('DELETE FROM destaques_publicos WHERE nucleo_id = ?').bind(nucleoId).run()
  await c.env.DB.prepare("DELETE FROM user_roles WHERE role = 'coord_nucleo' AND escopo_id = ?").bind(nucleoId).run()
  await c.env.DB.prepare('DELETE FROM nucleos WHERE id = ?').bind(nucleoId).run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'nucleo.excluir',
    entidade: 'nucleos',
    entidadeId: nucleoId,
    payload: { nome: nucleo.nome }
  })

  return okResponse(c, { message: `Núcleo "${nucleo.nome}" excluído permanentemente.`, arquivado: false })
})

export default nucleos
