import { Hono } from 'hono'
import type { AppEnv } from '../../types/bindings'
import type { AppDatabase } from '../../platform/db'
import type { AppBucket } from '../../platform/storage'
import { errorResponse, okResponse, isFormDataFile } from '../../utils/response'
import { generateRandomKey } from '../../utils/crypto'
import { parseCreditosNFP } from '../../utils/csv-nfp'
import { logAudit } from '../../middlewares/audit'
import { authMiddleware } from '../../middlewares/auth'
import { requireRole, isGlobalUser, getScopedNucleoIds, isAdmin } from '../../middlewares/rbac'

const financeiro = new Hono<AppEnv>()

financeiro.use('*', authMiddleware)

// Acesso aos painéis financeiros de Núcleo/Projeto: admin, coord_geral e o coord_nucleo
// do respectivo escopo. Articulador NUNCA tem acesso financeiro (isGlobalUser não o inclui
// e ele nunca possui escopo coord_nucleo) — bloqueado por definição.
async function userCanAccessNucleo(user: any, nucleoId: number): Promise<boolean> {
  if (isGlobalUser(user)) return true
  return getScopedNucleoIds(user).includes(nucleoId)
}

// Gestão de saídas no Projeto: admin OU coord_nucleo do núcleo dono do projeto.
// Coord_geral e Articulador NÃO lançam saídas (apenas o Coordenador de Núcleo gere os recursos do dia a dia).
function userCanManageSaidaProjeto(user: any, nucleoId: number): boolean {
  if (isAdmin(user)) return true
  return user.roles?.some((r: any) => r.role === 'coord_nucleo' && r.escopo_id === nucleoId)
}

async function getNucleoIdFromProjeto(db: AppDatabase, projetoId: number): Promise<number | null> {
  const row = await db.prepare('SELECT nucleo_id FROM projetos WHERE id = ?').bind(projetoId).first<{ nucleo_id: number }>()
  return row?.nucleo_id ?? null
}

async function uploadComprovanteFile(
  r2: AppBucket,
  lancamentoId: number,
  tipo: 'bancario' | 'fiscal',
  file: File
): Promise<string> {
  const key = `comprovantes/${lancamentoId}/${tipo}/${generateRandomKey()}-${file.name}`
  await r2.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } })
  return key
}

// ================= PAINEL GERAL =================
//
// O Painel Geral NÃO recebe mais lançamentos manuais de entrada — a única
// forma de lançar entrada no Geral é importando a planilha de créditos
// exportada do site da Nota Fiscal Paulista (ver rota /geral/importar-nfp
// abaixo). Isso garante que todo valor lançado no Geral tenha lastro
// rastreável no arquivo oficial da NFP (CNPJ, nota fiscal, data), em vez
// de um valor digitado manualmente sem comprovação.

// Importação da planilha de créditos NFP (admin, coord_geral) — cada linha
// elegível (Créditos > 0 e Situação != "A Calcular") vira um lançamento de
// entrada no Painel Geral. Deduplicação pelo hash de todos os campos da
// linha, para permitir reimportar o mesmo arquivo atualizado mês a mês
// sem duplicar lançamentos já processados.
financeiro.post('/geral/importar-nfp', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')

  const formData = await c.req.formData().catch(() => null)
  if (!formData) return errorResponse(c, 422, 'Envie o arquivo via multipart/form-data.')

  const arquivo = formData.get('arquivo')
  if (!isFormDataFile(arquivo)) {
    return errorResponse(c, 422, 'Envie o arquivo CSV exportado do site da Nota Fiscal Paulista (campo "arquivo").')
  }

  const nomeArquivo = arquivo.name
  const extensaoValida = /\.(csv|txt)$/i.test(nomeArquivo)
  if (!extensaoValida) {
    return errorResponse(
      c,
      422,
      'Formato de arquivo não suportado. Exporte a planilha do site da NFP em formato CSV (Consulta de Créditos → Exportar) e envie o arquivo .csv.'
    )
  }

  const conteudo = await arquivo.text()
  const resultado = await parseCreditosNFP(conteudo)

  if (resultado.erroFormato) {
    return errorResponse(c, 422, resultado.erroFormato)
  }

  if (resultado.linhasElegiveis.length === 0) {
    // Ainda registra a importação (com zero linhas novas) para ficar no histórico,
    // mesmo quando o arquivo só contém notas "A Calcular"/zeradas.
    const importRow = await c.env.DB.prepare(
      `INSERT INTO financeiro_importacoes_nfp
       (nome_arquivo, total_linhas_arquivo, linhas_elegiveis, linhas_novas, linhas_duplicadas, linhas_ignoradas_zero_ou_a_calcular, valor_total_importado, importado_por)
       VALUES (?, ?, 0, 0, 0, ?, 0, ?)`
    )
      .bind(nomeArquivo, resultado.totalLinhasArquivo, resultado.linhasIgnoradasZeroOuACalcular, actor.sub)
      .run()

    await logAudit(c, {
      userId: actor.sub,
      acao: 'financeiro.importar_nfp',
      entidade: 'financeiro_importacoes_nfp',
      entidadeId: importRow.meta.last_row_id as number,
      payload: { nomeArquivo, totalLinhasArquivo: resultado.totalLinhasArquivo, linhasNovas: 0 }
    })

    return okResponse(c, {
      totalLinhasArquivo: resultado.totalLinhasArquivo,
      linhasElegiveis: 0,
      linhasNovas: 0,
      linhasDuplicadas: 0,
      linhasIgnoradas: resultado.linhasIgnoradasZeroOuACalcular,
      valorTotalImportado: 0,
      mensagem: 'Nenhuma linha elegível encontrada no arquivo (todas estavam zeradas ou com situação "A Calcular").'
    })
  }

  // Verifica quais hashes já existem (já importados anteriormente) numa única query.
  const hashes = resultado.linhasElegiveis.map((l) => l.linhaHash)
  const placeholders = hashes.map(() => '?').join(',')
  const { results: existentes } = await c.env.DB.prepare(
    `SELECT linha_hash FROM financeiro_creditos_nfp WHERE linha_hash IN (${placeholders})`
  )
    .bind(...hashes)
    .all<{ linha_hash: string }>()
  const hashesExistentes = new Set((existentes ?? []).map((r) => r.linha_hash))

  const linhasNovas = resultado.linhasElegiveis.filter((l) => !hashesExistentes.has(l.linhaHash))
  const linhasDuplicadas = resultado.linhasElegiveis.length - linhasNovas.length
  const valorTotal = linhasNovas.reduce((acc, l) => acc + l.creditos, 0)

  // 1) Cria o registro da importação primeiro (precisamos do id para vincular os créditos).
  const importRow = await c.env.DB.prepare(
    `INSERT INTO financeiro_importacoes_nfp
     (nome_arquivo, total_linhas_arquivo, linhas_elegiveis, linhas_novas, linhas_duplicadas, linhas_ignoradas_zero_ou_a_calcular, valor_total_importado, importado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      nomeArquivo,
      resultado.totalLinhasArquivo,
      resultado.linhasElegiveis.length,
      linhasNovas.length,
      linhasDuplicadas,
      resultado.linhasIgnoradasZeroOuACalcular,
      valorTotal,
      actor.sub
    )
    .run()
  const importacaoId = importRow.meta.last_row_id as number

  // 2) Para cada linha nova: insere um lançamento 'entrada_nfp' no Geral +
  // o registro de crédito vinculado, de forma atômica por linha (evita
  // lançamento financeiro "órfão" sem o registro de dedup correspondente).
  for (const linha of linhasNovas) {
    const finalidade = `NFP — ${linha.emitente} (CNPJ ${linha.cnpjEmitente}, NF ${linha.numeroNf}, emissão ${linha.dataEmissao})`

    const insertLancamento = await c.env.DB.prepare(
      `INSERT INTO financeiro_lancamentos (nivel, tipo, valor, status, finalidade, solicitado_por, executado_por, executado_em)
       VALUES ('geral', 'entrada_nfp', ?, 'executado', ?, ?, ?, CURRENT_TIMESTAMP)`
    )
      .bind(linha.creditos, finalidade, actor.sub, actor.sub)
      .run()
    const lancamentoId = insertLancamento.meta.last_row_id as number

    try {
      await c.env.DB.prepare(
        `INSERT INTO financeiro_creditos_nfp
         (linha_hash, cnpj_emitente, emitente, numero_nf, data_emissao, valor_nf, data_registro, creditos, situacao_credito, lancamento_id, importacao_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          linha.linhaHash,
          linha.cnpjEmitente,
          linha.emitente,
          linha.numeroNf,
          linha.dataEmissao,
          linha.valorNf,
          linha.dataRegistro,
          linha.creditos,
          linha.situacaoCredito,
          lancamentoId,
          importacaoId
        )
        .run()
    } catch (err: any) {
      // Proteção contra condição de corrida: se outra importação concorrente
      // inseriu o mesmo linha_hash entre a checagem de duplicidade acima e
      // este INSERT, a UNIQUE KEY rejeita — desfazemos o lançamento órfão
      // que acabamos de criar para não deixar um registro financeiro sem
      // o vínculo de dedup correspondente.
      await c.env.DB.prepare('DELETE FROM financeiro_lancamentos WHERE id = ?').bind(lancamentoId).run()
      if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) {
        continue
      }
      throw err
    }
  }

  await logAudit(c, {
    userId: actor.sub,
    acao: 'financeiro.importar_nfp',
    entidade: 'financeiro_importacoes_nfp',
    entidadeId: importacaoId,
    payload: {
      nomeArquivo,
      totalLinhasArquivo: resultado.totalLinhasArquivo,
      linhasNovas: linhasNovas.length,
      linhasDuplicadas,
      valorTotal
    }
  })

  return okResponse(c, {
    totalLinhasArquivo: resultado.totalLinhasArquivo,
    linhasElegiveis: resultado.linhasElegiveis.length,
    linhasNovas: linhasNovas.length,
    linhasDuplicadas,
    linhasIgnoradas: resultado.linhasIgnoradasZeroOuACalcular,
    valorTotalImportado: valorTotal
  }, 201)
})

// Histórico de importações realizadas (admin, coord_geral)
financeiro.get('/geral/importacoes', requireRole('admin', 'coord_geral'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT i.*, u.nome AS importado_por_nome
     FROM financeiro_importacoes_nfp i
     JOIN users u ON u.id = i.importado_por
     ORDER BY i.created_at DESC`
  ).all()
  return okResponse(c, results)
})

financeiro.get('/geral/saldo', requireRole('admin', 'coord_geral'), async (c) => {
  const row = await c.env.DB.prepare('SELECT saldo FROM saldo_geral').first<{ saldo: number }>()
  return okResponse(c, { saldo: row?.saldo ?? 0 })
})

financeiro.get('/geral/lancamentos', requireRole('admin', 'coord_geral'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM financeiro_lancamentos WHERE nivel = 'geral' ORDER BY created_at DESC`
  ).all()
  return okResponse(c, results)
})

// ================= PAINEL DO NÚCLEO =================

financeiro.get('/nucleo/:nucleoId/saldo', async (c) => {
  const actor = c.get('user')
  const nucleoId = Number(c.req.param('nucleoId'))
  if (!(await userCanAccessNucleo(actor, nucleoId))) return errorResponse(c, 403, 'Sem acesso a este núcleo.')

  const row = await c.env.DB.prepare('SELECT saldo FROM saldo_nucleo WHERE nucleo_id = ?')
    .bind(nucleoId)
    .first<{ saldo: number }>()
  return okResponse(c, { saldo: row?.saldo ?? 0 })
})

financeiro.get('/nucleo/:nucleoId/lancamentos', async (c) => {
  const actor = c.get('user')
  const nucleoId = Number(c.req.param('nucleoId'))
  if (!(await userCanAccessNucleo(actor, nucleoId))) return errorResponse(c, 403, 'Sem acesso a este núcleo.')

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM financeiro_lancamentos WHERE nucleo_id = ? ORDER BY created_at DESC`
  )
    .bind(nucleoId)
    .all()
  return okResponse(c, results)
})

// ================= PAINEL DO PROJETO =================

financeiro.get('/projeto/:projetoId/saldo', async (c) => {
  const actor = c.get('user')
  const projetoId = Number(c.req.param('projetoId'))
  const nucleoId = await getNucleoIdFromProjeto(c.env.DB, projetoId)
  if (!nucleoId) return errorResponse(c, 404, 'Projeto não encontrado.')
  if (!(await userCanAccessNucleo(actor, nucleoId))) return errorResponse(c, 403, 'Sem acesso a este projeto.')

  const row = await c.env.DB.prepare('SELECT saldo FROM saldo_projeto WHERE projeto_id = ?')
    .bind(projetoId)
    .first<{ saldo: number }>()
  return okResponse(c, { saldo: row?.saldo ?? 0 })
})

financeiro.get('/projeto/:projetoId/lancamentos', async (c) => {
  const actor = c.get('user')
  const projetoId = Number(c.req.param('projetoId'))
  const nucleoId = await getNucleoIdFromProjeto(c.env.DB, projetoId)
  if (!nucleoId) return errorResponse(c, 404, 'Projeto não encontrado.')
  if (!(await userCanAccessNucleo(actor, nucleoId))) return errorResponse(c, 403, 'Sem acesso a este projeto.')

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM financeiro_lancamentos WHERE projeto_id = ? ORDER BY created_at DESC`
  )
    .bind(projetoId)
    .all()
  return okResponse(c, results)
})

// Saída de pagamento no Projeto — Admin OU Coordenador de Núcleo (do núcleo dono do projeto),
// com comprovante bancário E fiscal obrigatórios. O Coordenador de Núcleo é quem faz a gestão
// diária dos recursos do seu núcleo/projetos, por isso também pode lançar saídas.
financeiro.post('/projeto/:projetoId/saidas', requireRole('admin', 'coord_nucleo'), async (c) => {
  const actor = c.get('user')
  const projetoId = Number(c.req.param('projetoId'))

  const projeto = await c.env.DB.prepare('SELECT id, nucleo_id FROM projetos WHERE id = ?').bind(projetoId).first<any>()
  if (!projeto) return errorResponse(c, 404, 'Projeto não encontrado.')

  if (!userCanManageSaidaProjeto(actor, projeto.nucleo_id)) {
    return errorResponse(c, 403, 'Apenas o Administrador ou o Coordenador do Núcleo responsável podem lançar saídas neste projeto.')
  }

  const formData = await c.req.formData().catch(() => null)
  if (!formData) return errorResponse(c, 422, 'Envie os dados via multipart/form-data.')

  const valorRaw = formData.get('valor')?.toString()
  const finalidade = formData.get('finalidade')?.toString()
  const comprovanteBancario = formData.get('comprovante_bancario')
  const comprovanteFiscal = formData.get('comprovante_fiscal')

  const valor = valorRaw ? parseFloat(valorRaw) : NaN

  if (!valor || valor <= 0) return errorResponse(c, 422, 'Informe um valor positivo.')
  if (!finalidade) return errorResponse(c, 422, 'Informe a finalidade/prestação de contas do pagamento.')
  if (!isFormDataFile(comprovanteBancario)) {
    return errorResponse(c, 422, 'Comprovante bancário é obrigatório para toda saída financeira.')
  }
  if (!isFormDataFile(comprovanteFiscal)) {
    return errorResponse(c, 422, 'Comprovante fiscal é obrigatório para toda saída financeira.')
  }

  // Verifica saldo suficiente no projeto antes de executar a saída
  const saldoRow = await c.env.DB.prepare('SELECT saldo FROM saldo_projeto WHERE projeto_id = ?')
    .bind(projetoId)
    .first<{ saldo: number }>()
  const saldoAtual = saldoRow?.saldo ?? 0
  if (valor > saldoAtual) {
    return errorResponse(c, 422, `Saldo insuficiente no projeto. Saldo atual: R$ ${saldoAtual.toFixed(2)}.`)
  }

  // 1) Insere o lançamento (executado diretamente, pois só admin lança e já com comprovantes em mãos)
  const insertLancamento = await c.env.DB.prepare(
    `INSERT INTO financeiro_lancamentos (nivel, projeto_id, nucleo_id, tipo, valor, status, finalidade, executado_por, executado_em)
     VALUES ('projeto', ?, ?, 'saida_pagamento', ?, 'executado', ?, ?, CURRENT_TIMESTAMP)`
  )
    .bind(projetoId, projeto.nucleo_id, valor, finalidade, actor.sub)
    .run()

  const lancamentoId = insertLancamento.meta.last_row_id as number

  // 2) Upload dos arquivos para R2 (fora da transação D1, mas obrigatórios antes de finalizar)
  const bancarioKey = await uploadComprovanteFile(c.env.R2, lancamentoId, 'bancario', comprovanteBancario)
  const fiscalKey = await uploadComprovanteFile(c.env.R2, lancamentoId, 'fiscal', comprovanteFiscal)

  // 3) Insere os dois comprovantes atomicamente via batch
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO comprovantes (lancamento_id, tipo, r2_key, nome_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?)'
    ).bind(lancamentoId, 'bancario', bancarioKey, comprovanteBancario.name, actor.sub),
    c.env.DB.prepare(
      'INSERT INTO comprovantes (lancamento_id, tipo, r2_key, nome_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?)'
    ).bind(lancamentoId, 'fiscal', fiscalKey, comprovanteFiscal.name, actor.sub)
  ])

  await logAudit(c, {
    userId: actor.sub,
    acao: 'financeiro.saida_pagamento.executar',
    entidade: 'financeiro_lancamentos',
    entidadeId: lancamentoId,
    payload: { projetoId, valor, finalidade }
  })

  return okResponse(c, { id: lancamentoId, valor, status: 'executado' }, 201)
})

// ================= REPASSES: SOLICITAÇÃO / APROVAÇÃO / EXECUÇÃO =================

// Solicitar repasse Geral -> Núcleo (admin, coord_geral)
financeiro.post('/repasses/geral-nucleo', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ nucleo_id?: number; valor?: number; finalidade?: string }>().catch(() => ({} as any))
  const { nucleo_id, valor, finalidade } = body

  if (!nucleo_id || !valor || valor <= 0) return errorResponse(c, 422, 'Informe nucleo_id e valor positivo.')

  const nucleo = await c.env.DB.prepare('SELECT id FROM nucleos WHERE id = ?').bind(nucleo_id).first()
  if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')

  const saldoGeral = await c.env.DB.prepare('SELECT saldo FROM saldo_geral').first<{ saldo: number }>()
  if ((saldoGeral?.saldo ?? 0) < valor) {
    return errorResponse(c, 422, `Saldo geral insuficiente. Saldo atual: R$ ${(saldoGeral?.saldo ?? 0).toFixed(2)}.`)
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO financeiro_lancamentos (nivel, nucleo_id, tipo, valor, status, finalidade, solicitado_por)
     VALUES ('nucleo', ?, 'repasse_geral_nucleo', ?, 'pendente', ?, ?)`
  )
    .bind(nucleo_id, valor, finalidade ?? null, actor.sub)
    .run()

  const id = result.meta.last_row_id as number
  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse_geral_nucleo.solicitar', entidade: 'financeiro_lancamentos', entidadeId: id, payload: { nucleo_id, valor } })

  return okResponse(c, { id, status: 'pendente' }, 201)
})

// Solicitar repasse Núcleo -> Projeto (coord_nucleo do respectivo núcleo, coord_geral, admin)
financeiro.post('/repasses/nucleo-projeto', requireRole('admin', 'coord_geral', 'coord_nucleo'), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ projeto_id?: number; valor?: number; finalidade?: string }>().catch(() => ({} as any))
  const { projeto_id, valor, finalidade } = body

  if (!projeto_id || !valor || valor <= 0) return errorResponse(c, 422, 'Informe projeto_id e valor positivo.')
  if (!finalidade) return errorResponse(c, 422, 'Informe a finalidade do repasse (obrigatório).')

  const projeto = await c.env.DB.prepare('SELECT id, nucleo_id FROM projetos WHERE id = ?').bind(projeto_id).first<any>()
  if (!projeto) return errorResponse(c, 404, 'Projeto não encontrado.')

  if (!(await userCanAccessNucleo(actor, projeto.nucleo_id))) {
    return errorResponse(c, 403, 'Você não tem acesso ao núcleo deste projeto.')
  }

  const saldoNucleo = await c.env.DB.prepare('SELECT saldo FROM saldo_nucleo WHERE nucleo_id = ?')
    .bind(projeto.nucleo_id)
    .first<{ saldo: number }>()
  if ((saldoNucleo?.saldo ?? 0) < valor) {
    return errorResponse(c, 422, `Saldo do núcleo insuficiente. Saldo atual: R$ ${(saldoNucleo?.saldo ?? 0).toFixed(2)}.`)
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO financeiro_lancamentos (nivel, nucleo_id, projeto_id, tipo, valor, status, finalidade, solicitado_por)
     VALUES ('projeto', ?, ?, 'repasse_nucleo_projeto', ?, 'pendente', ?, ?)`
  )
    .bind(projeto.nucleo_id, projeto_id, valor, finalidade, actor.sub)
    .run()

  const id = result.meta.last_row_id as number
  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse_nucleo_projeto.solicitar', entidade: 'financeiro_lancamentos', entidadeId: id, payload: { projeto_id, valor, finalidade } })

  return okResponse(c, { id, status: 'pendente' }, 201)
})

// Aprovar repasse:
// - Geral -> Núcleo: SOMENTE o Administrador pode autorizar (Coord. Geral apenas solicita).
// - Núcleo -> Projeto: Admin ou Coord. Geral podem autorizar.
financeiro.post('/repasses/:id/aprovar', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const lancamento = await c.env.DB.prepare('SELECT * FROM financeiro_lancamentos WHERE id = ?').bind(id).first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')
  if (!['repasse_geral_nucleo', 'repasse_nucleo_projeto'].includes(lancamento.tipo)) {
    return errorResponse(c, 400, 'Este lançamento não é um repasse aprovável.')
  }
  if (lancamento.tipo === 'repasse_geral_nucleo' && !isAdmin(actor)) {
    return errorResponse(c, 403, 'Apenas o Administrador pode autorizar repasses do Painel Geral para um Núcleo.')
  }
  if (lancamento.status !== 'pendente') {
    return errorResponse(c, 409, `Lançamento já está com status "${lancamento.status}".`)
  }

  await c.env.DB.prepare(
    `UPDATE financeiro_lancamentos SET status = 'aprovado', aprovado_por = ?, aprovado_em = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(actor.sub, id)
    .run()

  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse.aprovar', entidade: 'financeiro_lancamentos', entidadeId: id })

  return okResponse(c, { message: 'Repasse aprovado. Aguardando execução pelo administrador.' })
})

// Rejeitar repasse (admin, coord_geral)
financeiro.post('/repasses/:id/rejeitar', requireRole('admin', 'coord_geral'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ motivo?: string }>().catch(() => ({} as any))

  const lancamento = await c.env.DB.prepare('SELECT * FROM financeiro_lancamentos WHERE id = ?').bind(id).first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')
  if (!['pendente', 'aprovado'].includes(lancamento.status)) {
    return errorResponse(c, 409, `Não é possível rejeitar um lançamento com status "${lancamento.status}".`)
  }

  await c.env.DB.prepare(
    `UPDATE financeiro_lancamentos SET status = 'rejeitado', rejeitado_em = CURRENT_TIMESTAMP, motivo_rejeicao = ? WHERE id = ?`
  )
    .bind(body.motivo ?? null, id)
    .run()

  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse.rejeitar', entidade: 'financeiro_lancamentos', entidadeId: id, payload: { motivo: body.motivo } })

  return okResponse(c, { message: 'Repasse rejeitado.' })
})

// Executar repasse (SOMENTE ADMIN) — exige comprovante bancário, multipart/form-data
financeiro.post('/repasses/:id/executar', requireRole('admin'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const lancamento = await c.env.DB.prepare('SELECT * FROM financeiro_lancamentos WHERE id = ?').bind(id).first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')
  if (!['repasse_geral_nucleo', 'repasse_nucleo_projeto'].includes(lancamento.tipo)) {
    return errorResponse(c, 400, 'Este lançamento não é um repasse executável.')
  }
  if (lancamento.status !== 'aprovado') {
    return errorResponse(c, 409, 'O repasse precisa estar aprovado antes de ser executado.')
  }

  const formData = await c.req.formData().catch(() => null)
  const comprovanteBancario = formData?.get('comprovante_bancario')
  if (!isFormDataFile(comprovanteBancario)) {
    return errorResponse(c, 422, 'Comprovante bancário é obrigatório para executar o repasse.')
  }

  const bancarioKey = await uploadComprovanteFile(c.env.R2, id, 'bancario', comprovanteBancario)

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE financeiro_lancamentos SET status = 'executado', executado_por = ?, executado_em = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(actor.sub, id),
    c.env.DB.prepare(
      'INSERT INTO comprovantes (lancamento_id, tipo, r2_key, nome_arquivo, enviado_por) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, 'bancario', bancarioKey, comprovanteBancario.name, actor.sub)
  ])

  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse.executar', entidade: 'financeiro_lancamentos', entidadeId: id })

  return okResponse(c, { message: 'Repasse executado com sucesso.' })
})

// ================= COMPROVANTES =================

financeiro.get('/lancamentos/:id/comprovantes', async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const lancamento = await c.env.DB.prepare('SELECT * FROM financeiro_lancamentos WHERE id = ?').bind(id).first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')

  if (lancamento.nucleo_id && !(await userCanAccessNucleo(actor, lancamento.nucleo_id))) {
    return errorResponse(c, 403, 'Sem acesso a este lançamento.')
  }
  if (lancamento.nivel === 'geral' && !isGlobalUser(actor)) {
    return errorResponse(c, 403, 'Sem acesso a este lançamento.')
  }

  const { results } = await c.env.DB.prepare('SELECT * FROM comprovantes WHERE lancamento_id = ?').bind(id).all()
  return okResponse(c, results)
})

// Ciclo de vida do arquivo (ver migrations/mysql/0003_comprovantes_ciclo_de_vida.sql):
// o arquivo fica disponível indefinidamente até o primeiro download. No primeiro
// download, grava-se `baixado_em` e `expira_em` (= baixado_em + 30 dias). Depois de
// `expira_em`, o job de limpeza (src/jobs/limpeza-comprovantes.ts) remove o binário
// do R2 e marca `expirado = 1` — o metadado permanece para fins de auditoria.
const RETENCAO_APOS_DOWNLOAD_DIAS = 30

financeiro.get('/comprovantes/:id/arquivo', async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))
  const comprovante = await c.env.DB.prepare('SELECT * FROM comprovantes WHERE id = ?').bind(id).first<any>()
  if (!comprovante) return errorResponse(c, 404, 'Comprovante não encontrado.')

  // Mesma regra de acesso usada para listar comprovantes de um lançamento —
  // sem isso, qualquer usuário autenticado poderia baixar qualquer comprovante
  // pelo id, mesmo fora do seu escopo de núcleo/projeto.
  const lancamento = await c.env.DB.prepare('SELECT nucleo_id, nivel FROM financeiro_lancamentos WHERE id = ?')
    .bind(comprovante.lancamento_id)
    .first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento associado não encontrado.')
  if (lancamento.nucleo_id && !(await userCanAccessNucleo(actor, lancamento.nucleo_id))) {
    return errorResponse(c, 403, 'Sem acesso a este comprovante.')
  }
  if (lancamento.nivel === 'geral' && !isGlobalUser(actor)) {
    return errorResponse(c, 403, 'Sem acesso a este comprovante.')
  }

  if (comprovante.expirado) {
    return errorResponse(c, 410, 'Este arquivo já expirou e foi removido do armazenamento 30 dias após o primeiro download. O registro do comprovante permanece para fins de auditoria.')
  }

  const object = await c.env.R2.get(comprovante.r2_key)
  if (!object) return errorResponse(c, 404, 'Arquivo não encontrado no armazenamento.')

  // Primeiro download: inicia a contagem de retenção de 30 dias.
  if (!comprovante.baixado_em) {
    await c.env.DB.prepare(
      `UPDATE comprovantes SET baixado_em = CURRENT_TIMESTAMP, expira_em = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? DAY) WHERE id = ?`
    )
      .bind(RETENCAO_APOS_DOWNLOAD_DIAS, id)
      .run()

    await logAudit(c, {
      userId: actor.sub,
      acao: 'financeiro.comprovante.primeiro_download',
      entidade: 'comprovantes',
      entidadeId: id,
      payload: { retencao_dias: RETENCAO_APOS_DOWNLOAD_DIAS }
    })
  }

  const nomeArquivo = comprovante.nome_arquivo || `comprovante-${id}`
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${nomeArquivo.replace(/"/g, '')}"`
    }
  })
})

export default financeiro
