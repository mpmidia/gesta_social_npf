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
