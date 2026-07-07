# NFP Gestão — Sistema de Gerenciamento da Nota Fiscal Paulista

## Visão Geral
- **Nome**: NFP Gestão
- **Objetivo**: Sistema de gestão de arrecadação, núcleos e projetos sociais financiados por recursos da Nota Fiscal Paulista, com controle financeiro rigoroso, rastreabilidade e prestação de contas.
- **Stack**: Hono (TypeScript) + Cloudflare Workers/Pages + D1 (SQLite) + R2 (arquivos) + JWT (cookie httpOnly)

## Status do Projeto
✅ **Backend completo e testado localmente** (D1 local + R2 local, `wrangler pages dev`)
✅ **Frontend administrativo funcional** (SPA leve em Vanilla JS + Tailwind CDN)
✅ **Páginas públicas de Núcleo/Projeto** (sem login, com formulário de colaborador)
⚠️ **E-mail e WhatsApp em modo STUB** (simulação em log — ver `src/modules/comunicacao/providers.ts`)
⚠️ **Não implantado em produção** — banco e recursos ainda são apenas locais (`--local`)

## Login de teste (seed)
- **E-mail**: `admin@nfp.org.br`
- **Senha**: `admin123`
- ⚠️ Troque essa senha antes de qualquer uso real.

## Arquitetura

```
src/
├── index.tsx                # bootstrap Hono, monta todas as rotas
├── types/bindings.ts         # tipos de Bindings (DB, R2, JWT_SECRET) e Role
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

migrations/
├── 0001_initial_schema.sql      # todas as tabelas (users, nucleos, projetos, financeiro_lancamentos, etc.)
└── 0002_views_saldo.sql          # views saldo_geral / saldo_nucleo / saldo_projeto (calculadas, nunca armazenadas)

seed.sql                         # admin padrão + núcleo/projeto de exemplo
```

## Entidades e Fluxo Financeiro

**Ledger imutável (append-only)**: toda movimentação é uma linha em `financeiro_lancamentos`, nunca atualizada em valor — apenas o `status` avança (`pendente` → `aprovado` → `executado`, ou `rejeitado`). Saldos (`saldo_geral`, `saldo_nucleo`, `saldo_projeto`) são **views SQL calculadas dinamicamente**, nunca campos mutáveis.

```
entrada_nfp (Geral, admin/coord_geral) → executado direto
repasse_geral_nucleo: solicitar (admin/coord_geral) → aprovar (admin/coord_geral) → executar (SOMENTE admin, + comprovante bancário)
repasse_nucleo_projeto: solicitar (admin/coord_geral/coord_nucleo do núcleo) → aprovar (admin/coord_geral) → executar (SOMENTE admin, + comprovante bancário)
saida_pagamento (Projeto): SOMENTE admin, exige comprovante bancário E fiscal simultaneamente (transação atômica)
```

Toda mutação relevante grava uma linha em `audit_log` (nunca editável/deletável via API).

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
| POST | `/api/financeiro/repasses/geral-nucleo` | admin, coord_geral |
| POST | `/api/financeiro/repasses/nucleo-projeto` | admin, coord_geral, coord_nucleo do núcleo |
| POST | `/api/financeiro/repasses/:id/aprovar` \| `/rejeitar` | admin, coord_geral |
| POST | `/api/financeiro/repasses/:id/executar` (multipart, comprovante_bancario) | **somente admin** |
| POST | `/api/financeiro/projeto/:id/saidas` (multipart, comprovante_bancario + comprovante_fiscal) | **somente admin** |
| GET/POST | `/api/comunicacao/campanhas`, `/api/comunicacao/campanhas/:id/enviar` | admin, coord_geral, coord_nucleo, articulador |
| POST | `/api/public/colaborador` | Público (sem login) |
| GET | `/n/:slug`, `/p/:slug` | Público (sem login) |

## Rodando localmente (sandbox)

```bash
cd /home/user/webapp
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000
```

Banco D1 e bucket R2 são locais (`.wrangler/state/v3/d1` e equivalente para R2) — nenhum recurso de produção foi provisionado ainda.

## Não implementado / Próximos passos
1. **Deploy em produção** (Cloudflare Pages real + D1/R2 de produção) — aguardando decisão do usuário sobre conta Cloudflare.
2. **Provedores reais de E-mail/WhatsApp** — substituir stubs em `src/modules/comunicacao/providers.ts` (ex.: Resend, WhatsApp Business Cloud API) e configurar secrets via `wrangler secret put`.
3. **Campo de e-mail no colaborador** — atualmente o formulário público só coleta WhatsApp; se e-mail for necessário para campanhas, adicionar coluna e ajustar disparo.
4. **Upload de imagem de capa** de núcleo/projeto (`imagem_capa_key` já existe no schema, falta rota de upload dedicada).
5. **Paginação** nas listagens (colaboradores, lançamentos, usuários) para volumes grandes.
6. **Testes automatizados** (unitários/integração) — validação até agora foi manual via curl.
7. **Refinar UI/UX** do dashboard (atualmente funcional, mas simples).

## Segurança
- Senhas com PBKDF2 (100.000 iterações, SHA-256) via Web Crypto API — sem dependências externas.
- Sessão via JWT em cookie `httpOnly`, `sameSite=Lax`, `secure` automático quando HTTPS.
- RBAC aplicado em middleware de rota, nunca apenas no frontend.
- Isolamento de dados por núcleo garantido nas queries SQL (nunca por filtro client-side).
