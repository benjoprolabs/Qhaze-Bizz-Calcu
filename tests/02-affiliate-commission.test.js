const { chromium } = require('playwright');
const { APP_URL, OUTPUT_DIR } = require('./helpers');
const AOUT = ['out-commission','out-commission-total','out-net-profit','out-net-margin'];
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

  const aouts = () => p.evaluate(ids => ids.map(i => document.getElementById(i).textContent), AOUT);
  const warn = () => p.evaluate(() => { const w = document.getElementById('loss-warning'); return w.hidden ? null : w.textContent; });
  const astatus = () => p.textContent('#affiliate-status');
  const lossClass = () => p.evaluate(() => ['out-net-profit','out-net-margin'].map(i => document.getElementById(i).classList.contains('is-loss')));
  async function enter(values) {
    await p.click('#reset-btn');
    for (const [id, v] of Object.entries(values)) await p.type(`#${id}`, String(v));
  }
  // Base product: cost RM 10/unit, 50% markup -> price RM 15, profit RM 5, margin 33.33%, 100 units
  const BASE = { materials: 500, packaging: 100, shipping: 150, labour: 200, other: 50, quantity: 100, markup: 50 };

  check('initial state', [await aouts(), await warn()], [['—','—','—','—'], null]);

  // Normal profitable case: 10% of 15 = 1.50; x100 = 150; 5 - 1.5 = 3.50; 3.5/15 = 23.33%
  await enter({ ...BASE, commission: 10 });
  check('10% commission', await aouts(), ['RM 1.50','RM 150.00','RM 3.50','23.33%']);
  check('10%: no warning', await warn(), null);
  check('10%: not red', await lossClass(), [false, false]);

  // Zero commission: net = gross
  await enter({ ...BASE, commission: 0 });
  check('0% commission', await aouts(), ['RM 0.00','RM 0.00','RM 5.00','33.33%']);

  // LOSS: 50% of 15 = 7.50 > 5 profit -> lose 2.50; -2.5/15 = -16.67%
  await enter({ ...BASE, commission: 50 });
  check('50% commission (loss)', await aouts(), ['RM 7.50','RM 750.00','-RM 2.50','-16.67%']);
  check('loss: warning text', await warn(),
    '⚠ This sale makes a loss.The commission (RM 7.50) is more than your gross profit (RM 5.00), so you lose RM 2.50 on every unit sold. Keep the commission at or below 33.33%, or increase your markup.');
  check('loss: figures turn red', await lossClass(), [true, true]);
  check('loss: status', await astatus(), 'Commission is higher than your profit.');
  await p.screenshot({ path: `${OUTPUT_DIR}/loss.png`, fullPage: true });

  // Lowering the rate removes the warning
  await p.fill('#commission', '20'); await p.dispatchEvent('#commission', 'input');
  check('warning disappears after lowering rate', [await warn(), await lossClass()], [null, [false, false]]);

  // 100% commission: you pay away the whole price -> lose the full cost
  await enter({ ...BASE, commission: 100 });
  check('100% commission', await aouts(), ['RM 15.00','RM 1,500.00','-RM 10.00','-66.67%']);

  // Break-even exactly at the margin (with a floating-point trap: 0.1 + 0.2 style numbers)
  // cost 0.30, markup 100% -> price 0.60, profit 0.30, margin 50%; 50% commission = 0.30 -> net 0
  await enter({ materials: 0.1, packaging: 0.2, quantity: 1, markup: 100, commission: 50 });
  check('break-even values', await aouts(), ['RM 0.30','RM 0.30','RM 0.00','0.00%']);
  check('break-even: no loss warning', await warn(), null);
  check('break-even: status', await astatus(), 'Break-even: the commission uses up all of your profit.');

  // Validation
  await enter({ ...BASE, commission: 101 });
  check('over 100%', await p.textContent('#commission-error'), 'Cannot be more than 100.');
  check('over 100%: results blocked', await aouts(), ['—','—','—','—']);
  await enter({ ...BASE, commission: -5 });
  check('negative rate', await p.textContent('#commission-error'), 'Cannot be negative.');
  await enter({ ...BASE });
  await p.type('#commission', 'e');
  check('invalid text', await p.textContent('#commission-error'), 'Please enter a valid number.');

  // Depends on Product Cost
  await enter({ commission: 10 });
  check('no product yet: waits', [await aouts(), await astatus()],
    [['—','—','—','—'], 'Complete the Product Cost calculator first (costs, quantity and markup).']);
  await enter({ ...BASE });
  check('no rate yet: prompt', await astatus(), 'Enter a commission rate to see your take-home profit.');

  // Changing the product cost updates the affiliate section live
  await enter({ ...BASE, commission: 50 });             // loss
  await p.fill('#markup', '200'); await p.dispatchEvent('#markup', 'input');
  // price 30, profit 20, commission 15 -> net 5, 16.67%
  check('editing markup updates affiliate live', [await aouts(), await warn()], [['RM 15.00','RM 1,500.00','RM 5.00','16.67%'], null]);

  // Breaking the product form clears the affiliate results and warning
  await enter({ ...BASE, commission: 50 });
  await p.fill('#quantity', '0'); await p.dispatchEvent('#quantity', 'input');
  check('invalid product form resets affiliate', [await aouts(), await warn()], [['—','—','—','—'], null]);

  // Enter key must not reload the page (single-field forms submit on Enter)
  await enter({ ...BASE, commission: 10 });
  await p.focus('#commission'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  check('Enter key keeps values', [await p.inputValue('#commission'), (await aouts())[0]], ['10', 'RM 1.50']);

  // Clear all resets the affiliate form too
  await p.click('#reset-btn');
  check('clear all resets commission', [await p.inputValue('#commission'), await aouts()], ['', ['—','—','—','—']]);

  // Helpers
  check('formatMoney negative', await p.evaluate(() => formatMoney(-2.5)), '-RM 2.50');
  check('formatMoney no "-RM 0.00"', await p.evaluate(() => formatMoney(-0.001)), 'RM 0.00');
  check('formatMoney positive unchanged', await p.evaluate(() => formatMoney(1234.5)), 'RM 1,234.50');

  // Mobile
  await p.setViewportSize({ width: 375, height: 740 });
  await enter({ ...BASE, commission: 50 });
  check('mobile: no sideways scrolling', await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await p.screenshot({ path: `${OUTPUT_DIR}/mobile3.png`, fullPage: true });

  check('no JavaScript errors', errors, []);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
  await b.close();
})();
