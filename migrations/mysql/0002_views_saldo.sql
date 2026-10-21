-- ============================================================
-- Views de saldo (calculadas dinamicamente, nunca armazenadas
-- como campo mutável — sempre derivadas do ledger imutável)
--
-- Sintaxe praticamente idêntica ao SQLite original; MySQL também
-- suporta DROP VIEW IF EXISTS e subqueries escalares em SELECT.
-- ============================================================

DROP VIEW IF EXISTS saldo_geral;
CREATE VIEW saldo_geral AS
SELECT
  (SELECT COALESCE(SUM(valor), 0) FROM financeiro_lancamentos WHERE tipo = 'entrada_nfp' AND status = 'executado')
  - (SELECT COALESCE(SUM(valor), 0) FROM financeiro_lancamentos WHERE tipo = 'repasse_geral_nucleo' AND status = 'executado')
  AS saldo;

DROP VIEW IF EXISTS saldo_nucleo;
CREATE VIEW saldo_nucleo AS
SELECT
  n.id AS nucleo_id,
  COALESCE((SELECT SUM(valor) FROM financeiro_lancamentos WHERE nucleo_id = n.id AND tipo = 'repasse_geral_nucleo' AND status = 'executado'), 0)
  - COALESCE((SELECT SUM(valor) FROM financeiro_lancamentos WHERE nucleo_id = n.id AND tipo = 'repasse_nucleo_projeto' AND status = 'executado'), 0)
  AS saldo
FROM nucleos n;

DROP VIEW IF EXISTS saldo_projeto;
CREATE VIEW saldo_projeto AS
SELECT
  p.id AS projeto_id,
  COALESCE((SELECT SUM(valor) FROM financeiro_lancamentos WHERE projeto_id = p.id AND tipo = 'repasse_nucleo_projeto' AND status = 'executado'), 0)
  - COALESCE((SELECT SUM(valor) FROM financeiro_lancamentos WHERE projeto_id = p.id AND tipo = 'saida_pagamento' AND status = 'executado'), 0)
  AS saldo
FROM projetos p;
