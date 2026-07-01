#!/bin/bash
# Claude Code web setup script
# Runs on Ubuntu 24.04 as root, before Claude Code launches.
# Enter the contents of this file in: Environment settings > Setup script
set -e

# Install dependencies
# Note: bun has known proxy compatibility issues in cloud environments, so use npm
npm install

# NOTE: Do not run `npx playwright install` here. The Claude Code web image
# already ships a prebuilt Chromium at $PLAYWRIGHT_BROWSERS_PATH
# (/opt/pw-browsers), and downloading the ~177 MB browser from
# cdn.playwright.dev is killed mid-transfer by the cloud egress proxy, so the
# install fails on every run. Playwright picks up the preinstalled browser
# automatically. Likewise, gh is already present in the image, so there is no
# need to apt-get install it.
