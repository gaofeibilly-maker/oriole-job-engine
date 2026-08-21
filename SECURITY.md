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

Baidu credentials are optional. The provider refuses to send a configured key to any host other than `qianfan.baidubce.com`. Registry state, raw artifacts, `.env` files, and audit outputs may contain operational evidence and must not be committed to a public repository.

Source approval is a trust decision. Discovery and probing cannot approve a source. The checked-in `verified-source-seeds.json` is an explicit, code-reviewed bootstrap approval and contains no jobs; modifying it must be reviewed as a trust-boundary change. MCP approval is disabled unless an operator explicitly sets `HUANGQUE_ALLOW_MCP_REVIEW=1`; approval also requires a reviewer, reason, confirmation, and expected Registry revision.

## Deployment guidance

- Run the Agent as an unprivileged user with a dedicated writable data directory.
- Keep `.huangque/` and secrets outside the source checkout in shared or production deployments.
- Limit outbound egress to the sources you intend to operate.
- Back up Registry state and evidence according to your retention and privacy policy.
- Review each source's terms, robots policy, applicable database rights, and personal-information obligations.
- Do not connect Oriole to private networks or use it to bypass authentication, CAPTCHAs, or access controls.
