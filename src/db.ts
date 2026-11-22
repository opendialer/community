import {errorFields} from './error-fields.js'
import pg from 'pg'

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
})
pool.on('error', (error) => console.error(JSON.stringify({event:'database_connection_lost',...errorFields(error)})))
