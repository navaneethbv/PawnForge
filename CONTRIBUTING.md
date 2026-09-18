# Contributing

## Branch policy

Changes to `main` must arrive through a pull request.
The [Protect main ruleset](https://github.com/navaneethbv/PawnForge/rules/23643627) blocks deletion and force pushes, requires an up-to-date branch and resolved review threads, and has no bypass actors.
The repository owner is the only current collaborator/admin and is listed in `.github/CODEOWNERS`.
Required approvals are zero because GitHub does not allow authors to approve their own pull requests.
This does not waive the required checks.

The ruleset requires `PR checks`, Codacy Static Code Analysis, CodeFactor, and CommitCheck.
GitHub Actions, Codacy, and CodeFactor checks are bound to their respective GitHub Apps.
CodeQL merge protection also requires scanning results and blocks qualifying new high/critical security findings and error-level code alerts in the PR diff.
GitHub's code scanning rules have exceptions, including Dependabot PRs analyzed by default setup; dependency audit/review still run on those PRs.

`.github/main-ruleset.json` records the configured policy.
Editing that file does not change GitHub settings automatically; an authorized administrator must apply it through the repository rules API and verify the effective rules afterward.
Do not rename `PR checks` without updating the live ruleset.

## Required CI

| Check | What it verifies |
| --- | --- |
| JavaScript lint and extension | Node syntax, ESLint recommended rules, Manifest V3 metadata and referenced files, and actionlint workflow validation |
| Node 22 tests / Node 24 tests | Worker recovery, cancellation, job deadlines, and queue limits |
| Browser and extension | Chromium UI regressions, real Stockfish API workflows, extension loading and relay boundaries, keyboard controls, and mobile layout |
| Swift build | The macOS launcher compiles with warnings treated as errors |
| Dependency audit | Installed npm dependencies have no known high or critical vulnerabilities |
| Dependency review | PR dependency changes introduce no known high or critical vulnerabilities |
| PR checks | Every applicable job above succeeded; failures, cancellations, and unexpected skips block merging |

CodeQL runs separately through GitHub default setup so it is not duplicated in the application workflow.
Codacy, CodeFactor, and CommitCheck also report separately.
Application linting excludes vendored Stockfish and generated output.
The browser suite uses a system-installed Stockfish in Linux CI and pinned test copies of frontend libraries.
It is an integration check, not a rebuild or exhaustive validation of the vendored C++ engine.
Native menu interaction and compatibility with third-party chess sites remain manual checks.

CI uses commit-pinned actions, read-only repository permissions, dependency installation without lifecycle scripts, job timeouts, and cancellation of superseded runs.
Browser failures retain screenshots and traces for seven days.

## Local checks

Use Node 22.13 or newer in the 22 release line, or Node 24 or newer.
Install or build Stockfish and leave port 4189 available before browser tests.

```bash
npm ci --ignore-scripts
npm run check
npm run lint
npm run check:extension
npm test
npx playwright install chromium
npm run test:browser
npm audit --audit-level=high
swift build --package-path macos -Xswiftc -warnings-as-errors
```

The Swift command requires macOS.
Workflow edits should also pass actionlint 1.7.12, the version pinned in CI.
When adding publicly served assets, update the explicit `publicFiles` map in `server.js`.
When upgrading CDN script or stylesheet versions, update their integrity hashes from the exact published bytes and rerun browser tests.
