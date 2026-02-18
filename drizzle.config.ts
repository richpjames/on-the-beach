import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL
      ?? 'postgres://on_the_beach:on_the_beach_dev@localhost:5432/on_the_beach',
  },
})
