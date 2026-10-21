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
