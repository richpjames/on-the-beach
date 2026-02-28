# AGENTS.md



## Build/Change Playbook For Agents

When implementing a feature:

1. Add/adjust types in `src/types/index.ts` first.
2. Implement backend route/data behavior in `server/routes/*` and `server/db/*` as needed.
3. Update `ApiClient` methods in `src/services/api-client.ts`.
4. Update UI behavior in `src/app.ts`.
5. Add/adjust unit tests for pure logic changes.
6. Add/adjust Playwright tests for user-visible behavior or integration tests
7. Run quality gates.

### On pushing
- check the the Github checks for the branch have passed. If they fail investigate and fix the error.
## Deployment Notes

- Docker Compose uses `docker-compose.yml`.
- In containerized deployment, persist DB file via `DATABASE_PATH` volume mapping.
- See `docs/deployment/` for runbooks.

### How to use skills

- Discovery: Use the listed names and paths above as the available skills for this session.
- Trigger rules: If the user names a skill or the task clearly matches its description, use it.
- Missing/blocked: If a skill path cannot be read, state that briefly and continue with best fallback.
- Progressive disclosure:
  1. Open the skill's `SKILL.md`.
  2. Resolve referenced relative paths from the skill directory first.
  3. Load only required referenced files.
  4. Prefer provided scripts/assets/templates over rewriting from scratch.
- Coordination:
  - If multiple skills apply, pick the minimal set and state execution order.
  - Announce which skill is used and why.
- Context hygiene:
  - Keep loaded context small.
  - Avoid deep reference chasing unless blocked.
- Safety fallback:
  - If a skill is unclear or incomplete, state issue and continue with a sound fallback.
