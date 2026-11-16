import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { AppEnv, JwtPayload } from '../../types/bindings'
import { verifyToken, COOKIE_NAME } from '../../utils/jwt'
import { baseLayout } from '../../views/layout'
import { logAudit } from '../../middlewares/audit'

// Visualização SOMENTE LEITURA do banco de produção, para conferência pelo
// Administrador (inclusive dentro do espelho de produção). Só executa SELECT;
// a única escrita é o registro de acesso no audit_log. Colunas sensíveis são omitidas.
const banco = new Hono<AppEnv>()

const POR_PAGINA = 50
const COLUNAS_OCULTAS = new Set(['senha_hash'])

function esc(v: unknown): string {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function celula(v: unknown): string {
  if (v === null || v === undefined) return '<span class="text-gray-300">NULL</span>'
  const texto = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return `<span title="${esc(texto)}">${esc(texto.length > 80 ? texto.slice(0, 80) + '…' : texto)}</span>`
}

banco.get('/', async (c) => {
  const token = getCookie(c, COOKIE_NAME)
  let user: JwtPayload | null = null
  try {
    user = token ? await verifyToken(token, c.env.JWT_SECRET) : null
  } catch {
    user = null
  }
  if (!user) return c.redirect('/login')
  if (!user.roles?.some((r) => r.role === 'admin')) {
    return c.html(
      baseLayout({ title: 'Banco', bodyContent: '<div class="p-8 text-gray-700">Acesso restrito ao Administrador.</div>' }),
      403
    )
  }

  const { results: objetos } = await c.env.DB.prepare(
    `SELECT TABLE_NAME AS nome, TABLE_TYPE AS tipo FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_TYPE, TABLE_NAME`
  ).all<{ nome: string; tipo: string }>()

  // O nome da tabela vem do information_schema (nunca da URL), então é seguro no SQL.
  const ident = (nome: string) => '`' + nome.replace(/`/g, '``') + '`'

  const tabelas = await Promise.all(
    objetos.map(async (o) => {
      const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${ident(o.nome)}`).first<{ n: number }>()
      return { nome: o.nome, view: o.tipo === 'VIEW', n: Number(r?.n ?? 0) }
    })
  )

  const atual = tabelas.find((t) => t.nome === c.req.query('t'))
  const totalPaginas = atual ? Math.max(1, Math.ceil(atual.n / POR_PAGINA)) : 1
  const pagina = Math.min(totalPaginas, Math.max(1, Number(c.req.query('p')) || 1))

  let conteudo = '<p class="text-sm text-gray-500">Selecione uma tabela à esquerda.</p>'

  if (atual) {
    const { results: linhas } = await c.env.DB.prepare(
      `SELECT * FROM ${ident(atual.nome)} ORDER BY 1 DESC LIMIT ${POR_PAGINA} OFFSET ${(pagina - 1) * POR_PAGINA}`
    ).all<Record<string, unknown>>()

    const colunas = linhas.length ? Object.keys(linhas[0]).filter((k) => !COLUNAS_OCULTAS.has(k)) : []
    const link = (p: number, rotulo: string, ativo: boolean) =>
      ativo
        ? `<a href="?t=${encodeURIComponent(atual.nome)}&p=${p}" class="px-2 py-1 rounded border bg-white hover:bg-gray-50">${rotulo}</a>`
        : `<span class="px-2 py-1 rounded border text-gray-300">${rotulo}</span>`

    conteudo = `
      <div class="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h2 class="text-lg font-bold text-gray-800">${esc(atual.nome)}${atual.view ? ' <span class="text-xs font-medium text-gray-400">view</span>' : ''}</h2>
          <p class="text-xs text-gray-500">${atual.n} registro(s) · página ${pagina} de ${totalPaginas} · mais recentes primeiro</p>
        </div>
        <div class="flex items-center gap-2 text-sm">
          ${link(pagina - 1, 'Anterior', pagina > 1)}
          ${link(pagina + 1, 'Próxima', pagina < totalPaginas)}
        </div>
      </div>
      ${
        linhas.length
          ? `<div class="bg-white rounded-xl border shadow-soft overflow-auto">
              <table class="min-w-full text-xs">
                <thead class="bg-gray-50 text-gray-500"><tr>${colunas
                  .map((k) => `<th class="text-left font-semibold px-3 py-2 whitespace-nowrap">${esc(k)}</th>`)
                  .join('')}</tr></thead>
                <tbody class="divide-y">${linhas
                  .map(
                    (l) =>
                      `<tr class="hover:bg-gray-50">${colunas
                        .map((k) => `<td class="px-3 py-2 whitespace-nowrap text-gray-700">${celula(l[k])}</td>`)
                        .join('')}</tr>`
                  )
                  .join('')}</tbody>
              </table>
            </div>`
          : '<p class="text-sm text-gray-500">Sem registros.</p>'
      }`

    await logAudit(c as any, { userId: user.sub, acao: 'diag.banco.ver', entidade: atual.nome, payload: { pagina } })
  }

  const menu = tabelas
    .map((t) => {
      const ativo = atual?.nome === t.nome
      return `<a href="?t=${encodeURIComponent(t.nome)}" class="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg ${
        ativo ? 'bg-brand-50 text-brand-700 font-semibold' : 'text-gray-700 hover:bg-gray-50'
      }"><span class="truncate">${esc(t.nome)}${t.view ? ' <span class="text-[10px] text-gray-400">view</span>' : ''}</span><span class="text-gray-400 tabular-nums">${t.n}</span></a>`
    })
    .join('')

  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })

  return c.html(
    baseLayout({
      title: 'Banco (somente leitura)',
      bodyContent: `
      <div class="flex h-screen overflow-hidden">
        <aside class="w-64 shrink-0 bg-white border-r flex flex-col">
          <div class="px-4 py-4 border-b">
            <p class="font-bold text-gray-800">Banco de dados</p>
            <p class="text-xs text-gray-500">Somente leitura · ${esc(agora)}</p>
          </div>
          <nav class="flex-1 overflow-y-auto p-2 text-sm space-y-0.5">${menu}</nav>
          <div class="p-3 border-t text-xs"><a href="/dashboard" class="text-brand-600 hover:text-brand-700">← Voltar ao painel</a></div>
        </aside>
        <main class="flex-1 overflow-auto p-6">${conteudo}</main>
      </div>`
    })
  )
})

export default banco
