---
name: db-migration
description: Generate and apply a Drizzle database migration safely - shows the generated SQL before applying
disable-model-invocation: true
---

Run a safe database migration workflow:

1. Run `bun run db:generate` to generate the migration SQL from schema changes
2. Show the contents of the newest file(s) in drizzle/ for review
3. Ask the user to confirm before proceeding
4. On confirmation, run `bun run db:migrate` to apply the migration
5. Run `bun run typecheck` to verify the schema types are still consistent
6. Report success or any errors
