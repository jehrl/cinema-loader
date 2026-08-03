# cron-job.org setup

This repository uses cron-job.org only as the scheduler. Every 15 minutes it
sends a small authenticated POST request to GitHub, which starts the existing
Cinema City watchdog workflow. The workflow checks the Cinema City API,
deduplicates sessions in `app/watch-state.json`, and publishes new sessions to
ntfy.

## 1. Create a dedicated GitHub token

Create a fine-grained personal access token at:

https://github.com/settings/personal-access-tokens/new

Use these settings:

- Token name: `cron-job.org cinema-loader dispatch`
- Expiration: shortly after the monitoring period ends
- Resource owner: `jehrl`
- Repository access: **Only select repositories** → `cinema-loader`
- Repository permissions: **Actions → Read and write**
- Do not grant any additional write permissions

Copy the token immediately. GitHub will not show it again.

## 2. Create the cron job

Open https://console.cron-job.org/jobs/create and enter:

- Title: `Cinema City Odyssea IMAX watchdog`
- URL:

  `https://api.github.com/repos/jehrl/cinema-loader/actions/workflows/cinema-watchdog.yml/dispatches`

- Schedule: every 15 minutes
- Request method: `POST`
- Request body:

  ```json
  {"ref":"master"}
  ```

- Headers:

  | Header | Value |
  |---|---|
  | `Accept` | `application/vnd.github+json` |
  | `Authorization` | `Bearer YOUR_FINE_GRAINED_TOKEN` |
  | `X-GitHub-Api-Version` | `2026-03-10` |
  | `Content-Type` | `application/json` |

Enable cron-job.org failure notifications. GitHub's dispatch endpoint should
return an HTTP 2xx response. The request itself only starts the workflow and
normally finishes in well under cron-job.org's 30-second timeout.

## 3. Test

Use **Test run** in cron-job.org. Then verify that a new run appears at:

https://github.com/jehrl/cinema-loader/actions/workflows/cinema-watchdog.yml

The run should finish successfully in roughly 10 seconds. New Cinema City
sessions will be published to the ntfy topic configured in the repository
secret `NTFY_TOPIC`.

Subscribe to the current ntfy topic here:

https://ntfy.sh/cinemacity-odyssea-e82af2cf0c0a9c1e826172a3a9803868

## 4. Security and shutdown

- Never put the GitHub token in the repository or the ntfy topic.
- Store it only in cron-job.org's custom `Authorization` header.
- When monitoring is no longer needed, disable the cron job and revoke the
  dedicated token at https://github.com/settings/personal-access-tokens.
