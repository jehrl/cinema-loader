# Cinema loader

Thanks to this, I don't need to reload cinema schedule while waiting for
premiere. When new schedule emerges, it sends a PushBullet or local macOS
notification.

## Usage

Get the code.

```shell
git clone https://github.com/ra100/cinema-loader
cd cinemacity-loader
npm install
```

Copy app/default.config.json to app/config.json and modify to suite your needs.

```shell
cp app/default.config.json app/config.json
nano app/config.json
```

Config structure

```json
[
  {
    "id": "odyssea-flora-imax-70mm-after-2026-08-24",
    "url": "https://www.cinemacity.cz/cz/data-api-service/v1/quickbook/10101/film-events/in-cinema/1052/at-date/YYYY-MM-DD?attr=&lang=cs_CZ",
    "startDate": "2026-08-25",
    "endDate": "2026-08-31",
    "filmId": "7268s2r",
    "requiredAttributeIds": ["70-mm"],
    "pushbulletApiKey": "NONE",
    "cinemaLink": "https://www.cinemacity.cz/films/odyssea/7268s2r#/",
    "refreshInterval": 60,
    "pingInterval": 3600,
    "type": "cinemaCity"
  },
  {
    "url": "http://cinestar.cz/cz/?option=com_csevents&view=eventsforday&date=YYYY-MM-DD&cinema=11&titleId=0&format=raw&tpl=program",
    "pushbulletApiKey": "NONE",
    "cinemaLink": "http://cinestar.cz/",
    "refreshInterval": "60",
    "pingInterval": "3600",
    "type": "cineStar"
  }
]
```

- `url` - Cinema City schedule API. `YYYY-MM-DD` is expanded using
  `startDate` and `endDate`.

- `filmId` and `requiredAttributeIds` filter the schedule. The example watches
  The Odyssey (`7268s2r`) at Flora (`1052`) in 70 mm IMAX only.

- `pushbulletApiKey` is your Access Token from <https://www.pushbullet.com/#settings>.
  When it is `NONE`, the loader uses a local macOS notification instead.

- `cinemaLink` will be send as url in pushbullet link

- `refreshInterval` (in seconds) indicates how often should
  script check for new schedule

- `pingInterval` (in seconds) indicates how often do you
  want to get pings that script still runs, if you don't want to
  receive pings, set to `0`

- `type` which detection type it should use

Start app.

```shell
npm start
```

## GitHub Actions

The workflow in `.github/workflows/cinema-watchdog.yml` runs the check every
15 minutes. It creates an assigned GitHub issue when matching sessions appear.
If the repository secret `PUSHBULLET_API_KEY` is configured, it sends a
PushBullet link instead.

The workflow commits `app/watch-state.json` only after a successful
notification, so the same sessions are not announced again on later runs.
