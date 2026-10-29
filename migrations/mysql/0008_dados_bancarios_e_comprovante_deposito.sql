-- ============================================================
-- Migration 0008: dados bancários/PIX do coordenador + comprovante
-- de depósito no fluxo de repasse.
--
-- Contexto de negócio:
--   1. O coordenador de núcleo precisa cadastrar onde o repasse deve
--      ser depositado (dados bancários e/ou chave PIX), para que o
--      financeiro/admin saiba para onde enviar o dinheiro ao executar
--      um repasse aprovado.
--   2. Ao executar um repasse, financeiro/admin agora anexam um
--      comprovante de depósito (arquivo) — reaproveita a tabela
--      `comprovantes` já existente, mas precisa de um novo valor de
--      `tipo` ('deposito') distinto de 'bancario'/'fiscal' (que são
--      os comprovantes de SAÍDA de projeto).
--   3. O comprovante de depósito tem uma política de retenção
--      DIFERENTE da dos comprovantes de saída: não expira ao ser
--      baixado/visualizado (o coordenador pode visualizar quantas
--      vezes quiser), mas expira 6 meses após a execução do repasse.
--      Para isso, `expira_em` é preenchido no momento da execução
--      (não no momento do download) e uma nova coluna `visualizavel`
--      marca que este comprovante não deve ser apagado por ação de
--      download do destinatário coord_nucleo.
-- ============================================================

-- 1) Dados bancários/PIX no cadastro do usuário (qualquer usuário pode
--    ter, mas o uso principal é o coordenador de núcleo).
ALTER TABLE users
  ADD COLUMN banco VARCHAR(100) NULL AFTER senha_hash,
  ADD COLUMN agencia VARCHAR(20) NULL AFTER banco,
  ADD COLUMN conta VARCHAR(30) NULL AFTER agencia,
  ADD COLUMN tipo_conta VARCHAR(20) NULL AFTER conta,
  ADD COLUMN pix_chave VARCHAR(140) NULL AFTER tipo_conta;

-- 2) Novo tipo de comprovante: 'deposito' (comprovante de depósito do
--    repasse, anexado por financeiro/admin ao executar).
--    OBS: "DROP CHECK" não é aceito pela sintaxe desta versão do
--    MySQL/MariaDB — a forma correta é "DROP CONSTRAINT".
ALTER TABLE comprovantes
  DROP CONSTRAINT chk_comprovantes_tipo;

ALTER TABLE comprovantes
  ADD CONSTRAINT chk_comprovantes_tipo CHECK (tipo IN ('bancario','fiscal','deposito'));

-- 3) Coluna para marcar comprovantes que não devem ser apagados ao
--    serem visualizados (ex.: comprovante de depósito visto pelo
--    coord_nucleo) — distingue da semântica atual de "baixado_em
--    dispara expiração em 30 dias" usada pelos comprovantes de saída.
ALTER TABLE comprovantes
  ADD COLUMN visualizado_em DATETIME NULL AFTER baixado_em;
