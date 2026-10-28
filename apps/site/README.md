# Website

The app's public one-page site: static files in `public/`, served by Cloudflare Pages (free plan) at
https://saqqezy-player.pages.dev.

Deploy from the repository root (needs `pnpm dlx wrangler login` once):

```
pnpm site:deploy
```

The font is Familjen Grotesk (SIL Open Font License, `public/fonts/OFL.txt`), served from the site itself so visitors
make no requests to other companies. Keep it that way: no analytics, no third-party scripts or fonts.

## Screenshots

`public/screens/*.webp` are real screens of the TV app on a showcase test source: every channel, programme and title
name is made up, the posters and logos are drawn by the fake provider, and the video is the licensed Big Buck Bunny test
stream (credited on the page). Never use a real playlist for them (docs/GUARDRAILS.md legal rules 1, 3 and 4).

To refresh them after UI changes, start the TV dev server (`pnpm dev`) and a showcase provider in a second terminal, then
run the capture script from the repository root (needs Chrome and ffmpeg):

```
PORT=8900 SHOWCASE=1 SPORTS=0 pnpm fake-xtream
node apps/site/scripts/screens.mjs
```

The same script with `readme` (`node apps/site/scripts/screens.mjs readme`) captures the README's pictures into
`docs/images/`.
