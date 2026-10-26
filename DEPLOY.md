# Deploying this to Railway

No git and no command line needed. Everything here is done in a browser.

## 1. Put the files on GitHub

GitHub is just storage that Railway can read from.

1. Go to github.com and sign in, or create a free account.
2. Click **New repository**. Name it `pokefinder-draws`. Set it to **Private**.
   Do not tick "Add a README". Click **Create repository**.
3. On the empty repo page click **uploading an existing file**.
4. Unzip the folder I sent you, then drag everything inside it into the browser:
   `package.json`, `schema.sql`, `README.md`, `DEPLOY.md`, `.env.example`, and
   the `src` and `test` folders. Do not drag the outer folder itself, drag what
   is inside it.
5. At the bottom click the green **Commit changes** button.

"Commit" just means save. That button is the whole of it.

## 2. Point Railway at it

1. Open your Railway project, the one that already has Postgres in it.
2. Click **New** then **GitHub Repo**. Authorise GitHub if it asks, and pick
   `pokefinder-draws`.

Railway reads the files, works out it is a Node project, installs it and starts
it. The first build fails because the variables are not set yet. That is
expected.

## 3. Set the variables

Open the new service, go to **Variables**, and add these four.

| Name | Value |
| --- | --- |
| `DISCORD_TOKEN` | your bot token |
| `WALMART_CHANNEL_ID` | `1366430736877355098` |
| `ALERT_CHANNEL_ID` | `1369491926922952818` |
| `DATABASE_URL` | see below |

For `DATABASE_URL`, do not type a value. Railway can link it to your existing
database. Click **Add a Variable Reference**, or type `${{Postgres.DATABASE_URL}}`
exactly as written, with the name matching your Postgres service. If your
Postgres service is called something else, use that name in the braces.

Railway restarts the service by itself once you save.

## 4. Check it worked

Open the **Deployments** tab and click the running deployment to see its logs.
A healthy boot looks like this:

```
database schema is up to date
listening as YourBotName#1234 on channel 1366430736877355098
quiet period 300s, ceiling 1200s
```

If you see all three lines, it is done. It will now sit quietly until the next
Walmart draw and then post a summary to your alert channel.

## When something is wrong

**`missing required env var ...`** means one of the four is not set, or is
spelled differently.

**`could not apply the database schema`** means `DATABASE_URL` is not pointing
at your Postgres. Check the service name inside the braces.

**It boots fine but a draw goes past with no summary.** Almost always the
Message Content intent on the Discord bot page, which has to be on or the
embeds arrive empty. Second most likely is the bot not having permission to
post in the alert channel.

## Stage two: turn on the public domain

Stage two added a small web server that hosts the draw images, so the service
now needs an address on the internet. This was pointless before, because
nothing was listening.

1. Click the **PokeFinder-Draws** service box to open its panel.
2. Open the **Settings** tab inside that panel, not the project settings from
   the top bar.
3. Scroll to **Networking**, or **Public Networking**, and click
   **Generate Domain**.
4. If it asks for a port, enter `3000`.

Railway gives you something like `pokefinder-draws-production.up.railway.app`
and sets it as `RAILWAY_PUBLIC_DOMAIN` by itself, so there is no variable to
add. The service picks it up on the next restart.

Check it worked by opening the domain in a browser. It should say `ok`. The
logs will also now read:

```
image server listening on port 3000
images will be served from https://your-domain.up.railway.app/images/
```

If you skip this, everything else still runs. Images get downloaded, trimmed
and stored, and the run summary says no public URL is configured yet. Nothing
breaks, the images just are not reachable from outside until you do it.

## Stage three: connecting Canva

Add two variables in Railway, both taken from your Canva app's Credentials
section:

```
CANVA_CLIENT_ID
CANVA_CLIENT_SECRET
```

In the Canva Developer Portal, under Outside Canva then Redirect URLs, set
URL 1 to your Railway domain followed by `/oauth/redirect`, for example:

```
https://pokefinder-draws-production.up.railway.app/oauth/redirect
```

After the service restarts, open the Deploy Logs. You will see:

```
CANVA IS NOT CONNECTED YET. Open this once, in a browser, and approve:
  https://your-domain.up.railway.app/canva/connect?key=3f9a...
```

Open that link, approve on Canva's own screen, and you should land on a page
saying the refresh token is stored. That is the whole of it. Restart the
service and the logs will now read `canva is connected`.

You only ever do this once. Canva rotates its refresh tokens on every use and
the service handles that by itself.

The key in that URL changes every time the service restarts, so if the link
stops working just take the current one from the latest logs. You can pin it by
setting a `SETUP_KEY` variable, but there is no need.

## Changing it later

When I send you new files, go to the repo on GitHub, click **Add file** then
**Upload files**, drag the new ones in, and commit. Railway notices and
redeploys on its own. You never need to touch Railway again after the first
setup.
