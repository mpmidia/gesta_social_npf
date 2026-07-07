import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import type { AppEnv } from './types/bindings'

import authRoutes from './modules/auth/routes'
import nucleosRoutes from './modules/nucleos/routes'
import projetosRoutes from './modules/projetos/routes'
import colaboradoresRoutes from './modules/colaboradores/routes'
import financeiroRoutes from './modules/financeiro/routes'
import comunicacaoRoutes from './modules/comunicacao/routes'
import publicoRoutes from './modules/publico/routes'
import { renderPublicNucleoPage, renderPublicProjetoPage } from './views/public-pages'
import { renderLoginPage } from './views/login-page'
import { renderDashboardPage } from './views/dashboard-page'

const app = new Hono<AppEnv>()

// Arquivos estáticos (CSS/JS do frontend)
app.use('/static/*', serveStatic({ root: './public' }))

// ===== API =====
app.route('/api/auth', authRoutes)
app.route('/api/nucleos', nucleosRoutes)
app.route('/api/projetos', projetosRoutes)
app.route('/api/colaboradores', colaboradoresRoutes)
app.route('/api/financeiro', financeiroRoutes)
app.route('/api/comunicacao', comunicacaoRoutes)
app.route('/api/public', publicoRoutes)

// ===== PÁGINAS PÚBLICAS (server-rendered, sem login) =====
app.get('/n/:slug', async (c) => {
  const slug = c.req.param('slug')
  return renderPublicNucleoPage(c, slug)
})

app.get('/p/:slug', async (c) => {
  const slug = c.req.param('slug')
  return renderPublicProjetoPage(c, slug)
})

// ===== LOGIN (raiz) =====
app.get('/', (c) => renderLoginPage(c))
app.get('/login', (c) => renderLoginPage(c))

// ===== DASHBOARD (restrito — checagem de sessão feita no client-side via /api/auth/me) =====
app.get('/dashboard', (c) => renderDashboardPage(c))

export default app
