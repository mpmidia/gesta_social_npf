-- ============================================================
-- Lançamentos manuais no Painel Geral (correções/ajustes além da
-- importação automática da planilha NFP). Dois novos tipos:
--   entrada_manual  -> soma ao saldo geral
--   saida_manual    -> subtrai do saldo geral
-- Também adiciona o status 'cancelado' (soft-delete de lançamento
-- manual: mantém o registro para auditoria, mas exclui do saldo).
-- As CHECK CONSTRAINTS originais (chk_fin_tipo, chk_fin_status)
-- precisam ser recriadas para liberar os novos valores, e a view
-- saldo_geral precisa ser recriada para considerar os novos tipos
-- no cálculo do saldo disponível.
-- ============================================================

ALTER TABLE financeiro_lancamentos DROP CONSTRAINT chk_fin_tipo;
ALTER TABLE financeiro_lancamentos ADD CONSTRAINT chk_fin_tipo
  CHECK (tipo IN ('entrada_nfp','entrada_manual','saida_manual','repasse_geral_nucleo','repasse_nucleo_projeto','saida_pagamento'));

ALTER TABLE financeiro_lancamentos DROP CONSTRAINT chk_fin_status;
ALTER TABLE financeiro_lancamentos ADD CONSTRAINT chk_fin_status
  CHECK (status IN ('pendente','aprovado','executado','rejeitado','cancelado'));

DROP VIEW IF EXISTS saldo_geral;
CREATE VIEW saldo_geral AS
SELECT
  (SELECT COALESCE(SUM(valor), 0) FROM financeiro_lancamentos WHERE tipo = 'entrada_nfp' AND status = 'executado')
  + (SELECT COALESCE(SUM(valor), 0) FROM financeiro_lancamentos WHERE tipo = 'entrada_manual' AND status = 'executado')
  - (SELECT COALESCE(SUM(valor), 0) FROM financeiro_lancamentos WHERE tipo = 'saida_manual' AND status = 'executado')
  - (SELECT COALESCE(SUM(valor), 0) FROM financeiro_lancamentos WHERE tipo = 'repasse_geral_nucleo' AND status = 'executado')
  AS saldo;
