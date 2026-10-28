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
