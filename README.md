# Orion Console

Orion Console is a local-first Windows web console intended to coordinate Codex CLI and Claude Code CLI through governed, observable workflows.

## Current Milestone

The repository is at **M0 — Foundation**. S0 establishes repository governance and preserves the Orion specification baseline. Application packages, scripts, and runnable development commands are not implemented yet.

There is no Orion Console Agent runtime at this stage. Orion, Archon, Forge, Verify, Sentinel, and other catalog names are responsibility labels only. Current planning, review, implementation, validation, and completion work uses independent, user-started general Codex or Claude sessions.

## Requirements

The documented target environment is:

- Windows 11
- Node.js 24.x
- pnpm 11.x
- supported Git for Windows
- Codex CLI 0.138.0 or later
- Claude Code 2.1.156 or later

S0 does not install packages or test CLI login/capabilities.

## Repository Structure

```text
.
├─ docs/orion/     # Orion Console Source of Truth
├─ AGENTS.md       # common repository and phase rules
├─ CLAUDE.md       # Claude Code-specific guidance
└─ README.md       # repository entry point
```

The planned M0 application structure (`apps/`, `packages/`, `scripts/`, migrations, workspace manifests, and quality configuration) is created only in later approved M0 steps.

## Documentation

Start with [Orion Console Documentation Index](docs/orion/orion-console-documentation-index.md). The documents under `docs/orion/` define product scope, architecture, API contracts, security, testing, operation, implementation sequencing, and development gates.

Security and permission decisions follow `docs/orion/orion-console-security-permission-model.md`.

## Development Gates

Development proceeds through five user-controlled gates:

1. Planning
2. Independent plan review
3. Implementation
4. Independent validation
5. Completion

Each transition is initiated manually after its file-based evidence is reviewed. Implementation and validation use separate AI sessions.

## Runtime Data

Runtime databases, logs, artifacts, worktrees, exports, and local session/task state belong outside tracked source. The planned product runtime root is `%LOCALAPPDATA%\OrionConsole`. Local `.gjc/` and `.orion/` state is not committed.

## Installation and Commands

Workspace installation and `pnpm` development, lint, typecheck, test, coverage, build, E2E, dev, and start commands will be implemented and verified during approved M0 S1-S8 work. They are intentionally not documented as working commands in S0.

## External Actions

Local approved edits, tests, and commits are distinct from external changes. Push, PR creation or merge, deployment, release, external messages, and other external-state mutations require separate explicit user approval and are not performed by S0.
