# Security policy

## Supported version

Security fixes are applied to the latest release on the default branch.

## Reporting a vulnerability

Please do not publish exploit details, credentials, private job data, or a vulnerable target URL in a public issue. Use GitHub's private vulnerability reporting feature for this repository. Include:

- the affected version or commit;
- the smallest reproducible request or fixture;
- the expected and observed security boundary;
- whether a real credential, private address, or third-party service was contacted;
- a suggested mitigation, if available.

If private reporting is unavailable, open a public issue that contains no exploit or secret and asks the maintainer to establish a private channel.

## Security boundaries

Oriole treats every discovered webpage and API response as untrusted data. Content is parsed as data and is never executed as an instruction. The network layer provides HTTPS-only access, DNS and connection-time public-address checks, cross-origin redirect controls, per-hop robots checks, response limits, timeouts, and request budgets.

Baidu credentials are optional. The provider refuses to send a configured key to any host other than `qianfan.baidubce.com`. Registry state, the employer universe, source-spider state, receipts, raw artifacts, `.env` files, and audit outputs may contain operational evidence. The reference automation commits the complete durable state tree to `oriole-state`: a compressed, hash-manifested Registry bundle plus the validated employer universe, queue, and receipts. Raw run artifacts are retained separately for 30 days. Compression is not encryption. Use an access-controlled repository when those records are not suitable for public disclosure. A separate branch in a public repository is still public. Never commit credentials or private-source content to either branch.

The state bundle fails closed above 90 MiB compressed and 512 MiB plaintext. The compressed cap is intentionally below [GitHub's documented 100 MiB file block](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github#file-size-limits), but remaining below that single-file limit does not make Git a database or a backup. Migrate before approaching the cap and maintain an independent backup target.

Source approval is a trust decision. Discovery, the 5,000+ employer queue, same-origin crawling, and probing cannot approve a source. The checked-in `verified-source-seeds.json` is an explicit, code-reviewed bootstrap approval and contains no jobs; modifying it must be reviewed as a trust-boundary change. MCP approval is disabled unless an operator explicitly sets `HUANGQUE_ALLOW_MCP_REVIEW=1`; approval also requires a reviewer, reason, confirmation, and expected Registry revision.

The hosted projection enforces a 14-day source-scoped freshness window. This reduces the risk of presenting an old observation as a current opening, but it is not a guarantee that a third-party position remains available between checks. The complete Registry retains older evidence for audit.

The MCP server is a local stdio transport with 18 bounded tools. A client that supports MCP can be configured to invoke it, but Oriole does not provide an unauthenticated public remote endpoint and does not automatically grant every LLM access. Operators who add a remote transport must supply authentication, authorization, isolation, rate limits, and audit logging.

Oriole intentionally excludes private WeChat groups, image ingestion/OCR, email inboxes, login/CAPTCHA-only sources, and access-control bypass. Do not extend the source spider to those channels without a separate privacy, authorization, and compliance design.

## Deployment guidance

- Run the Agent as an unprivileged user with a dedicated writable data directory.
- Keep `.huangque/` and secrets outside the source checkout in shared or production deployments.
- Initialize a missing `oriole-state` only with `npm run init-state -- --output <empty-parent>/state-data`; inspect its exact four-file allowlist and use a non-forced first push. The command creates nine reviewed sources but no jobs, runs, or receipts. Never use a fresh bootstrap to overwrite or “repair” an existing state branch.
- Limit outbound egress to the sources you intend to operate.
- Back up Registry state and evidence according to your retention and privacy policy.
- Treat `oriole-state` as workflow-owned: block human writes/deletion and restrict dispatch permissions. Its weekly recovery job intentionally uses SHA-pinned `--force-with-lease` to compact generated history, so branch rules must allow that workflow identity while rejecting uncoordinated force-pushes.
- Treat GitHub's 30-day artifact retention as evidence retention, not as your only backup.
- Review each source's terms, robots policy, applicable database rights, and personal-information obligations.
- Do not connect Oriole to private networks or use it to bypass authentication, CAPTCHAs, or access controls.

Security controls being implemented is not evidence that the hosted deployment is currently secure and operational. Keep `implementationComplete`, `operationalNow`, and two-date `maturityObserved` conclusions separate; `fullyOperational` also requires current state integrity. A configured workflow, an initialization commit, or one successful run cannot stand in for the missing claim levels.
