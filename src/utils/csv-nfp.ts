// ============================================================
// Parser nativo (sem dependências externas) para o arquivo de
// "Consulta de Créditos" exportado pelo site da Nota Fiscal Paulista
// (formato .csv com campos entre aspas, delimitador TAB ou ";",
// colunas: CNPJ emit. | Emitente | No. | Data Emissão | Valor NF |
// Data Registro | Créditos | Situação do Crédito).
//
// Não usamos bibliotecas de planilha (xlsx/exceljs) de propósito:
// ambas têm vulnerabilidades conhecidas sem correção disponível no
// momento. O arquivo real exportado pela NFP é um CSV/TSV simples,
// então um parser dedicado e auditável é mais seguro.
// ============================================================

export interface LinhaCreditoNFP {
  cnpjEmitente: string
  emitente: string
  numeroNf: string
  dataEmissao: string // YYYY-MM-DD
  valorNf: number
  dataRegistro: string // YYYY-MM-DD
  creditos: number
  situacaoCredito: string
  linhaHash: string
}

export interface ResultadoParseNFP {
  totalLinhasArquivo: number
  linhasElegiveis: LinhaCreditoNFP[]
  linhasIgnoradasZeroOuACalcular: number
  erroFormato?: string
}

function detectarDelimitador(linhaHeader: string): string {
  const candidatos = ['\t', ';', ',']
  let melhor = '\t'
  let melhorContagem = -1
  for (const d of candidatos) {
    const contagem = linhaHeader.split(d).length
    if (contagem > melhorContagem) {
      melhorContagem = contagem
      melhor = d
    }
  }
  return melhor
}

/** Faz o parse de uma única linha de CSV/TSV respeitando aspas (incluindo "" como aspas escapadas). */
function parseLinha(linha: string, delimitador: string): string[] {
  const campos: string[] = []
  let atual = ''
  let dentroDeAspas = false
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i]
    if (dentroDeAspas) {
      if (ch === '"') {
        if (linha[i + 1] === '"') {
          atual += '"'
          i++
        } else {
          dentroDeAspas = false
        }
      } else {
        atual += ch
      }
    } else {
      if (ch === '"') dentroDeAspas = true
      else if (ch === delimitador) {
        campos.push(atual)
        atual = ''
      } else atual += ch
    }
  }
  campos.push(atual)
  return campos.map((c) => c.trim())
}

function normalizarCabecalho(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function normalizarTexto(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

/** Converte "1.234,56" ou "1234,56" ou "1234.56" em número. Retorna 0 se inválido. */
function parseMoeda(s: string): number {
  const limpo = s.trim()
  if (!limpo) return 0
  // Formato brasileiro: ponto como separador de milhar, vírgula como decimal.
  const normalizado = limpo.replace(/\./g, '').replace(',', '.')
  const n = parseFloat(normalizado)
  return Number.isFinite(n) ? n : 0
}

/** Converte "DD/MM/AAAA" em "AAAA-MM-DD" (formato aceito pelo MySQL DATE). */
function parseDataBr(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  const [, dd, mm, aaaa] = m
  return `${aaaa}-${mm}-${dd}`
}

async function sha256Hex(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const COLUNAS_ESPERADAS = [
  'cnpjemit',
  'emitente',
  'no',
  'dataemissao',
  'valornf',
  'dataregistro',
  'creditos',
  'situacaodocredito'
]

/**
 * Faz o parse do arquivo de créditos NFP, retornando apenas as linhas
 * elegíveis para lançamento (Créditos > 0 E Situação != "A Calcular").
 * Linhas zeradas ou "a calcular" são contadas mas descartadas.
 */
export async function parseCreditosNFP(conteudoArquivo: string): Promise<ResultadoParseNFP> {
  const linhas = conteudoArquivo.split(/\r\n|\n|\r/).filter((l) => l.length > 0)
  if (linhas.length === 0) {
    return { totalLinhasArquivo: 0, linhasElegiveis: [], linhasIgnoradasZeroOuACalcular: 0, erroFormato: 'Arquivo vazio.' }
  }

  const delimitador = detectarDelimitador(linhas[0])
  const cabecalho = parseLinha(linhas[0], delimitador).map(normalizarCabecalho)

  const idx = {
    cnpj: cabecalho.indexOf('cnpjemit'),
    emitente: cabecalho.indexOf('emitente'),
    numero: cabecalho.indexOf('no'),
    dataEmissao: cabecalho.indexOf('dataemissao'),
    valorNf: cabecalho.indexOf('valornf'),
    dataRegistro: cabecalho.indexOf('dataregistro'),
    creditos: cabecalho.indexOf('creditos'),
    situacao: cabecalho.indexOf('situacaodocredito')
  }

  const faltando = COLUNAS_ESPERADAS.filter((c) => !cabecalho.includes(c))
  if (faltando.length > 0) {
    return {
      totalLinhasArquivo: 0,
      linhasElegiveis: [],
      linhasIgnoradasZeroOuACalcular: 0,
      erroFormato: `Arquivo não reconhecido como exportação da Nota Fiscal Paulista. Colunas esperadas não encontradas: ${faltando.join(', ')}. Verifique se o arquivo enviado é o CSV exportado diretamente do site da NFP (Consulta de Créditos).`
    }
  }

  const linhasDeDados = linhas.slice(1)
  const elegiveis: LinhaCreditoNFP[] = []
  let ignoradas = 0

  for (const linha of linhasDeDados) {
    const campos = parseLinha(linha, delimitador)
    if (campos.length < cabecalho.length) continue

    const situacaoRaw = campos[idx.situacao] ?? ''
    const situacaoNormalizada = normalizarTexto(situacaoRaw)
    const creditos = parseMoeda(campos[idx.creditos] ?? '0')

    // Ignora linhas com situação "a calcular" (crédito ainda não definido pelo
    // programa) OU com valor de crédito zerado/ausente — nada disso deve virar
    // lançamento financeiro real ainda.
    if (situacaoNormalizada.includes('calcular') || creditos <= 0) {
      ignoradas++
      continue
    }

    const dataEmissao = parseDataBr(campos[idx.dataEmissao] ?? '')
    const dataRegistro = parseDataBr(campos[idx.dataRegistro] ?? '')
    const cnpjEmitente = (campos[idx.cnpj] ?? '').trim()
    const emitente = (campos[idx.emitente] ?? '').trim()
    const numeroNf = (campos[idx.numero] ?? '').trim()
    const valorNf = parseMoeda(campos[idx.valorNf] ?? '0')

    if (!dataEmissao || !dataRegistro || !cnpjEmitente || !numeroNf) {
      // Linha mal formada — não é um registro de crédito válido, ignora.
      ignoradas++
      continue
    }

    // Hash de TODOS os campos relevantes da linha — é a chave de dedup.
    // Se qualquer campo mudar entre importações (ex.: Situação ou Créditos
    // forem atualizados pelo site da NFP), o hash muda e a linha é tratada
    // como nova (correto: antes ela nem era elegível).
    const chaveHash = [cnpjEmitente, numeroNf, dataEmissao, valorNf.toFixed(2), dataRegistro, creditos.toFixed(2), situacaoNormalizada].join('|')
    const linhaHash = await sha256Hex(chaveHash)

    elegiveis.push({
      cnpjEmitente,
      emitente,
      numeroNf,
      dataEmissao,
      valorNf,
      dataRegistro,
      creditos,
      situacaoCredito: situacaoRaw,
      linhaHash
    })
  }

  return {
    totalLinhasArquivo: linhasDeDados.length,
    linhasElegiveis: elegiveis,
    linhasIgnoradasZeroOuACalcular: ignoradas
  }
}
