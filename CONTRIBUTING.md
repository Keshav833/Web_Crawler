# Contributing

Thanks for considering a contribution. Small, focused pull requests with clear tests and documentation are especially helpful.

## Development setup

1. Fork the repository and clone your fork.
2. Use Node.js `20.18.1` or newer and npm.
3. Install dependencies:

   ```bash
   npm ci
   ```

4. If you are working on browser support or running the full browser tests, install Chromium:

   ```bash
   npx playwright install chromium
   ```

## Validate your changes

Run these checks before opening a pull request:

```bash
npx tsc --noEmit
npm test
npm run build
```

Tests use Vitest. Browser integration tests use controlled local pages, not public websites. There is no linter configured; do not add one without discussing the change first.

Dashboard API and browser UI tests also use local test servers. The browser UI tests require the Playwright Chromium installation described above.

## Code and test expectations

- Follow the existing TypeScript style and module structure.
- Keep changes focused and avoid adding dependencies without a clear need.
- Preserve HTTP as the default backend and maintain existing robots, timeout, retry, pacing, and worker behavior.
- Add or update tests for behavior changes. Prefer deterministic local responses and avoid ordinary tests that depend on external sites.
- Update the README when changing user-facing commands, options, or behavior.
- Do not commit generated crawl output, build artifacts, local environment files, or credentials.

## Branch and commit suggestions

Use descriptive branch names, for example:

- `fix/browser-timeout-cleanup`
- `feat/csv-output-option`
- `docs/contributor-setup`

Use concise imperative commit subjects, optionally with a Conventional Commit prefix, such as `fix: close browser context after timeout` or `docs: clarify CLI limits`.

## Pull requests

- Explain the problem and the approach.
- Link related issues, if any.
- List the tests and validation commands you ran, including any that could not be run.
- Include documentation updates for user-visible changes.
- Keep the pull request focused; avoid mixing unrelated refactors.

## Bug reports and feature requests

Before opening a report, check existing issues for duplicates. Include reproducible steps, expected and actual behavior, the Node.js version, the crawler mode, relevant CLI options, and a redacted error message. Never include credentials, cookies, private URLs, or other sensitive data.

For feature requests, describe the use case and its impact on responsible crawling, resource use, and compatibility with the current API.

## Responsible crawling

Only test against public pages you are authorized to access, or use local controlled pages. Respect `robots.txt`, site terms, rate limits, and requests from site owners. Do not contribute CAPTCHA bypasses, stealth or fingerprint evasion, authentication bypasses, access-control circumvention, or code intended to overload websites.
