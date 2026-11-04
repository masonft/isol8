// Unit tests: real FFT vs naive DFT, inverse round trip, uniform filter vs reference.
const E = require("../src/engine.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } };
for (const n of [8, 16, 64, 1024]) {
  const x = Float64Array.from({ length: n }, () => Math.random() * 2 - 1);
  const f = E.rfftFor(n), H = n / 2 + 1, re = new Float64Array(H), im = new Float64Array(H);
  f.forward(x, re, im);
  let err = 0;
  for (let k = 0; k < H; k++) {
    let r = 0, i = 0;
    for (let t = 0; t < n; t++) { r += x[t] * Math.cos(2 * Math.PI * k * t / n); i -= x[t] * Math.sin(2 * Math.PI * k * t / n); }
    err = Math.max(err, Math.abs(r - re[k]), Math.abs(i - im[k]));
  }
  ok(err < 1e-9, `forward n=${n} err=${err}`);
  const y = new Float64Array(n); f.inverse(re, im, y);
  let e2 = 0; for (let t = 0; t < n; t++) e2 = Math.max(e2, Math.abs(y[t] - x[t]));
  ok(e2 < 1e-12, `inverse n=${n} err=${e2}`);
}
// zero-padded forward with offset/length
{
  const x = Float64Array.from({ length: 20 }, (_, i) => i);
  const f = E.rfftFor(16), re = new Float64Array(9), im = new Float64Array(9);
  f.forward(x, re, im, 3, 5);
  ok(Math.abs(re[0] - (3 + 4 + 5 + 6 + 7)) < 1e-12, "offset/length DC");
}
// uniform_filter1d reflect reference values (computed with scipy):
// uniform_filter1d([1,2,3,4,5,6], 4) -> [1.5, 2, 2.5, 3.5, 4.5, 5]  (scipy rounds to int for int input; float here)
{
  const r = Array.from(E.uniformFilter1d(Float64Array.from([1, 2, 3, 4, 5, 6]), 4));
  const exp = [1.5, 1.75, 2.5, 3.5, 4.5, 5.25];
  ok(r.every((v, i) => Math.abs(v - exp[i]) < 1e-12), "uniform_filter1d " + r);
}
console.log(fails ? `${fails} failures` : "fft tests passed");
process.exit(fails ? 1 : 0);
