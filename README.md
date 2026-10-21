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
⚠️ **E-mail e WhatsApp em modo STUB** (simulação em log — ver `src/modules/comunicacao/providers.ts`)
⚠️ **Upload de comprovantes/galeria depende de credenciais reais do Cloudflare R2** — com credenciais placeholder, o upload falha (comportamento esperado; ver seção R2 abaixo)
🔲 **Deploy em produção na Hostinger** — aguardando push ao GitHub e configuração do app no hPanel (ver seção de Deploy)

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
| Papel | Painel Geral | Painel Núcleo | Painel Projeto | Observações |
|---|---|---|---|---|
| Administrador | Total | Total | Total | Único que autoriza repasse Geral→Núcleo e executa repasses/saídas |
| Coordenador Geral | Ver + lançar entrada + **solicitar** repasse Geral→Núcleo | Ver + solicitar/aprovar repasse Núcleo→Projeto | Ver | Não autoriza repasse Geral→Núcleo |
| Coordenador de Núcleo | Sem acesso | Ver entradas/saídas do seu Núcleo, solicitar repasse Núcleo→Projeto | Ver + **lançar saídas com comprovantes** (bancário e fiscal) | Escopo restrito ao(s) núcleo(s) sob sua coordenação |
| Articulador | **Sem acesso** | **Sem acesso** | **Sem acesso** | Somente leitura institucional de Núcleos/Projetos + acesso ao módulo de Comunicação |
| Colaborador | Sem acesso | Sem acesso | Sem acesso | Não acessa o backend/CRM |

## Principais Endpoints da API

| Método | Rota | Quem acessa |
|---|---|---|
| POST | `/api/auth/login` | Público |
| GET | `/api/auth/me` | Autenticado |
| POST | `/api/auth/usuarios` | admin, coord_geral |
| POST | `/api/auth/usuarios/:id/promover-admin` | **somente admin** |
| GET/POST | `/api/nucleos` | conforme escopo |
| POST | `/api/nucleos/:id/coordenadores` | admin, coord_geral |
| GET/POST | `/api/projetos` | conforme escopo |
| POST | `/api/projetos/:id/galeria` | admin, coord_geral, coord_nucleo do núcleo |
| POST | `/api/financeiro/geral/entradas` | admin, coord_geral |
| POST | `/api/financeiro/repasses/geral-nucleo` | admin, coord_geral (apenas solicita) |
| POST | `/api/financeiro/repasses/nucleo-projeto` | admin, coord_geral, coord_nucleo do núcleo |
| POST | `/api/financeiro/repasses/:id/aprovar` | **repasse Geral→Núcleo: somente admin**; repasse Núcleo→Projeto: admin ou coord_geral |
| POST | `/api/financeiro/repasses/:id/rejeitar` | admin, coord_geral |
| POST | `/api/financeiro/repasses/:id/executar` (multipart, comprovante_bancario) | **somente admin** |
| POST | `/api/financeiro/projeto/:id/saidas` (multipart, comprovante_bancario + comprovante_fiscal) | admin, coord_geral, **coord_nucleo do núcleo responsável pelo projeto** |
| GET/POST | `/api/comunicacao/campanhas`, `/api/comunicacao/campanhas/:id/enviar` | admin, coord_geral, coord_nucleo, articulador (Articulador NÃO tem acesso a nenhuma rota `/api/financeiro/*`) |
| POST | `/api/public/colaborador` | Público (sem login) |
| GET | `/n/:slug`, `/p/:slug` | Público (sem login) |

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

## Não implementado / Próximos passos
1. **Deploy real na Hostinger** — aguardando push ao GitHub e configuração do Node.js App no hPanel (ver seção de Deploy acima).
2. **Credenciais reais do Cloudflare R2** — localmente testado apenas com placeholder; upload de comprovantes/galeria só funcionará em produção com chaves reais configuradas.
3. **Provedores reais de E-mail/WhatsApp** — substituir stubs em `src/modules/comunicacao/providers.ts` (ex.: Resend, WhatsApp Business Cloud API).
4. **Campo de e-mail no colaborador** — atualmente o formulário público só coleta WhatsApp; se e-mail for necessário para campanhas, adicionar coluna e ajustar disparo.
5. **Upload de imagem de capa** de núcleo/projeto (`imagem_capa_key` já existe no schema, falta rota de upload dedicada).
6. **Paginação** nas listagens (colaboradores, lançamentos, usuários) para volumes grandes.
7. **Testes automatizados** (unitários/integração) — validação até agora foi manual via curl.

## Segurança
- Senhas com PBKDF2 (100.000 iterações, SHA-256) via Web Crypto API — sem dependências externas, funciona igual em Node.js 18+.
- Sessão via JWT em cookie `httpOnly`, `sameSite=Lax`, `secure` automático quando HTTPS.
- RBAC aplicado em middleware de rota, nunca apenas no frontend.
- Isolamento de dados por núcleo garantido nas queries SQL (nunca por filtro client-side).
- Nenhuma credencial (MySQL, R2, JWT_SECRET) é commitada no repositório — todas vêm de variáveis de ambiente (`.env` local / hPanel em produção).
