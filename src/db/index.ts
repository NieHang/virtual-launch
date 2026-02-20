import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import { config } from '../config.js'
import fs from 'fs'
import path from 'path'

// Ensure data directory exists
const dbDir = path.dirname(config.dbPath)
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}

const sqlite: DatabaseType = new Database(config.dbPath)

// Enable WAL mode for better concurrent read performance
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })
export { schema }
export { sqlite }

