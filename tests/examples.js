/* Where the hand-made example songs live. They're kept out of the repo (copyrighted audio).
   Order: first CLI argument, $ISOL8_EXAMPLES, then ../isol8-examples next to the repo.

   The folder also holds examples.json, which says which songs there are and what was found
   in each by hand, so no song is named in the tests:
     { "songs": [ { "dir": "<folder>", "main": true, "e2e": false, "truths": [
         { "lag": <samples>, "resStart": <sample>, "resLen": <samples>,
           "lagTolerance": 1, "partial": true, "minCoverage": 0.7 } ] } ] }
   "main" marks the lossless song the probe and browser tests look at closely (its first truth
   is the pair they probe); "e2e": false keeps a song out of the browser test. The last three
   truth fields are optional. */
const fs = require("fs");
const path = require("path");
const AUDIO = /\.(mp3|flac|wav|m4a|ogg|aiff?)$/i;
module.exports = (arg) => {
  const dir = arg || process.env.ISOL8_EXAMPLES || path.join(__dirname, "..", "..", "isol8-examples");
  return fs.existsSync(dir) ? dir : null;
};
/** Songs listed in examples.json whose folder exists, each with the path of its audio file. */
module.exports.songs = (root) => {
  const manifest = root && path.join(root, "examples.json");
  if (!manifest || !fs.existsSync(manifest)) return [];
  return JSON.parse(fs.readFileSync(manifest, "utf8")).songs
    .filter((s) => fs.existsSync(path.join(root, s.dir)))
    .map((s) => {
      const file = fs.readdirSync(path.join(root, s.dir)).find((f) => AUDIO.test(f));
      return Object.assign({}, s, { file: file && path.join(root, s.dir, file) });
    })
    .filter((s) => s.file);
};
