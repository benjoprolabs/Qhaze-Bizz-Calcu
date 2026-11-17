const { chromium } = require('playwright');
const { APP_URL, OUTPUT_DIR } = require('./helpers');
const URL = APP_URL;
const KEY = 'qhaze-calculator-inputs-v1';
const FIELDS = ['materials','packaging','shipping','labour','other','quantity','markup','commission'];
const OUT = ['out-total','out-unit-cost','out-price','out-profit','out-margin','out-commission','out-commission-total','out-net-profit','out-net-margin'];
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`));
}
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const watch = pg => { pg.on('pageerror', e => errors.push(e.message)); pg.on('console', m => m.type()==='error' && errors.push(m.text())); };
  let p = await ctx.newPage(); watch(p);
  await p.goto(URL);

  const inputs = pg => pg.evaluate(ids => ids.map(i => document.getElementById(i).value), FIELDS);
  const outs = pg => pg.evaluate(ids => ids.map(i => document.getElementById(i).textContent), OUT);
  const stored = pg => pg.evaluate(k => localStorage.getItem(k), KEY);
  const warn = pg => pg.evaluate(() => !document.getElementById('loss-warning').hidden);
  const BASE = { materials: 500, packaging: 100, shipping: 150, labour: 200, other: 50, quantity: 100, markup: 50, commission: 50 };
  const ALL_DASH = Array(9).fill('—');

  check('fresh visit: nothing stored', await stored(p), null);
  check('fresh visit: empty form', await inputs(p), Array(8).fill(''));

  // Type everything, then check what was saved
  for (const [id, v] of Object.entries(BASE)) await p.type(`#${id}`, String(v));
  check('saved as JSON text', JSON.parse(await stored(p)),
    { materials:'500', packaging:'100', shipping:'150', labour:'200', other:'50', quantity:'100', markup:'50', commission:'50',
      'cap-equipment':'', 'cap-materials':'', 'cap-packaging':'', 'cap-marketing':'', 'cap-rental':'', 'cap-other':'',
      'sp-cost':'10.00', 'sp-rate':'', 'sp-wholesale':'', 'sp-affiliate':'', 'sp-platform':'', 'sp-fixed-fee':'',
      'sp-method':'margin', 'sp-cost-manual':'false' });
  const before = await outs(p);

  // Refresh
  await p.reload();
  check('refresh: inputs restored', await inputs(p), ['500','100','150','200','50','100','50','50']);
  check('refresh: results recalculated', await outs(p),
    ['RM 1,000.00','RM 10.00','RM 15.00','RM 5.00','33.33%','RM 7.50','RM 750.00','-RM 2.50','-16.67%']);
  check('refresh: same results as before', await outs(p), before);
  check('refresh: loss warning restored', await warn(p), true);

  // Close the tab and open a new one (like reopening the browser later)
  await p.close();
  p = await ctx.newPage(); watch(p);
  await p.goto(URL);
  check('reopen: inputs restored', (await inputs(p))[0], '500');
  check('reopen: results present', (await outs(p))[2], 'RM 15.00');

  // Edits after restore keep working and get saved
  await p.fill('#commission', '10'); await p.dispatchEvent('#commission', 'input');
  check('edit after restore: recalculates', [(await outs(p))[7], await warn(p)], ['RM 3.50', false]);
  check('edit after restore: saved', JSON.parse(await stored(p)).commission, '10');

  // Emptying a field is saved too
  await p.fill('#other', ''); await p.dispatchEvent('#other', 'input');
  await p.reload();
  check('emptied field stays empty after refresh', [(await inputs(p))[4], (await outs(p))[0]], ['', 'RM 950.00']);

  // Clear all deletes saved data
  await p.click('#reset-btn');
  check('clear all: storage deleted', await stored(p), null);
  check('clear all: form and results empty', [await inputs(p), await outs(p)], [Array(8).fill(''), ALL_DASH]);
  await p.reload();
  check('clear all: still empty after refresh', [await inputs(p), await outs(p)], [Array(8).fill(''), ALL_DASH]);

  // Partial data restores with the right helper message
  await p.type('#materials', '300'); await p.reload();
  check('partial data: total + status', [(await outs(p))[0], await p.textContent('#status')],
    ['RM 300.00', 'Enter the production quantity to see per-unit results.']);

  // Invalid saved value is restored AND flagged
  await p.click('#reset-btn');
  await p.type('#materials', '100'); await p.type('#quantity', '2.5'); await p.reload();
  check('invalid saved value: error shown after refresh', await p.textContent('#quantity-error'), 'Must be a whole number.');

  // Damaged / unexpected stored data must never break the page
  const cases = [
    ['broken JSON', '{not json'],
    ['a list instead of object', '[1,2,3]'],
    ['the word null', 'null'],
    ['a number', '42'],
  ];
  for (const [name, data] of cases) {
    await p.evaluate(([k, d]) => localStorage.setItem(k, d), [KEY, data]);
    await p.reload();
    check(`damaged data (${name}): empty form, no crash`, [await inputs(p), await outs(p)], [Array(8).fill(''), ALL_DASH]);
  }
  await p.evaluate(k => localStorage.setItem(k, JSON.stringify({ materials: '100', quantity: 4, markup: '25', hacker: '<b>x</b>' })), KEY);
  await p.reload();
  check('mixed data: good fields kept, bad ones ignored', [await inputs(p), (await outs(p)).slice(0,2)],
    [['100','','','','','','25',''], ['RM 100.00','—']]);

  check('normal save status', [await p.textContent('#save-status-text'),
    await p.evaluate(() => document.getElementById('save-status').classList.contains('is-off'))],
    ['Your inputs are saved on this device automatically.', false]);

  // Mobile toolbar fits
  await p.setViewportSize({ width: 375, height: 740 });
  check('mobile: no sideways scrolling', await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await p.screenshot({ path: `${OUTPUT_DIR}/mobile4.png` });
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.click('#reset-btn');
  for (const [id, v] of Object.entries(BASE)) await p.type(`#${id}`, String(v));
  await p.reload();
  await p.screenshot({ path: `${OUTPUT_DIR}/desktop4.png` });

  // Browser that blocks storage entirely (some private modes)
  const blocked = await b.newContext();
  await blocked.addInitScript(() => {
    const deny = () => { throw new DOMException('blocked', 'SecurityError'); };
    Storage.prototype.setItem = deny; Storage.prototype.getItem = deny; Storage.prototype.removeItem = deny;
  });
  const bp = await blocked.newPage(); watch(bp);
  await bp.goto(URL);
  for (const [id, v] of Object.entries(BASE)) await bp.type(`#${id}`, String(v));
  check('blocked storage: calculator still works', (await outs(bp))[7], '-RM 2.50');
  check('blocked storage: user is told', [await bp.textContent('#save-status-text'),
    await bp.evaluate(() => document.getElementById('save-status').classList.contains('is-off'))],
    ['Saving is turned off in this browser. Your inputs will be lost when you leave.', true]);
  await bp.click('#reset-btn');
  check('blocked storage: clear all still works', await outs(bp), ALL_DASH);
  await bp.screenshot({ path: `${OUTPUT_DIR}/blocked4.png`, clip: { x: 0, y: 0, width: 1280, height: 200 } });

  check('no JavaScript errors anywhere', errors, []);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
  await b.close();
})();
