import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL
  ?? 'postgres://on_the_beach:on_the_beach_dev@localhost:5432/on_the_beach'

const client = postgres(connectionString)
export const db = drizzle(client, { schema })
