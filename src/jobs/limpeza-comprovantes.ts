// ============================================================
// Job de limpeza de comprovantes expirados.
//
// Requisito de negócio: o comprovante fica guardado até ser baixado
// pela primeira vez; a partir do primeiro download, é removido do
// armazenamento (Cloudflare R2) 30 dias depois.
//
// Como este processo Node.js roda de forma persistente na Hostinger
// (diferente de um ambiente serverless tipo Cloudflare Workers, que
// não permite "triggers"/cron em Hosted Deploy), um `setInterval`
// simples dentro do próprio processo é suficiente e seguro: não há
// necessidade de infraestrutura externa de cron.
//
// O registro em `comprovantes` NUNCA é apagado (mantém-se o rastro de
// auditoria/prestação de contas) — apenas o arquivo binário no R2 é
// removido, e a linha é marcada com `expirado = 1`.
// ============================================================

import type { AppDatabase } from '../platform/db'
import type { AppBucket } from '../platform/storage'

interface ComprovanteExpirado {
  id: number
  r2_key: string
}

export async function limparComprovantesExpirados(db: AppDatabase, r2: AppBucket): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, r2_key FROM comprovantes
       WHERE expirado = 0 AND expira_em IS NOT NULL AND expira_em <= CURRENT_TIMESTAMP`
    )
    .all<ComprovanteExpirado>()

  let removidos = 0
  for (const comp of results ?? []) {
    try {
      await r2.delete(comp.r2_key)
    } catch (err) {
      // Se o arquivo já não existir no R2 (ex.: removido manualmente), ainda
      // assim marcamos como expirado — não deixamos o job travado em loop.
      console.warn(`[limpeza-comprovantes] falha ao remover ${comp.r2_key} do R2:`, err)
    }

    await db
      .prepare('UPDATE comprovantes SET expirado = 1 WHERE id = ?')
      .bind(comp.id)
      .run()

    removidos++
  }

  if (removidos > 0) {
    console.log(`[limpeza-comprovantes] ${removidos} arquivo(s) expirado(s) removido(s) do armazenamento.`)
  }

  return removidos
}

/**
 * Agenda a execução periódica da limpeza dentro do processo Node.js.
 * Roda uma vez logo na subida do servidor e depois a cada `intervalHoras`.
 */
export function agendarLimpezaComprovantes(db: AppDatabase, r2: AppBucket, intervalHoras = 24): void {
  const executar = () => {
    limparComprovantesExpirados(db, r2).catch((err) => {
      console.error('[limpeza-comprovantes] erro na execução:', err)
    })
  }

  // Primeira execução logo após subir o servidor (com pequeno atraso para não
  // competir com a inicialização de conexões com o banco).
  setTimeout(executar, 10_000)

  setInterval(executar, intervalHoras * 60 * 60 * 1000)
}
