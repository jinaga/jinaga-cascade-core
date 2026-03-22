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
2. **Secrets** — If you publish with a classic automation token, add **`NPM_TOKEN`** under Settings → Secrets and variables → Actions. The publish workflow reads it as `NODE_AUTH_TOKEN` (see appendix). If you use **Trusted Publishers** (OIDC) only, you do not need `NPM_TOKEN`.
3. **Workflow files** — They should live in the monorepo at `packages/jinaga-cascade-core/.github/workflows/`, be committed to `jinaga/cascade`, then deployed to GitHub with `npm run sync-core`. After that, changes to workflows follow the same path: edit in the monorepo, commit, sync.

### npm package and publishing identity

1. **Package name** — `@jinaga/cascade-core` (see `package.json`). It is **scoped** to the `jinaga` org on npm. Use **`npm publish --access public`** so the package is public (scoped packages default to private on first publish without it).
2. **Owners** — On [npm](https://www.npmjs.com/package/@jinaga/cascade-core), ensure the right accounts have publish access (`npm owner ls @jinaga/cascade-core`).
3. **Choose how CI authenticates to npm:**

   **Trusted publishing (recommended)**  
   In the npm package’s settings, connect **Trusted Publishers** to the GitHub repository `jinaga/jinaga-cascade-core` and the workflow that runs `npm publish`. Follow [npm’s Trusted Publishers documentation](https://docs.npmjs.com/trusted-publishers) for OIDC setup. The workflow needs whatever `permissions` npm documents (commonly `id-token: write`). You can add [provenance](https://docs.npmjs.com/generating-provenance-statements) if your workflow supports it.

   **Automation token**  
   Create an npm [automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens), store it as the `NPM_TOKEN` secret on GitHub, and use `setup-node` with `registry-url` plus `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the publish step (see appendix).

4. **First publish from automation** — After credentials work, the first real publish is usually triggered by pushing a **version tag** to the public repo (see [Releases](#releases)). You can dry-run locally with `npm publish --dry-run` after `npm run build` in a clean clone of the public repo or in this package directory after sync.

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

## Appendix: Example GitHub Actions workflows

Place these under `packages/jinaga-cascade-core/.github/workflows/` in the monorepo, commit, and run `npm run sync-core` so they appear on the public repository.

Adjust `node-version` to your chosen LTS. The public repo root must contain `package.json` (true after subtree sync).

### `ci.yml` (continuous integration)

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

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

### `publish.yml` (npm publish on version tags)

Use **either** Trusted Publishing (OIDC) **or** `NPM_TOKEN`; do not duplicate publish steps.

**With `NPM_TOKEN` repository secret:**

```yaml
name: Publish

on:
  push:
    tags:
      - "v*"

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - name: Verify tag matches package.json
        run: |
          VERSION=$(node -p "require('./package.json').version")
          TAG="${GITHUB_REF_NAME#v}"
          if [ "$VERSION" != "$TAG" ]; then
            echo "Tag $GITHUB_REF_NAME does not match package.json version $VERSION"
            exit 1
          fi
      - run: npm run build
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

If you use **Trusted Publishers** with OIDC, follow npm’s current documentation for the publish job (tokenless OIDC, `id-token`, and optional provenance flags) instead of `NPM_TOKEN`.
