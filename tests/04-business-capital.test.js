const { chromium } = require('playwright');
const { APP_URL, OUTPUT_DIR } = require('./helpers');
const URL = APP_URL;
const CAP = ['cap-equipment','cap-materials','cap-packaging','cap-marketing','cap-rental','cap-other'];
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
  await p.goto(URL);

  const total = () => p.textContent('#out-capital-total');
  const largest = () => p.textContent('#out-capital-largest');
  const status = () => p.textContent('#capital-status');
  // Each breakdown row as [label, "amount (share)", bar width]
  const rows = () => p.evaluate(() => [...document.querySelectorAll('#capital-breakdown li')].map(li => {
    const s = li.querySelectorAll('.breakdown-label span');
    return [s[0].textContent, s[1].textContent, li.querySelector('.bar-fill').style.width];
  }));
  async function enter(values) {
    await p.click('#reset-btn');
    for (const [id, v] of Object.entries(values)) await p.type(`#${id}`, String(v));
  }

  check('initial state', [await total(), await largest(), await rows(), await status()],
    ['—', '—', [], 'Start by entering your startup costs.']);

  // Main sample: 5000 + 2000 + 500 + 1500 + 800 + 200 = 10,000
  const SAMPLE = { 'cap-equipment': 5000, 'cap-materials': 2000, 'cap-packaging': 500, 'cap-marketing': 1500, 'cap-rental': 800, 'cap-other': 200 };
  await enter(SAMPLE);
  check('sample: total', await total(), 'RM 10,000.00');
  check('sample: largest expense', await largest(), 'Equipment & machinery');
  check('sample: breakdown sorted biggest first, shares + bar widths', await rows(), [
    ['Equipment & machinery', 'RM 5,000.00 (50.00%)', '50%'],
    ['Initial raw materials', 'RM 2,000.00 (20.00%)', '20%'],
    ['Marketing budget',      'RM 1,500.00 (15.00%)', '15%'],
    ['Rental & utilities',    'RM 800.00 (8.00%)',    '8%'],
    ['Packaging capital',     'RM 500.00 (5.00%)',    '5%'],
    ['Other startup expenses','RM 200.00 (2.00%)',    '2%'],
  ]);
  check('sample: status', await status(), 'Results update automatically as you type.');
  await p.locator('#capital').screenshot({ path: `${OUTPUT_DIR}/capital.png` });

  // Partial input: empty fields count as 0 and are hidden from the breakdown
  await enter({ 'cap-marketing': 1234.56, 'cap-rental': 765.44 });
  check('partial: total', await total(), 'RM 2,000.00');
  check('partial: only non-zero rows', (await rows()).map(r => r[0]), ['Marketing budget', 'Rental & utilities']);
  check('partial: shares', (await rows()).map(r => r[1]), ['RM 1,234.56 (61.73%)', 'RM 765.44 (38.27%)']);

  // Thirds: shares should still add to ~100%
  await enter({ 'cap-equipment': 100, 'cap-materials': 100, 'cap-packaging': 100 });
  check('equal thirds', (await rows()).map(r => r[1]), Array(3).fill('RM 100.00 (33.33%)'));
  check('tie: largest is the first in form order', await largest(), 'Equipment & machinery');

  // Single category = 100%
  await enter({ 'cap-other': 999 });
  check('single category = 100%', await rows(), [['Other startup expenses', 'RM 999.00 (100.00%)', '100%']]);

  // All zeros: no ÷ 0
  await enter({ 'cap-equipment': 0, 'cap-marketing': 0 });
  check('all zeros', [await total(), await largest(), await rows(), await status()],
    ['RM 0.00', '—', [], 'All amounts are zero.']);

  // Validation
  await enter({ 'cap-equipment': -100, 'cap-marketing': 500 });
  check('negative: error', await p.textContent('#cap-equipment-error'), 'Cannot be negative.');
  check('negative: results blocked', [await total(), await rows(), await status()], ['—', [], 'Please fix the highlighted fields.']);
  await enter({ 'cap-rental': 2000000000 });
  check('too large', await p.textContent('#cap-rental-error'), 'That number is too large.');
  await enter({});
  await p.type('#cap-other', 'e');
  check('invalid text', await p.textContent('#cap-other-error'), 'Please enter a valid number.');
  await p.fill('#cap-other', '50'); await p.dispatchEvent('#cap-other', 'input');
  check('error clears after fix', [await p.textContent('#cap-other-error'), await total()], ['', 'RM 50.00']);

  // Independent from the other calculators, and they still work
  await enter({ ...SAMPLE, materials: 500, quantity: 100, markup: 50, commission: 10 });
  check('other calculators unaffected', await p.evaluate(() =>
    ['out-total','out-price','out-net-profit'].map(i => document.getElementById(i).textContent)),
    ['RM 500.00', 'RM 7.50', 'RM 1.75']);  // 2.50 profit - 0.75 commission
  check('capital unaffected by product inputs', await total(), 'RM 10,000.00');

  // Remember inputs: saved + restored after refresh
  check('capital inputs saved', JSON.parse(await p.evaluate(() => localStorage.getItem('qhaze-calculator-inputs-v1')))['cap-equipment'], '5000');
  await p.reload();
  check('refresh: capital inputs restored', await p.evaluate(ids => ids.map(i => document.getElementById(i).value), CAP),
    ['5000','2000','500','1500','800','200']);
  check('refresh: capital results recalculated', [await total(), (await rows()).length, await largest()],
    ['RM 10,000.00', 6, 'Equipment & machinery']);
  check('refresh: other calculators restored too', await p.textContent('#out-net-profit'), 'RM 1.75');

  // Old saved data from before this feature (no capital keys) still loads
  await p.evaluate(() => localStorage.setItem('qhaze-calculator-inputs-v1',
    JSON.stringify({ materials: '100', quantity: '10', markup: '20', commission: '5' })));
  await p.reload();
  check('old saved data still loads', [await p.textContent('#out-price'), await total()], ['RM 12.00', '—']);

  // Clear all clears capital too
  await enter(SAMPLE);
  await p.click('#reset-btn');
  check('clear all: capital emptied', [await p.evaluate(ids => ids.map(i => document.getElementById(i).value), CAP), await total(), await rows()],
    [Array(6).fill(''), '—', []]);

  // Navigation links
  check('nav links point at real sections', await p.evaluate(() =>
    [...document.querySelectorAll('.section-nav a')].map(a => [a.textContent, !!document.querySelector(a.getAttribute('href'))])),
    [['Product Cost', true], ['Affiliate Commission', true], ['Business Capital', true], ['Smart Pricing', true], ['Records', true]]);
  await p.click('.section-nav a[href="#capital"]');
  await p.waitForTimeout(800);
  check('clicking "Business Capital" brings it fully into view', await p.evaluate(() => {
    const r = document.getElementById('capital').getBoundingClientRect();
    return scrollY > 0 && r.top >= 0 && r.bottom <= innerHeight;
  }), true);

  // Unique ids (cap- prefix avoids clashing with product "packaging")
  check('all element ids unique', await p.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
    return ids.length === new Set(ids).size;
  }), true);

  // Mobile
  await p.setViewportSize({ width: 375, height: 740 });
  await enter(SAMPLE);
  check('mobile: no sideways scrolling', await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await p.locator('#capital').screenshot({ path: `${OUTPUT_DIR}/capital-mobile.png` });
  await p.setViewportSize({ width: 320, height: 700 });
  await enter({ 'cap-equipment': 999999999, 'cap-marketing': 999999999 });
  check('320px + huge numbers: no sideways scrolling', await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await p.setViewportSize({ width: 375, height: 740 });
  await p.goto(URL); await p.click('#reset-btn');
  await p.screenshot({ path: `${OUTPUT_DIR}/top-mobile.png` });

  check('no JavaScript errors', errors, []);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
  await b.close();
})();
