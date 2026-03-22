# Deploying `@jinaga/cascade-core`

This guide is for **maintainers** of the public repository (`jinaga/jinaga-cascade-core`) and the **`@jinaga/cascade-core`** npm package (scoped under the **`jinaga`** organization). It covers credentials and one-time package setup, then ongoing work and releases.

Development happens in the private Cascade monorepo (`jinaga/cascade`) under `packages/jinaga-cascade-core/`. The public repo receives updates via **git subtree** (`npm run sync-core` from the monorepo root). Creating the public repo, adding the `public-repo` remote, and first-time subtree troubleshooting are documented in [`docs/setup-monorepo-git-subtree.md`](../../docs/setup-monorepo-git-subtree.md).

---

## How the repositories relate

| | Private monorepo (`jinaga/cascade`) | Public package repo (`jinaga/jinaga-cascade-core`) |
|---|-------------------------------------|---------------------------------------------------|
| **Role** | Authoritative source; develop with the desktop app | Published tree at **repo root**; CI; npm publishes |
| **Git remote** | `origin` | `public-repo` (local convention) |

After a subtree push, the public `main` branch looks like a normal npm package at the repository root (`package.json`, `src/`, `.github/workflows/`, and so on).

---

## One-time: credentials and package setup

Use this when onboarding a new maintainer machine, wiring npm to GitHub Actions, or finishing npm package configuration.

### GitHub repository

1. **Actions** — Confirm [GitHub Actions](https://github.com/jinaga/jinaga-cascade-core/actions) are enabled for the repository (Settings → Actions → General).
2. **OIDC for publish** — The publish workflow uses **Trusted Publishing** (no `NPM_TOKEN`). It must run on **GitHub-hosted** runners (`ubuntu-latest`) with `permissions: id-token: write` (see [npm: Trusted publishing](https://docs.npmjs.com/trusted-publishers)). Self-hosted runners are not supported for OIDC publish today.
3. **Workflow files** — They live in the monorepo at `packages/jinaga-cascade-core/.github/workflows/`, are committed to `jinaga/cascade`, then deployed to GitHub with `npm run sync-core`. Both **CI** and **Publish** support **`workflow_dispatch`**: in the GitHub Actions tab, choose the workflow, then **Run workflow**. Publish defaults to a **dry run** (`npm publish --dry-run`); turn **dry_run** off only if you intend to publish the current `package.json` version from `main` without a tag (use with care). If manual publish fails with an auth mismatch, see npm’s note on **`workflow_dispatch`** and [trusted publisher configuration](https://docs.npmjs.com/trusted-publishers#troubleshooting).

### npm package and publishing identity

1. **Package name** — `@jinaga/cascade-core` (see `package.json`). It is **scoped** to the `jinaga` org on npm. Use **`npm publish --access public`** so the package is public (scoped packages default to private on first publish without it).
2. **`repository` in `package.json`** — Set to the public Git repo (already present) so npm can associate the package with source and [provenance](https://docs.npmjs.com/generating-provenance-statements) works as documented.
3. **Owners** — On [npm](https://www.npmjs.com/package/@jinaga/cascade-core), ensure the right accounts can manage the package (`npm owner ls @jinaga/cascade-core`).
4. **Trusted publishing (OIDC)** — On [npmjs.com](https://www.npmjs.com/) → package → **Settings** → **Trusted publishing**, add **GitHub Actions** with:
   - Repository: `jinaga/jinaga-cascade-core`
   - **Workflow filename** must match exactly (e.g. `publish.yml` — filename only, case-sensitive).
   After it works, npm recommends tightening **Publishing access** (e.g. disallow classic publish tokens); see [Trusted publishing](https://docs.npmjs.com/trusted-publishers).

5. **Requirements** — [npm CLI](https://www.npmjs.com/package/npm) **≥ 11.5.1** and **Node ≥ 22.14.0** for trusted publishing; the workflow upgrades npm and pins Node accordingly.

6. **Fallback: automation token** — If you cannot use OIDC, add **`NPM_TOKEN`** on GitHub and pass `NODE_AUTH_TOKEN` on `npm publish` steps instead (not the default in this repo).

7. **First publish from automation** — After trusted publishing is configured, the first real publish is usually triggered by pushing a **version tag** to the public repo (see [Releases](#releases)). You can dry-run locally with `npm publish --dry-run` after `npm run build` in a clean clone of the public repo or in this package directory after sync.

### Local clone: `public-repo` remote

Your monorepo checkout needs a remote pointing at the public repository so you can sync and push tags:

```bash
git remote add public-repo git@github.com:jinaga/jinaga-cascade-core.git
# or HTTPS: https://github.com/jinaga/jinaga-cascade-core.git
```

If the remote already exists, verify with `git remote -v`. Adding the remote or fixing the first subtree push is covered in [`docs/setup-monorepo-git-subtree.md`](../../docs/setup-monorepo-git-subtree.md).

---

## Ongoing maintenance

### Day-to-day development

Work in `packages/jinaga-cascade-core` inside `jinaga/cascade`. Run tests and builds from the monorepo (`npm run test:core`, `npm run build:core`) or from this package (`npm test`, `npm run build`, `npm run typecheck`, `npm run lint`). Commit to `origin` like any other package.

### Pushing changes to the public GitHub mirror

From the **monorepo root**:

```bash
npm run sync-core
```

This runs `git subtree push` to `public-repo`’s `main`. Use it whenever you want the public repo (and CI on `main`) to reflect merged work. For large or sensitive changes, run tests locally before syncing.

### Keeping Actions and Node aligned

- Workflow files under `packages/jinaga-cascade-core/.github/workflows/` are the source of truth; sync them with `npm run sync-core`.
- Keep the `node-version` in workflows in step with an [active LTS](https://nodejs.org/) and what you use locally so CI matches developer experience.

### Pull requests on the public repository

If contributors open PRs against `jinaga/jinaga-cascade-core`, merge them there, then **bring changes back** into the monorepo with a subtree pull (see [`docs/setup-monorepo-git-subtree.md`](../../docs/setup-monorepo-git-subtree.md)) so `jinaga/cascade` does not drift:

```bash
git subtree pull --prefix=packages/jinaga-cascade-core public-repo main --squash
```

Resolve conflicts, run tests, and commit.

---

## Releases

### Why tags must target the public repo

Tags created on the **private** monorepo point at monorepo commits. Those SHAs are not the same as the rewritten history on `public-repo/main`. **Do not** use `git push public-repo --tags` from the monorepo to drive releases unless you understand exactly which commits those tags reference.

### Release checklist

1. **Bump the version** in `packages/jinaga-cascade-core/package.json` using [semver](https://semver.org/). You can use `npm version patch|minor|major` inside this directory if that fits your process.
2. **Commit and merge** to `main` on `jinaga/cascade` and push to `origin`.
3. **Sync to the public repo** (monorepo root): `npm run sync-core`.
4. **Tag the tip of the public branch** so the tag exists on a commit that `jinaga/jinaga-cascade-core` actually has:

   ```bash
   git fetch public-repo main
   git tag vX.Y.Z public-repo/main -m "@jinaga/cascade-core vX.Y.Z"
   git push public-repo vX.Y.Z
   ```

   Use `vX.Y.Z` matching `package.json` (for example `0.2.0` → `v0.2.0`).

5. **Confirm** the publish workflow on the [Actions](https://github.com/jinaga/jinaga-cascade-core/actions) tab and the new version on [npm](https://www.npmjs.com/package/@jinaga/cascade-core).
6. **Optional:** Create a [GitHub Release](https://github.com/jinaga/jinaga-cascade-core/releases) from that tag with notes.

The publish workflow should **fail** if the tag does not match `"version"` in `package.json` (see appendix).

### Pre-release checks

From the monorepo root:

```bash
npm run test:core
npm run build:core
```

Or from this package:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

---

## Quick reference

| Task | Where | Command / action |
|------|--------|------------------|
| Sync code to public GitHub | Monorepo root | `npm run sync-core` |
| Cut an npm release | Monorepo clone | Bump version → merge → `npm run sync-core` → tag `public-repo/main` → `git push public-repo vX.Y.Z` |
| Local build / test | This package | `npm run build` / `npm test` |

---

## Related documentation

- [`docs/setup-monorepo-git-subtree.md`](../../docs/setup-monorepo-git-subtree.md) — subtree remote, first push, pull, squash, troubleshooting  
- [`docs/QUICKSTART.md`](../../docs/QUICKSTART.md) — monorepo quick start  

---

## Appendix: GitHub Actions workflows

Workflows are committed under `packages/jinaga-cascade-core/.github/workflows/`. Sync with `npm run sync-core`. The public repo root must contain `package.json` (true after subtree sync).

Publish uses **Trusted Publishing**: `id-token: write`, no `NODE_AUTH_TOKEN`. To use a classic token instead, add `NPM_TOKEN` and restore `env: NODE_AUTH_TOKEN` on publish steps.

### `ci.yml` (continuous integration)

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

### `publish.yml` (tags + manual, Trusted Publishing)

```yaml
name: Publish

on:
  push:
    tags:
      - "v*"
  workflow_dispatch:
    inputs:
      dry_run:
        description: When true, runs npm publish --dry-run (no upload). Ignored for tag pushes.
        type: boolean
        default: true

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22.14"
          registry-url: https://registry.npmjs.org
          cache: npm
      - name: Use npm with trusted publishing support
        run: npm install -g npm@^11.5.1
      - run: npm ci
      - name: Verify tag matches package.json
        if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')
        run: |
          VERSION=$(node -p "require('./package.json').version")
          TAG="${GITHUB_REF_NAME#v}"
          if [ "$VERSION" != "$TAG" ]; then
            echo "Tag $GITHUB_REF_NAME does not match package.json version $VERSION"
            exit 1
          fi
      - run: npm run build
      - name: Publish to npm (release)
        if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')
        run: npm publish --access public
      - name: Dry-run publish (manual)
        if: github.event_name == 'workflow_dispatch' && inputs.dry_run
        run: npm publish --dry-run --access public
      - name: Publish to npm (manual, not dry-run)
        if: github.event_name == 'workflow_dispatch' && inputs.dry_run == false
        run: npm publish --access public
```
