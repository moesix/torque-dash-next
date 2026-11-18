# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (Security → Report a
vulnerability) for this repository. Do not open a public issue for an
exploitable problem. We aim to acknowledge within 7 days.

## Supported versions

The latest `v2.x` release and the `development` branch receive fixes. Older
tags do not.

## Scope

In scope: the application code in this repository (auth/session handling,
upload token gate, SSRF guard for admin-configured LLM endpoints, SQL/JSON
handling, the nginx edge config shipped in `apps/frontend`).

Out of scope: misconfiguration of your own deployment (exposed `.env`,
`COOKIE_SECURE=false` on a public host, open registration on a fresh
instance), and third-party services (your LLM provider, Torque Pro).

## Hardening checklist

See `docs/deployment.md` §2 (required variables), §5 (first-time setup:
`ADMIN_SETUP_TOKEN`, disable registration) and §6 (upgrades).
