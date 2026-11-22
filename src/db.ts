import {log} from './log.js'
import pg from 'pg'

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
})
// pg emits this for an idle client whose connection dropped (restart, failover, network); the pool discards it.
pool.on('error', (error) => log.error('database_connection_lost',{reason:'idle_client_error',error}))
