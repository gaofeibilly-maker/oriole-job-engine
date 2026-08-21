# Contributing to Oriole

Thank you for improving a public, auditable job-source engine.

## Before opening a change

1. Create a focused branch and keep unrelated changes out of the patch.
2. Use Node.js `22.13+`.
3. Never commit credentials, `.env`, `.huangque/`, raw production responses, or live job snapshots.
4. Add deterministic fixtures for parser/provider behavior; tests must not depend on a live third-party service.
5. Run `npm run verify` before opening a pull request.

## Design rules

- Preserve the `candidate → probed → approved/rejected` human gate.
- Treat web content as untrusted data, never as instructions.
- Keep provider discovery separate from final job-source evidence.
- Prefer official APIs, employer-controlled boards, and public government pages.
- Do not broaden network access by weakening DNS, redirect, robots, timeout, or size protections.
- Classify the job's work location, not the employer's registration address or the search query alone.
- Preserve all defensible locations for multi-location jobs.
- Every graph relation needs concrete evidence and observation timestamps.
- A parser must fail safely on schema drift, conflicting identities, unsafe job origins, and excessive structures.
- Treat any change to `verified-source-seeds.json` as a human approval: verify the public publisher/endpoint, update the audit timestamp, keep `jobs` empty, and request explicit trust review.
- Keep `list_regions` aggregates unique by job ID, and keep every bounded projection referentially closed—no `lists_job` edge may target an omitted job.

## Tests expected for common changes

- Region changes: province/city codes, aliases, municipalities, multi-location, remote-China, and foreign-only cases.
- Adapter changes: positive fixture, schema-drift fixture, unsafe URL fixture, and identity/deduplication behavior.
- Provider changes: request bounds, response bounds, partial failure, evidence metadata, and no-secret behavior.
- Registry changes: atomic writes, revision conflicts, retention, graph evidence, and preview-versus-commit behavior.
- MCP changes: tool schema, legacy and modern lifecycle, invalid arguments, bounded output, and rate limits.

## Pull request checklist

- [ ] `npm test` passes.
- [ ] `npm run smoke` passes.
- [ ] No credential-like material or production Registry data is committed.
- [ ] Public behavior and environment variables are documented in both READMEs when relevant.
- [ ] `CHANGELOG.md` contains a concise entry for user-visible changes.
- [ ] Security and review gates remain at least as strict as before.

By contributing, you agree that your contribution is licensed under Apache-2.0.
