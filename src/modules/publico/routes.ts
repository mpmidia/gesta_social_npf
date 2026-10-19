import { Hono } from 'hono'
import type { AppEnv } from '../../types/bindings'
import { errorResponse, okResponse } from '../../utils/response'
import { criarColaboradorPublico } from '../colaboradores/routes'

const publico = new Hono<AppEnv>()

// ===== LANDING DE NÚCLEO (dados institucionais, sem financeiro) =====
publico.get('/nucleo/:slug', async (c) => {
  const slug = c.req.param('slug')
  const nucleo = await c.env.DB.prepare(
    'SELECT id, nome, descricao, slug_publico, imagem_capa_key FROM nucleos WHERE slug_publico = ? AND ativo = 1'
  )
    .bind(slug)
    .first<any>()

  if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')

  const { results: projetos } = await c.env.DB.prepare(
    'SELECT id, nome, descricao, slug_publico, imagem_capa_key FROM projetos WHERE nucleo_id = ? AND ativo = 1'
  )
    .bind(nucleo.id)
    .all()

  const { results: destaques } = await c.env.DB.prepare(
    'SELECT * FROM destaques_publicos WHERE nucleo_id = ? AND ativo = 1 ORDER BY created_at DESC'
  )
    .bind(nucleo.id)
    .all()

  return okResponse(c, { ...nucleo, projetos, destaques })
})

// ===== LANDING DE PROJETO =====
publico.get('/projeto/:slug', async (c) => {
  const slug = c.req.param('slug')
  const projeto = await c.env.DB.prepare(
    `SELECT p.id, p.nome, p.descricao, p.slug_publico, p.imagem_capa_key, n.nome as nucleo_nome, n.slug_publico as nucleo_slug
     FROM projetos p JOIN nucleos n ON n.id = p.nucleo_id
     WHERE p.slug_publico = ? AND p.ativo = 1`
  )
    .bind(slug)
    .first<any>()

  if (!projeto) return errorResponse(c, 404, 'Projeto não encontrado.')

  const { results: galeria } = await c.env.DB.prepare(
    'SELECT id, legenda, ordem FROM projeto_galeria WHERE projeto_id = ? ORDER BY ordem ASC'
  )
    .bind(projeto.id)
    .all()

  const { results: destaques } = await c.env.DB.prepare(
    'SELECT * FROM destaques_publicos WHERE projeto_id = ? AND ativo = 1 ORDER BY created_at DESC'
  )
    .bind(projeto.id)
    .all()

  return okResponse(c, { ...projeto, galeria, destaques })
})

// ===== IMAGEM PÚBLICA DA GALERIA (sem autenticação) =====
publico.get('/galeria/:imageId/arquivo', async (c) => {
  const imageId = Number(c.req.param('imageId'))
  const img = await c.env.DB.prepare('SELECT r2_key FROM projeto_galeria WHERE id = ?')
    .bind(imageId)
    .first<{ r2_key: string }>()

  if (!img) return errorResponse(c, 404, 'Imagem não encontrada.')

  const object = await c.env.R2.get(img.r2_key)
  if (!object) return errorResponse(c, 404, 'Arquivo não encontrado.')

  return new Response(object.body, {
    headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream' }
  })
})

// ===== FORMULÁRIO PÚBLICO DE COLABORADOR (sem login) =====
publico.post('/colaborador', async (c) => {
  const body = await c.req.json<{
    nucleo_slug?: string
    projeto_slug?: string
    nome?: string
    cpf?: string
    whatsapp?: string
    status_portal_fazenda?: string
  }>().catch(() => ({} as any))

  const { nucleo_slug, projeto_slug, nome, cpf, whatsapp, status_portal_fazenda } = body

  if (!nome || !cpf || !whatsapp || !status_portal_fazenda) {
    return errorResponse(c, 422, 'Preencha nome, CPF, WhatsApp e status no portal da Fazenda.')
  }
  if (!nucleo_slug && !projeto_slug) {
    return errorResponse(c, 422, 'Informe o núcleo ou projeto de origem do formulário.')
  }

  let nucleo_id: number | undefined
  let projeto_id: number | undefined

  if (projeto_slug) {
    const projeto = await c.env.DB.prepare('SELECT id, nucleo_id FROM projetos WHERE slug_publico = ?')
      .bind(projeto_slug)
      .first<{ id: number; nucleo_id: number }>()
    if (!projeto) return errorResponse(c, 404, 'Projeto não encontrado.')
    projeto_id = projeto.id
    nucleo_id = projeto.nucleo_id
  } else if (nucleo_slug) {
    const nucleo = await c.env.DB.prepare('SELECT id FROM nucleos WHERE slug_publico = ?')
      .bind(nucleo_slug)
      .first<{ id: number }>()
    if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')
    nucleo_id = nucleo.id
  }

  try {
    const id = await criarColaboradorPublico(c.env.DB, {
      nucleo_id,
      projeto_id,
      nome,
      cpf,
      whatsapp,
      status_portal_fazenda
    })
    return okResponse(c, { id, message: 'Cadastro realizado com sucesso! Em breve entraremos em contato.' }, 201)
  } catch (err: any) {
    return errorResponse(c, 422, err.message || 'Erro ao processar o cadastro.')
  }
})

export default publico
