# Gestão Social — Sistema de Gerenciamento da Nota Fiscal Paulista

## Visão Geral
- **Nome**: Gestão Social
- **Objetivo**: Sistema de gestão de arrecadação, núcleos e projetos sociais financiados por recursos do programa Nota Fiscal Paulista, com controle financeiro rigoroso, rastreabilidade e prestação de contas.
- **Stack**: Hono (TypeScript) + Node.js (`@hono/node-server`) + MySQL + Cloudflare R2 (armazenamento de arquivos via API S3-compatível) + JWT (cookie httpOnly)
- **Hospedagem**: Hostinger (plano Business/Cloud, Node.js App via hPanel)

## Status do Projeto
✅ **Backend completo e testado** (lógica de negócio, RBAC, ledger financeiro)
✅ **Frontend administrativo** (SPA leve em Vanilla JS + Tailwind CDN, identidade visual "Gestão Social")
✅ **Páginas públicas de Núcleo/Projeto** (sem login, com formulário de colaborador)
✅ **Migração de infraestrutura concluída**: Cloudflare Workers/D1/R2-nativo → Node.js/MySQL/R2-via-S3, para viabilizar o deploy na Hostinger
✅ **Testado localmente contra MySQL real** (MariaDB), com todas as regras de negócio revalidadas após a migração
✅ **Deploy em produção na Hostinger concluído** — app Node.js ativo, GitHub-integrado (auto-deploy a cada push em `main`), domínio `nfp.social.br` (DNS/HTTPS pendentes de propagação)
✅ **Ciclo de vida de comprovantes implementado** (download único + expiração em 30 dias — ver seção dedicada abaixo)
✅ **Gestão completa de usuários** (admin cria/edita/exclui/reseta senha; exclusão inteligente faz soft-delete quando há histórico vinculado — ver seção dedicada abaixo)
✅ **Importação da planilha da Nota Fiscal Paulista no Financeiro Geral**, com deduplicação e ignorando linhas "A Calcular"/zeradas (ver seção dedicada abaixo)
✅ **Lançamentos manuais no Financeiro Geral** (entrada/saída avulsa, com edição e cancelamento auditados — ver seção dedicada abaixo)
✅ **Papel único por usuário** (`UNIQUE KEY` em `user_roles.user_id` — um usuário nunca acumula mais de um papel; reatribuição de papel é feita via DELETE+INSERT, nunca soma)
✅ **Coordenador Geral sem nenhum acesso a Financeiro e a Usuários & Permissões** — RBAC reforçado no backend (`requireRole`) e espelhado no frontend (`hasFinanceiroFullAccess()` = somente admin/financeiro); Visão Geral do Coordenador Geral mostra apenas panorama de núcleos/projetos, nunca dados financeiros
✅ **Papel Financeiro dedicado**: único (além do admin) que acessa o Financeiro Geral, importa a planilha NFP, lança manualmente e aprova/executa repasses — sem acesso a Usuários & Permissões
✅ **Cadastro de Coordenador de Núcleo pelo próprio painel do Núcleo** (`POST /api/nucleos/:id/coordenadores` com `modo: 'novo'` ou `'existente'`), substituindo o fluxo antigo via tela de Usuários
✅ **Usuários & Permissões redesenhado**: grade de cards (nome + papel) com modal único de detalhe/edição (substituindo tabela densa + múltiplos modais) — reúne editar dados, resetar senha, promover admin, ativar/desativar e excluir em um só lugar
✅ **Visão Geral por papel**: dashboard inicial agora é renderizado de forma específica para cada papel (admin, coordenador geral, coordenador de núcleo, financeiro, articulador), com indicadores e atalhos relevantes a cada escopo
✅ **Visão concisa de Colaboradores para o Articulador**: grade de cards com filtro por núcleo, substituindo a tabela de gestão completa (mantida para admin/coord. geral/coord. núcleo)
⚠️ **E-mail e WhatsApp em modo STUB** (simulação em log — ver `src/modules/comunicacao/providers.ts`)
⚠️ **Senha padrão do admin de seed (`admin123`) ainda ativa em produção** — trocar antes de uso real
⚠️ **Confirmar se as variáveis de ambiente `R2_*` estão configuradas no painel da Hostinger** — sem elas, upload/download de comprovantes e galeria falha

## Login de teste (seed)
- **E-mail**: `admin@nfp.org.br`
- **Senha**: `admin123`
- ⚠️ Troque essa senha antes de qualquer uso real.

## Por que a migração de infraestrutura?
O sistema foi originalmente construído para Cloudflare Workers/Pages (Hono + D1 + R2 nativos). O domínio do projeto já foi registrado na **Hostinger**, que:
- Só expõe **hPanel** para deploy (sem SSH/root) — GitHub-integração (auto-deploy a cada push) ou upload de ZIP.
- Só suporta **MySQL** como banco de dados gerenciado (sem SQLite/D1/Postgres).
- Tem **filesystem efêmero**: os diretórios de build/`public_html` são completamente sobrescritos a cada deploy — qualquer arquivo gravado localmente em runtime (ex.: comprovantes financeiros, fotos da galeria) seria perdido no próximo deploy.
- Tem **suporte oficial a Hono** via `@hono/node-server`, com preset documentado (`app_type: hono`, entry `dist/index.js`, build `npm run build`).

Por isso, a stack foi portada mantendo o **mesmo código de regras de negócio** (RBAC, ledger imutável, validações), trocando apenas a camada de infraestrutura:
- **Cloudflare D1 (SQLite)** → **MySQL**, acessado via um adaptador compatível com a API D1 (`prepare/bind/first/all/run/batch`) implementado sobre `mysql2`.
- **Cloudflare R2 (binding nativo)** → **mesmo Cloudflare R2**, mas acessado via sua **API compatível com S3** (`@aws-sdk/client-s3`), a partir do servidor Node.js hospedado na Hostinger — o disco local da Hostinger nunca é usado para armazenar arquivos, justamente por ser efêmero.
- **Cloudflare Workers runtime** → **Node.js puro**, via `@hono/node-server` (`serve()` + `serveStatic`).

## Arquitetura

```
src/
├── index.ts                  # bootstrap Hono + @hono/node-server (serve), injeta DB/R2/JWT_SECRET em c.env
├── types/bindings.ts         # tipos de Bindings (DB: AppDatabase, R2: AppBucket, JWT_SECRET) e Role
├── platform/
│   ├── db.ts                   # adaptador D1-compatible sobre mysql2 (prepare/bind/first/all/run/batch)
│   └── storage.ts               # adaptador R2-compatible sobre @aws-sdk/client-s3 (put/get/delete)
├── utils/
│   ├── crypto.ts              # hash de senha PBKDF2 (Web Crypto API), slugify
│   ├── jwt.ts                  # criação/verificação de token JWT (cookie de sessão)
│   └── response.ts             # helpers okResponse/errorResponse padronizados
├── middlewares/
│   ├── auth.ts                 # extrai/valida JWT do cookie ou header
│   ├── rbac.ts                  # requireRole, requireNucleoAccess, isAdmin, isGlobalUser
│   └── audit.ts                  # logAudit() — grava audit_log (append-only)
├── modules/
│   ├── auth/routes.ts           # login, logout, me, CRUD usuários, promover admin
│   ├── nucleos/routes.ts         # CRUD núcleos + coordenadores
│   ├── projetos/routes.ts        # CRUD projetos + galeria (upload R2)
│   ├── colaboradores/routes.ts   # gestão/validação (privado) + criarColaboradorPublico()
│   ├── financeiro/routes.ts      # ledger geral/núcleo/projeto, repasses, saídas, comprovantes
│   ├── comunicacao/
│   │   ├── routes.ts              # templates, campanhas, disparo, histórico de envios
│   │   └── providers.ts            # STUBS de e-mail/WhatsApp (trocar por API real)
│   └── publico/routes.ts         # landing núcleo/projeto (JSON) + formulário colaborador
└── views/
    ├── layout.ts                # layout HTML base (Tailwind + FontAwesome CDN)
    ├── login-page.ts             # página de login
    ├── dashboard-page.ts         # shell do dashboard (SPA)
    └── public-pages.ts           # landing pages públicas server-rendered

public/static/
├── app.js                      # SPA completo do dashboard administrativo
└── styles.css                   # estilos auxiliares

migrations/mysql/
├── 0001_initial_schema.sql      # todas as tabelas, em sintaxe MySQL (AUTO_INCREMENT, FOREIGN KEY, CHECK, DECIMAL)
├── 0002_views_saldo.sql          # views saldo_geral / saldo_nucleo / saldo_projeto (calculadas, nunca armazenadas)
└── seed.sql                       # admin padrão + núcleo/projeto de exemplo (INSERT IGNORE)
```

## Entidades e Fluxo Financeiro

**Ledger imutável (append-only)**: toda movimentação é uma linha em `financeiro_lancamentos`, nunca atualizada em valor — apenas o `status` avança (`pendente` → `aprovado` → `executado`, ou `rejeitado`). Saldos (`saldo_geral`, `saldo_nucleo`, `saldo_projeto`) são **views SQL calculadas dinamicamente**, nunca campos mutáveis. Um repasse aprovado e executado **subtrai** do saldo de origem e **soma** no saldo de destino automaticamente, pois ambos são calculados a partir da mesma linha do ledger.

```
entrada_nfp (Geral, admin/coord_geral) → executado direto

repasse_geral_nucleo (Geral → Núcleo):
  solicitar (admin/coord_geral) → aprovar (SOMENTE admin) → executar (SOMENTE admin, + comprovante bancário)
  ⚠️ Coordenador Geral pode apenas SOLICITAR; a autorização final é exclusiva do Administrador.

repasse_nucleo_projeto (Núcleo → Projeto):
  solicitar (admin/coord_geral/coord_nucleo do núcleo) → aprovar (admin OU coord_geral) → executar (SOMENTE admin, + comprovante bancário)

saida_pagamento (Projeto):
  admin OU coord_nucleo do núcleo responsável pelo projeto — exige comprovante bancário E fiscal simultaneamente (transação atômica)
```

Toda mutação relevante grava uma linha em `audit_log` (nunca editável/deletável via API).

### Acesso por papel ao módulo financeiro
> ⚠️ **Atualizado nesta versão**: Coordenador Geral perdeu totalmente o acesso ao módulo Financeiro e à tela de Usuários & Permissões. O papel **Financeiro** passou a ser o responsável operacional pelo Financeiro Geral (junto com o admin).

| Papel | Painel Geral | Painel Núcleo | Painel Projeto | Observações |
|---|---|---|---|---|
| Administrador | Total | Total | Total | Único que autoriza repasse Geral→Núcleo e executa repasses/saídas |
| Financeiro | Total: importa planilha NFP, lança manualmente, aprova e executa repasses | Ver | Ver | Acesso **exclusivo ao módulo Financeiro** — sem acesso a Usuários & Permissões, núcleos/projetos (CRUD) ou comunicação |
| Coordenador Geral | **Sem acesso** | Sem acesso | Sem acesso | Zero acesso a qualquer rota `/api/financeiro/*` — seu papel é gestão institucional de Núcleos/Projetos, não financeira |
| Coordenador de Núcleo | Sem acesso | Ver entradas/saídas do seu Núcleo, **solicitar** repasse Núcleo→Projeto | Ver + **lançar saídas com comprovantes** (bancário e fiscal) | Escopo restrito ao(s) núcleo(s) sob sua coordenação; não aprova nem executa repasses |
| Articulador | **Sem acesso** | **Sem acesso** | **Sem acesso** | Somente leitura institucional de Núcleos/Projetos + acesso ao módulo de Comunicação + visão concisa de Colaboradores |
| Colaborador | Sem acesso | Sem acesso | Sem acesso | Não acessa o backend/CRM |

## Principais Endpoints da API

| Método | Rota | Quem acessa |
|---|---|---|
| POST | `/api/auth/login` | Público |
| GET | `/api/auth/me` | Autenticado |
| POST | `/api/auth/usuarios` | **somente admin** |
| GET/PUT/DELETE | `/api/auth/usuarios/:id` | **somente admin** |
| POST | `/api/auth/usuarios/:id/promover-admin` | **somente admin** |
| POST | `/api/auth/usuarios/:id/resetar-senha`, `/reativar` | **somente admin** |
| GET/POST | `/api/nucleos` | conforme escopo |
| POST | `/api/nucleos/:id/coordenadores` (body `{modo: 'novo'\|'existente', nome?, email?, senha?}`) | admin, coord_geral — `modo:'existente'` reatribui papel de um usuário já cadastrado (bloqueado para admin/coord_geral/financeiro, salvo se o ator for admin); `modo:'novo'` (padrão) cria usuário + papel |
| DELETE | `/api/nucleos/:id/coordenadores/:userId` | admin, coord_geral |
| GET/POST | `/api/projetos` | conforme escopo |
| POST | `/api/projetos/:id/galeria` | admin, coord_geral, coord_nucleo do núcleo |
| POST | `/api/financeiro/geral/entradas` | **admin, financeiro** |
| POST | `/api/financeiro/geral/importar-nfp` | **admin, financeiro** |
| POST/PUT | `/api/financeiro/geral/lancamentos-manuais`, `/:id` | **admin, financeiro** |
| DELETE | `/api/financeiro/geral/lancamentos-manuais/:id` | **somente admin** |
| GET | `/api/financeiro/geral/importacoes`, `/importacoes/:id/arquivo`, `/saldo`, `/lancamentos`, `/buscar` | **admin, financeiro** |
| POST | `/api/financeiro/repasses/geral-nucleo` | **admin, financeiro** (solicita) |
| POST | `/api/financeiro/repasses/nucleo-projeto` | admin, financeiro, coord_nucleo do núcleo (solicita) |
| POST | `/api/financeiro/repasses/:id/aprovar` | **admin, financeiro** (ambos os tipos de repasse) |
| POST | `/api/financeiro/repasses/:id/rejeitar` | **admin, financeiro** |
| POST | `/api/financeiro/repasses/:id/executar` (multipart, comprovante_bancario) | **admin, financeiro** |
| POST | `/api/financeiro/projeto/:id/saidas` (multipart, comprovante_bancario + comprovante_fiscal) | admin, **coord_nucleo do núcleo responsável pelo projeto** (coord_geral e financeiro **não** lançam saída de projeto) |
| GET/POST | `/api/comunicacao/campanhas`, `/api/comunicacao/campanhas/:id/enviar` | admin, coord_geral, coord_nucleo, articulador (nenhum deles acessa `/api/financeiro/*`, exceto conforme tabela acima) |
| GET | `/api/financeiro/lancamentos/:id/comprovantes` | mesmo escopo do lançamento (admin/financeiro/coord_nucleo do núcleo) |
| GET | `/api/financeiro/comprovantes/:id/arquivo` | mesmo escopo do lançamento — baixa o arquivo (ver "Ciclo de vida dos comprovantes" abaixo) |
| GET | `/api/colaboradores/gestao` (param opcional `nucleo_id`) | admin, coord_geral, coord_nucleo (escopo do núcleo), **articulador (todos os núcleos ou filtrado por `nucleo_id`)** |
| POST | `/api/public/colaborador` | Público (sem login) |
| GET | `/n/:slug`, `/p/:slug` | Público (sem login) |

## Ciclo de vida dos comprovantes (download único + expiração em 30 dias)

Requisito de negócio: o comprovante (bancário/fiscal) fica disponível para download
enquanto ninguém o baixar. No **primeiro download**, inicia-se uma contagem de
**30 dias**; passado esse prazo, o **arquivo binário** é removido do armazenamento
(Cloudflare R2) automaticamente. O **registro/metadado** do comprovante (`comprovantes`
no MySQL) nunca é apagado — permanece para fins de auditoria/prestação de contas,
apenas marcado como `expirado = 1`.

- `GET /api/financeiro/comprovantes/:id/arquivo`: serve o binário com
  `Content-Disposition: attachment` (botão "Baixar" no frontend). Na primeira vez que
  o arquivo é servido, grava `baixado_em = agora` e `expira_em = agora + 30 dias`.
  Downloads seguintes não recalculam `expira_em`. Depois de `expirado = 1`, a rota
  responde **HTTP 410 Gone** com mensagem explicando que o arquivo foi removido
  após o prazo de retenção.
- `src/jobs/limpeza-comprovantes.ts`: roda **dentro do próprio processo Node.js**
  (via `setInterval`, a cada 24h, com uma primeira execução 10s após o boot). Isso é
  seguro e suficiente aqui porque a Hostinger hospeda um **processo Node.js
  persistente e de longa duração** — diferente de um ambiente serverless (ex.:
  Cloudflare Workers Hosted Deploy), que não permite `triggers`/cron.
- Migration: `migrations/mysql/0003_comprovantes_ciclo_de_vida.sql` adiciona as
  colunas `baixado_em`, `expira_em` e `expirado` à tabela `comprovantes`.

### Por que o arquivo continua no Cloudflare R2 (e não no disco da Hostinger)?
Foi cogitado guardar os arquivos diretamente no disco da hospedagem Hostinger para
simplificar a arquitetura, mas isso foi **descartado por risco de perda de dados**:
conforme a própria documentação da Hostinger, os diretórios de deploy (`hbuilds/`,
`public_html`) são **sobrescritos a cada novo deploy** do app Node.js. Um comprovante
financeiro gravado em disco local seria apagado silenciosamente na próxima vez que
o código for atualizado (ex.: um futuro ajuste de bug) — inaceitável para documentos
de prestação de contas. O R2 (via API S3-compatível) permanece como o armazenamento
real dos arquivos; a mudança pedida (botão de download + expiração em 30 dias) foi
implementada **na camada de aplicação**, preservando a durabilidade dos arquivos.

## Variáveis de ambiente

Veja `.env.example`. Resumo:

| Variável | Descrição |
|---|---|
| `PORT` | Porta HTTP (a Hostinger define automaticamente em produção) |
| `DB_HOST` | Host do MySQL — **use `127.0.0.1`, nunca `localhost`** (Node 17+ resolve `localhost` para `::1`/IPv6, que o MySQL da Hostinger recusa) |
| `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Credenciais do banco MySQL (criado via hPanel → Bancos de Dados) |
| `JWT_SECRET` | Segredo de assinatura do JWT de sessão — gerar valor aleatório forte em produção |
| `R2_ENDPOINT` | Endpoint S3-compatível do bucket R2 (`https://<account_id>.r2.cloudflarestorage.com`) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Chaves de API R2 (Cloudflare Dashboard → R2 → Manage API Tokens) |
| `R2_BUCKET_NAME` | Nome do bucket R2 usado para comprovantes financeiros e galeria de projetos |

## Rodando localmente (sandbox / qualquer máquina com Node.js + MySQL)

```bash
cd webapp
npm install
cp .env.example .env   # preencha com suas credenciais reais (MySQL local + R2)

# Aplicar schema + views + dados de exemplo no MySQL
export DB_USER=... DB_PASSWORD=... DB_NAME=...
npm run db:migrate:local
npm run db:seed

npm run build
npm start               # ou: pm2 start ecosystem.config.cjs
curl http://localhost:3000
```

## Deploy em produção — Hostinger

1. **Banco de dados**: hPanel → Bancos de Dados → Gerenciar → criar um banco MySQL e um usuário. Anote host (`127.0.0.1`), porta, nome do banco, usuário e senha.
2. **Aplicar as migrations** no banco de produção (via hPanel → phpMyAdmin, ou localmente apontando `DB_HOST`/credenciais para o host remoto se a Hostinger permitir conexão externa):
   - `migrations/mysql/0001_initial_schema.sql`
   - `migrations/mysql/0002_views_saldo.sql`
   - `migrations/mysql/seed.sql` (opcional — cria o admin padrão; troque a senha depois)
3. **Cloudflare R2**: criar um bucket R2 na conta Cloudflare (pode ser uma conta Cloudflare gratuita, usada **apenas como storage**, sem hospedar nada nela) e gerar um token de API S3-compatível (Cloudflare Dashboard → R2 → Manage API Tokens). Anotar `endpoint`, `access_key_id`, `secret_access_key` e nome do bucket.
4. **GitHub**: fazer push deste repositório para o GitHub (necessário para o fluxo de deploy via hPanel com auto-deploy).
5. **hPanel → Node.js App**:
   - Conectar o repositório GitHub (branch `main`).
   - `app_type`: Hono
   - Entry file: `dist/index.js`
   - Build command: `npm run build`
   - Output directory: (deixar em branco)
   - Variáveis de ambiente: preencher todas as listadas em `.env.example` (sem commitar o `.env` real).
6. Disparar o deploy. A cada novo push na branch conectada, a Hostinger reconstrói e reinicia o app automaticamente.
7. **Domínio**: já registrado na Hostinger — apontar/vincular ao Node.js App criado, conforme painel do hPanel.

### Status atual do deploy (produção)
- App Node.js criado corretamente na Hostinger como **"Web App"** com GitHub integrado (branch `main`, auto-deploy a cada push) — confirmado funcional via testes diretos (login, RBAC, UTF-8, SQL-injection, páginas públicas) contra o banco MySQL real.
- Domínio: `nfp.social.br` — DNS ainda propagando; testado via `curl --resolve nfp.social.br:PORT:193.203.175.122` enquanto a propagação não completa. HTTPS/certificado SSL pendente até a propagação de DNS.
- Banco de dados de produção: `u733854142_gestao_nfp` em `srv1597.hstgr.io`, com as migrations `0001`, `0002` e `0003` aplicadas e verificadas.
- **Pendências de configuração a confirmar no hPanel**: variáveis `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` — sem elas, upload/download de comprovantes e galeria falha (o restante do sistema funciona normalmente).
- **Pendência crítica de segurança**: a senha do usuário admin de seed (`admin123`) ainda está ativa em produção — deve ser trocada antes de uso real (via `POST /api/auth/usuarios` + `/promover-admin` para um novo admin, seguido de desativação do seed, ou diretamente no banco).

## Testes de regressão realizados após a migração (curl, contra MySQL local)
Revalidação completa das regras de negócio após a troca de infraestrutura (Cloudflare Workers/D1/R2 → Node.js/MySQL/R2-via-S3):
- **Login e sessão** via JWT/cookie funcionando com hash PBKDF2 migrado sem alteração (mesmo usuário seed).
- **UTF-8**: identificado e corrigido um problema de acentuação (mojibake) na conexão MySQL — corrigido com `charset: 'utf8mb4'` no pool de conexões.
- **Tipos DECIMAL**: identificado e corrigido um bug real — o driver `mysql2` retorna colunas `DECIMAL` como `string` por padrão (para não perder precisão), o que quebrava `.toFixed()` e comparações numéricas herdadas do código original (escrito para D1/SQLite, que retorna `number` nativo). Corrigido configurando `decimalNumbers: true` no adaptador (`src/platform/db.ts`), preservando o comportamento esperado por todo o código financeiro sem precisar alterá-lo.
- **Ledger financeiro multi-nível**: entrada NFP no Geral → repasse Geral→Núcleo (solicitar/aprovar/executar com comprovante) → saldo do Núcleo atualizado corretamente via view SQL.
- **RBAC e isolamento**: Coordenador de Núcleo bloqueado corretamente ao tentar lançar entrada no Painel Geral (403); bloqueado ao tentar acessar núcleo/saldo de outro núcleo fora do seu escopo; validado criando campanha de comunicação apenas para seu próprio núcleo (bloqueado para núcleo de terceiros).
- **Colaboradores**: cadastro público via `/api/public/colaborador` persistido no MySQL; listagem e validação por Coordenador de Núcleo funcionando com escopo correto.
- **Auditoria**: todas as ações relevantes (login, criação de usuário/núcleo, lançamentos financeiros, validação de colaborador, criação de campanha) confirmadas gravadas em `audit_log`.
- **Páginas públicas**: landing de núcleo renderizando corretamente via SSR.

## Testes de regressão — ciclo de vida de comprovantes (download único + expiração 30 dias)
Validado localmente, de ponta a ponta, contra MySQL real (MariaDB) e um storage mock equivalente ao R2:
- Upload de saída de projeto com comprovantes bancário+fiscal obrigatórios → `baixado_em`/`expira_em` iniciam `NULL` para ambos.
- Primeiro download de um dos dois comprovantes → grava `baixado_em` (timestamp do download) e `expira_em` (+30 dias); o outro comprovante (ainda não baixado) permanece intocado.
- Segundo download do mesmo comprovante → `expira_em` **não** é recalculado (confirma que a contagem começa apenas no primeiro download).
- `Content-Disposition: attachment; filename="..."` presente na resposta (download real no navegador, não apenas abrir inline).
- Execução do job de limpeza (`limparComprovantesExpirados`) com `expira_em` forçado para o passado → arquivo removido do storage, linha marcada `expirado = 1`, registro mantido na tabela.
- Tentativa de download de um comprovante já expirado → **HTTP 410 Gone** com mensagem explicativa, sem tentar acessar o storage.
- **Correção de RBAC também aplicada nesta mudança**: a rota `GET /api/financeiro/comprovantes/:id/arquivo` **não validava escopo** (qualquer usuário autenticado podia baixar qualquer comprovante por id). Corrigido para aplicar a mesma regra de acesso usada na listagem (`userCanAccessNucleo` / `isGlobalUser`) — testado com usuário `articulador` (sem acesso financeiro) tentando baixar um comprovante fora de seu alcance → corretamente bloqueado com 403.

## Não implementado / Próximos passos
1. **Credenciais reais do Cloudflare R2 em produção** — confirmar no hPanel que `R2_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME` estão preenchidas; sem elas, upload/download de comprovantes e galeria falha.
2. **Trocar a senha do admin de seed (`admin123`)** em produção antes de uso real.
3. **Provedores reais de E-mail/WhatsApp** — substituir stubs em `src/modules/comunicacao/providers.ts` (ex.: Resend, WhatsApp Business Cloud API).
4. **Campo de e-mail no colaborador** — atualmente o formulário público só coleta WhatsApp; se e-mail for necessário para campanhas, adicionar coluna e ajustar disparo.
5. **Upload de imagem de capa** de núcleo/projeto (`imagem_capa_key` já existe no schema, falta rota de upload dedicada).
6. **Paginação** nas listagens (colaboradores, lançamentos, usuários) para volumes grandes.
7. **Testes automatizados** (unitários/integração) — validação até agora foi manual via curl e smoke test funcional.
8. **HTTPS/SSL do domínio `nfp.social.br`** — depende da propagação de DNS concluída na Hostinger.

## Segurança
- Senhas com PBKDF2 (100.000 iterações, SHA-256) via Web Crypto API — sem dependências externas, funciona igual em Node.js 18+.
- Sessão via JWT em cookie `httpOnly`, `sameSite=Lax`, `secure` automático quando HTTPS.
- RBAC aplicado em middleware de rota, nunca apenas no frontend.
- Isolamento de dados por núcleo garantido nas queries SQL (nunca por filtro client-side).
- Nenhuma credencial (MySQL, R2, JWT_SECRET) é commitada no repositório — todas vêm de variáveis de ambiente (`.env` local / hPanel em produção).

## Gestão de Usuários e Permissões (atualizado)
- **Somente admin** acessa a tela de Usuários & Permissões e as rotas `/api/auth/usuarios*` — Coordenador Geral **não tem mais acesso** a esta área (mudança desta versão).
- **Papel único por usuário**: `user_roles.user_id` tem `UNIQUE KEY` — reatribuir o papel de um usuário é sempre DELETE+INSERT, nunca uma soma de papéis.
- **Cadastro de Coordenador de Núcleo** passou a ser feito **pelo próprio painel do Núcleo** (`POST /api/nucleos/:id/coordenadores`), não mais pela tela de Usuários — suporta `modo: 'novo'` (cria usuário novo) ou `modo: 'existente'` (reatribui o papel de um usuário já cadastrado, por e-mail).
- **Interface em cards**: a tela de Usuários & Permissões foi redesenhada — grade de cards (nome + papel, com cor por papel) substituindo a tabela densa; clicar no card abre um modal único que reúne edição de dados, troca de papel, resetar senha, promover a admin, ativar/desativar e excluir.
- **Exclusão inteligente**: se o usuário tiver histórico vinculado (lançamentos, comprovantes, auditoria etc. — 13 tabelas verificadas), o sistema faz **soft-delete** (`excluido_em` + `ativo=0`, bloqueia login, some da listagem, mas preserva o registro para auditoria); sem histórico, exclui definitivamente.
- **Reset de senha**: admin define uma senha ou o sistema gera uma temporária exibida uma única vez na tela.

## Visão Geral por papel (novo)
O dashboard inicial (`renderVisaoGeral()` em `app.js`) agora é dividido por papel, cada um com indicadores e atalhos próprios:
- **Admin**: saldo geral consolidado, contagem de núcleos/projetos/colaboradores, atalhos para Repasses, Usuários e Comunicação.
- **Financeiro**: saldo geral, total de repasses pendentes de aprovação (agregado de núcleos e projetos), atalho direto para importar a planilha NFP e para a tela de Repasses.
- **Coordenador Geral**: panorama de núcleos/projetos (contagem + status), tabela de núcleos com contagem de projetos — **sem nenhum dado financeiro**.
- **Coordenador de Núcleo**: saldo do seu próprio núcleo, lista de projetos do núcleo com status, atalho para criar novo projeto.
- **Articulador**: panorama de colaboradores (total/validados/pendentes), detalhamento por núcleo, atalhos para Comunicação e para a tela de Colaboradores.

## Colaboradores — visão concisa para o Articulador (novo)
- `GET /api/colaboradores/gestao` aceita filtro opcional `?nucleo_id=`.
- Para o papel **Articulador**, a tela de Colaboradores exibe uma grade de cards concisa (nome, WhatsApp, status validado/pendente) com um seletor de núcleo para filtrar — em vez da tabela de gestão completa usada por admin/coord. geral/coord. núcleo.

## Importação da planilha NFP (novo)
- `POST /api/financeiro/geral/importar-nfp` (admin, coord_geral): recebe o CSV exportado da "Consulta de Créditos" do site da NFP.
- Parser nativo (sem `xlsx`/`exceljs` — ambos com vulnerabilidades sem correção disponível), auditável, em `src/utils/csv-nfp.ts`.
- Ignora automaticamente linhas com crédito zerado ou situação "A Calcular".
- Deduplicação por hash SHA-256 de todos os campos da linha + `UNIQUE KEY` no banco — permite reimportar o mesmo arquivo atualizado mês a mês sem duplicar lançamentos.
- Histórico de importações em `GET /api/financeiro/geral/importacoes`.

## Lançamentos manuais no Financeiro Geral (novo)
- `POST /api/financeiro/geral/lancamentos-manuais` (admin, coord_geral): registra entrada ou saída avulsa (ex.: estorno, taxa bancária, doação direta), com finalidade/justificativa obrigatória.
- `PUT /.../lancamentos-manuais/:id` (admin, coord_geral): edita valor/finalidade — bloqueado para lançamentos vindos da importação NFP ou repasses.
- `DELETE /.../lancamentos-manuais/:id` (somente admin): soft-delete via `status='cancelado'`, preservando o registro para auditoria mas excluindo do cálculo de saldo.
- Toda saída (nova ou editada) valida saldo suficiente antes de executar.
