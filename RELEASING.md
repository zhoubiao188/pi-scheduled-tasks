# Releasing

Releases are published by GitHub Actions through npm **Trusted Publishing**
(OIDC). No npm token and no interactive 2FA are involved: GitHub mints a
short-lived token, and npm attaches a provenance statement to the release.

## One-time setup on npm

1. Open <https://www.npmjs.com/package/@zhoubiao188/pi-scheduled-tasks> →
   **Settings** → **Trusted Publishing**.
2. Add a GitHub publisher:
   - Organization or user: `zhoubiao188`
   - Repository: `pi-scheduled-tasks`
   - Workflow filename: `release.yml`
   - Environment: leave empty
   - Allowed actions: publish
3. Save. npm asks for 2FA once, when the publisher is created.

## Cutting a release

```bash
npm version patch --no-git-tag-version   # or minor / major
git add -A
git commit -m "chore(release): $(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push origin main --tags
```

The tag starts `.github/workflows/release.yml`, which:

1. installs, tests and typechecks;
2. refuses to publish when the tag and `package.json` version disagree;
3. runs `npm publish --provenance --access public`.

Check the run with `gh run list --workflow=release.yml` and the result with:

```bash
npm view @zhoubiao188/pi-scheduled-tasks version --registry=https://registry.npmjs.org
```

## Verifying the workflow without publishing

Actions → **Release** → **Run workflow** keeps `dry_run` on by default: it
builds, tests and runs `npm publish --dry-run` without touching the registry.
Turn `dry_run` off only when the trusted publisher is configured.

## If trusted publishing is unavailable

The fallback is an interactive publish from a machine with 2FA, or a granular
access token with "Bypass two-factor authentication" enabled (npm retires that
for publishing in January 2027):

```bash
npm publish --registry=https://registry.npmjs.org
```
