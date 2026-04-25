# Brief

A minimal web app for your iPhone home screen: daily & weekly summary from your Cowork iCal feed, plus a configurable Pomodoro timer. Static HTML/CSS/JS, no build step, deploys to GitHub Pages.

## Use it

1. **One-time:** in this repo's **Settings → Pages**, set **Source** to **GitHub Actions**. Then re-run the latest workflow from the **Actions** tab (or push any commit) to trigger the deploy.
2. Once deployed, open `https://<user>.github.io/<repo>/` on your iPhone in Safari → Share → **Add to Home Screen**.
3. First launch: tap **Settings**, paste your Cowork iCal URL, save.

## Cowork feed

Cowork provides an iCal (`.ics`) URL for scheduled tasks. Paste it into Settings. The app fetches it via a CORS proxy (default `https://corsproxy.io/?`) since iCal hosts rarely send CORS headers; you can change the proxy or run your own. The feed is cached in `localStorage` for 10 minutes.

## Design

Apple × Swiss: black and white only, system font stack, hairline dividers, tabular-nums for times, auto light/dark mode with manual override.

## Local

Open `index.html` directly, or run any static server:

```
python3 -m http.server 8080
```
