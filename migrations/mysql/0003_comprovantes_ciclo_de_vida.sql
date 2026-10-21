-- ============================================================
-- Ciclo de vida dos arquivos de comprovante (e galeria):
--
-- Requisito de negócio: o arquivo fica disponível para download
-- até que seja baixado pela primeira vez. A partir do primeiro
-- download, inicia-se uma contagem de 30 dias; passado esse prazo,
-- o arquivo é removido do armazenamento (Cloudflare R2) por um job
-- de limpeza em segundo plano que roda dentro do próprio processo
-- Node.js (ver src/jobs/limpeza-comprovantes.ts).
--
-- Arquivos NUNCA baixados permanecem guardados indefinidamente —
-- apenas o primeiro download dispara o relógio de expiração.
-- O registro em `comprovantes` (metadado) nunca é apagado, apenas
-- marcado como expirado — preserva-se o rastro de auditoria/
-- prestação de contas mesmo depois do arquivo binário ser removido.
-- ============================================================

ALTER TABLE comprovantes
  ADD COLUMN baixado_em DATETIME NULL AFTER created_at,
  ADD COLUMN expira_em DATETIME NULL AFTER baixado_em,
  ADD COLUMN expirado TINYINT(1) NOT NULL DEFAULT 0 AFTER expira_em;

CREATE INDEX idx_comprovantes_expira_em ON comprovantes (expira_em);
