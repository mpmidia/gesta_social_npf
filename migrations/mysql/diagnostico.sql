-- ============================================================
-- Diagnóstico SOMENTE LEITURA (não altera nada). Rodar no phpMyAdmin
-- com o banco de produção selecionado, um bloco por vez.
-- ============================================================

-- 1) Migrations aplicadas? (ok = 1 aplicada, 0 faltando)
SELECT '0003 comprovantes.expira_em' AS item, (COUNT(*) > 0) AS ok FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comprovantes' AND COLUMN_NAME = 'expira_em'
UNION ALL SELECT '0004 tabela financeiro_creditos_nfp', (COUNT(*) > 0) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'financeiro_creditos_nfp'
UNION ALL SELECT '0004 users.excluido_em', (COUNT(*) > 0) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'excluido_em'
UNION ALL SELECT '0005 view saldo_geral com manuais', (COUNT(*) > 0) FROM information_schema.VIEWS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'saldo_geral' AND VIEW_DEFINITION LIKE '%saida_manual%'
UNION ALL SELECT '0006 nucleos.arquivado_em', (COUNT(*) > 0) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nucleos' AND COLUMN_NAME = 'arquivado_em'
UNION ALL SELECT '0006 tabela financeiro_faturas', (COUNT(*) > 0) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'financeiro_faturas'
UNION ALL SELECT '0006 importacoes.arquivo_original_key', (COUNT(*) > 0) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'financeiro_importacoes_nfp' AND COLUMN_NAME = 'arquivo_original_key'
UNION ALL SELECT '0007 user_roles único por usuário', (COUNT(*) > 0) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND INDEX_NAME = 'uq_user_roles_user_id'
UNION ALL SELECT '0008 users.pix_chave', (COUNT(*) > 0) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'pix_chave'
UNION ALL SELECT '0008 comprovantes.visualizado_em', (COUNT(*) > 0) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comprovantes' AND COLUMN_NAME = 'visualizado_em';

-- 2) CHECK constraints atuais (conferir se 'financeiro' e 'deposito' aparecem)
SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND CONSTRAINT_NAME IN ('chk_user_roles_role', 'chk_comprovantes_tipo', 'chk_fin_tipo', 'chk_fin_status');

-- 3) Usuários: papel e vínculo de núcleo (escopo apontando para núcleo inexistente aparece como nucleo_existe = 0)
SELECT u.id, u.email, u.ativo, u.excluido_em, ur.role, ur.escopo_id,
       (n.id IS NOT NULL) AS nucleo_existe
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN nucleos n ON n.id = ur.escopo_id
  ORDER BY u.id;

-- 4) Saldos negativos (deve voltar vazio)
SELECT 'geral' AS nivel, NULL AS id, saldo FROM saldo_geral WHERE saldo < 0
UNION ALL SELECT 'nucleo', nucleo_id, saldo FROM saldo_nucleo WHERE saldo < 0
UNION ALL SELECT 'projeto', projeto_id, saldo FROM saldo_projeto WHERE saldo < 0;

-- 5) Saídas executadas sem os 2 comprovantes (deve voltar vazio)
SELECT l.id, l.projeto_id, l.valor, l.executado_em, COUNT(cp.id) AS comprovantes
  FROM financeiro_lancamentos l
  LEFT JOIN comprovantes cp ON cp.lancamento_id = l.id AND cp.tipo IN ('bancario', 'fiscal')
  WHERE l.tipo = 'saida_pagamento' AND l.status = 'executado'
  GROUP BY l.id, l.projeto_id, l.valor, l.executado_em
  HAVING COUNT(cp.id) < 2;

-- 6) Contagem por tabela (para saber o que existe em produção)
SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME;
