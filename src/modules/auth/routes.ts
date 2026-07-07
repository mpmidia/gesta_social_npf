import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import type { AppEnv, Role } from '../../types/bindings'
import { hashPassword, verifyPassword } from '../../utils/crypto'
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

async function loadUserRoles(db: D1Database, userId: number): Promise<UserRoleRow[]> {
  const { results } = await db
    .prepare('SELECT role, escopo_id FROM user_roles WHERE user_id = ?')
    .bind(userId)
    .all<UserRoleRow>()
  return results ?? []
}

// ===== LOGIN (público) =====
auth.post('/login', async (c) => {
  const body = await c.req.json<{ email?: string; senha?: string }>().catch(() => ({}))
  const { email, senha } = body
  if (!email || !senha) {
    return errorResponse(c, 422, 'Informe e-mail e senha.')
  }

  const user = await c.env.DB.prepare(
    'SELECT id, nome, email, senha_hash, ativo FROM users WHERE email = ?'
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
     FROM users u ORDER BY u.created_at DESC`
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
  }>().catch(() => ({}))

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

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
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

export default auth
