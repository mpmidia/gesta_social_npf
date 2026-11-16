// ============================================================
// Checagem pré-deploy
//
// Roda depois de `npm run build` (ver script "check" no package.json) e
// confirma que o servidor compilado realmente SOBE e RESPONDE, sem precisar
// de banco de dados nem de credenciais do R2:
//
//   1. dist/index.js e dist/build-commit.txt existem;
//   2. o servidor inicia numa porta livre;
//   3. GET /api/_diag/versao responde 200 com o commit do build;
//   4. GET /login responde 200 com HTML.
//
// Se qualquer passo falhar, o processo sai com código 1 — o que faz o
// GitHub Actions marcar o commit com ❌ e avisar por e-mail.
// ============================================================

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const raiz = process.cwd()
const TEMPO_MAXIMO_SUBIDA_MS = 20_000

function ok(msg) {
  console.log(`  ✅ ${msg}`)
}

function falhar(msg) {
  console.error(`  ❌ ${msg}`)
  throw new Error(msg)
}

function portaLivre() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function esperarServidor(base, processo) {
  const inicio = Date.now()
  while (Date.now() - inicio < TEMPO_MAXIMO_SUBIDA_MS) {
    if (processo.exitCode !== null) {
      falhar(`o servidor encerrou sozinho ao iniciar (código ${processo.exitCode})`)
    }
    try {
      const r = await fetch(`${base}/api/_diag/versao`)
      if (r.ok) return r
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  falhar(`o servidor não respondeu em ${TEMPO_MAXIMO_SUBIDA_MS / 1000}s`)
}

async function main() {
  console.log('Checagem pré-deploy')

  // 1. Artefatos do build
  if (!existsSync(join(raiz, 'dist', 'index.js'))) falhar('dist/index.js não existe — rode `npm run build`')
  ok('dist/index.js gerado')

  const commitArquivo = join(raiz, 'dist', 'build-commit.txt')
  if (!existsSync(commitArquivo)) falhar('dist/build-commit.txt não existe')
  const buildInfo = readFileSync(commitArquivo, 'utf-8').trim()
  if (!buildInfo || buildInfo === 'desconhecido') falhar(`dist/build-commit.txt sem commit válido ("${buildInfo}")`)
  ok(`build-commit.txt: ${buildInfo}`)

  // 2. Sobe o servidor sem banco/R2 (as conexões são criadas sob demanda)
  const porta = await portaLivre()
  const base = `http://127.0.0.1:${porta}`
  const saida = []
  const servidor = spawn(process.execPath, ['dist/index.js'], {
    cwd: raiz,
    env: {
      ...process.env,
      PORT: String(porta),
      JWT_SECRET: process.env.JWT_SECRET || 'checagem-pre-deploy',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  servidor.stdout.on('data', (d) => saida.push(d.toString()))
  servidor.stderr.on('data', (d) => saida.push(d.toString()))

  try {
    // 3. Endpoint de versão
    const r = await esperarServidor(base, servidor)
    const json = await r.json()
    if (json.build !== buildInfo) falhar(`/api/_diag/versao devolveu "${json.build}", esperado "${buildInfo}"`)
    ok(`servidor subiu e /api/_diag/versao responde (${json.nodeVersion})`)

    // 4. Página de login
    const login = await fetch(`${base}/login`)
    const html = await login.text()
    if (login.status !== 200) falhar(`/login respondeu ${login.status}`)
    if (!/<html/i.test(html)) falhar('/login não devolveu HTML')
    ok('/login responde com a página')
  } catch (err) {
    if (saida.length) {
      console.error('\n--- saída do servidor ---')
      console.error(saida.join('').slice(-4000))
    }
    throw err
  } finally {
    servidor.kill('SIGTERM')
  }

  console.log('\nTudo certo: pode publicar.')
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    console.error('\nChecagem falhou: NÃO publique este commit.')
    process.exit(1)
  })
