import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../types/bindings'

// Permite exibir o app dentro de um iframe em origens confiáveis (ex.: o espelho
// de produção no ambiente de design). Variável EMBED_ORIGINS, separada por vírgula:
//   EMBED_ORIGINS=https://claude.ai,https://*.claudeusercontent.com
// Vazia/ausente: o app só pode ser exibido no próprio domínio (frame-ancestors 'self')
// e o cookie de sessão continua SameSite=Lax.
export const EMBED_ORIGINS = (process.env.EMBED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export const embedHabilitado = EMBED_ORIGINS.length > 0

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS'])

function hostDe(origin: string | undefined): string | null {
  if (!origin) return null
  try {
    return new URL(origin).host
  } catch {
    return null
  }
}

export const embedMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Dentro do iframe o cookie de sessão precisa ser SameSite=None, e aí o navegador
  // passa a enviá-lo também em requisições vindas de outros sites. Para não abrir
  // brecha de CSRF, toda escrita (POST/PUT/DELETE) precisa vir do próprio domínio.
  if (embedHabilitado && !METODOS_SEGUROS.has(c.req.method)) {
    const origin = c.req.header('Origin')
    if (origin) {
      const permitidos = [
        c.req.header('X-Forwarded-Host'),
        c.req.header('Host'),
        hostDe(process.env.APP_ORIGIN || 'https://nfp.social.br')
      ].filter(Boolean)
      if (!permitidos.includes(hostDe(origin) ?? '')) {
        return c.json({ ok: false, error: 'Origem não permitida.' }, 403)
      }
    }
  }

  await next()

  try {
    c.res.headers.set(
      'Content-Security-Policy',
      `frame-ancestors 'self'${embedHabilitado ? ' ' + EMBED_ORIGINS.join(' ') : ''}`
    )
  } catch {
    // respostas com headers imutáveis seguem sem o cabeçalho
  }
}
