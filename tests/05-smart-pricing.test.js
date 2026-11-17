const { chromium } = require('playwright');
const { APP_URL, OUTPUT_DIR } = require('./helpers');
const URL = APP_URL;
const OUT = ['out-sp-price','out-sp-ratio','out-sp-gross','out-sp-affiliate','out-sp-platform','out-sp-net','out-sp-net-margin',
             'out-sp-wholesale','out-sp-wholesale-profit','out-sp-wholesale-margin','out-sp-min-price','out-sp-capital','out-sp-breakeven'];
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

  const outs = () => p.evaluate(ids => Object.fromEntries(ids.map(i => [i.replace('out-sp-',''), document.getElementById(i).textContent])), OUT);
  const pick = async (...keys) => { const o = await outs(); return keys.map(k => o[k]); };
  const cost = () => p.inputValue('#sp-cost');
  const note = () => p.textContent('#sp-cost-note');
  const relink = () => p.evaluate(() => { const b = document.getElementById('sp-relink'); return b.hidden ? null : b.textContent; });
  const status = () => p.textContent('#sp-status');
  const warning = () => p.evaluate(() => { const w = document.getElementById('sp-warning'); return w.hidden ? null : w.textContent; });
  const red = (...ids) => p.evaluate(ids => ids.map(i => document.getElementById('out-sp-' + i).classList.contains('is-loss')), ids);
  const method = m => p.click(`.segmented input[value="${m}"] + span`);
  async function enter(values, m = 'margin') {
    await p.click('#reset-btn');
    await method(m);
    for (const [id, v] of Object.entries(values)) await p.type(`#${id}`, String(v));
  }
  // Product Cost giving RM 10.00 per unit; capital RM 10,000
  const PRODUCT = { materials: 1000, quantity: 100 };
  const CAPITAL = { 'cap-equipment': 6000, 'cap-marketing': 4000 };

  // ---------- Linking with Product Cost ----------
  check('start: empty, linked note', [await cost(), await note(), await relink(), await status()],
    ['', 'Linked to Product Cost: fill it in above, or type a cost here.', null, 'Enter a product cost to begin.']);

  await enter(PRODUCT);
  check('auto-fills cost per unit (no markup needed)', [await cost(), await note()], ['10.00', 'Linked to Product Cost (cost per unit).']);

  await p.fill('#quantity', '200'); await p.dispatchEvent('#quantity', 'input');
  check('updates when Product Cost changes', await cost(), '5.00');

  await enter({ materials: 12.5, packaging: 3.75, quantity: 3, 'sp-rate': 40 });
  check('decimals shown to the sen (16.25 / 3 = 5.4167 -> 5.42)', await cost(), '5.42');
  check('price uses the value shown (5.42 at 40% margin = RM 9.04)', await pick('price', 'net', 'net-margin'), ['RM 9.04', 'RM 3.62', '40.04%']);

  await enter({ ...PRODUCT, 'sp-rate': 30 });
  await p.fill('#sp-cost', '12'); await p.dispatchEvent('#sp-cost', 'input');
  check('typing switches to manual', [await cost(), await note(), await relink()],
    ['12', 'Typed by hand (not linked).', 'Use Product Cost (RM 10.00)']);
  await p.fill('#materials', '2000'); await p.dispatchEvent('#materials', 'input');
  check('manual value is NOT overwritten by Product Cost', [await cost(), await relink()], ['12', 'Use Product Cost (RM 20.00)']);
  check('manual value used in maths (12 / 0.7 = 17.143 -> 17.15)', (await pick('price'))[0], 'RM 17.15');
  await p.click('#sp-relink');
  check('"Use Product Cost" re-links', [await cost(), await note(), await relink()],
    ['20.00', 'Linked to Product Cost (cost per unit).', null]);
  await p.fill('#materials', '500'); await p.dispatchEvent('#materials', 'input');
  check('linked again: follows Product Cost', await cost(), '5.00');

  await p.fill('#quantity', '0'); await p.dispatchEvent('#quantity', 'input');
  check('Product Cost invalid -> linked cost empties', [await cost(), await status()], ['', 'Enter a product cost to begin.']);

  await enter({ 'sp-cost': 8, 'sp-rate': 50 });
  check('manual without any Product Cost', [await cost(), await relink(), (await pick('price'))[0]], ['8', 'Link to Product Cost', 'RM 16.00']);

  // ---------- Calculations (expected values computed separately in Python) ----------
  // A: margin method, all fees, wholesale, capital
  await enter({ ...PRODUCT, ...CAPITAL, 'sp-rate': 30, 'sp-wholesale': 20, 'sp-affiliate': 8, 'sp-platform': 4, 'sp-fixed-fee': 0.5 });
  check('A: target margin with fees', await outs(), {
    price: 'RM 18.11', ratio: '81.10% markup · 44.78% gross margin', gross: 'RM 8.11', affiliate: 'RM 1.45', platform: 'RM 1.22',
    net: 'RM 5.44', 'net-margin': '30.02%', wholesale: 'RM 14.49', 'wholesale-profit': 'RM 4.49', 'wholesale-margin': '30.99%',
    'min-price': 'RM 11.94', capital: 'RM 10,000.00', breakeven: '1,840 units' });
  check('A: net margin meets the 30% target', parseFloat((await pick('net-margin'))[0]) >= 30, true);
  check('A: no warnings', [await warning(), await status()], [null, 'Results update automatically as you type.']);
  await p.locator('#smart-price').screenshot({ path: `${OUTPUT_DIR}/smart.png` });

  // B: markup method
  await enter({ ...PRODUCT, 'sp-rate': 50, 'sp-affiliate': 10, 'sp-platform': 5 }, 'markup');
  check('B: markup method', await pick('price','ratio','affiliate','platform','net','net-margin','min-price','wholesale'),
    ['RM 15.00','50.00% markup · 33.33% gross margin','RM 1.50','RM 0.75','RM 2.75','18.33%','RM 11.77','RM 15.00']);
  check('B: label changes with method', await p.textContent('#sp-rate-label'), 'Markup on cost');
  check('B: break-even waits for capital', await pick('capital', 'breakeven'), ['—', 'Fill in Business Capital']);

  // Switching method keeps the number but changes its meaning
  await method('margin');
  check('switch to margin: 50% margin after 15% fees -> 10 / 0.35 = RM 28.58',
    [await p.textContent('#sp-rate-label'), (await pick('price'))[0]], ['Target profit margin (after fees)', 'RM 28.58']);

  // C: retail loss (markup too low for the fees)
  await enter({ ...PRODUCT, ...CAPITAL, 'sp-rate': 10, 'sp-affiliate': 10, 'sp-platform': 5 }, 'markup');
  check('C: loss values', await pick('price','net','net-margin','min-price','breakeven'),
    ['RM 11.00','-RM 0.65','-5.91%','RM 11.77','Never (no profit per sale)']);
  check('C: loss warning', await warning(), '⚠ Retail sales make a loss.After fees you lose RM 0.65 on every unit. Charge at least RM 11.77 to avoid a loss.');
  check('C: net figures red', await red('net', 'net-margin'), [true, true]);
  check('C: status points to warning', await status(), 'Check the warnings above.');

  // E: wholesale below cost
  await enter({ ...PRODUCT, 'sp-rate': 10, 'sp-wholesale': 20 }, 'markup');
  check('E: wholesale below cost', await pick('wholesale','wholesale-profit','wholesale-margin','net'),
    ['RM 8.80','-RM 1.20','-13.64%','RM 1.00']);
  check('E: wholesale warning only', await warning(), '⚠ Wholesale price is below cost.RM 8.80 is less than your cost of RM 10.00. Lower the wholesale discount.');
  check('E: only wholesale figures red', await red('net', 'wholesale-profit', 'wholesale-margin'), [false, true, true]);

  // Both warnings at once
  await enter({ ...PRODUCT, 'sp-rate': 10, 'sp-wholesale': 20, 'sp-affiliate': 10, 'sp-platform': 5 }, 'markup');
  check('both warnings shown', (await warning()).match(/⚠/g).length, 2);
  await p.locator('#smart-price aside').screenshot({ path: `${OUTPUT_DIR}/smart-warn.png` });

  // Break-even exactly at the sen: net 5.00, capital 10,000 -> exactly 2,000 (not 2,001)
  await enter({ ...PRODUCT, ...CAPITAL, 'sp-rate': 50 }, 'markup');
  check('break-even exact division not over-rounded', await pick('net', 'breakeven'), ['RM 5.00', '2,000 units']);

  // Zero markup: no profit -> never break even, but not a loss
  await enter({ ...PRODUCT, ...CAPITAL, 'sp-rate': 0 }, 'markup');
  check('zero markup: break-even never, no warning', [await pick('net', 'breakeven'), await warning()], [['RM 0.00', 'Never (no profit per sale)'], null]);

  // Impossible target: 60 + 30 + 10 = 100%
  await enter({ ...PRODUCT, 'sp-rate': 60, 'sp-affiliate': 30, 'sp-platform': 10 });
  check('impossible target: explained, no results', [await status(), (await pick('price'))[0]],
    ['Margin + fees add up to 100.00%. They must stay below 100%, or no price can reach your target. Lower the margin or the fees.', '—']);

  // Fees take 100% in markup mode: no minimum price exists
  await enter({ ...PRODUCT, 'sp-rate': 50, 'sp-affiliate': 60, 'sp-platform': 40 }, 'markup');
  check('fees = 100%: min price not possible', [(await pick('min-price'))[0], (await warning()).includes('Your fees take 100% of the price')], ['Not possible', true]);

  // Cost 0 doesn't divide by zero
  await enter({ 'sp-cost': 0, 'sp-rate': 50 }, 'markup');
  check('zero cost: no crash, percentages "—"', await pick('price', 'ratio', 'net-margin'), ['RM 0.00', '— markup · — gross margin', '—']);

  // ---------- Validation ----------
  await enter({ ...PRODUCT, 'sp-rate': 100 });
  check('margin 100% rejected', await p.textContent('#sp-rate-error'), 'Cannot be more than 99.99.');
  await enter({ ...PRODUCT, 'sp-rate': 300 }, 'markup');
  check('markup 300% allowed', [await p.textContent('#sp-rate-error'), (await pick('price'))[0]], ['', 'RM 40.00']);
  for (const [id, v, msg] of [['sp-wholesale', 101, 'Cannot be more than 100.'], ['sp-affiliate', -1, 'Cannot be negative.'],
                              ['sp-platform', 150, 'Cannot be more than 100.'], ['sp-fixed-fee', -2, 'Cannot be negative.'],
                              ['sp-cost', -5, 'Cannot be negative.']]) {
    await enter({ 'sp-rate': 30, [id]: v });
    check(`validation ${id}=${v}`, [await p.textContent(`#${id}-error`), await status()], [msg, 'Please fix the highlighted fields.']);
  }
  await enter({ ...PRODUCT });
  check('no rate yet (margin)', await status(), 'Enter your target profit margin %.');
  await method('markup');
  check('no rate yet (markup)', await status(), 'Enter your markup %.');

  // ---------- Saving ----------
  await enter({ ...PRODUCT, 'sp-rate': 50, 'sp-affiliate': 10 }, 'markup');
  await p.fill('#sp-cost', '12'); await p.dispatchEvent('#sp-cost', 'input');
  await p.reload();
  check('refresh: manual cost, method and inputs restored',
    [await cost(), await note(), await p.isChecked('.segmented input[value="markup"]'), await p.inputValue('#sp-affiliate'), (await pick('price'))[0]],
    ['12', 'Typed by hand (not linked).', true, '10', 'RM 18.00']);
  await p.click('#sp-relink'); await p.reload();
  check('refresh: linked state restored', [await cost(), await relink()], ['10.00', null]);
  await p.fill('#materials', '3000'); await p.dispatchEvent('#materials', 'input'); await p.reload();
  check('refresh: linked cost follows new Product Cost', await cost(), '30.00');

  await p.evaluate(() => localStorage.setItem('qhaze-calculator-inputs-v1',
    JSON.stringify({ materials: '1000', quantity: '100', 'sp-rate': '20', 'sp-method': 'evil', 'sp-cost-manual': 'yes' })));
  await p.reload();
  check('bad saved settings ignored (defaults: margin, linked)',
    [await p.isChecked('.segmented input[value="margin"]'), await cost(), await relink(), (await pick('price'))[0]],
    [true, '10.00', null, 'RM 12.50']);

  await p.evaluate(() => localStorage.setItem('qhaze-calculator-inputs-v1', JSON.stringify({ materials: '1000', quantity: '100' })));
  await p.reload();
  check('old saved data (no smart keys) loads', [await cost(), await p.isChecked('.segmented input[value="margin"]')], ['10.00', true]);

  // Clear all
  await enter({ ...PRODUCT, 'sp-rate': 50, 'sp-wholesale': 10 }, 'markup');
  await p.fill('#sp-cost', '12'); await p.dispatchEvent('#sp-cost', 'input');
  await p.click('#reset-btn');
  check('clear all resets smart pricing', [await cost(), await relink(), await p.isChecked('.segmented input[value="margin"]'),
    await p.inputValue('#sp-wholesale'), (await pick('price'))[0]], ['', null, true, '', '—']);

  // ---------- Other features still fine ----------
  await enter({ ...PRODUCT, markup: 50, commission: 10, ...CAPITAL, 'sp-rate': 30 });
  check('Product Cost + Affiliate + Capital unchanged', await p.evaluate(() =>
    ['out-price', 'out-net-profit', 'out-capital-total'].map(i => document.getElementById(i).textContent)),
    ['RM 15.00', 'RM 3.50', 'RM 10,000.00']);
  check('nav link to Smart Pricing works', await p.evaluate(() => !!document.querySelector(document.querySelector('a[href="#smart-price"]').getAttribute('href'))), true);
  check('ids unique', await p.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(e => e.id); return ids.length === new Set(ids).size; }), true);
  check('radio usable by keyboard', await p.evaluate(() => {
    const r = document.querySelector('.segmented input[value="markup"]'); r.focus(); return document.activeElement === r; }), true);

  // ---------- Mobile ----------
  for (const w of [375, 320]) {
    await p.setViewportSize({ width: w, height: 740 });
    await enter({ ...PRODUCT, ...CAPITAL, 'sp-rate': 10, 'sp-wholesale': 20, 'sp-affiliate': 10, 'sp-platform': 5 }, 'markup');
    check(`${w}px: no sideways scrolling`, await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await p.setViewportSize({ width: 375, height: 740 });
  await p.locator('#smart-price').screenshot({ path: `${OUTPUT_DIR}/smart-mobile.png` });

  check('no JavaScript errors', errors, []);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
  await b.close();
})();
