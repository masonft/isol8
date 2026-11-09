<div align="center">
<a href="https://isol8.it" target="_blank"><img src="src/icons/icon-circle.png" /></a>
</div>

<div align="center">
<img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/masonft/isol8">
<img alt="GitHub License" src="https://img.shields.io/github/license/masonft/isol8">
</div>

<div align="center">
<a href="https://isol8.it" target="_blank">isol8.it</a>
</div>

# isol8
A simple yet powerful tool to find hidden sounds in a song. No need to upload anything to a server.

**This is NOT just another vocal remover.**

## Features
- Works like no other tool available
- Automatic segment detection
- Waveform and section visualisation
- Process results even further:
  - Center & side channel extraction
  - Noise reduction
  - Crop/shorten
  - EQ with low & high cut  
- Save results locally
- Crossfade between the result and the original section for comparison
- Adjust parameters (for advanced users)

## How it works
When a song reuses a section, such as a chorus, flipping one copy upside down over the other cancels everything they share. Whatever is left over, like an extra ad-lib or a layer you'd never notice, is what will be returned.

isol8 finds those repeats automatically and lets you listen to and download what's left.

*Everything runs in your browser. Your audio is never uploaded.*

**Still confused?** Visit [isol8.it/how](https://isol8.it/how)

## Limitations
- Because of the way this works, the results vary depending on the song and it does not always give good results (or any at all). But when it does, trust me you'll be amazed. **Just give it a chance.**
- Low quality files will result in a worse isolation and more noise left over. **FLAC is recommended.**

## FAQ
### Doesn't this already exist?
I wasn't able to find an existing tool that uses this method in the same way.

However after I'd already published this project I did stumble upon a research paper with a similar concept called **[REPET for Background/Foreground Separation in Audio](https://interactiveaudiolab.github.io/assets/papers/Rafii-Liutkus-Pardo%20-%20REPET%20for%20Background-Foreground%20Separation%20in%20Audio%20-%20Springer%202014.pdf)**. This is the closest thing I could find to my project.

As far as I could tell, REPET uses estimated masks to filter out the background, which isn't nearly as effective but works with a lot more songs and doesn't require near-identical sections. isol8 performs an exact cancellation on the repeating parts, resulting in a more precise isolation when it does work.

### Does it need a lot of processing power?
Nope not at all. I will add benchmarks at a later date.

## Run locally

It's a plain static site with no build step:

```
npm run serve
# or:
python3 -m http.server 8080 -d src
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

isol8 is MIT. The MP3 encoder (`src/vendor/lame.min.js`, lamejs) is LGPL-3.0.
