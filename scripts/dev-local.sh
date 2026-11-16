#!/bin/bash
# ============================================================
# Liga o sistema de TESTE aqui no Mac:
#   - MySQL local (porta 3307), com o banco "nfp_teste"
#   - o app (porta 3000) apontando para esse banco
#
# Nada aqui fala com a Hostinger nem com o banco de produção.
# Os programas ficam em .local/ (fora do git).
#
#   bash scripts/dev-local.sh            liga (mantém os dados de teste)
#   RESETAR=1 bash scripts/dev-local.sh  apaga o banco de teste e recria do zero
#
# Login inicial do banco de teste: admin@nfp.org.br / admin123
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
L="$ROOT/.local"
MY="$L/mysql/bin"
DATA="$L/mysql-data"
SOCK=/tmp/nfp-teste-mysql.sock
PORTA_DB=3307
export PATH="$L/node/bin:$PATH"

if [ ! -x "$MY/mysqld" ] || [ ! -x "$L/node/bin/node" ]; then
  echo "Faltam os programas em .local/ (mysql e node). Peça ao Claude para reinstalar."
  exit 1
fi

NOVO=0
if [ ! -d "$DATA" ]; then
  echo "[teste] Criando o banco de teste pela primeira vez..."
  "$MY/mysqld" --initialize-insecure --basedir="$L/mysql" --datadir="$DATA" --log-error="$L/mysql.log"
  NOVO=1
fi

"$MY/mysqld" --basedir="$L/mysql" --datadir="$DATA" --port=$PORTA_DB --bind-address=127.0.0.1 \
  --socket=$SOCK --mysqlx=OFF --log-error="$L/mysql.log" &
MYPID=$!
trap 'kill $MYPID 2>/dev/null || true; wait $MYPID 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 60); do
  "$MY/mysqladmin" -uroot --socket=$SOCK ping >/dev/null 2>&1 && break
  sleep 0.5
done

SQL() { "$MY/mysql" -uroot --socket=$SOCK --default-character-set=utf8mb4 "$@"; }

if [ "$NOVO" = 1 ] || [ "${RESETAR:-0}" = 1 ]; then
  echo "[teste] Montando o banco nfp_teste (migrations + dados de exemplo)..."
  SQL -e "DROP DATABASE IF EXISTS nfp_teste;
          CREATE DATABASE nfp_teste CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
          CREATE USER IF NOT EXISTS 'nfp'@'127.0.0.1' IDENTIFIED BY 'nfp-teste-local';
          GRANT ALL ON nfp_teste.* TO 'nfp'@'127.0.0.1';"
  SQL nfp_teste < "$ROOT/migrations/mysql/banco-teste-completo.sql"
fi

cd "$ROOT"
[ -d node_modules ] || npm ci
npm run build

echo "[teste] Sistema de teste em http://localhost:${PORT:-3000}  (login: admin@nfp.org.br / admin123)"
DB_HOST=127.0.0.1 DB_PORT=$PORTA_DB DB_USER=nfp DB_PASSWORD=nfp-teste-local DB_NAME=nfp_teste \
JWT_SECRET=teste-local-somente-neste-mac-nao-usar-em-producao \
PORT=${PORT:-3000} node dist/index.js
