-- ============================================================
-- Banco de TESTE (teste.nfp.social.br) — monta tudo do zero.
-- Rodar UMA vez no phpMyAdmin com o banco de TESTE selecionado
-- (nunca no banco de produção). Junta as migrations 0001 a 0008
-- e o seed. Login inicial: admin@nfp.org.br / admin123
-- (trocar a senha depois do primeiro acesso).
-- Gerado a partir de migrations/mysql/*.sql — não editar à mão.
-- ============================================================


-- >>>>> migrations/mysql/0001_initial_schema.sql
-- ============================================================
-- Sistema de Gestão Social (NFP) - Schema inicial (MySQL/MariaDB)
--
-- Convertido do schema original SQLite/D1 (migrations/0001_initial_schema.sql)
-- para rodar em MySQL (Hostinger). Diferenças principais:
--   - INTEGER PRIMARY KEY AUTOINCREMENT -> INT AUTO_INCREMENT PRIMARY KEY
--   - TEXT com UNIQUE/INDEX -> VARCHAR(n) (TEXT não pode ser indexado
--     sem tamanho de prefixo em InnoDB)
--   - REAL (dinheiro) -> DECIMAL(12,2) (evita erros de ponto flutuante)
--   - REFERENCES inline (ignorado por padrão no MySQL) -> cláusulas
--     FOREIGN KEY explícitas, para a integridade referencial ser
--     realmente aplicada
--   - Índices movidos para dentro do CREATE TABLE (KEY ...), para que
--     o script seja seguro de reexecutar (CREATE TABLE IF NOT EXISTS
--     não recria índices separados, que dariam erro de duplicidade)
--   - Requer MySQL 8.0.16+ ou MariaDB 10.2.1+ para os CHECK constraints
--     serem de fato aplicados (ambos amplamente disponíveis na Hostinger)
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

-- ===== AUTENTICAÇÃO =====
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  senha_hash VARCHAR(255) NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Papéis do usuário. Um usuário pode ter múltiplos papéis (ex.: coord_nucleo em vários núcleos = múltiplas linhas).
CREATE TABLE IF NOT EXISTS user_roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  role VARCHAR(20) NOT NULL,
  escopo_tipo VARCHAR(20) NULL,
  escopo_id INT NULL, -- nucleo_id quando role = coord_nucleo, NULL para os demais
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_roles_user (user_id),
  KEY idx_user_roles_escopo (role, escopo_id),
  CONSTRAINT chk_user_roles_role CHECK (role IN ('admin','coord_geral','coord_nucleo','articulador')),
  CONSTRAINT chk_user_roles_escopo_tipo CHECK (escopo_tipo IS NULL OR escopo_tipo IN ('nucleo')),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== NÚCLEOS E PROJETOS =====
CREATE TABLE IF NOT EXISTS nucleos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  descricao TEXT,
  slug_publico VARCHAR(255) NOT NULL,
  imagem_capa_key VARCHAR(500),
  criado_por INT NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_nucleos_slug (slug_publico),
  CONSTRAINT fk_nucleos_criado_por FOREIGN KEY (criado_por) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS projetos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nucleo_id INT NOT NULL,
  nome VARCHAR(255) NOT NULL,
  descricao TEXT,
  slug_publico VARCHAR(255) NOT NULL,
  imagem_capa_key VARCHAR(500),
  criado_por INT NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_projetos_slug (slug_publico),
  KEY idx_projetos_nucleo (nucleo_id),
  CONSTRAINT fk_projetos_nucleo FOREIGN KEY (nucleo_id) REFERENCES nucleos(id),
  CONSTRAINT fk_projetos_criado_por FOREIGN KEY (criado_por) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS projeto_galeria (
  id INT AUTO_INCREMENT PRIMARY KEY,
  projeto_id INT NOT NULL,
  r2_key VARCHAR(500) NOT NULL,
  legenda TEXT,
  ordem INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_galeria_projeto FOREIGN KEY (projeto_id) REFERENCES projetos(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Campanhas/promoções vinculadas a núcleo ou projeto (exibidas na landing pública)
CREATE TABLE IF NOT EXISTS destaques_publicos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nucleo_id INT NULL,
  projeto_id INT NULL,
  titulo VARCHAR(255) NOT NULL,
  descricao TEXT,
  tipo VARCHAR(30) NOT NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_por INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_destaques_tipo CHECK (tipo IN ('campanha','promocao','premiacao','chamada_colaborador')),
  CONSTRAINT fk_destaques_nucleo FOREIGN KEY (nucleo_id) REFERENCES nucleos(id),
  CONSTRAINT fk_destaques_projeto FOREIGN KEY (projeto_id) REFERENCES projetos(id),
  CONSTRAINT fk_destaques_criado_por FOREIGN KEY (criado_por) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== COLABORADORES (formulário público, sem login) =====
CREATE TABLE IF NOT EXISTS colaboradores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nucleo_id INT NULL,
  projeto_id INT NULL,
  nome VARCHAR(255) NOT NULL,
  cpf VARCHAR(20) NOT NULL,
  whatsapp VARCHAR(30) NOT NULL,
  status_portal_fazenda VARCHAR(20) NOT NULL,
  validado_por INT NULL,
  validado_em DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_colab_nucleo (nucleo_id),
  KEY idx_colab_projeto (projeto_id),
  CONSTRAINT chk_colab_status CHECK (status_portal_fazenda IN ('pleno','nao_pleno')),
  CONSTRAINT fk_colab_nucleo FOREIGN KEY (nucleo_id) REFERENCES nucleos(id),
  CONSTRAINT fk_colab_projeto FOREIGN KEY (projeto_id) REFERENCES projetos(id),
  CONSTRAINT fk_colab_validado_por FOREIGN KEY (validado_por) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== FINANCEIRO — LEDGER IMUTÁVEL (append-only) =====
CREATE TABLE IF NOT EXISTS financeiro_lancamentos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nivel VARCHAR(20) NOT NULL,
  nucleo_id INT NULL,
  projeto_id INT NULL,
  tipo VARCHAR(40) NOT NULL,
  valor DECIMAL(12,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pendente',
  finalidade TEXT,
  solicitado_por INT NULL,
  aprovado_por INT NULL,
  executado_por INT NULL,
  lancamento_origem_id INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  aprovado_em DATETIME NULL,
  executado_em DATETIME NULL,
  rejeitado_em DATETIME NULL,
  motivo_rejeicao TEXT,
  KEY idx_fin_nucleo (nucleo_id),
  KEY idx_fin_projeto (projeto_id),
  KEY idx_fin_status (status),
  KEY idx_fin_tipo (tipo),
  CONSTRAINT chk_fin_nivel CHECK (nivel IN ('geral','nucleo','projeto')),
  CONSTRAINT chk_fin_tipo CHECK (tipo IN ('entrada_nfp','repasse_geral_nucleo','repasse_nucleo_projeto','saida_pagamento')),
  CONSTRAINT chk_fin_valor CHECK (valor > 0),
  CONSTRAINT chk_fin_status CHECK (status IN ('pendente','aprovado','executado','rejeitado')),
  CONSTRAINT fk_fin_nucleo FOREIGN KEY (nucleo_id) REFERENCES nucleos(id),
  CONSTRAINT fk_fin_projeto FOREIGN KEY (projeto_id) REFERENCES projetos(id),
  CONSTRAINT fk_fin_solicitado_por FOREIGN KEY (solicitado_por) REFERENCES users(id),
  CONSTRAINT fk_fin_aprovado_por FOREIGN KEY (aprovado_por) REFERENCES users(id),
  CONSTRAINT fk_fin_executado_por FOREIGN KEY (executado_por) REFERENCES users(id),
  CONSTRAINT fk_fin_origem FOREIGN KEY (lancamento_origem_id) REFERENCES financeiro_lancamentos(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS comprovantes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lancamento_id INT NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  r2_key VARCHAR(500) NOT NULL,
  nome_arquivo VARCHAR(255),
  enviado_por INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_comprovantes_lancamento (lancamento_id),
  CONSTRAINT chk_comprovantes_tipo CHECK (tipo IN ('bancario','fiscal')),
  CONSTRAINT fk_comprovantes_lancamento FOREIGN KEY (lancamento_id) REFERENCES financeiro_lancamentos(id),
  CONSTRAINT fk_comprovantes_enviado_por FOREIGN KEY (enviado_por) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== AUDITORIA IMUTÁVEL (append-only, sem UPDATE/DELETE expostos) =====
CREATE TABLE IF NOT EXISTS audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  acao VARCHAR(100) NOT NULL,
  entidade VARCHAR(100) NOT NULL,
  entidade_id INT NULL,
  payload_json TEXT,
  ip VARCHAR(64),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_entidade (entidade, entidade_id),
  KEY idx_audit_user (user_id),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== COMUNICAÇÃO =====
CREATE TABLE IF NOT EXISTS campanhas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  titulo VARCHAR(255) NOT NULL,
  canal VARCHAR(20) NOT NULL,
  corpo_template TEXT NOT NULL,
  segmento_tipo VARCHAR(20) NOT NULL,
  segmento_id INT NULL,
  criado_por INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_campanhas_canal CHECK (canal IN ('email','whatsapp','ambos')),
  CONSTRAINT chk_campanhas_segmento CHECK (segmento_tipo IN ('nucleo','projeto','todos')),
  CONSTRAINT fk_campanhas_criado_por FOREIGN KEY (criado_por) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS campanha_envios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campanha_id INT NOT NULL,
  colaborador_id INT NULL,
  canal VARCHAR(20) NOT NULL,
  destino VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL,
  provider_response TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_envios_campanha (campanha_id),
  CONSTRAINT chk_envios_canal CHECK (canal IN ('email','whatsapp')),
  CONSTRAINT chk_envios_status CHECK (status IN ('enviado','falhou','lido')),
  CONSTRAINT fk_envios_campanha FOREIGN KEY (campanha_id) REFERENCES campanhas(id),
  CONSTRAINT fk_envios_colaborador FOREIGN KEY (colaborador_id) REFERENCES colaboradores(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS templates_mensagem (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  canal VARCHAR(20) NOT NULL,
  corpo TEXT NOT NULL,
  criado_por INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_templates_canal CHECK (canal IN ('email','whatsapp','ambos')),
  CONSTRAINT fk_templates_criado_por FOREIGN KEY (criado_por) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- >>>>> migrations/mysql/0002_views_saldo.sql
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


-- >>>>> migrations/mysql/0003_comprovantes_ciclo_de_vida.sql
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


-- >>>>> migrations/mysql/0004_importacao_nfp_e_usuarios.sql
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


-- >>>>> migrations/mysql/0005_lancamentos_manuais_geral.sql
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


-- >>>>> migrations/mysql/0006_arquivamento_financeiro_e_role_financeiro.sql
-- ============================================================
-- 1) Arquivamento de Núcleos/Projetos (distinto de "inativo" comum):
--    `arquivado_em` marca que o registro foi formalmente encerrado
--    (porque já teve movimentação financeira histórica, então não
--    pode ser excluído fisicamente sem perder o rastro). Núcleos/
--    projetos SEM nenhum histórico financeiro podem ser excluídos
--    de verdade (DELETE) em vez de arquivados.
-- ============================================================

ALTER TABLE nucleos
  ADD COLUMN arquivado_em DATETIME NULL AFTER ativo,
  ADD COLUMN arquivado_por INT NULL AFTER arquivado_em,
  ADD CONSTRAINT fk_nucleos_arquivado_por FOREIGN KEY (arquivado_por) REFERENCES users(id);

ALTER TABLE projetos
  ADD COLUMN arquivado_em DATETIME NULL AFTER ativo,
  ADD COLUMN arquivado_por INT NULL AFTER arquivado_em,
  ADD CONSTRAINT fk_projetos_arquivado_por FOREIGN KEY (arquivado_por) REFERENCES users(id);

-- ============================================================
-- 2) Arquivamento manual de comprovantes pelo papel "financeiro"
--    (ou admin): diferente da expiração automática de 30 dias após
--    download — aqui é uma ação deliberada ("já conferi, pode
--    arquivar"), que remove o binário do R2 desde já, preservando
--    o metadado para auditoria.
-- ============================================================

ALTER TABLE comprovantes
  ADD COLUMN arquivado_em DATETIME NULL AFTER expirado,
  ADD COLUMN arquivado_por INT NULL AFTER arquivado_em,
  ADD CONSTRAINT fk_comprovantes_arquivado_por FOREIGN KEY (arquivado_por) REFERENCES users(id);

-- ============================================================
-- 3) Guarda o arquivo CSV original de cada importação NFP no R2,
--    para permitir "baixar a planilha" depois (auditoria/conferência),
--    sem precisar listar as milhares de linhas individuais na tela.
-- ============================================================

ALTER TABLE financeiro_importacoes_nfp
  ADD COLUMN arquivo_original_key VARCHAR(500) NULL AFTER nome_arquivo;

-- ============================================================
-- 4) Novo papel "financeiro": visão 360° de todas as operações
--    financeiras (Geral/Núcleo/Projeto), pode baixar e arquivar
--    comprovantes, e anexar comprovante de pagamento quando ele
--    próprio executa um repasse/saída. NÃO tem acesso a gestão de
--    usuários, núcleos/projetos (CRUD) ou comunicação.
-- ============================================================

ALTER TABLE user_roles DROP CONSTRAINT chk_user_roles_role;
ALTER TABLE user_roles ADD CONSTRAINT chk_user_roles_role
  CHECK (role IN ('admin','coord_geral','coord_nucleo','articulador','financeiro'));

-- ============================================================
-- 5) Faturas de repasse: ao executar um repasse (Geral->Núcleo ou
--    Núcleo->Projeto), deixa de ser obrigatório anexar comprovante
--    bancário — em vez disso, o sistema gera uma fatura (documento
--    simples, imprimível/PDF via navegador) que pode ser enviada ao
--    coordenador do núcleo responsável.
-- ============================================================

CREATE TABLE IF NOT EXISTS financeiro_faturas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lancamento_id INT NOT NULL,
  numero VARCHAR(50) NOT NULL,
  nucleo_id INT NULL,
  projeto_id INT NULL,
  valor DECIMAL(12,2) NOT NULL,
  finalidade TEXT,
  gerado_por INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  enviada_em DATETIME NULL,
  enviada_para VARCHAR(255) NULL,
  UNIQUE KEY uq_faturas_lancamento (lancamento_id),
  CONSTRAINT fk_faturas_lancamento FOREIGN KEY (lancamento_id) REFERENCES financeiro_lancamentos(id),
  CONSTRAINT fk_faturas_nucleo FOREIGN KEY (nucleo_id) REFERENCES nucleos(id),
  CONSTRAINT fk_faturas_projeto FOREIGN KEY (projeto_id) REFERENCES projetos(id),
  CONSTRAINT fk_faturas_gerado_por FOREIGN KEY (gerado_por) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- >>>>> migrations/mysql/0007_papel_unico_e_ajustes_rbac.sql
-- ============================================================
-- Migration 0007: papel único por usuário + ajustes de fronteiras
-- de RBAC entre os papéis (Coordenador Geral perde acesso ao
-- financeiro; Financeiro passa a aprovar/executar repasses;
-- Coordenador de Núcleo passa a poder solicitar repasse do Geral
-- para o seu próprio núcleo).
--
-- Esta migration só adiciona uma constraint de unicidade — nenhuma
-- coluna nova. As mudanças de regra de negócio (quem aprova o quê)
-- vivem no código das rotas (src/modules/.../routes.ts), não no
-- schema.
-- ============================================================

-- Garante que cada usuário possua, no máximo, UM papel (user_roles.user_id
-- único). Antes de aplicar, confirme que não há usuário com múltiplas
-- linhas em user_roles (rode a query abaixo — deve retornar 0 linhas):
--   SELECT user_id, COUNT(*) FROM user_roles GROUP BY user_id HAVING COUNT(*) > 1;
ALTER TABLE user_roles
  ADD UNIQUE KEY uq_user_roles_user_id (user_id);


-- >>>>> migrations/mysql/0008_dados_bancarios_e_comprovante_deposito.sql
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


-- >>>>> migrations/mysql/seed.sql
-- ============================================================
-- Seed inicial: usuário Administrador padrão + dados de exemplo
-- Login: admin@nfp.org.br / Senha: admin123
-- IMPORTANTE: trocar a senha em produção.
--
-- Convertido de seed.sql (SQLite "INSERT OR IGNORE") para MySQL
-- ("INSERT IGNORE").
-- ============================================================

INSERT IGNORE INTO users (id, nome, email, senha_hash, ativo) VALUES
  (1, 'Administrador Master', 'admin@nfp.org.br', 'pbkdf2$100000$ep4vOZkR6PtylF0jbv2mLA==$rF7mNkFjmy4uxRIuVujMxJBL1vFjsTNbWS07OnKXi2Y=', 1);

INSERT IGNORE INTO user_roles (user_id, role, escopo_tipo, escopo_id) VALUES
  (1, 'admin', NULL, NULL);

-- Núcleo de exemplo
INSERT IGNORE INTO nucleos (id, nome, descricao, slug_publico, criado_por) VALUES
  (1, 'Núcleo Zona Leste', 'Núcleo social responsável pela região da Zona Leste de São Paulo.', 'nucleo-zona-leste', 1);

-- Projeto de exemplo
INSERT IGNORE INTO projetos (id, nucleo_id, nome, descricao, slug_publico, criado_por) VALUES
  (1, 1, 'Projeto Alimenta SP', 'Distribuição de cestas básicas para famílias em vulnerabilidade.', 'projeto-alimenta-sp', 1);

-- Destaque público de exemplo
INSERT IGNORE INTO destaques_publicos (nucleo_id, titulo, descricao, tipo, criado_por) VALUES
  (1, 'Seja um colaborador!', 'Cadastre sua Nota Fiscal Paulista e ajude nosso núcleo a arrecadar mais recursos.', 'chamada_colaborador', 1);

