# Website

The app's public one-page site: static files in `public/`, served by Cloudflare Pages (free plan) at
https://saqqezy-player.pages.dev.

Deploy from the repository root (needs `pnpm dlx wrangler login` once):

```
pnpm site:deploy
```

The font is Familjen Grotesk (SIL Open Font License, `public/fonts/OFL.txt`), served from the site itself so visitors
make no requests to other companies. Keep it that way: no analytics, no third-party scripts or fonts.
