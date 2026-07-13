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

**Never hand-edit `drizzle/meta/_journal.json` to insert a migration with a
backdated `when` timestamp.** Drizzle's migrator only applies entries whose
`when` is newer than the last applied migration's timestamp, so any database
that has already migrated past the inserted slot (i.e. production) will skip
the migration forever — silently. This happened with `0007_item_suggestions`
(healed by `0012_ensure_item_suggestions`). A new migration must always be
appended with a current timestamp, which is what `bun run db:generate` does.
