// ============================================================
// Adaptador de banco de dados: expõe uma interface compatível
// com a API D1 do Cloudflare Workers (prepare/bind/first/all/run/batch),
// mas implementada sobre MySQL (mysql2) — usado no deploy Hostinger.
//
// Isso evita reescrever as ~160 chamadas `c.env.DB.prepare(...).bind(...)...`
// espalhadas pelas rotas: elas continuam funcionando sem alteração,
// apontando para este objeto em vez do binding nativo do Workers.
// ============================================================

import mysql from 'mysql2/promise'

export interface AppD1Result<T = unknown> {
  results: T[]
  success: boolean
  meta: {
    last_row_id: number
    changes: number
  }
}

export interface AppD1PreparedStatement {
  bind(...values: unknown[]): AppD1PreparedStatement
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ results: T[] }>
  run<T = unknown>(): Promise<AppD1Result<T>>
  /** Acesso interno usado apenas por AppDatabase.batch() */
  _sql: string
  _params: unknown[]
}

export interface AppDatabase {
  prepare(sql: string): AppD1PreparedStatement
  batch<T = unknown>(statements: AppD1PreparedStatement[]): Promise<AppD1Result<T>[]>
}

/**
 * Converte os placeholders estilo SQLite (`?`) usados nas queries originais
 * — já compatíveis com a sintaxe de placeholder posicional do mysql2, então
 * nenhuma conversão de `?` é necessária. O que precisamos ajustar são apenas
 * algumas diferenças de sintaxe SQL entre SQLite e MySQL dentro das queries
 * (isso já foi feito nas migrations convertidas, não aqui em runtime).
 */
function createPreparedStatement(pool: mysql.Pool, sql: string): AppD1PreparedStatement {
  let boundParams: unknown[] = []

  const stmt: AppD1PreparedStatement = {
    _sql: sql,
    _params: boundParams,
    bind(...values: unknown[]) {
      boundParams = values
      stmt._params = boundParams
      return stmt
    },
    async first<T = unknown>(): Promise<T | null> {
      const [rows] = await pool.query(sql, boundParams)
      const arr = rows as T[]
      return arr.length > 0 ? arr[0] : null
    },
    async all<T = unknown>(): Promise<{ results: T[] }> {
      const [rows] = await pool.query(sql, boundParams)
      return { results: rows as T[] }
    },
    async run<T = unknown>(): Promise<AppD1Result<T>> {
      const [result] = await pool.query(sql, boundParams)
      const r = result as mysql.ResultSetHeader
      return {
        results: [],
        success: true,
        meta: {
          last_row_id: r.insertId ?? 0,
          changes: r.affectedRows ?? 0
        }
      }
    }
  }
  return stmt
}

/**
 * Cria o adaptador de banco. `batch()` executa as queries dentro de uma
 * transação MySQL real (equivalente à atomicidade do D1.batch()).
 */
export function createDatabase(pool: mysql.Pool): AppDatabase {
  return {
    prepare(sql: string) {
      return createPreparedStatement(pool, sql)
    },
    async batch<T = unknown>(statements: AppD1PreparedStatement[]): Promise<AppD1Result<T>[]> {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const results: AppD1Result<T>[] = []
        for (const stmt of statements) {
          const [result] = await conn.query(stmt._sql, stmt._params)
          const r = result as mysql.ResultSetHeader
          results.push({
            results: [],
            success: true,
            meta: { last_row_id: r.insertId ?? 0, changes: r.affectedRows ?? 0 }
          })
        }
        await conn.commit()
        return results
      } catch (err) {
        await conn.rollback()
        throw err
      } finally {
        conn.release()
      }
    }
  }
}

let pool: mysql.Pool | null = null

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      dateStrings: true,
      charset: 'utf8mb4',
      // Importante: o código de negócio foi escrito originalmente para o
      // D1 (SQLite), que retorna valores numéricos (REAL) como `number`
      // nativo do JS. O mysql2, por padrão, retorna colunas DECIMAL/NEWDECIMAL
      // (usadas aqui para valores monetários) como `string`, para não perder
      // precisão. Isso quebraria silenciosamente comparações e `.toFixed()`
      // espalhados pelas rotas financeiras. `decimalNumbers: true` faz o driver
      // converter essas colunas para `number` automaticamente, preservando o
      // comportamento esperado pelas rotas sem precisar alterá-las.
      decimalNumbers: true
    })
  }
  return pool
}

export function getDatabase(): AppDatabase {
  return createDatabase(getPool())
}
