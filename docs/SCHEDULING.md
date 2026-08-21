# Scheduling

## Business rule

Oriole's daily runner is defined for `00:00 Asia/Shanghai` and uses the Beijing calendar date as its idempotency key.

```bash
npm run daily
```

The script:

1. opens the portable Registry, or imports the eight audited public source seeds when it is empty;
2. runs due discovery buckets;
3. safely probes a bounded number of candidates;
4. collects only sources that were already verified and human-approved;
5. writes a portable projection and machine-readable audit;
6. records `.huangque/daily/YYYY-MM-DD.json` atomically.

If that date already completed, another invocation exits successfully without repeating the run. Use `npm run daily -- --force` only for an intentional replay.

## GitHub Actions

`.github/workflows/daily-oriole.yml` schedules:

```yaml
- cron: "0 16 * * *"
```

GitHub cron uses UTC. `16:00 UTC` is `00:00 Asia/Shanghai` on the following calendar day. Scheduled jobs can be delayed by platform queues; Oriole's local-date marker still prevents duplicates.

The workflow has one non-cancelling concurrency group, restores the latest `.huangque` cache, runs the Agent, saves a new cache key, and uploads the latest run/audit/projection as a 30-day artifact. Repository caches are operational convenience, not guaranteed permanent storage. A production deployment should mount persistent storage and back it up.

## Optional Baidu secret

The workflow reads an optional repository secret named:

```text
HUANGQUE_BAIDU_API_KEY
```

Without it, official-catalog and Common Crawl discovery continue; the Baidu provider records `not_configured`. Add the value through GitHub repository settings. Do not add it to a workflow file, `.env.example`, issue, log, artifact, or Registry fixture.

## Limits

Defaults can be changed with repository/workflow environment variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `HUANGQUE_DAILY_MAX_QUERIES` | 20 | discovery tasks selected per daily run |
| `HUANGQUE_DAILY_MAX_PROBES` | 8 | candidates probed per run |
| `HUANGQUE_DAILY_MAX_COLLECTIONS` | 100 | approved sources considered for collection |
| `HUANGQUE_BAIDU_DAILY_BUDGET` | 40 | maximum admitted Baidu requests per Registry day |

The query plan has its own cadence per bucket and each source has a collection cadence. Therefore the midnight runner does not necessarily call every provider or source every day; it runs what is due. The seed manifest contains no jobs, so the first real job rows can only come from a successful runtime collection.

## System cron alternative

On a host whose cron uses local Asia/Shanghai time:

```cron
0 0 * * * cd /srv/oriole-job-engine && /usr/bin/node scripts/huangque/daily-update.mjs >> /var/log/oriole.log 2>&1
```

If the host cron uses UTC, schedule `0 16 * * *`. Run under an unprivileged account and place `HUANGQUE_REGISTRY_PATH` and `HUANGQUE_ARTIFACT_ROOT` on a backed-up writable volume.
