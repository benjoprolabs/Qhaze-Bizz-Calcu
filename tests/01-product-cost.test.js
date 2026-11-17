const { chromium } = require('playwright');
const { APP_URL, OUTPUT_DIR } = require('./helpers');
const OUT = ['out-total','out-unit-cost','out-price','out-profit','out-margin'];
const FIELDS = ['materials','packaging','shipping','labour','other','quantity','markup'];
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`));
}
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await p.goto(APP_URL);

  const outs = () => p.evaluate(ids => ids.map(i => document.getElementById(i).textContent), OUT);
  const err = id => p.textContent(`#${id}-error`);
  const status = () => p.textContent('#status');
  async function enter(values) {           // clear everything, then type like a user
    await p.click('#reset-btn');
    for (const [id, v] of Object.entries(values)) await p.type(`#${id}`, String(v));
  }

  // 1. Start state
  check('initial: all results empty', await outs(), ['—','—','—','—','—']);

  // 2. Main sample: 500+100+150+200+50 = 1000; /100 = 10; +50% = 15; profit 5; 5/15 = 33.33%
  await enter({ materials: 500, packaging: 100, shipping: 150, labour: 200, other: 50, quantity: 100, markup: 50 });
  check('sample A (round numbers)', await outs(), ['RM 1,000.00','RM 10.00','RM 15.00','RM 5.00','33.33%']);

  // 3. Decimals: 12.50+3.75 = 16.25; /3 = 5.4167; ×1.4 = 7.5833; profit 2.1667; 2.1667/7.5833 = 28.57%
  await enter({ materials: 12.5, packaging: 3.75, quantity: 3, markup: 40 });
  check('sample B (decimals, empty fields = 0)', await outs(), ['RM 5.42'.replace('5.42','16.25'),'RM 5.42','RM 7.58','RM 2.17','28.57%']);

  // 4. Large numbers + thousands separators: 25,000 / 1,000 = 25; ×2 = 50; 50% margin
  await enter({ materials: 20000, labour: 5000, quantity: 1000, markup: 100 });
  check('sample C (100% markup = 50% margin)', await outs(), ['RM 25,000.00','RM 25.00','RM 50.00','RM 25.00','50.00%']);

  // 5. Zero markup -> no profit
  await enter({ materials: 100, quantity: 10, markup: 0 });
  check('zero markup', await outs(), ['RM 100.00','RM 10.00','RM 10.00','RM 0.00','0.00%']);

  // 6. Partial input: no quantity yet
  await enter({ materials: 300 });
  check('no quantity: only total shown', await outs(), ['RM 300.00','—','—','—','—']);
  check('no quantity: helpful status', await status(), 'Enter the production quantity to see per-unit results.');

  // 7. Partial input: no markup yet
  await enter({ materials: 300, quantity: 4 });
  check('no markup: total + unit cost shown', await outs(), ['RM 300.00','RM 75.00','—','—','—']);

  // 8. All costs zero -> no divide-by-zero
  await enter({ materials: 0, quantity: 5, markup: 50 });
  check('all-zero costs: margin safely "—"', await outs(), ['RM 0.00','RM 0.00','RM 0.00','RM 0.00','—']);

  // ---- Validation ----
  await enter({ materials: -5, quantity: 10, markup: 50 });
  check('negative cost: error message', await err('materials'), 'Cannot be negative.');
  check('negative cost: field highlighted', await p.evaluate(() => document.getElementById('materials').closest('.field').classList.contains('invalid')), true);
  check('negative cost: results blocked', await outs(), ['—','—','—','—','—']);
  check('negative cost: status', await status(), 'Please fix the highlighted fields.');

  await enter({ materials: 100, quantity: 2.5, markup: 50 });
  check('fractional quantity', await err('quantity'), 'Must be a whole number.');
  await enter({ materials: 100, quantity: 0, markup: 50 });
  check('zero quantity', await err('quantity'), 'Must be at least 1.');
  await enter({ materials: 2000000000, quantity: 1, markup: 1 });
  check('too large', await err('materials'), 'That number is too large.');
  await enter({ materials: 100, quantity: 1 });
  await p.type('#markup', 'e');   // "e" alone is not a number
  check('invalid text in markup', await err('markup'), 'Please enter a valid number.');
  await enter({ markup: -10, materials: 100, quantity: 1 });
  check('negative markup', await err('markup'), 'Cannot be negative.');

  // Fixing the error clears it
  await p.fill('#markup', '25'); await p.dispatchEvent('#markup', 'input');
  check('error clears after fix', [await err('markup'), (await outs())[2]], ['', 'RM 125.00']);

  // Clear all
  await p.click('#reset-btn');
  check('clear all resets results', await outs(), ['—','—','—','—','—']);
  check('clear all resets inputs', await p.evaluate(ids => ids.map(i => document.getElementById(i).value), FIELDS), ['','','','','','','']);

  // Step 1 features still work
  check('footer currency (Step 1)', await p.textContent('#currency-label'), 'Currency: RM');
  check('formatMoney helper (Step 1)', await p.evaluate(() => formatMoney(1234.5)), 'RM 1,234.50');

  // Screenshots with the main sample filled in
  for (const [name, vp] of [['desktop2', { width: 1280, height: 900 }], ['mobile2', { width: 375, height: 740 }]]) {
    await p.setViewportSize(vp);
    await enter({ materials: 500, packaging: 100, shipping: 150, labour: 200, other: 50, quantity: 100, markup: 50 });
    if (name === 'mobile2') {
      check('mobile: no sideways scrolling', await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await p.screenshot({ path: `${OUTPUT_DIR}/${name}.png`, fullPage: true });
  }
  // Validation look
  await p.setViewportSize({ width: 1280, height: 900 });
  await enter({ materials: -5, quantity: 2.5, markup: 50 });
  await p.screenshot({ path: `${OUTPUT_DIR}/invalid.png` });

  check('no JavaScript errors', errors, []);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
  await b.close();
})();
