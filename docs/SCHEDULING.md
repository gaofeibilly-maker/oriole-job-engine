# Scheduling

Oriole separates job freshness from source discovery. The schedules below are configured target times in `Asia/Shanghai`; GitHub Actions can start later because of queueing. Configuration alone is not evidence that an online run succeeded.

## Reference schedule

| Beijing time | GitHub UTC cron | Workflow | Responsibility |
| --- | --- | --- | --- |
| Daily `00:17` | `17 16 * * *` | `daily-oriole.yml` | Refresh due, already-approved job sources; write projection and audit |
| Sunday `01:15` | `15 17 * * 6` | `employer-universe-refresh.yml` | Atomically rebuild the validated employer denominator before the deep scan |
| Daily `02:30` | `30 18 * * *` | `source-spider.yml` | Work the bounded employer-source queue; create only candidates/probes |
| Sunday `03:30` | `30 19 * * 6` | `source-spider.yml` | Deeper employer and regional gap scan |
| Sunday `04:47` | `47 20 * * 6` | `state-recovery-audit.yml` | Restore durable state, verify SHA-256, run Agent status, and persist a recovery receipt |

Saturday in the UTC cron expression corresponds to Sunday morning in Beijing. Every state-writing workflow uses the shared non-cancelling `oriole-state-writer` concurrency group.

## First-time `oriole-state` initialization

All four state-writing workflows check out `oriole-state`, so that branch must exist before the first run. From a clone whose `origin` points at the intended GitHub repository, use a disposable repository to create it:

```bash
ORIOLE_ORIGIN_URL="$(git remote get-url origin)"
ORIOLE_BOOTSTRAP_ROOT="$(mktemp -d)"
mkdir "$ORIOLE_BOOTSTRAP_ROOT/repository"

npm run init-state -- \
  --output "$ORIOLE_BOOTSTRAP_ROOT/repository/state-data"

ls -1 "$ORIOLE_BOOTSTRAP_ROOT/repository/state-data"
test ! -e "$ORIOLE_BOOTSTRAP_ROOT/repository/state-data/registry.json"

git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" init -b oriole-state
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" config user.name "Oriole State Bootstrap"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" config user.email "actions@users.noreply.github.com"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" remote add origin "$ORIOLE_ORIGIN_URL"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" add -- state-data
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" diff --cached --name-only
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" commit -m "state: initialize oriole-state"
git -C "$ORIOLE_BOOTSTRAP_ROOT/repository" push origin HEAD:refs/heads/oriole-state
```

The staged paths must be exactly:

```text
state-data/employer-universe.json
state-data/registry.bundle-manifest.json
state-data/registry.json.gz
state-data/source-spider-state.json
```

The command refuses a nonempty or symlinked output and removes plaintext `registry.json` after creating the verified gzip/manifest pair. Its summary must report nine approved reviewed sources and zero jobs, runs, and receipts. The final push is deliberately non-forced; an existing remote branch causes a safe failure. Initialization is not a successful scheduled run and creates no evidence for `operationalNow` or `maturityObserved`.

## Independent job updater

Run locally with:

```bash
npm run daily
```

The updater:

1. idempotently syncs the nine reviewed source seeds;
2. selects only due sources that are already `verified + approved + collectionEnabled`;
3. collects and commits jobs under the Registry's source-revision/cursor checks;
4. produces the 14-day-fresh hosted projection and a machine-readable audit;
5. atomically writes `job-updates/<Beijing-date>.json` and `latest-job-update.json`.

It does not discover or probe new sources. If the same Beijing date already has a successful/no-work receipt, another invocation returns `skipped: true`. Use `npm run daily -- --force` only for an intentional replay.

## Independent source spider

Run the ordinary bounded pass with:

```bash
npm run source-spider
```

Run the deeper mode only when intended:

```bash
npm run source-spider -- --deep
```

The spider works a persistent priority/backoff queue whose denominator is the full 5,000+ employer universe. The checked artifact has 5,425 targets assembled from SSE Main Board, SSE STAR Market, CNINFO's Shenzhen A-share disclosure-publisher directory (explicitly current plus historical publishers under the documented filter), the SASAC central-enterprise directory, and 19 versioned priority employers. A failed live directory refresh is labelled or rejected atomically; it cannot be presented as live or overwrite the last valid file. The spider may discover and safely probe public career roots, but it has no approval path and never collects jobs from a newly found source.

The expanded nationwide query plan has 833 tasks. Of these, 730 are the two rotating prefecture templates across all 365 second-level entries. Deep mode additionally selects bounded province/prefecture, company-career, park, and association gaps.

## Durable GitHub state

The reference workflows check out the dedicated `oriole-state` branch and persist:

- the complete Registry as `state-data/registry.json.gz` plus `registry.bundle-manifest.json` (plaintext is explicitly removed before staging);
- the validated `state-data/employer-universe.json` denominator shared by the updater and spider;
- `state-data/source-spider-state.json` and dated spider receipts;
- latest and dated job-update receipts, audit, and hosted snapshot;
- the latest successful state-recovery receipt.

Writers use a fixed allowlist and reject `*.lock`, `*.tmp`, and `*.backup`; they do not stage the entire directory. Raw content-addressed run evidence is not committed to the code branch; GitHub Actions uploads it as a run artifact with 30-day retention. The recovery run rewrites the dedicated branch as a single root commit with `--force-with-lease`, preventing whole-bundle history from growing without bound. The current tree and artifacts can support operational verification, but their mere existence is not a successful receipt; operators should also maintain independent backups.

The recovery workflow copies the complete `state-data` tree into an isolated directory, compares a deterministic file inventory, validates and unpacks the Registry bundle, validates the employer universe, spider state, and latest receipts when present, then runs Agent status against the restored copy. It writes `latest-state-recovery.json` only after every check succeeds. A failed restore/check cannot replace the prior success receipt.

## Optional Baidu secret

Source discovery can read the repository secret:

```text
HUANGQUE_BAIDU_API_KEY
```

Without it, approved-source job updates continue, official-catalog work remains available, and Common Crawl can execute controlled `site:` tasks. Baidu-only keyword tasks remain explicitly blocked rather than being marked complete. Never place the key in a workflow file, `.env.example`, issue, log, artifact, or Registry fixture.

## Workflow bounds

The reference workflows currently apply these bounds:

| Setting | Reference value | Meaning |
| --- | ---: | --- |
| `HUANGQUE_DAILY_MAX_COLLECTIONS` | 100 | maximum due approved sources considered by one job update |
| `HUANGQUE_SOURCE_SPIDER_MAX_EMPLOYERS` | 100 daily / 150 deep | employer targets selected from the persistent queue |
| `HUANGQUE_SOURCE_SPIDER_MAX_PROBES` | 20 daily / 40 deep | candidate probes in one spider run |
| `HUANGQUE_SOURCE_SPIDER_MAX_CRAWL_PAGES` | 20 default | same-origin employer pages visited in one run |
| `HUANGQUE_BAIDU_DAILY_BUDGET` | 300 in the spider workflow | maximum admitted Baidu requests per Registry day |

The Registry bundle fails when compressed bytes exceed 90 MiB (94,371,840 bytes) or plaintext exceeds 512 MiB. The compressed guard is intentionally below [GitHub's official 100 MiB per-file block](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github#file-size-limits). This is a protective ceiling, not an infinite-scale database claim; migrate to partitioned database/object storage before reaching it.

Each collection also retains its own page, row, byte, host, and request bounds. A ByteDance/Feishu segment advances its saved cursor only in the same successful Registry transaction as its accepted job observations.

## What counts as verified

Use three named claims and never substitute one for another (the five configured schedule entries are separate from these claims):

1. **Implementation — `implementationComplete`:** the workflow, full-state bundle/recovery, queue, and safety contracts inspected by the machine audit exist in the checked-out revision. Verify `init-state` and the wider release surface with the deterministic test suite as a separate supporting check. Tests and `stateIntegrityPassed` never prove an online run.
2. **Operational now — `operationalNow`:** the current durable Registry has real traceable jobs and graph data; the spider queue has actual attempt state; official catalog, Baidu, and Common Crawl observations meet their audit recency windows; and recent GitHub job-update, online-evidenced spider, and full-state recovery receipts pass. Baidu is optional for basic collection, but this deliberately strongest all-channel audit remains false when its recent Baidu evidence is absent.
3. **Cross-day maturity — `maturityObserved`:** successful GitHub job-update receipts and online-evidenced spider receipts each cover at least two distinct `Asia/Shanghai` natural dates.

One manually triggered success proves only that run. Initializing the branch, passing tests, or configuring cron proves none of the online claims. Conversely, `maturityObserved` records repetition and does not guarantee that the shorter `operationalNow` recency windows still pass. `fullyOperational` requires implementation, state integrity, operational-now, and maturity checks together.

## System cron alternative

On a host whose cron uses Beijing time, equivalent job/source entries are:

```cron
17 0 * * * cd /srv/oriole-job-engine && /usr/bin/node scripts/huangque/daily-update.mjs >> /var/log/oriole-jobs.log 2>&1
30 2 * * * cd /srv/oriole-job-engine && /usr/bin/node scripts/huangque/source-spider-update.mjs >> /var/log/oriole-spider.log 2>&1
30 3 * * 0 cd /srv/oriole-job-engine && /usr/bin/node scripts/huangque/source-spider-update.mjs --deep >> /var/log/oriole-spider-deep.log 2>&1
```

The GitHub-specific recovery workflow has no direct local cron equivalent unless you also implement restoration from your backup target and persist its receipt. Run every command as an unprivileged user and place state and evidence on backed-up writable storage.
