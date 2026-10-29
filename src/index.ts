import 'dotenv/config'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import type { AppEnv } from './types/bindings'
import { getDatabase } from './platform/db'
import { getStorage } from './platform/storage'
import { agendarLimpezaComprovantes } from './jobs/limpeza-comprovantes'

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

// ============================================================
// Injeção de "bindings" (env) estilo Cloudflare Workers.
//
// No Cloudflare Workers, `env` (com DB/R2/etc.) é injetado
// automaticamente pelo runtime a cada chamada de `fetch(request, env, ctx)`.
// Rodando sob @hono/node-server (Node.js puro, para a Hostinger), o
// `serve()` do node-server injeta apenas `{ incoming, outgoing }` como
// segundo argumento — não há equivalente nativo ao `env` do Workers.
//
// `c.env` no Hono é apenas um objeto mutável comum (sem getters/setters
// especiais), então o padrão idiomático é popular `c.env` via middleware,
// no topo da cadeia, antes de qualquer rota ser avaliada. As ~160 chamadas
// existentes `c.env.DB.prepare(...)` / `c.env.R2.put(...)` continuam
// funcionando sem nenhuma alteração, pois os adaptadores (platform/db.ts,
// platform/storage.ts) implementam a mesma interface dos bindings nativos.
// ============================================================
const db = getDatabase()
const r2 = getStorage()
const jwtSecret = process.env.JWT_SECRET || ''

if (!jwtSecret) {
  console.warn('[aviso] JWT_SECRET não definido no ambiente — defina-o antes de produção.')
}

app.use('*', async (c, next) => {
  c.env.DB = db
  c.env.R2 = r2
  c.env.JWT_SECRET = jwtSecret
  await next()
})

// Handler de erro global: evita que exceções não tratadas virem um 500
// "Internal Server Error" sem detalhe nenhum. Sempre loga a stack completa
// no stdout (visível via `pm2 logs`), e — apenas enquanto DEBUG_ERRORS=1
// estiver definido no ambiente — também devolve a mensagem/stack na resposta
// JSON, para diagnóstico temporário em produção sem expor isso por padrão.
app.onError((err, c) => {
  console.error('[erro-nao-tratado]', c.req.method, c.req.path, err)
  const debug = process.env.DEBUG_ERRORS === '1'
  return c.json(
    {
      ok: false,
      error: 'Ocorreu um erro inesperado.',
      ...(debug ? { debug_message: err.message, debug_stack: err.stack } : {})
    },
    500
  )
})

// Job de limpeza: remove do R2 (após o processo Node.js persistente na
// Hostinger subir) os comprovantes cujo prazo de retenção de 30 dias após
// o primeiro download já expirou. Ver src/jobs/limpeza-comprovantes.ts.
agendarLimpezaComprovantes(db, r2)

app.use('/static/*', serveStatic({ root: './public' }))

app.route('/api/auth', authRoutes)
app.route('/api/nucleos', nucleosRoutes)
app.route('/api/projetos', projetosRoutes)
app.route('/api/colaboradores', colaboradoresRoutes)
app.route('/api/financeiro', financeiroRoutes)
app.route('/api/comunicacao', comunicacaoRoutes)
app.route('/api/public', publicoRoutes)

app.get('/n/:slug', async (c) => {
  const slug = c.req.param('slug')
  return renderPublicNucleoPage(c, slug)
})

app.get('/p/:slug', async (c) => {
  const slug = c.req.param('slug')
  return renderPublicProjetoPage(c, slug)
})

app.get('/', (c) => renderLoginPage(c))
app.get('/login', (c) => renderLoginPage(c))
app.get('/dashboard', (c) => renderDashboardPage(c))

const port = Number(process.env.PORT ?? 3000)

serve(
  {
    fetch: app.fetch,
    port
  },
  (info) => {
    console.log(`Servidor rodando em http://0.0.0.0:${info.port}`)
  }
)

export default app
