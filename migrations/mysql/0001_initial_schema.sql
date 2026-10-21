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
