import { Hono } from 'hono'
import type { AppEnv } from '../../types/bindings'
import type { AppDatabase } from '../../platform/db'
import type { AppBucket } from '../../platform/storage'
import { errorResponse, okResponse, isFormDataFile } from '../../utils/response'
import { generateRandomKey } from '../../utils/crypto'
import { parseCreditosNFP } from '../../utils/csv-nfp'
import { logAudit } from '../../middlewares/audit'
import { authMiddleware } from '../../middlewares/auth'
import { requireRole, getScopedNucleoIds, isAdmin, isFinanceiro, hasFinanceiroFullAccess } from '../../middlewares/rbac'

const financeiro = new Hono<AppEnv>()

financeiro.use('*', authMiddleware)

// Acesso aos painéis financeiros de Núcleo/Projeto: admin, financeiro (visão 360°)
// e o coord_nucleo do respectivo escopo. Coord_geral e Articulador NUNCA têm acesso
// financeiro (hasFinanceiroFullAccess não inclui coord_geral, e nenhum dos dois possui
// escopo coord_nucleo) — bloqueados por definição.
async function userCanAccessNucleo(user: any, nucleoId: number): Promise<boolean> {
  if (hasFinanceiroFullAccess(user)) return true
  return getScopedNucleoIds(user).includes(nucleoId)
}

// Gestão de saídas no Projeto: admin, financeiro (quando ele próprio executa o pagamento)
// OU coord_nucleo do núcleo dono do projeto. Coord_geral e Articulador NÃO lançam saídas
// (apenas o Coordenador de Núcleo gere os recursos do dia a dia, e o Financeiro quando
// é ele quem está efetivamente pagando).
function userCanManageSaidaProjeto(user: any, nucleoId: number): boolean {
  if (isAdmin(user) || isFinanceiro(user)) return true
  return user.roles?.some((r: any) => r.role === 'coord_nucleo' && r.escopo_id === nucleoId)
}

async function getNucleoIdFromProjeto(db: AppDatabase, projetoId: number): Promise<number | null> {
  const row = await db.prepare('SELECT nucleo_id FROM projetos WHERE id = ?').bind(projetoId).first<{ nucleo_id: number }>()
  return row?.nucleo_id ?? null
}

async function uploadComprovanteFile(
  r2: AppBucket,
  lancamentoId: number,
  tipo: 'bancario' | 'fiscal' | 'deposito',
  file: File
): Promise<string> {
  const key = `comprovantes/${lancamentoId}/${tipo}/${generateRandomKey()}-${file.name}`
  await r2.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } })
  return key
}

// Retenção do comprovante de DEPÓSITO (repasse): diferente dos comprovantes de
// saída (que expiram 30 dias após o primeiro download), o comprovante de
// depósito pode ser visualizado livremente pelo coordenador do núcleo
// destinatário e só expira 6 MESES após a execução do repasse — a contagem
// começa na execução, não no download/visualização.
const RETENCAO_DEPOSITO_MESES = 6

function dataMaisMeses(meses: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() + meses)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

// ================= PAINEL GERAL =================
//
// A forma PRINCIPAL de lançar entrada no Geral é importando a planilha de
// créditos exportada do site da Nota Fiscal Paulista (ver rota
// /geral/importar-nfp abaixo) — isso garante que a maior parte do valor
// lançado no Geral tenha lastro rastreável no arquivo oficial da NFP (CNPJ,
// nota fiscal, data), em vez de ser digitado manualmente sem comprovação.
//
// Além disso, admin/financeiro podem registrar lançamentos MANUAIS pontuais
// (/geral/lancamentos-manuais) para ajustes que não vêm da planilha — ex.:
// estorno, taxa bancária, correção de valor, doação direta etc. Esses
// lançamentos usam tipos próprios (entrada_manual/saida_manual), exigem
// finalidade/justificativa obrigatória e ficam sempre auditados em
// audit_log, mas NUNCA se confundem com entrada_nfp (que só é criada pela
// importação da planilha).

// Importação da planilha de créditos NFP (admin, financeiro) — cada linha
// elegível (Créditos > 0 e Situação != "A Calcular") vira um lançamento de
// entrada no Painel Geral. Deduplicação pelo hash de todos os campos da
// linha, para permitir reimportar o mesmo arquivo atualizado mês a mês
// sem duplicar lançamentos já processados. Coord_geral NÃO participa (sem
// acesso ao financeiro); o Financeiro é quem sobe a planilha de arrecadação.
financeiro.post('/geral/importar-nfp', requireRole('admin', 'financeiro'), async (c) => {
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

  // Guarda o arquivo original no R2 para permitir "baixar a planilha" depois
  // (auditoria/conferência), sem precisar listar as linhas individuais na tela.
  const arquivoKey = `importacoes-nfp/${generateRandomKey()}-${nomeArquivo}`
  await c.env.R2.put(arquivoKey, await arquivo.arrayBuffer(), {
    httpMetadata: { contentType: arquivo.type || 'text/csv' }
  })

  if (resultado.linhasElegiveis.length === 0) {
    // Ainda registra a importação (com zero linhas novas) para ficar no histórico,
    // mesmo quando o arquivo só contém notas "A Calcular"/zeradas.
    const importRow = await c.env.DB.prepare(
      `INSERT INTO financeiro_importacoes_nfp
       (nome_arquivo, arquivo_original_key, total_linhas_arquivo, linhas_elegiveis, linhas_novas, linhas_duplicadas, linhas_ignoradas_zero_ou_a_calcular, valor_total_importado, importado_por)
       VALUES (?, ?, ?, 0, 0, 0, ?, 0, ?)`
    )
      .bind(nomeArquivo, arquivoKey, resultado.totalLinhasArquivo, resultado.linhasIgnoradasZeroOuACalcular, actor.sub)
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
     (nome_arquivo, arquivo_original_key, total_linhas_arquivo, linhas_elegiveis, linhas_novas, linhas_duplicadas, linhas_ignoradas_zero_ou_a_calcular, valor_total_importado, importado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      nomeArquivo,
      arquivoKey,
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

// Lançamento manual no Painel Geral — para correções/ajustes pontuais que não
// vêm da planilha NFP (ex.: estorno, taxa bancária, correção de valor). Fica
// SEPARADO da importação automática (tipo 'entrada_nfp'), sempre com
// finalidade obrigatória e registro em audit_log, para manter rastreabilidade
// mesmo sendo um lançamento digitado manualmente. admin/financeiro apenas.
financeiro.post('/geral/lancamentos-manuais', requireRole('admin', 'financeiro'), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ direcao?: 'entrada' | 'saida'; valor?: number; finalidade?: string }>().catch(() => ({} as any))
  const { direcao, valor, finalidade } = body

  if (direcao !== 'entrada' && direcao !== 'saida') {
    return errorResponse(c, 422, 'Informe a direção do lançamento: "entrada" ou "saida".')
  }
  if (!valor || valor <= 0) return errorResponse(c, 422, 'Informe um valor positivo.')
  if (!finalidade || !finalidade.trim()) {
    return errorResponse(c, 422, 'Informe a finalidade/justificativa do lançamento manual.')
  }

  const tipo = direcao === 'entrada' ? 'entrada_manual' : 'saida_manual'

  if (direcao === 'saida') {
    const saldoRow = await c.env.DB.prepare('SELECT saldo FROM saldo_geral').first<{ saldo: number }>()
    const saldoAtual = saldoRow?.saldo ?? 0
    if (valor > saldoAtual) {
      return errorResponse(c, 422, `Saldo geral insuficiente. Saldo atual: R$ ${saldoAtual.toFixed(2)}.`)
    }
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO financeiro_lancamentos (nivel, tipo, valor, status, finalidade, solicitado_por, executado_por, executado_em)
     VALUES ('geral', ?, ?, 'executado', ?, ?, ?, CURRENT_TIMESTAMP)`
  )
    .bind(tipo, valor, finalidade.trim(), actor.sub, actor.sub)
    .run()

  const lancamentoId = result.meta.last_row_id as number

  await logAudit(c, {
    userId: actor.sub,
    acao: 'financeiro.lancamento_manual.criar',
    entidade: 'financeiro_lancamentos',
    entidadeId: lancamentoId,
    payload: { tipo, valor, finalidade }
  })

  return okResponse(c, { id: lancamentoId, tipo, valor, finalidade, status: 'executado' }, 201)
})

// Edita um lançamento manual existente (somente entrada_manual/saida_manual,
// nunca entrada_nfp nem repasses — esses têm seu próprio ciclo de vida/lastro).
financeiro.put('/geral/lancamentos-manuais/:id', requireRole('admin', 'financeiro'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ valor?: number; finalidade?: string }>().catch(() => ({} as any))
  const { valor, finalidade } = body

  const lancamento = await c.env.DB.prepare(
    `SELECT * FROM financeiro_lancamentos WHERE id = ? AND nivel = 'geral'`
  ).bind(id).first<any>()

  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')
  if (!['entrada_manual', 'saida_manual'].includes(lancamento.tipo)) {
    return errorResponse(c, 422, 'Apenas lançamentos manuais podem ser editados. Entradas importadas da NFP e repasses têm seu próprio fluxo.')
  }
  if (lancamento.status === 'cancelado') return errorResponse(c, 422, 'Este lançamento já foi cancelado.')

  if (!valor || valor <= 0) return errorResponse(c, 422, 'Informe um valor positivo.')
  if (!finalidade || !finalidade.trim()) return errorResponse(c, 422, 'Informe a finalidade/justificativa do lançamento.')

  // Se for saída, verifica se o novo valor ainda cabe no saldo (considerando que o valor antigo será substituído).
  if (lancamento.tipo === 'saida_manual') {
    const saldoRow = await c.env.DB.prepare('SELECT saldo FROM saldo_geral').first<{ saldo: number }>()
    const saldoSemEsteLancamento = (saldoRow?.saldo ?? 0) + Number(lancamento.valor)
    if (valor > saldoSemEsteLancamento) {
      return errorResponse(c, 422, `Saldo geral insuficiente para este novo valor. Saldo disponível (sem este lançamento): R$ ${saldoSemEsteLancamento.toFixed(2)}.`)
    }
  }

  await c.env.DB.prepare(`UPDATE financeiro_lancamentos SET valor = ?, finalidade = ? WHERE id = ?`)
    .bind(valor, finalidade.trim(), id)
    .run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'financeiro.lancamento_manual.editar',
    entidade: 'financeiro_lancamentos',
    entidadeId: id,
    payload: { valorAnterior: lancamento.valor, valorNovo: valor, finalidadeAnterior: lancamento.finalidade, finalidadeNova: finalidade }
  })

  return okResponse(c, { id, valor, finalidade })
})

// "Exclui" um lançamento manual — na prática faz soft-delete (status='cancelado')
// para preservar o histórico/auditoria em vez de apagar a linha do ledger.
// Lançamentos cancelados são automaticamente excluídos do cálculo de saldo.
financeiro.delete('/geral/lancamentos-manuais/:id', requireRole('admin'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const lancamento = await c.env.DB.prepare(
    `SELECT * FROM financeiro_lancamentos WHERE id = ? AND nivel = 'geral'`
  ).bind(id).first<any>()

  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')
  if (!['entrada_manual', 'saida_manual'].includes(lancamento.tipo)) {
    return errorResponse(c, 422, 'Apenas lançamentos manuais podem ser excluídos. Entradas importadas da NFP e repasses têm seu próprio fluxo.')
  }
  if (lancamento.status === 'cancelado') return errorResponse(c, 422, 'Este lançamento já foi cancelado.')

  await c.env.DB.prepare(`UPDATE financeiro_lancamentos SET status = 'cancelado' WHERE id = ?`).bind(id).run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'financeiro.lancamento_manual.cancelar',
    entidade: 'financeiro_lancamentos',
    entidadeId: id,
    payload: { tipo: lancamento.tipo, valor: lancamento.valor, finalidade: lancamento.finalidade }
  })

  return okResponse(c, { id, status: 'cancelado' })
})

// Histórico de importações realizadas (admin, financeiro)
financeiro.get('/geral/importacoes', requireRole('admin', 'financeiro'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT i.*, u.nome AS importado_por_nome
     FROM financeiro_importacoes_nfp i
     JOIN users u ON u.id = i.importado_por
     ORDER BY i.created_at DESC`
  ).all()
  return okResponse(c, results)
})

// Baixa o arquivo original (CSV) de uma importação NFP — para conferência/auditoria,
// sem precisar listar as milhares de linhas individuais na tela.
financeiro.get('/geral/importacoes/:id/arquivo', requireRole('admin', 'financeiro'), async (c) => {
  const id = Number(c.req.param('id'))
  const importacao = await c.env.DB.prepare('SELECT nome_arquivo, arquivo_original_key FROM financeiro_importacoes_nfp WHERE id = ?')
    .bind(id)
    .first<{ nome_arquivo: string; arquivo_original_key: string | null }>()

  if (!importacao) return errorResponse(c, 404, 'Importação não encontrada.')
  if (!importacao.arquivo_original_key) {
    return errorResponse(c, 404, 'O arquivo original desta importação não está disponível (importado antes deste recurso existir).')
  }

  const object = await c.env.R2.get(importacao.arquivo_original_key)
  if (!object) return errorResponse(c, 404, 'Arquivo não encontrado no armazenamento.')

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'text/csv',
      'Content-Disposition': `attachment; filename="${importacao.nome_arquivo.replace(/"/g, '')}"`
    }
  })
})

financeiro.get('/geral/saldo', requireRole('admin', 'financeiro'), async (c) => {
  const row = await c.env.DB.prepare('SELECT saldo FROM saldo_geral').first<{ saldo: number }>()
  return okResponse(c, { saldo: row?.saldo ?? 0 })
})

financeiro.get('/geral/lancamentos', requireRole('admin', 'financeiro'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM financeiro_lancamentos WHERE nivel = 'geral' ORDER BY created_at DESC`
  ).all()
  return okResponse(c, results)
})

// Busca pontual de um registro específico no financeiro geral — por CNPJ, nome do
// emitente, número da NF ou id do lançamento. Usado pela tela de Financeiro Geral
// em vez de listar todos os registros de uma vez (que pode somar milhares de linhas
// vindas da importação da NFP).
financeiro.get('/geral/buscar', requireRole('admin', 'financeiro'), async (c) => {
  const termo = (c.req.query('q') || '').trim()
  if (!termo || termo.length < 2) {
    return errorResponse(c, 422, 'Informe ao menos 2 caracteres para buscar.')
  }

  const like = `%${termo}%`
  const { results: creditos } = await c.env.DB.prepare(
    `SELECT cr.*, l.status AS lancamento_status
     FROM financeiro_creditos_nfp cr
     JOIN financeiro_lancamentos l ON l.id = cr.lancamento_id
     WHERE cr.cnpj_emitente LIKE ? OR cr.emitente LIKE ? OR cr.numero_nf LIKE ?
     ORDER BY cr.created_at DESC
     LIMIT 100`
  )
    .bind(like, like, like)
    .all()

  // Também busca em lançamentos manuais/outros tipos pela finalidade (ex.: estorno, taxa).
  const { results: manuais } = await c.env.DB.prepare(
    `SELECT * FROM financeiro_lancamentos
     WHERE nivel = 'geral' AND tipo IN ('entrada_manual','saida_manual') AND finalidade LIKE ?
     ORDER BY created_at DESC
     LIMIT 50`
  )
    .bind(like)
    .all()

  return okResponse(c, { creditosNfp: creditos, lancamentosManuais: manuais })
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
financeiro.post('/projeto/:projetoId/saidas', requireRole('admin', 'coord_nucleo', 'financeiro'), async (c) => {
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
//
// Coordenador Geral NÃO tem nenhum acesso ao módulo financeiro (regra de negócio
// explícita) — por isso nenhuma rota abaixo o inclui. Quem SOLICITA repasse do
// Geral para um Núcleo é o próprio Coordenador de Núcleo (do seu núcleo) ou o
// Administrador; quem APROVA/EXECUTA é o Administrador ou o papel Financeiro
// ("recebe as solicitações de repasse e pagamento dos núcleos").

// Solicitar repasse Geral -> Núcleo (admin, financeiro, ou o próprio coord_nucleo do núcleo)
financeiro.post('/repasses/geral-nucleo', requireRole('admin', 'coord_nucleo', 'financeiro'), async (c) => {
  const actor = c.get('user')
  const body = await c.req.json<{ nucleo_id?: number; valor?: number; finalidade?: string }>().catch(() => ({} as any))
  const { nucleo_id, valor, finalidade } = body

  if (!nucleo_id || !valor || valor <= 0) return errorResponse(c, 422, 'Informe nucleo_id e valor positivo.')

  const nucleo = await c.env.DB.prepare('SELECT id FROM nucleos WHERE id = ?').bind(nucleo_id).first()
  if (!nucleo) return errorResponse(c, 404, 'Núcleo não encontrado.')

  if (!(await userCanAccessNucleo(actor, nucleo_id))) {
    return errorResponse(c, 403, 'Você só pode solicitar repasse para o seu próprio núcleo.')
  }

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

// Solicitar repasse Núcleo -> Projeto (coord_nucleo do respectivo núcleo, admin, financeiro)
financeiro.post('/repasses/nucleo-projeto', requireRole('admin', 'coord_nucleo', 'financeiro'), async (c) => {
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

// Retorna os dados bancários/PIX do coordenador destinatário de um repasse —
// usado pelo financeiro/admin na tela de execução, para saber para onde
// depositar o valor antes de anexar o comprovante. Destinatário = o
// coord_nucleo do núcleo envolvido no repasse (tanto para repasse
// Geral->Núcleo quanto Núcleo->Projeto, o núcleo gestor é o mesmo).
financeiro.get('/repasses/:id/destinatario', requireRole('admin', 'financeiro'), async (c) => {
  const id = Number(c.req.param('id'))
  const lancamento = await c.env.DB.prepare('SELECT nucleo_id FROM financeiro_lancamentos WHERE id = ?').bind(id).first<{ nucleo_id: number | null }>()
  if (!lancamento || !lancamento.nucleo_id) return errorResponse(c, 404, 'Lançamento/núcleo não encontrado.')

  const coordenador = await c.env.DB.prepare(
    `SELECT u.nome, u.email, u.banco, u.agencia, u.conta, u.tipo_conta, u.pix_chave
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     WHERE ur.role = 'coord_nucleo' AND ur.escopo_id = ? AND u.excluido_em IS NULL
     LIMIT 1`
  )
    .bind(lancamento.nucleo_id)
    .first()

  if (!coordenador) return errorResponse(c, 404, 'Nenhum coordenador vinculado a este núcleo.')
  return okResponse(c, coordenador)
})

// Aprovar repasse (admin, financeiro) — o Financeiro é quem recebe e processa
// as solicitações de repasse/pagamento dos núcleos, tanto Geral->Núcleo quanto
// Núcleo->Projeto.
financeiro.post('/repasses/:id/aprovar', requireRole('admin', 'financeiro'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const lancamento = await c.env.DB.prepare('SELECT * FROM financeiro_lancamentos WHERE id = ?').bind(id).first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')
  if (!['repasse_geral_nucleo', 'repasse_nucleo_projeto'].includes(lancamento.tipo)) {
    return errorResponse(c, 400, 'Este lançamento não é um repasse aprovável.')
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

  return okResponse(c, { message: 'Repasse aprovado. Aguardando execução.' })
})

// Rejeitar repasse (admin, financeiro)
financeiro.post('/repasses/:id/rejeitar', requireRole('admin', 'financeiro'), async (c) => {
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

// Executar repasse (admin, financeiro) — exige o anexo do COMPROVANTE DE
// DEPÓSITO (arquivo) feito na conta bancária/PIX do coordenador destinatário.
// Além do comprovante, o sistema continua gerando uma FATURA (financeiro_faturas),
// documento simples e imprimível (ver GET /financeiro/faturas/:id), como registro
// formal complementar da transferência (a fatura não substitui o comprovante).
//
// O comprovante de depósito usa uma política de retenção DIFERENTE da dos
// comprovantes de saída: não expira ao ser baixado/visualizado pelo coordenador
// (fica disponível para consulta), mas expira automaticamente 6 meses após a
// execução — `expira_em` já é definido aqui, no momento da execução.
financeiro.post('/repasses/:id/executar', requireRole('admin', 'financeiro'), async (c) => {
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
  if (!formData) return errorResponse(c, 422, 'Envie os dados via multipart/form-data.')

  const comprovanteDeposito = formData.get('comprovante_deposito')
  const enviarPara = formData.get('enviar_para')?.toString() || ''

  if (!isFormDataFile(comprovanteDeposito)) {
    return errorResponse(c, 422, 'Anexe o comprovante de depósito para executar o repasse.')
  }

  const numero = `FAT-${id}-${generateRandomKey().slice(0, 6).toUpperCase()}`

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE financeiro_lancamentos SET status = 'executado', executado_por = ?, executado_em = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(actor.sub, id),
    c.env.DB.prepare(
      `INSERT INTO financeiro_faturas (lancamento_id, numero, nucleo_id, projeto_id, valor, finalidade, gerado_por, enviada_em, enviada_para)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      numero,
      lancamento.nucleo_id,
      lancamento.projeto_id,
      lancamento.valor,
      lancamento.finalidade,
      actor.sub,
      enviarPara ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      enviarPara || null
    )
  ])

  // Upload do comprovante de depósito para R2 (fora da transação do DB, mas
  // só chega aqui depois do lançamento já marcado como executado).
  const depositoKey = await uploadComprovanteFile(c.env.R2, id, 'deposito', comprovanteDeposito)

  // expira_em já é definido AGORA (execução), não no download/visualização —
  // retenção de 6 meses independente de quando o coordenador vir o arquivo.
  await c.env.DB.prepare(
    `INSERT INTO comprovantes (lancamento_id, tipo, r2_key, nome_arquivo, enviado_por, expira_em)
     VALUES (?, 'deposito', ?, ?, ?, ?)`
  )
    .bind(id, depositoKey, comprovanteDeposito.name, actor.sub, dataMaisMeses(RETENCAO_DEPOSITO_MESES))
    .run()

  const fatura = await c.env.DB.prepare('SELECT id FROM financeiro_faturas WHERE lancamento_id = ?').bind(id).first<{ id: number }>()

  await logAudit(c, { userId: actor.sub, acao: 'financeiro.repasse.executar', entidade: 'financeiro_lancamentos', entidadeId: id, payload: { numero_fatura: numero, comprovante_deposito: true } })

  return okResponse(c, { message: 'Repasse executado com sucesso. Comprovante anexado e fatura gerada.', fatura_id: fatura?.id, numero })
})

// ================= FATURAS =================

// Exibe a fatura como HTML simples, pronto para impressão/PDF pelo navegador
// (Ctrl+P / Salvar como PDF). Acesso: admin, financeiro (visão 360°)
// ou o coordenador do núcleo destinatário do repasse.
financeiro.get('/faturas/:id', async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const fatura = await c.env.DB.prepare(
    `SELECT f.*, u.nome AS gerado_por_nome, n.nome AS nucleo_nome, p.nome AS projeto_nome
     FROM financeiro_faturas f
     JOIN users u ON u.id = f.gerado_por
     LEFT JOIN nucleos n ON n.id = f.nucleo_id
     LEFT JOIN projetos p ON p.id = f.projeto_id
     WHERE f.id = ?`
  ).bind(id).first<any>()

  if (!fatura) return errorResponse(c, 404, 'Fatura não encontrada.')
  if (fatura.nucleo_id && !(await userCanAccessNucleo(actor, fatura.nucleo_id))) {
    return errorResponse(c, 403, 'Sem acesso a esta fatura.')
  }

  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><title>Fatura ${fatura.numero}</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 700px; margin: 40px auto; color: #1f2937; }
  h1 { font-size: 20px; border-bottom: 2px solid #0f766e; padding-bottom: 10px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  td, th { padding: 10px; border: 1px solid #e5e7eb; text-align: left; font-size: 14px; }
  .valor { font-size: 24px; font-weight: bold; color: #0f766e; margin: 20px 0; }
  @media print { button { display: none; } }
</style></head>
<body>
  <h1>Fatura de Repasse — ${fatura.numero}</h1>
  <p class="meta">Gestão Social (NFP) — Gerada em ${new Date(fatura.created_at).toLocaleString('pt-BR')} por ${fatura.gerado_por_nome}</p>
  <table>
    <tr><th>Destino</th><td>${fatura.projeto_nome ? `Projeto: ${fatura.projeto_nome}` : `Núcleo: ${fatura.nucleo_nome || '-'}`}</td></tr>
    <tr><th>Finalidade</th><td>${fatura.finalidade || '-'}</td></tr>
  </table>
  <p class="valor">Valor: ${Number(fatura.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
  <button onclick="window.print()">Imprimir / Salvar como PDF</button>
</body></html>`

  return c.html(html)
})

// Busca a fatura vinculada a um lançamento (usado pelo frontend após executar o repasse).
financeiro.get('/lancamentos/:id/fatura', async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const lancamento = await c.env.DB.prepare('SELECT nucleo_id FROM financeiro_lancamentos WHERE id = ?').bind(id).first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento não encontrado.')
  if (lancamento.nucleo_id && !(await userCanAccessNucleo(actor, lancamento.nucleo_id))) {
    return errorResponse(c, 403, 'Sem acesso a este lançamento.')
  }

  const fatura = await c.env.DB.prepare('SELECT * FROM financeiro_faturas WHERE lancamento_id = ?').bind(id).first()
  if (!fatura) return errorResponse(c, 404, 'Nenhuma fatura gerada para este lançamento.')
  return okResponse(c, fatura)
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
  if (lancamento.nivel === 'geral' && !hasFinanceiroFullAccess(actor)) {
    return errorResponse(c, 403, 'Sem acesso a este lançamento.')
  }

  const { results } = await c.env.DB.prepare('SELECT * FROM comprovantes WHERE lancamento_id = ?').bind(id).all()
  return okResponse(c, results)
})

// Visualização (NÃO download) do comprovante de DEPÓSITO de um repasse, pelo
// próprio coordenador do núcleo destinatário. Diferente de /comprovantes/:id/arquivo
// (reservado a admin/financeiro, que dispara a janela de 30 dias de retenção),
// esta rota: (1) só serve comprovantes tipo='deposito', (2) nunca marca
// baixado_em/expirado por efeito da visualização — o arquivo some apenas quando
// `expira_em` (6 meses após a execução, já gravado na execução) é atingido pelo
// job de limpeza, (3) é restrita ao próprio escopo do núcleo do coord_nucleo.
financeiro.get('/comprovantes/:id/visualizar', async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))
  const comprovante = await c.env.DB.prepare('SELECT * FROM comprovantes WHERE id = ?').bind(id).first<any>()
  if (!comprovante) return errorResponse(c, 404, 'Comprovante não encontrado.')
  if (comprovante.tipo !== 'deposito') {
    return errorResponse(c, 403, 'Esta rota só serve comprovantes de depósito de repasse.')
  }

  const lancamento = await c.env.DB.prepare('SELECT nucleo_id FROM financeiro_lancamentos WHERE id = ?')
    .bind(comprovante.lancamento_id)
    .first<{ nucleo_id: number | null }>()
  if (!lancamento || !lancamento.nucleo_id) return errorResponse(c, 404, 'Lançamento associado não encontrado.')

  const podeVer = isAdmin(actor) || isFinanceiro(actor) || getScopedNucleoIds(actor).includes(lancamento.nucleo_id)
  if (!podeVer) return errorResponse(c, 403, 'Sem acesso a este comprovante.')

  if (comprovante.expirado) {
    return errorResponse(c, 410, 'Este comprovante expirou (6 meses após a execução do repasse) e foi removido do armazenamento.')
  }

  const object = await c.env.R2.get(comprovante.r2_key)
  if (!object) return errorResponse(c, 404, 'Arquivo não encontrado no armazenamento.')

  // Apenas registra que foi visualizado (auditoria), SEM disparar expiração —
  // a expiração deste tipo de comprovante já foi fixada na execução do repasse.
  if (!comprovante.visualizado_em) {
    await c.env.DB.prepare('UPDATE comprovantes SET visualizado_em = CURRENT_TIMESTAMP WHERE id = ?').bind(id).run()
  }

  const nomeArquivo = comprovante.nome_arquivo || `comprovante-deposito-${id}`
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${nomeArquivo.replace(/"/g, '')}"`
    }
  })
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

  // Regra de negócio: o comprovante é ANEXADO pelo Coordenador de Núcleo (ou pelo
  // Financeiro, quando ele próprio executa um pagamento), mas o DOWNLOAD do arquivo
  // fica reservado ao Administrador e ao papel Financeiro (visão 360°) — não ao
  // próprio coord_nucleo que o enviou, nem a coord_geral/articulador. Isso garante
  // que o fluxo seja "coordenador sobe o arquivo → administrador/financeiro confere
  // e baixa". A listagem de METADADOS (verComprovantes) continua visível a todo
  // escopo de núcleo, apenas o binário em si é restrito aqui.
  const lancamento = await c.env.DB.prepare('SELECT nucleo_id, nivel FROM financeiro_lancamentos WHERE id = ?')
    .bind(comprovante.lancamento_id)
    .first<any>()
  if (!lancamento) return errorResponse(c, 404, 'Lançamento associado não encontrado.')
  if (!isAdmin(actor) && !isFinanceiro(actor)) {
    return errorResponse(c, 403, 'Apenas o Administrador ou o papel Financeiro podem baixar comprovantes.')
  }

  if (comprovante.arquivado_em) {
    return errorResponse(c, 410, 'Este comprovante foi arquivado manualmente e o arquivo não está mais disponível para download. O registro permanece para fins de auditoria.')
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

// Arquivamento manual de comprovante (admin, financeiro) — ação deliberada de
// "já conferi, pode arquivar": remove o binário do R2 desde já (sem esperar os
// 30 dias pós-download) e marca arquivado_em/arquivado_por. O metadado nunca é
// apagado, preservando o rastro de auditoria.
financeiro.post('/comprovantes/:id/arquivar', requireRole('admin', 'financeiro'), async (c) => {
  const actor = c.get('user')
  const id = Number(c.req.param('id'))

  const comprovante = await c.env.DB.prepare('SELECT * FROM comprovantes WHERE id = ?').bind(id).first<any>()
  if (!comprovante) return errorResponse(c, 404, 'Comprovante não encontrado.')
  if (comprovante.arquivado_em) return errorResponse(c, 409, 'Este comprovante já está arquivado.')

  if (!comprovante.expirado) {
    await c.env.R2.delete(comprovante.r2_key).catch(() => {})
  }

  await c.env.DB.prepare(
    'UPDATE comprovantes SET arquivado_em = CURRENT_TIMESTAMP, arquivado_por = ? WHERE id = ?'
  )
    .bind(actor.sub, id)
    .run()

  await logAudit(c, {
    userId: actor.sub,
    acao: 'financeiro.comprovante.arquivar',
    entidade: 'comprovantes',
    entidadeId: id
  })

  return okResponse(c, { message: 'Comprovante arquivado. O arquivo foi removido do armazenamento, o registro permanece para auditoria.' })
})

export default financeiro
