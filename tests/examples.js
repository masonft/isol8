/* Where the hand-made example songs live. They're kept out of the repo (copyrighted audio).
   Order: first CLI argument, $ISOL8_EXAMPLES, then ../isol8-examples next to the repo. */
const fs = require("fs");
const path = require("path");
module.exports = (arg) => {
  const dir = arg || process.env.ISOL8_EXAMPLES || path.join(__dirname, "..", "..", "isol8-examples");
  return fs.existsSync(dir) ? dir : null;
};
