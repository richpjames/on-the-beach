#!/bin/bash
# Claude Code web setup script
# Runs on Ubuntu 24.04 as root, before Claude Code launches.
# Enter the contents of this file in: Environment settings > Setup script
set -e

# Install gh CLI (not in the default cloud image)
apt-get update -qq && apt-get install -y gh

# Install dependencies
# Note: bun has known proxy compatibility issues in cloud environments, so use npm
npm install

# Install Playwright browser for E2E tests (chromium only, headless)
npx playwright install --with-deps chromium || true
