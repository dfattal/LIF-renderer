# GitHub Pages Deployment via GitHub Actions (No Branch Commits)

This document explains how to deploy a built project to GitHub Pages using GitHub Actions **without creating commits in a gh-pages branch**. This is the modern, recommended approach from GitHub.

## Overview

Traditional GitHub Pages deployment created commits in a `gh-pages` branch. The modern approach uses **GitHub Actions workflows** that upload build artifacts directly to GitHub Pages infrastructure, with no branch commits required.

## Benefits

- ✅ No separate branch to maintain
- ✅ No commit history pollution
- ✅ Cleaner git history
- ✅ Automatic deployment on push
- ✅ Full control over build process
- ✅ Works with any static site generator

## Setup Steps

### 1. Create GitHub Actions Workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches:
      - main  # or your default branch

  # Allows manual triggering from Actions tab
  workflow_dispatch:

# Required permissions for deployment
permissions:
  contents: read
  pages: write
  id-token: write

# Prevent concurrent deployments
concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build site
        run: npm run build:demo  # or your build command

      - name: Setup Pages
        uses: actions/configure-pages@v4

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: './dist-demo'  # path to your build output

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

### 2. Configure Repository Settings

#### Option A: Via GitHub Web UI

1. Go to repository **Settings** → **Pages**
2. Under **Build and deployment** → **Source**:
   - Select: **GitHub Actions**
3. Save changes

#### Option B: Via GitHub CLI

```bash
gh api -X PUT repos/OWNER/REPO/pages -f build_type=workflow
```

### 3. Configure Environment (if needed)

If deployment fails with "branch not allowed" error:

1. Go to **Settings** → **Environments** → **github-pages**
2. Under **Deployment branches and tags**:
   - Add your main branch (e.g., `main`)
   - OR set to "All branches"

Via GitHub CLI:
```bash
# Check current config
gh api repos/OWNER/REPO/pages

# Should show: "build_type": "workflow"
```

### 4. Deploy

Push to your main branch:
```bash
git add .
git commit -m "Your changes"
git push origin main
```

GitHub Actions will automatically:
1. Build your site
2. Upload the artifact
3. Deploy to GitHub Pages

## How It Works

1. **Trigger**: Push to main branch triggers the workflow
2. **Build Job**:
   - Checks out code
   - Installs dependencies
   - Runs build command
   - Uploads build output as artifact
3. **Deploy Job**:
   - Downloads artifact
   - Deploys to GitHub Pages infrastructure
   - **No branch commits created**

## Deployment URLs

- **Repository Pages**: `https://USERNAME.github.io/REPO-NAME/`
- **User/Org Pages**: `https://USERNAME.github.io/`

## Avoiding Conflicts with User Site

If you have a user site (`USERNAME.github.io` repository) with a folder matching your project name, it can conflict.

**Solution**: Remove the folder from your user site:

```bash
# Clone user site
gh repo clone USERNAME/USERNAME.github.io
cd USERNAME.github.io

# Remove conflicting folder
git rm -r PROJECT-NAME
git commit -m "Remove PROJECT-NAME (now deployed from separate repo)"
git push origin main
```

The project site deployment will take precedence once the folder is removed.

## Verifying Deployment

```bash
# Check deployment status
gh run list --limit 3

# Check Pages configuration
gh api repos/OWNER/REPO/pages

# Should show:
# "build_type": "workflow"  (not "legacy")
# "html_url": "https://USERNAME.github.io/REPO/"
```

## Troubleshooting

### Error: "Invalid deployment branch"

Your repository's Pages environment has branch restrictions.

**Fix**: Add your branch to allowed deployment branches:
1. Settings → Environments → github-pages
2. Deployment branches → Add rule for `main`

### Error: "Not found" on deployment URL

1. Check workflow completed successfully
2. Verify `build_type` is set to `workflow` (not `legacy`)
3. Wait 1-2 minutes for propagation

### Build fails

1. Check build command works locally: `npm run build:demo`
2. Verify `path` in upload-pages-artifact matches your build output directory
3. Check workflow logs in Actions tab

## Example Projects

- **This project** (LIF-renderer): [.github/workflows/deploy.yml](.github/workflows/deploy.yml)

## References

- [GitHub Actions for Pages](https://github.com/actions/deploy-pages)
- [Configuring Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
