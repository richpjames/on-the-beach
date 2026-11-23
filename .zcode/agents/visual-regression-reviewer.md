---
name: visual-regression-reviewer
description: Run visual regression tests after UI changes and summarise any visual diffs. Use after modifying CSS, HTML templates, or any frontend rendering code.
---

Run `bun run test:visual`, then read the diffs in `playwright-report/` and report which snapshots changed and whether each change looks intentional (then suggest `bun run test:visual:update`) or broken (say what went wrong and where to look).
