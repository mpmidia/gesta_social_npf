# Gestão Social (NFP)

## Visão Geral
Sistema de gestão de rede (RBAC) para o programa Nota Fiscal Paulista, com
hierarquia financeira Geral → Núcleo → Projeto.

- **Stack**: Hono + Node.js (`@hono/node-server`) + MySQL (Hostinger), storage via Cloudflare R2 (API S3).
- **Deploy**: Hostinger hPanel, auto-deploy via push no GitHub (`mpmidia/gesta_social_npf`, branch `main`).
- **Domínio produção**: https://nfp.social.br

## Papéis (RBAC)
admin, coord_geral, coord_nucleo, articulador, financeiro — um papel por usuário.

## Novidades desta sessão

1. **Meu Perfil (autosserviço)**: qualquer usuário autenticado agora pode
   consultar/editar seu nome, e-mail, dados bancários (banco, agência, conta,
   tipo de conta) e chave PIX, além de trocar a própria senha (exige senha
   atual). Rotas: `GET/PUT /api/auth/me/perfil` e `/me`, `POST /api/auth/me/senha`.
   Acessível pelo menu lateral "Meu Perfil" (todos os papéis).
2. **Bug do menu Núcleos corrigido**: coordenador de núcleo via "Editar"
   aparecendo mas sempre falhando com 403. Agora o botão "Editar"/"Excluir"
   só aparece para admin/coord_geral (`canEditNucleo`); coord_nucleo continua
   com acesso de visualização e ao botão "Novo projeto".
3. **"Meu Financeiro (Núcleo)" removido** do menu do coord_nucleo (confirmado,
   já estava ausente desde a sessão anterior).
4. **Repasse com comprovante de depósito**: ao executar um repasse aprovado,
   financeiro/admin agora preenchem um formulário multipart com o
   **comprovante de depósito** (obrigatório) e, opcionalmente, e-mail para
   envio da fatura. A tela de execução também mostra os dados bancários/PIX
   cadastrados pelo coordenador destinatário (nova rota
   `GET /api/financeiro/repasses/:id/destinatario`). O comprovante é salvo
   com `tipo='deposito'` na tabela `comprovantes` e `expira_em` já definido
   para **6 meses após a execução** (não depende de download).
5. **Visualização de comprovante de depósito pelo coord_nucleo**: nova rota
   `GET /api/financeiro/comprovantes/:id/visualizar`, restrita a
   admin/financeiro/coord_nucleo do escopo do núcleo, que **não dispara**
   a lógica de expiração por download (diferente da rota `/arquivo`, usada
   pelos comprovantes de saída). Expira automaticamente 6 meses após a
   execução do repasse via o job de limpeza existente.
6. **Bug do lançamento de saída CORRIGIDO**: o formulário de saída de
   pagamento e o de upload de galeria enviavam `Content-Type:
   multipart/form-data` manualmente (sem o parâmetro `boundary`), quebrando
   o parsing de `c.req.formData()` no backend e retornando 422. Removido o
   header manual nos dois lugares — agora o axios define o Content-Type
   correto automaticamente.

### Banco de dados — nova migration
`migrations/mysql/0008_dados_bancarios_e_comprovante_deposito.sql`:
- Novas colunas em `users`: `banco`, `agencia`, `conta`, `tipo_conta`, `pix_chave`.
- `comprovantes.tipo` agora aceita `'deposito'` (além de `'bancario'`/`'fiscal'`).
- Nova coluna `comprovantes.visualizado_em` (auditoria, não dispara expiração).

**IMPORTANTE**: esta migration precisa ser aplicada manualmente no MySQL de
produção (Hostinger) antes/durante o deploy — não há runner automático de
migrations neste projeto. Rodar o conteúdo do arquivo via phpMyAdmin/CLI MySQL
da Hostinger.

## Regras de retenção de comprovantes
- **Comprovante de saída de projeto** (`bancario`/`fiscal`): disponível até o
  primeiro download por admin/financeiro; a partir daí expira em 30 dias
  (`RETENCAO_APOS_DOWNLOAD_DIAS`), removido do R2 pelo job
  `src/jobs/limpeza-comprovantes.ts`. Pode ser arquivado manualmente antes disso.
- **Comprovante de depósito de repasse** (`deposito`): expira 6 meses após a
  EXECUÇÃO do repasse (não depende de download/visualização). Visualizável
  livremente pelo coordenador de núcleo destinatário via rota dedicada.

## Pendências / próximos passos
- Validar manualmente em produção o fluxo completo: solicitar repasse →
  aprovar → executar com comprovante → coord_nucleo visualiza no painel.
- Testar a expiração de 6 meses e 30 dias via manipulação direta de
  `expira_em` no banco + execução manual de `limparComprovantesExpirados()`
  (não foi possível validar localmente devido ao mock do R2 local sem
  credenciais reais — `ENOTFOUND mock.s3.auto.amazonaws.com`, limitação de
  ambiente já conhecida de sessões anteriores).
- Aplicar a migration 0008 no MySQL de produção.
- Avaliar se o fluxo de "fatura" (PDF/HTML imprimível) deve ser simplificado
  agora que o comprovante de depósito real passou a ser anexado.

## Deploy
- **Plataforma**: Hostinger (Node.js + MySQL), auto-deploy via push no GitHub.
- **Status**: ✅ Código local buildado e testado (exceto upload real, bloqueado
  pelo mock do R2 local); aguardando push + confirmação de auto-deploy.
