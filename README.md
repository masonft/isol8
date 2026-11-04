# isol8

Hear the sounds hidden in a song's repeats.

When a song reuses a section sample for sample, such as a copied chorus, flipping one copy upside down over the other cancels everything they share. Whatever is left over, like an extra ad-lib or a layer you'd never notice, is what was different. isol8 finds those repeats automatically and lets you listen to and download what's left.

Everything runs in your browser. Your audio is never uploaded.

## Run locally

It's a plain static site with no build step:

```
npm run serve        # or: python3 -m http.server 8080 -d src
```

Then open http://localhost:8080.

## Deploy

Upload the `src/` folder to any static host.

## Project layout

```
src/      the site (HTML, CSS, JS, vendored MP3 encoder)
tests/    unit and browser tests
```

## Tests

```
npm test                                        # needs ffmpeg
npm i && npx playwright install chromium
npm run test:e2e                                # real browser
```

Some tests check results against songs I isolated by hand. Those songs aren't in the repo. Put them in `../isol8-examples`, or set `ISOL8_EXAMPLES` to their folder. Without them, those tests are skipped, except the browser test, which needs them.

## License

The MP3 encoder (`src/vendor/lame.min.js`, lamejs) is LGPL-3.0.
