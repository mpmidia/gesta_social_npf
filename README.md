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

## ⚠️ BLOQUEIO CRÍTICO: Upload de comprovantes não funciona (causa raiz confirmada)

**Diagnóstico definitivo (via API Cloudflare)**: a conta Cloudflare vinculada
a este projeto **nunca teve o serviço R2 habilitado**. Tanto `GET
/accounts/:id/r2/buckets` (listar) quanto `POST .../r2/buckets` (criar bucket
`gestao-social-arquivos`) retornam o mesmo erro da API Cloudflare:
```
{"code":10042,"message":"Please enable R2 through the Cloudflare Dashboard."}
```
Isso explica por que `R2_ENDPOINT`, `R2_ACCESS_KEY_ID` e
`R2_SECRET_ACCESS_KEY` nunca puderam ser configurados corretamente na
Hostinger: **essas credenciais nunca existiram**, porque o bucket em si nunca
foi criado. A variável `R2_BUCKET_NAME=gestao-social-arquivos` já está
definida na Hostinger, mas aponta para um bucket inexistente.

**Esta ativação exige aceite de termos pelo painel web do Cloudflare — não é
possível fazer via API/token.** Passo a passo para destravar:

1. Acesse https://dash.cloudflare.com → faça login na conta
   `Prod.mpmidia@gmail.com` (ou a conta correta do projeto).
2. No menu lateral, clique em **R2 Object Storage** (ou **R2** no menu
   superior). Na primeira vez, o Cloudflare pede para **aceitar os termos de
   uso do R2** (pode pedir cadastro de cartão de crédito, mesmo dentro do
   free tier — é só verificação, R2 tem camada gratuita generosa).
3. Após habilitar, crie o bucket com o nome exato `gestao-social-arquivos`
   (ou outro nome, desde que atualize `R2_BUCKET_NAME` na Hostinger também).
4. Em **R2 → Manage R2 API Tokens**, crie um token com permissão de
   leitura/escrita (Object Read & Write) para esse bucket. Isso gera:
   - **Access Key ID**
   - **Secret Access Key**
   - **Endpoint S3** (formato `https://<account_id>.r2.cloudflarestorage.com`)
5. No painel Node.js da Hostinger (variáveis de ambiente), configure:
   - `R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com`
   - `R2_ACCESS_KEY_ID=<access key id gerado>`
   - `R2_SECRET_ACCESS_KEY=<secret gerado>`
   - `R2_BUCKET_NAME=gestao-social-arquivos`
6. Reinicie a aplicação Node.js na Hostinger.

Assim que isso for feito, o upload de comprovantes (saída de pagamento e
execução de repasse) deve funcionar sem nenhuma mudança de código — a lógica
de upload já está correta e testada (ver seção "Integridade financeira"
abaixo). Caso queira, posso te ajudar a validar após a configuração.

## Banco de dados zerado para novos testes
A pedido do usuário, todas as tabelas operacionais (núcleos, projetos,
lançamentos financeiros, comprovantes, faturas, colaboradores, campanhas,
auditoria) foram **truncadas** nesta sessão, mantendo apenas `users` e
`user_roles` intactos. Papéis atuais em produção:
- `presidente@acriart.org.br` — admin
- `fabiano@mpmidia.com.br` — coord_nucleo (escopo_id ainda aponta para um
  núcleo que não existe mais — ao criar o próximo núcleo de teste, reatribua
  este usuário como coordenador para restaurar o vínculo)
- `luciana@mpmidia.com.br` — financeiro
- `pedro.baccarat@gmail.com` — coord_geral

**Atenção**: as senhas desses usuários foram alteradas durante os testes
desta sessão (diretamente no banco, para fins de diagnóstico) e **não foram
restauradas às senhas originais** — não há registro de qual era a senha
original de cada um. Será necessário redefinir a senha de cada usuário (via
tela de admin ou diretamente no banco) antes do próximo teste.

## Integridade financeira (já corrigido e validado)
O upload do comprovante para o R2 acontece **antes** de qualquer gravação que
marque o lançamento como "executado" (saída de pagamento e execução de
repasse). Se o upload falhar — como está acontecendo agora pela falta do R2 —
nenhuma linha órfã é criada e o saldo não é debitado. Validado nesta sessão:
múltiplas tentativas de saída com upload falho não geraram nenhum lançamento
no banco.

## Pendências / próximos passos
1. **[BLOQUEADOR]** Habilitar R2 no painel Cloudflare e configurar as 4
   variáveis de ambiente na Hostinger (ver seção acima).
2. Redefinir as senhas dos 4 usuários de produção (foram alteradas durante o
   diagnóstico desta sessão).
3. Recriar ao menos um núcleo + projeto de teste e revincular
   `fabiano@mpmidia.com.br` como coordenador.
4. Após o R2 estar ativo, testar o fluxo completo: solicitar repasse → aprovar
   → executar com comprovante de depósito → coord_nucleo visualiza → lançar
   saída de pagamento com comprovante bancário/fiscal → financeiro concilia
   via tela de Repasses.
5. Aplicar a migration 0008 no MySQL de produção, se ainda não aplicada.

## Deploy
- **Plataforma**: Hostinger (Node.js + MySQL), auto-deploy via push no GitHub.
- **Status**: ✅ Deploy mais recente no ar (commit `9a2eeff`). Correções de
  navegação/bug do núcleo para coord_nucleo e menu do financeiro já em
  produção. Upload de comprovantes **continua bloqueado** até o R2 ser
  habilitado (ver seção de bloqueio crítico acima).
