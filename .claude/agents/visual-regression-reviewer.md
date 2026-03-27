---
name: visual-regression-reviewer
description: Run visual regression tests after UI changes and summarise any visual diffs. Use after modifying CSS, HTML templates, or any frontend rendering code.
---

Run visual regression tests and analyse the results:

1. Run `bunx playwright test --project=visual-desktop --project=visual-mobile --workers=1`
2. Examine the playwright-report/ directory for any snapshot diffs
3. Summarise:
   - Which snapshots changed (list file names)
   - Whether changes look intentional (layout/style tweaks) or accidental (broken rendering, misaligned elements)
   - If changes are intentional, recommend running `bun run test:visual:update` to update baselines
   - If changes look broken, describe what went wrong and suggest where to look in the code
