# Staging website (Cloudflare Pages)

Production and staging are separate Cloudflare Pages projects.

| Environment | Project | Branch | URL |
|-------------|---------|--------|-----|
| Production | `skills-website` | `main` | https://skills.wezzard.com |
| Staging (PR previews) | `skills-website-staging` | `pr-<number>` | https://pr-<number>.skills-website-staging.pages.dev |

## How previews work

[`.github/workflows/preview-website.yml`](../.github/workflows/preview-website.yml) runs on pull requests that touch website-related paths. Each PR deploys to its own branch alias:

- PR #4 → https://pr-4.skills-website-staging.pages.dev
- PR #12 → https://pr-12.skills-website-staging.pages.dev

Multiple open PRs can be previewed at the same time without overwriting each other.

The workflow posts (and updates) a comment on the PR with the preview URL.

## Who can trigger previews

Preview deploys use Cloudflare secrets and are restricted in the workflow:

| Check | Reason |
|-------|--------|
| PR head branch is in **`WeZZard/skills`** (not a fork) | Fork PRs never deploy |
| PR author is **`WeZZard`** or **`github-actions[bot]`** | Blocks other GitHub users / collaborators |

To allow another login, add it to the job `if:` in `.github/workflows/preview-website.yml`.

**Repo setting (recommended):** GitHub → **Settings → Actions → General** → set **Fork pull request workflows** to **Disable** so fork PRs do not run Actions at all.

## One-time Cloudflare setup

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Direct Upload**.
2. Name the project **`skills-website-staging`** (must match the workflow).
3. Ensure the GitHub Actions token (`CLOUDFLARE_API_TOKEN`) can deploy to Pages (Account → **Cloudflare Pages** → Edit).

The first workflow deploy will upload assets; no custom domain is required for staging.

## Local preview

For offline or faster iteration:

```bash
cd website
npm ci
npm run build
npm run preview
```
