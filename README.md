# Wallflower

Front-end game script for the Wallflower `/scenes/[slug]` template, served as a
static asset over Vercel's CDN and loaded from the Webflow page footer.

## What this is

A single file, [`public/wallflower.js`](public/wallflower.js). It reads scene and
avatar data already in the DOM (Webflow CMS) plus Memberstack records (`hides`,
`spots`, member JSON), then runs one of two modes on the page — hide mode or
playground — chosen by the data rather than a button. No build step, no
dependencies.

## Deploy / CDN

The file is deployed to Vercel and served at:

```
https://<project>.vercel.app/wallflower.js
```

Reference it in the Webflow page footer:

```html
<script defer src="https://<project>.vercel.app/wallflower.js"></script>
```

Any push to `main` triggers a new production deployment. The CDN cache is set to
5 minutes (`Cache-Control` in [`vercel.json`](vercel.json)) with
stale-while-revalidate, so edits propagate quickly without hammering the origin.

### jsDelivr fallback (optional)

Because the repo is public, the same file is also available via jsDelivr,
pinned to a commit or tag:

```
https://cdn.jsdelivr.net/gh/Magnaem-a/wallflower@main/public/wallflower.js
```

## Layout

```
public/wallflower.js   the game script (the deployed asset)
vercel.json            content-type, CORS, and cache headers for the asset
```
