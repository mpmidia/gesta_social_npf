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

// ===== MEUS DADOS (qualquer usuário autenticado — consulta própria) =====
// Retorna os dados completos do próprio usuário (nome, email, dados
// bancários/PIX), usados para a tela de "Meu Perfil" (autosserviço).
// Diferente de GET /me (que só devolve o payload do JWT), esta rota
// consulta a tabela `users` para trazer os campos bancários também.
auth.get('/me/perfil', authMiddleware, async (c) => {
  const actor = c.get('user')
  const row = await c.env.DB.prepare(
    `SELECT id, nome, email, banco, agencia, conta, tipo_conta, pix_chave, created_at
     FROM users WHERE id = ? AND excluido_em IS NULL`
  )
    .bind(actor.sub)
    .first()
  if (!row) return errorResponse(c, 404, 'Usuário não encontrado.')
  return okResponse(c, row)
})

// ===== EDITAR MEUS DADOS (qualquer usuário autenticado) =====
// Permite que o próprio usuário atualize nome, e-mail e dados
// bancários/PIX (usados pelo financeiro para saber onde depositar um
// repasse). NÃO permite alterar papel/escopo (role/nucleo_id) — isso
// continua exclusivo do admin via PUT /usuarios/:id. Troca de senha
// tem rota própria (POST /me/senha), que exige a senha atual.
auth.put('/me', authMiddleware, async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{
    nome?: string
    email?: string
    banco?: string | null
    agencia?: string | null
    conta?: string | null
    tipo_conta?: string | null
    pix_chave?: string | null
  }>().catch(() => ({} as any))

  const { nome, email, banco, agencia, conta, tipo_conta, pix_chave } = body

  const target = await c.env.DB.prepare('SELECT id, nome FROM users WHERE id = ? AND excluido_em IS NULL')
    .bind(actor.sub)
    .first<{ id: number; nome: string }>()
  if (!target) return errorResponse(c, 404, 'Usuário não encontrado.')

  if (nome !== undefined && !nome.trim()) {
    return errorResponse(c, 422, 'Nome não pode ser vazio.')
  }

  if (email !== undefined) {
    if (!email.trim()) return errorResponse(c, 422, 'E-mail não pode ser vazio.')
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ? AND excluido_em IS NULL')
      .bind(email.toLowerCase().trim(), actor.sub)
      .first()
    if (existing) return errorResponse(c, 409, 'Já existe outro usuário com este e-mail.')
  }

  const validTiposConta = ['corrente', 'poupanca', null, undefined]
  if (tipo_conta !== undefined && tipo_conta !== null && !['corrente', 'poupanca'].includes(tipo_conta)) {
    return errorResponse(c, 422, "tipo_conta deve ser 'corrente' ou 'poupanca'.")
  }

  await c.env.DB.prepare(
    `UPDATE users SET
       nome = COALESCE(?, nome),
       email = COALESCE(?, email),
       banco = ?,
       agencia = ?,
       conta = ?,
       tipo_conta = ?,
       pix_chave = ?
     WHERE id = ?`
  )
    .bind(
      nome?.trim() ?? null,
      email ? email.toLowerCase().trim() : null,
      banco !== undefined ? (banco?.trim() || null) : null,
      agencia !== undefined ? (agencia?.trim() || null) : null,
      conta !== undefined ? (conta?.trim() || null) : null,
      tipo_conta !== undefined ? (tipo_conta || null) : null,
      pix_chave !== undefined ? (pix_chave?.trim() || null) : null,
      actor.sub
    )
    .run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'auth.me.editar',
    entidade: 'users',
    entidadeId: actor.sub,
    payload: { nome, email, banco, agencia, conta, tipo_conta, pix_chave_informada: !!pix_chave }
  })

  const atualizado = await c.env.DB.prepare(
    `SELECT id, nome, email, banco, agencia, conta, tipo_conta, pix_chave FROM users WHERE id = ?`
  )
    .bind(actor.sub)
    .first()

  return okResponse(c, atualizado)
})

// ===== TROCAR MINHA SENHA (qualquer usuário autenticado) =====
// Diferente do reset feito pelo admin (que não exige a senha atual),
// aqui o próprio usuário precisa confirmar a senha atual antes de
// definir uma nova — ação sensível sempre auditada.
auth.post('/me/senha', authMiddleware, async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ senha_atual?: string; nova_senha?: string }>().catch(() => ({} as any))
  const { senha_atual, nova_senha } = body

  if (!senha_atual || !nova_senha) {
    return errorResponse(c, 422, 'Informe a senha atual e a nova senha.')
  }
  if (nova_senha.length < 6) {
    return errorResponse(c, 422, 'A nova senha deve ter ao menos 6 caracteres.')
  }

  const target = await c.env.DB.prepare('SELECT id, senha_hash FROM users WHERE id = ? AND excluido_em IS NULL')
    .bind(actor.sub)
    .first<{ id: number; senha_hash: string }>()
  if (!target) return errorResponse(c, 404, 'Usuário não encontrado.')

  const senhaOk = await verifyPassword(senha_atual, target.senha_hash)
  if (!senhaOk) return errorResponse(c, 401, 'Senha atual incorreta.')

  const novoHash = await hashPassword(nova_senha)
  await c.env.DB.prepare('UPDATE users SET senha_hash = ? WHERE id = ?').bind(novoHash, actor.sub).run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'auth.me.trocar_senha',
    entidade: 'users',
    entidadeId: actor.sub
    // Nunca gravar a senha (nem hash) no payload de auditoria.
  })

  return okResponse(c, { message: 'Senha alterada com sucesso.' })
})

// ===== LISTAR USUÁRIOS (somente admin) =====
// Usuários & Permissões é uma tela EXCLUSIVA do Administrador — nenhum outro
// papel enxerga ou gerencia outros usuários (nem Coordenador Geral).
auth.get('/usuarios', authMiddleware, requireRole('admin'), async (c) => {
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

// ===== CRIAR USUÁRIO COM PAPEL (somente admin) =====
// Cada usuário possui exatamente UM papel (user_roles.user_id tem UNIQUE KEY —
// ver migration 0007). Não existe mais o conceito de "múltiplos papéis" por
// usuário: trocar de papel sempre substitui o anterior (ver PUT abaixo).
auth.post('/usuarios', authMiddleware, requireRole('admin'), async (c) => {
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

  const validRoles: Role[] = ['admin', 'coord_geral', 'coord_nucleo', 'articulador', 'financeiro']
  if (!validRoles.includes(role)) {
    return errorResponse(c, 422, 'Papel inválido.')
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
// Como cada usuário tem exatamente UM papel (user_roles.user_id é UNIQUE),
// promover a admin SUBSTITUI o papel atual do usuário pelo papel 'admin'
// (não soma um papel extra — não existe mais "acumular papéis").
auth.post('/usuarios/:id/promover-admin', authMiddleware, requireRole('admin'), async (c) => {
  const actor = c.get('user')
  const targetId = Number(c.req.param('id'))

  const target = await c.env.DB.prepare('SELECT id, nome FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ id: number; nome: string }>()

  if (!target) {
    return errorResponse(c, 404, 'Usuário não encontrado.')
  }

  const targetRoles = await loadUserRoles(c.env.DB, targetId)
  if (targetRoles.some((r) => r.role === 'admin')) {
    return errorResponse(c, 409, 'Usuário já é administrador.')
  }

  await c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(targetId).run()
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
    payload: { promovido: target.nome, por: actor.nome, papelAnterior: targetRoles[0]?.role ?? null }
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

// ===== EDITAR USUÁRIO (somente admin) =====
// Permite alterar nome, e-mail e o papel/escopo (núcleo) do usuário. Cada
// usuário tem exatamente UM papel — atribuir um novo papel sempre SUBSTITUI
// o anterior (nunca acumula). A troca de senha tem rota própria
// (/usuarios/:id/resetar-senha), para manter uma ação sensível isolada e
// sempre auditada separadamente.
auth.put('/usuarios/:id', authMiddleware, requireRole('admin'), async (c) => {
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
    const validRoles: Role[] = ['admin', 'coord_geral', 'coord_nucleo', 'articulador', 'financeiro']
    if (!validRoles.includes(role)) return errorResponse(c, 422, 'Papel inválido.')
    if (role === 'coord_nucleo' && !nucleo_id) {
      return errorResponse(c, 422, 'Para o papel coord_nucleo é obrigatório informar nucleo_id.')
    }
    if (targetId === actor.sub && role !== 'admin') {
      return errorResponse(c, 400, 'Você não pode remover seu próprio papel de administrador.')
    }

    // Substitui o único papel do usuário pelo novo (user_roles.user_id é UNIQUE).
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
  { tabela: 'financeiro_importacoes_nfp', coluna: 'importado_por' },
  { tabela: 'financeiro_faturas', coluna: 'gerado_por' },
  { tabela: 'nucleos', coluna: 'arquivado_por' },
  { tabela: 'projetos', coluna: 'arquivado_por' },
  { tabela: 'comprovantes', coluna: 'arquivado_por' }
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
