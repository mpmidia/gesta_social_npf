import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import type { AppEnv, Role } from '../../types/bindings'
import type { AppDatabase } from '../../platform/db'
import { hashPassword, verifyPassword, generateRandomKey } from '../../utils/crypto'
import { createToken, COOKIE_NAME } from '../../utils/jwt'
import { errorResponse, okResponse } from '../../utils/response'
import { logAudit } from '../../middlewares/audit'
import { authMiddleware } from '../../middlewares/auth'
import { requireRole, isAdmin } from '../../middlewares/rbac'

const auth = new Hono<AppEnv>()

interface UserRoleRow {
  role: Role
  escopo_id: number | null
}

async function loadUserRoles(db: AppDatabase, userId: number): Promise<UserRoleRow[]> {
  const { results } = await db
    .prepare('SELECT role, escopo_id FROM user_roles WHERE user_id = ?')
    .bind(userId)
    .all<UserRoleRow>()
  return results ?? []
}

// ===== LOGIN (público) =====
auth.post('/login', async (c) => {
  const body = await c.req.json<{ email?: string; senha?: string }>().catch(() => ({} as any))
  const { email, senha } = body
  if (!email || !senha) {
    return errorResponse(c, 422, 'Informe e-mail e senha.')
  }

  const user = await c.env.DB.prepare(
    'SELECT id, nome, email, senha_hash, ativo FROM users WHERE email = ? AND excluido_em IS NULL'
  )
    .bind(email.toLowerCase().trim())
    .first<{ id: number; nome: string; email: string; senha_hash: string; ativo: number }>()

  if (!user || !user.ativo) {
    return errorResponse(c, 401, 'Credenciais inválidas.')
  }

  const valid = await verifyPassword(senha, user.senha_hash)
  if (!valid) {
    return errorResponse(c, 401, 'Credenciais inválidas.')
  }

  const roles = await loadUserRoles(c.env.DB, user.id)
  if (roles.length === 0) {
    return errorResponse(c, 403, 'Usuário sem papel atribuído. Contate um administrador.')
  }

  const token = await createToken(
    { sub: user.id, nome: user.nome, email: user.email, roles },
    c.env.JWT_SECRET
  )

  const isHttps = new URL(c.req.url).protocol === 'https:'
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 12
  })

  await logAudit(c, { userId: user.id, acao: 'auth.login', entidade: 'users', entidadeId: user.id })

  return okResponse(c, { id: user.id, nome: user.nome, email: user.email, roles })
})

// ===== LOGOUT =====
auth.post('/logout', authMiddleware, async (c) => {
  const user = c.get('user')
  deleteCookie(c, COOKIE_NAME, { path: '/' })
  await logAudit(c, { userId: user.sub, acao: 'auth.logout', entidade: 'users', entidadeId: user.sub })
  return okResponse(c, { message: 'Logout realizado.' })
})

// ===== ME =====
auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user')
  return okResponse(c, user)
})

// ===== LISTAR USUÁRIOS (admin, coord_geral) =====
auth.get('/usuarios', authMiddleware, requireRole('admin', 'coord_geral'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.nome, u.email, u.ativo, u.created_at
     FROM users u WHERE u.excluido_em IS NULL ORDER BY u.created_at DESC`
  ).all()

  const usersWithRoles = await Promise.all(
    (results ?? []).map(async (u: any) => {
      const roles = await loadUserRoles(c.env.DB, u.id)
      return { ...u, roles }
    })
  )

  return okResponse(c, usersWithRoles)
})

// ===== CRIAR USUÁRIO COM PAPEL (admin cria qualquer papel; coord_geral cria coord_nucleo/articulador) =====
auth.post('/usuarios', authMiddleware, requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{
    nome?: string
    email?: string
    senha?: string
    role?: Role
    nucleo_id?: number | null
  }>().catch(() => ({} as any))

  const { nome, email, senha, role, nucleo_id } = body

  if (!nome || !email || !senha || !role) {
    return errorResponse(c, 422, 'Informe nome, e-mail, senha e papel (role).')
  }

  const validRoles: Role[] = ['admin', 'coord_geral', 'coord_nucleo', 'articulador']
  if (!validRoles.includes(role)) {
    return errorResponse(c, 422, 'Papel inválido.')
  }

  // Regra crítica: apenas admin pode criar outro admin ou coord_geral
  const actorIsAdmin = isAdmin(actor)
  if ((role === 'admin' || role === 'coord_geral') && !actorIsAdmin) {
    return errorResponse(c, 403, 'Apenas administradores podem criar admin ou coordenador geral.')
  }

  if (role === 'coord_nucleo' && !nucleo_id) {
    return errorResponse(c, 422, 'Para o papel coord_nucleo é obrigatório informar nucleo_id.')
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND excluido_em IS NULL')
    .bind(email.toLowerCase().trim())
    .first()
  if (existing) {
    return errorResponse(c, 409, 'Já existe um usuário com este e-mail.')
  }

  const senhaHash = await hashPassword(senha)

  const insertUser = await c.env.DB.prepare(
    'INSERT INTO users (nome, email, senha_hash) VALUES (?, ?, ?)'
  )
    .bind(nome, email.toLowerCase().trim(), senhaHash)
    .run()

  const newUserId = insertUser.meta.last_row_id as number

  await c.env.DB.prepare(
    'INSERT INTO user_roles (user_id, role, escopo_tipo, escopo_id) VALUES (?, ?, ?, ?)'
  )
    .bind(newUserId, role, role === 'coord_nucleo' ? 'nucleo' : null, role === 'coord_nucleo' ? nucleo_id : null)
    .run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'auth.usuario.criar',
    entidade: 'users',
    entidadeId: newUserId,
    payload: { nome, email, role, nucleo_id }
  })

  return okResponse(c, { id: newUserId, nome, email, role, nucleo_id }, 201)
})

// ===== PROMOVER USUÁRIO A ADMIN (somente admin) =====
auth.post('/usuarios/:id/promover-admin', authMiddleware, requireRole('admin'), async (c) => {
  const actor = c.get('user')
  const targetId = Number(c.req.param('id'))

  const target = await c.env.DB.prepare('SELECT id, nome FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ id: number; nome: string }>()

  if (!target) {
    return errorResponse(c, 404, 'Usuário não encontrado.')
  }

  const alreadyAdmin = await c.env.DB.prepare(
    "SELECT id FROM user_roles WHERE user_id = ? AND role = 'admin'"
  )
    .bind(targetId)
    .first()

  if (alreadyAdmin) {
    return errorResponse(c, 409, 'Usuário já é administrador.')
  }

  await c.env.DB.prepare(
    "INSERT INTO user_roles (user_id, role, escopo_tipo, escopo_id) VALUES (?, 'admin', NULL, NULL)"
  )
    .bind(targetId)
    .run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'auth.usuario.promover_admin',
    entidade: 'users',
    entidadeId: targetId,
    payload: { promovido: target.nome, por: actor.nome }
  })

  return okResponse(c, { message: `${target.nome} agora é administrador.` })
})

// ===== DESATIVAR USUÁRIO (somente admin) =====
auth.post('/usuarios/:id/desativar', authMiddleware, requireRole('admin'), async (c) => {
  const actor = c.get('user')
  const targetId = Number(c.req.param('id'))

  if (targetId === actor.sub) {
    return errorResponse(c, 400, 'Você não pode desativar sua própria conta.')
  }

  await c.env.DB.prepare('UPDATE users SET ativo = 0 WHERE id = ?').bind(targetId).run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'auth.usuario.desativar',
    entidade: 'users',
    entidadeId: targetId
  })

  return okResponse(c, { message: 'Usuário desativado.' })
})

// ===== REATIVAR USUÁRIO (somente admin) =====
auth.post('/usuarios/:id/reativar', authMiddleware, requireRole('admin'), async (c) => {
  const actor = c.get('user')
  const targetId = Number(c.req.param('id'))

  const target = await c.env.DB.prepare('SELECT id, nome FROM users WHERE id = ? AND excluido_em IS NULL')
    .bind(targetId)
    .first<{ id: number; nome: string }>()
  if (!target) return errorResponse(c, 404, 'Usuário não encontrado.')

  await c.env.DB.prepare('UPDATE users SET ativo = 1 WHERE id = ?').bind(targetId).run()

  await logAudit(c, { userId: actor.sub, acao: 'auth.usuario.reativar', entidade: 'users', entidadeId: targetId })

  return okResponse(c, { message: `${target.nome} reativado.` })
})

// ===== EDITAR USUÁRIO (admin edita qualquer um; coord_geral edita coord_nucleo/articulador) =====
// Permite alterar nome, e-mail e o papel/escopo (núcleo) do usuário. A troca de
// senha tem rota própria (/usuarios/:id/resetar-senha), para manter uma ação
// sensível isolada e sempre auditada separadamente.
auth.put('/usuarios/:id', authMiddleware, requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const targetId = Number(c.req.param('id'))
  const body = await c.req.json<{
    nome?: string
    email?: string
    role?: Role
    nucleo_id?: number | null
  }>().catch(() => ({} as any))

  const { nome, email, role, nucleo_id } = body

  const target = await c.env.DB.prepare('SELECT id, nome FROM users WHERE id = ? AND excluido_em IS NULL')
    .bind(targetId)
    .first<{ id: number; nome: string }>()
  if (!target) return errorResponse(c, 404, 'Usuário não encontrado.')

  const targetRoles = await loadUserRoles(c.env.DB, targetId)
  const targetIsAdminOrCoordGeral = targetRoles.some((r) => r.role === 'admin' || r.role === 'coord_geral')
  const actorIsAdmin = isAdmin(actor)

  // coord_geral não pode editar admin/coord_geral (inclusive a si mesmo via esta rota
  // — ele não altera o próprio papel por aqui, só um admin pode reatribuir papéis de
  // admin/coord_geral).
  if (!actorIsAdmin && targetIsAdminOrCoordGeral) {
    return errorResponse(c, 403, 'Apenas administradores podem editar administradores ou coordenadores gerais.')
  }

  if (nome !== undefined && !nome.trim()) {
    return errorResponse(c, 422, 'Nome não pode ser vazio.')
  }

  if (email !== undefined) {
    if (!email.trim()) return errorResponse(c, 422, 'E-mail não pode ser vazio.')
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ? AND excluido_em IS NULL')
      .bind(email.toLowerCase().trim(), targetId)
      .first()
    if (existing) return errorResponse(c, 409, 'Já existe outro usuário com este e-mail.')
  }

  if (nome !== undefined || email !== undefined) {
    await c.env.DB.prepare('UPDATE users SET nome = COALESCE(?, nome), email = COALESCE(?, email) WHERE id = ?')
      .bind(nome?.trim() ?? null, email ? email.toLowerCase().trim() : null, targetId)
      .run()
  }

  if (role !== undefined) {
    const validRoles: Role[] = ['admin', 'coord_geral', 'coord_nucleo', 'articulador']
    if (!validRoles.includes(role)) return errorResponse(c, 422, 'Papel inválido.')
    if ((role === 'admin' || role === 'coord_geral') && !actorIsAdmin) {
      return errorResponse(c, 403, 'Apenas administradores podem atribuir o papel admin ou coordenador geral.')
    }
    if (role === 'coord_nucleo' && !nucleo_id) {
      return errorResponse(c, 422, 'Para o papel coord_nucleo é obrigatório informar nucleo_id.')
    }
    if (targetId === actor.sub && role !== 'admin' && isAdmin(actor)) {
      return errorResponse(c, 400, 'Você não pode remover seu próprio papel de administrador.')
    }

    // Substitui todos os papéis do usuário por este único papel (o formulário de
    // edição trabalha com um papel principal por usuário, igual à criação).
    await c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(targetId).run()
    await c.env.DB.prepare(
      'INSERT INTO user_roles (user_id, role, escopo_tipo, escopo_id) VALUES (?, ?, ?, ?)'
    )
      .bind(targetId, role, role === 'coord_nucleo' ? 'nucleo' : null, role === 'coord_nucleo' ? nucleo_id : null)
      .run()
  }

  await logAudit(c, {
    userId: actor.sub,
    acao: 'auth.usuario.editar',
    entidade: 'users',
    entidadeId: targetId,
    payload: { nome, email, role, nucleo_id }
  })

  const rolesAtualizados = await loadUserRoles(c.env.DB, targetId)
  return okResponse(c, { id: targetId, nome: nome ?? target.nome, email, roles: rolesAtualizados })
})

// ===== RESETAR SENHA (somente admin) =====
// Gera uma nova senha temporária aleatória e a retorna na resposta (uma única
// vez) para o administrador repassar ao usuário por um canal seguro — a senha
// em texto puro nunca é persistida nem logada, apenas o hash.
auth.post('/usuarios/:id/resetar-senha', authMiddleware, requireRole('admin'), async (c) => {
  const actor = c.get('user')
  const targetId = Number(c.req.param('id'))
  const body = await c.req.json<{ nova_senha?: string }>().catch(() => ({} as any))

  const target = await c.env.DB.prepare('SELECT id, nome FROM users WHERE id = ? AND excluido_em IS NULL')
    .bind(targetId)
    .first<{ id: number; nome: string }>()
  if (!target) return errorResponse(c, 404, 'Usuário não encontrado.')

  // Se o admin não informar uma senha específica, gera uma temporária aleatória.
  const novaSenha = body.nova_senha?.trim() || generateRandomKey()
  if (novaSenha.length < 6) {
    return errorResponse(c, 422, 'A nova senha deve ter ao menos 6 caracteres.')
  }

  const senhaHash = await hashPassword(novaSenha)
  await c.env.DB.prepare('UPDATE users SET senha_hash = ? WHERE id = ?').bind(senhaHash, targetId).run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'auth.usuario.resetar_senha',
    entidade: 'users',
    entidadeId: targetId
    // Nunca gravar a senha (nem hash) no payload de auditoria.
  })

  return okResponse(c, {
    message: `Senha de ${target.nome} redefinida com sucesso.`,
    senha_temporaria: novaSenha
  })
})

// Tabelas que referenciam users.id via FOREIGN KEY — usadas para decidir se um
// usuário pode ser excluído fisicamente (sem nenhum histórico vinculado) ou se
// precisa de soft-delete (marca excluido_em, preservando o rastro de auditoria/
// financeiro/conteúdo criado por ele).
const TABELAS_COM_REFERENCIA_A_USERS: Array<{ tabela: string; coluna: string }> = [
  { tabela: 'user_roles', coluna: 'user_id' },
  { tabela: 'nucleos', coluna: 'criado_por' },
  { tabela: 'projetos', coluna: 'criado_por' },
  { tabela: 'destaques_publicos', coluna: 'criado_por' },
  { tabela: 'colaboradores', coluna: 'validado_por' },
  { tabela: 'financeiro_lancamentos', coluna: 'solicitado_por' },
  { tabela: 'financeiro_lancamentos', coluna: 'aprovado_por' },
  { tabela: 'financeiro_lancamentos', coluna: 'executado_por' },
  { tabela: 'comprovantes', coluna: 'enviado_por' },
  { tabela: 'audit_log', coluna: 'user_id' },
  { tabela: 'campanhas', coluna: 'criado_por' },
  { tabela: 'templates_mensagem', coluna: 'criado_por' },
  { tabela: 'financeiro_importacoes_nfp', coluna: 'importado_por' }
]

async function usuarioPossuiHistorico(db: AppDatabase, userId: number): Promise<boolean> {
  for (const { tabela, coluna } of TABELAS_COM_REFERENCIA_A_USERS) {
    // user_roles é esperado ter linha (todo usuário tem papel) — não conta como
    // "histórico" que impeça exclusão física, pois é removido junto na mesma operação.
    if (tabela === 'user_roles') continue
    const row = await db.prepare(`SELECT 1 FROM ${tabela} WHERE ${coluna} = ? LIMIT 1`).bind(userId).first()
    if (row) return true
  }
  return false
}

// ===== EXCLUIR USUÁRIO (somente admin) =====
// Exclusão física quando o usuário nunca teve nenhuma ação vinculada em
// tabelas com FK para users (nenhum lançamento financeiro, núcleo/projeto
// criado, comprovante enviado, entrada de auditoria etc.) — caso contrário,
// soft-delete (excluido_em) para preservar o rastro de auditoria/prestação
// de contas, que nunca pode ser apagado silenciosamente.
auth.delete('/usuarios/:id', authMiddleware, requireRole('admin'), async (c) => {
  const actor = c.get('user')
  const targetId = Number(c.req.param('id'))

  if (targetId === actor.sub) {
    return errorResponse(c, 400, 'Você não pode excluir sua própria conta.')
  }

  const target = await c.env.DB.prepare('SELECT id, nome FROM users WHERE id = ? AND excluido_em IS NULL')
    .bind(targetId)
    .first<{ id: number; nome: string }>()
  if (!target) return errorResponse(c, 404, 'Usuário não encontrado.')

  const possuiHistorico = await usuarioPossuiHistorico(c.env.DB, targetId)

  if (possuiHistorico) {
    // Soft-delete: marca excluído, desativa login e remove os papéis (perde
    // acesso imediatamente), mas preserva a linha em `users` — necessária
    // para o histórico (quem lançou/aprovou/validou o quê) continuar íntegro.
    await c.env.DB.prepare(
      "UPDATE users SET ativo = 0, excluido_em = CURRENT_TIMESTAMP WHERE id = ?"
    )
      .bind(targetId)
      .run()
    await c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(targetId).run()

    await logAudit(c, {
      userId: actor.sub,
      acao: 'auth.usuario.excluir_logico',
      entidade: 'users',
      entidadeId: targetId,
      payload: { nome: target.nome, motivo: 'usuario_possui_historico_vinculado' }
    })

    return okResponse(c, {
      message: `${target.nome} foi removido do sistema. Como este usuário possui histórico vinculado (lançamentos, conteúdo criado ou auditoria), o registro foi mantido de forma inativa para preservar a rastreabilidade — ele não aparece mais na listagem e não pode mais fazer login.`
    })
  }

  // Exclusão física: sem nenhum histórico vinculado, pode remover de verdade.
  await c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(targetId).run()
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'auth.usuario.excluir_fisico',
    entidade: 'users',
    entidadeId: targetId,
    payload: { nome: target.nome }
  })

  return okResponse(c, { message: `${target.nome} foi excluído permanentemente.` })
})

export default auth
