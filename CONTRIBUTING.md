# Contributing to Viewpoint Arena

Thank you for your interest in contributing to Viewpoint Arena. This document explains how to set up the development environment, our branch and PR conventions, and the legal basis for contributions.

## Development setup

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- [npm](https://www.npmjs.com/) (ships with Node.js)

### Getting started

```bash
git clone https://github.com/coacopacoXR/viewpoint-arena.git
cd viewpoint-arena
npm install
```

### Running the app

```bash
npm run dev
```

This starts the Vite development server. The app works in **zero-account mock mode** by default — no external service credentials are required for local development.

### Available scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite development server |
| `npm run build` | Build the production bundle |
| `npm run preview` | Preview the production build locally |
| `npm run typecheck` | Run TypeScript type checking (`tsc --noEmit`) |
| `npm run lint` | Lint the codebase with ESLint (errors fail; warnings are tracked debt) |
| `npm run format` | Format the codebase with Prettier |
| `npm run test` | Run unit and contract tests with Vitest |
| `npm run test:e2e` | Run end-to-end tests with Playwright |
| `npm run check:env` | Guard against secret-shaped `VITE_*` env vars leaking into the client bundle |

## Branch and PR conventions

- Create a feature branch from `main` for each piece of work.
- Use descriptive branch names (e.g., `feat/local-capture-provider`, `fix/turn-credential-handling`).
- Keep PRs focused — one logical change per PR.
- Write a clear PR description explaining **what** changed and **why**.
- Ensure `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, and `npm run check:env` all pass before requesting review — these are the checks CI runs on every PR.
- Follow existing code style and naming conventions in the project.

## Reporting bugs and requesting features

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) for bugs.
- Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml) for new features.
- For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Inbound = outbound contribution policy

By submitting a contribution (pull request, issue comment, patch, or any other form of contribution), you agree that:

1. Your contribution is provided under the same license as the project — the [Apache License, Version 2.0](LICENSE).
2. You have the right to grant this license for your contribution.
3. You understand and agree that your contribution is provided on an "AS IS" basis, without warranties of any kind.

This is an **inbound = outbound** model: everything you contribute automatically becomes part of the project under Apache-2.0, just as everything you receive from the project is already Apache-2.0. No separate CLA or DCO signature is required — the act of submitting a contribution constitutes acceptance of these terms.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## License

Viewpoint Arena is licensed under the [Apache License, Version 2.0](LICENSE).

Third-party components that ship in a build, and the obligations that come with
them, are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
