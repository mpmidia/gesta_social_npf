-- ============================================================
-- Sistema de Gestão NFP - Schema inicial
-- ============================================================

-- ===== AUTENTICAÇÃO =====
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Papéis do usuário. Um usuário pode ter múltiplos papéis (ex.: coord_nucleo em vários núcleos = múltiplas linhas).
CREATE TABLE IF NOT EXISTS user_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin','coord_geral','coord_nucleo','articulador')),
  escopo_tipo TEXT CHECK (escopo_tipo IN ('nucleo')),
  escopo_id INTEGER, -- nucleo_id quando role = coord_nucleo, NULL para os demais
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_escopo ON user_roles(role, escopo_id);

-- ===== NÚCLEOS E PROJETOS =====
CREATE TABLE IF NOT EXISTS nucleos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT,
  slug_publico TEXT UNIQUE NOT NULL,
  imagem_capa_key TEXT,
  criado_por INTEGER NOT NULL REFERENCES users(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projetos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nucleo_id INTEGER NOT NULL REFERENCES nucleos(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  slug_publico TEXT UNIQUE NOT NULL,
  imagem_capa_key TEXT,
  criado_por INTEGER NOT NULL REFERENCES users(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_projetos_nucleo ON projetos(nucleo_id);

CREATE TABLE IF NOT EXISTS projeto_galeria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projeto_id INTEGER NOT NULL REFERENCES projetos(id),
  r2_key TEXT NOT NULL,
  legenda TEXT,
  ordem INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Campanhas/promoções vinculadas a núcleo ou projeto (exibidas na landing pública)
CREATE TABLE IF NOT EXISTS destaques_publicos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nucleo_id INTEGER REFERENCES nucleos(id),
  projeto_id INTEGER REFERENCES projetos(id),
  titulo TEXT NOT NULL,
  descricao TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('campanha','promocao','premiacao','chamada_colaborador')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_por INTEGER NOT NULL REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ===== COLABORADORES (formulário público, sem login) =====
CREATE TABLE IF NOT EXISTS colaboradores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nucleo_id INTEGER REFERENCES nucleos(id),
  projeto_id INTEGER REFERENCES projetos(id),
  nome TEXT NOT NULL,
  cpf TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  status_portal_fazenda TEXT NOT NULL CHECK (status_portal_fazenda IN ('pleno','nao_pleno')),
  validado_por INTEGER REFERENCES users(id),
  validado_em DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_colab_nucleo ON colaboradores(nucleo_id);
CREATE INDEX IF NOT EXISTS idx_colab_projeto ON colaboradores(projeto_id);

-- ===== FINANCEIRO — LEDGER IMUTÁVEL (append-only) =====
CREATE TABLE IF NOT EXISTS financeiro_lancamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nivel TEXT NOT NULL CHECK (nivel IN ('geral','nucleo','projeto')),
  nucleo_id INTEGER REFERENCES nucleos(id),
  projeto_id INTEGER REFERENCES projetos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada_nfp','repasse_geral_nucleo','repasse_nucleo_projeto','saida_pagamento')),
  valor REAL NOT NULL CHECK (valor > 0),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado','executado','rejeitado')),
  finalidade TEXT,
  solicitado_por INTEGER REFERENCES users(id),
  aprovado_por INTEGER REFERENCES users(id),
  executado_por INTEGER REFERENCES users(id),
  lancamento_origem_id INTEGER REFERENCES financeiro_lancamentos(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  aprovado_em DATETIME,
  executado_em DATETIME,
  rejeitado_em DATETIME,
  motivo_rejeicao TEXT
);
CREATE INDEX IF NOT EXISTS idx_fin_nucleo ON financeiro_lancamentos(nucleo_id);
CREATE INDEX IF NOT EXISTS idx_fin_projeto ON financeiro_lancamentos(projeto_id);
CREATE INDEX IF NOT EXISTS idx_fin_status ON financeiro_lancamentos(status);
CREATE INDEX IF NOT EXISTS idx_fin_tipo ON financeiro_lancamentos(tipo);

CREATE TABLE IF NOT EXISTS comprovantes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lancamento_id INTEGER NOT NULL REFERENCES financeiro_lancamentos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('bancario','fiscal')),
  r2_key TEXT NOT NULL,
  nome_arquivo TEXT,
  enviado_por INTEGER NOT NULL REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_comprovantes_lancamento ON comprovantes(lancamento_id);

-- ===== AUDITORIA IMUTÁVEL (append-only, sem UPDATE/DELETE expostos) =====
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  acao TEXT NOT NULL,
  entidade TEXT NOT NULL,
  entidade_id INTEGER,
  payload_json TEXT,
  ip TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_entidade ON audit_log(entidade, entidade_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

-- ===== COMUNICAÇÃO =====
CREATE TABLE IF NOT EXISTS campanhas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  canal TEXT NOT NULL CHECK (canal IN ('email','whatsapp','ambos')),
  corpo_template TEXT NOT NULL,
  segmento_tipo TEXT NOT NULL CHECK (segmento_tipo IN ('nucleo','projeto','todos')),
  segmento_id INTEGER,
  criado_por INTEGER NOT NULL REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campanha_envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campanha_id INTEGER NOT NULL REFERENCES campanhas(id),
  colaborador_id INTEGER REFERENCES colaboradores(id),
  canal TEXT NOT NULL CHECK (canal IN ('email','whatsapp')),
  destino TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enviado','falhou','lido')),
  provider_response TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_envios_campanha ON campanha_envios(campanha_id);

CREATE TABLE IF NOT EXISTS templates_mensagem (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  canal TEXT NOT NULL CHECK (canal IN ('email','whatsapp','ambos')),
  corpo TEXT NOT NULL,
  criado_por INTEGER NOT NULL REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
