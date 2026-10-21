-- ============================================================
-- 1) Importação de créditos NFP (Financeiro Geral)
--
-- Regra de negócio: o Painel Geral do financeiro NÃO recebe mais
-- lançamentos manuais de entrada — a única forma de lançar entrada
-- no Geral passa a ser a importação da planilha exportada do site
-- da Nota Fiscal Paulista (colunas: CNPJ emit., Emitente, No.,
-- Data Emissão, Valor NF, Data Registro, Créditos, Situação do
-- Crédito).
--
-- Cada LINHA elegível da planilha (Créditos > 0 e Situação diferente
-- de "A Calcular") vira uma linha em `financeiro_creditos_nfp`, que é
-- a fonte de verdade para dedup. Cada upload de arquivo também fica
-- registrado em `financeiro_importacoes_nfp`, para auditoria/histórico
-- (quantas linhas vieram, quantas foram novas, quantas já existiam).
--
-- Deduplicação: como a mesma planilha "ConsultaNFP_xxx.csv" é
-- reexportada todo mês (acumulando o período inteiro, não só o mês),
-- reimportá-la não pode duplicar lançamentos já processados. A chave
-- de duplicidade é o hash de TODOS os campos da linha original
-- (cnpj_emitente + numero_nf + data_emissao + valor_nf + data_registro
-- + creditos + situacao) — se qualquer campo mudar (ex.: a situação
-- de uma nota passar de "A Calcular" para um valor definitivo), a
-- linha é tratada como NOVA (pois antes ela nem teria sido elegível
-- para lançamento, já que estava "A Calcular"/zerada).
-- ============================================================

CREATE TABLE IF NOT EXISTS financeiro_importacoes_nfp (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome_arquivo VARCHAR(255) NOT NULL,
  total_linhas_arquivo INT NOT NULL DEFAULT 0,
  linhas_elegiveis INT NOT NULL DEFAULT 0,
  linhas_novas INT NOT NULL DEFAULT 0,
  linhas_duplicadas INT NOT NULL DEFAULT 0,
  linhas_ignoradas_zero_ou_a_calcular INT NOT NULL DEFAULT 0,
  valor_total_importado DECIMAL(12,2) NOT NULL DEFAULT 0,
  importado_por INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_importacoes_nfp_user FOREIGN KEY (importado_por) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS financeiro_creditos_nfp (
  id INT AUTO_INCREMENT PRIMARY KEY,
  linha_hash CHAR(64) NOT NULL,
  cnpj_emitente VARCHAR(32) NOT NULL,
  emitente VARCHAR(255) NOT NULL,
  numero_nf VARCHAR(50) NOT NULL,
  data_emissao DATE NOT NULL,
  valor_nf DECIMAL(12,2) NOT NULL,
  data_registro DATE NOT NULL,
  creditos DECIMAL(12,2) NOT NULL,
  situacao_credito VARCHAR(50) NOT NULL,
  lancamento_id INT NOT NULL,
  importacao_id INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_creditos_nfp_hash (linha_hash),
  KEY idx_creditos_nfp_importacao (importacao_id),
  CONSTRAINT fk_creditos_nfp_lancamento FOREIGN KEY (lancamento_id) REFERENCES financeiro_lancamentos(id),
  CONSTRAINT fk_creditos_nfp_importacao FOREIGN KEY (importacao_id) REFERENCES financeiro_importacoes_nfp(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 2) Gestão de usuários: suporte a edição e exclusão definitiva.
--
-- `excluido_em` permite "soft delete" quando o usuário já possui
-- histórico vinculado (lançamentos financeiros, auditoria etc. têm
-- FK para users.id — apagar a linha fisicamente quebraria o rastro
-- de quem fez o quê). Quando o usuário NUNCA teve nenhuma ação
-- vinculada em nenhuma tabela com FK para users, a exclusão pode ser
-- física (DELETE real) — a rota de exclusão decide isso dinamicamente.
-- ============================================================

ALTER TABLE users
  ADD COLUMN excluido_em DATETIME NULL AFTER ativo;
