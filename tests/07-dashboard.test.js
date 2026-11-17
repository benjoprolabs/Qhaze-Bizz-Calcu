const { chromium } = require('playwright');
const fs = require('fs');
const { APP_URL, OUTPUT_DIR } = require('./helpers');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`));
}

// Every result key a record can have; unset ones are null.
const NULL_RESULTS = {
  totalCost: null, costPerUnit: null, sellingPrice: null, grossProfit: null, marginPercent: null,
  commissionPerUnit: null, netProfit: null, netMarginPercent: null, capitalTotal: null, smartCost: null,
  smartPrice: null, smartNetProfit: null, smartNetMarginPercent: null, wholesalePrice: null, breakEvenUnits: null,
};
const record = (id, productName, businessName, updatedAt, results) => ({
  id, productName, businessName, createdAt: updatedAt, updatedAt, inputs: {}, results: { ...NULL_RESULTS, ...results },
});

// Test data: one product of each kind. Expected numbers are worked out by hand.
const BACKUP = {
  app: 'qhaze-business-calculator', version: 1, records: [
    // Smart pricing (its markup numbers must be IGNORED in favour of smart ones)
    record('r1', 'Rose Serum', 'QHAZE Beauty', '2026-11-10T10:00:00.000Z', {
      costPerUnit: 10, sellingPrice: 15, grossProfit: 5, marginPercent: 33.33, capitalTotal: 10000,
      smartCost: 10, smartPrice: 18.11, smartNetProfit: 5.4368, smartNetMarginPercent: 30.021, breakEvenUnits: 1840 }),
    // Markup + commission, NEWER capital figure for QHAZE Beauty
    record('r2', 'Lip Balm', 'QHAZE Beauty', '2026-11-15T10:00:00.000Z', {
      costPerUnit: 3, sellingPrice: 6, grossProfit: 3, marginPercent: 50, netProfit: 2.4, netMarginPercent: 40, capitalTotal: 12000 }),
    // Markup only (no commission): net = gross
    record('r3', 'Face Mist', 'QHAZE Beauty', '2026-11-12T10:00:00.000Z', {
      costPerUnit: 4, sellingPrice: 5, grossProfit: 1, marginPercent: 20 }),
    // Smart pricing that loses money
    record('r4', 'Coffee Beans', 'Kopi Co', '2026-11-11T10:00:00.000Z', {
      capitalTotal: 5000, smartCost: 10, smartPrice: 11, smartNetProfit: -0.65, smartNetMarginPercent: -5.909 }),
    // Not priced at all
    record('r5', 'Gift Box', 'Kopi Co', '2026-11-13T10:00:00.000Z', { costPerUnit: 7 }),
  ],
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await p.goto(APP_URL);

  const kpis = () => p.evaluate(() => ['kpi-products','kpi-products-sub','kpi-margin','kpi-margin-sub','kpi-capital','kpi-capital-sub','kpi-best','kpi-best-sub']
    .map(id => document.getElementById(id).textContent));
  const bars = () => p.evaluate(() => [...document.querySelectorAll('#margin-bars li')].map(li => {
    const spans = li.querySelectorAll('.breakdown-label span');
    const fill = li.querySelector('.bar-fill');
    return spans.length ? [spans[0].textContent, spans[1].textContent, fill.style.width, fill.classList.contains('is-negative')] : li.textContent;
  }));
  const table = () => p.evaluate(() => [...document.querySelectorAll('#report-body tr')].map(tr =>
    [...tr.querySelectorAll('td')].slice(0, 7).map(td => td.textContent)));
  const lossBox = () => p.evaluate(() => { const w = document.getElementById('dash-loss'); return w.hidden ? null : w.textContent; });
  const visible = sel => p.locator(sel).isVisible();
  const filter = value => p.selectOption('#dash-business', value);
  const importBackup = async (data) => {
    p.once('dialog', d => d.accept());
    await p.setInputFiles('#import-file', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
    await p.waitForTimeout(200);
  };
  const deleteRecord = async (name) => {
    p.once('dialog', d => d.accept());
    await p.locator('.record', { has: p.locator('.record-name', { hasText: new RegExp(`^${name}$`) }) })
      .locator('button[data-action="delete"]').click();
  };

  // ---------- Empty state ----------
  check('empty: helpful message shown', [await visible('#dashboard-empty'),
    (await p.textContent('#dashboard-empty')).includes('Your dashboard is empty.')], [true, true]);
  check('empty: KPIs, filter and print button hidden', [await visible('#dashboard-content'), await visible('#print-btn'), await visible('#dash-business')],
    [false, false, false]);
  check('empty: link to Business Records', await p.getAttribute('#dashboard-empty a', 'href'), '#records');
  check('dashboard is the first nav link', await p.textContent('.section-nav a:first-child'), 'Dashboard');

  // ---------- Pure calculation ----------
  const sources = await p.evaluate(b => b.records.map(r => recordMetrics(cleanRecord(r)).source), BACKUP);
  check('each record uses one consistent source', sources, ['Smart pricing', 'Markup + commission', 'Markup', 'Smart pricing', 'Not priced']);

  // ---------- All businesses ----------
  await importBackup(BACKUP);
  check('records added -> dashboard appears', [await visible('#dashboard-empty'), await visible('#dashboard-content')], [false, true]);
  check('KPIs (all businesses)', await kpis(), [
    '5', 'in 2 businesses',
    '21.03%', 'across 4 priced products',            // (30.021 + 40 + 20 - 5.909) / 4
    'RM 17,000.00', 'from 2 businesses',              // QHAZE newest 12,000 + Kopi 5,000
    'Lip Balm', '40.00% net margin · QHAZE Beauty']);
  check('loss alert', await lossBox(), '⚠ 1 product loses money on each sale.Coffee Beans (-RM 0.65)');
  check('margin bars: highest first, widths = margin, loss in red', await bars(), [
    ['Lip Balm · QHAZE Beauty', '40.00%', '40%', false],
    ['Rose Serum · QHAZE Beauty', '30.02%', '30.021%', false],
    ['Face Mist · QHAZE Beauty', '20.00%', '20%', false],
    ['Coffee Beans · Kopi Co', '-5.91%', '5.909%', true],
  ]);
  check('report table: sorted by business then product, one source per row', await table(), [
    ['Coffee BeansSmart pricing', 'Kopi Co', 'RM 10.00', 'RM 11.00', '-RM 0.65', '-5.91%', '—'],
    ['Gift BoxNot priced', 'Kopi Co', 'RM 7.00', '—', '—', '—', '—'],
    ['Face MistMarkup', 'QHAZE Beauty', 'RM 4.00', 'RM 5.00', 'RM 1.00', '20.00%', '—'],
    ['Lip BalmMarkup + commission', 'QHAZE Beauty', 'RM 3.00', 'RM 6.00', 'RM 2.40', '40.00%', '—'],
    ['Rose SerumSmart pricing', 'QHAZE Beauty', 'RM 10.00', 'RM 18.11', 'RM 5.44', '30.02%', '1,840 units'],
  ]);
  check('loss row cells red', await p.evaluate(() => [...document.querySelectorAll('#report-body tr:first-child td.is-loss')].length), 2);
  const meta = await p.textContent('#report-meta');
  check('report line', /^Report generated \d{1,2} \w{3} \d{4} · All businesses · 5 products$/.test(meta), true);
  check('filter options', await p.evaluate(() => [...document.querySelectorAll('#dash-business option')].map(o => [o.value, o.textContent])),
    [['', 'All businesses'], ['kopi co', 'Kopi Co'], ['qhaze beauty', 'QHAZE Beauty']]);
  await p.locator('#dashboard').screenshot({ path: `${OUTPUT_DIR}/dashboard.png` });

  // ---------- Filter ----------
  await filter('kopi co');
  check('filter Kopi Co: KPIs', await kpis(), ['2', 'in 1 business', '-5.91%', 'across 1 priced product',
    'RM 5,000.00', 'from 1 business', 'Coffee Beans', '-5.91% net margin · Kopi Co']);
  check('filter Kopi Co: bars without business name', (await bars()).map(r => r[0]), ['Coffee Beans']);
  check('filter Kopi Co: table rows', (await table()).map(r => r[0]), ['Coffee BeansSmart pricing', 'Gift BoxNot priced']);
  check('filter Kopi Co: report line', (await p.textContent('#report-meta')).endsWith('· Kopi Co · 2 products'), true);

  await filter('qhaze beauty');
  check('filter QHAZE: KPIs', await kpis(), ['3', 'in 1 business', '30.01%', 'across 3 priced products',   // (30.021+40+20)/3
    'RM 12,000.00', 'from 1 business', 'Lip Balm', '40.00% net margin · QHAZE Beauty']);
  check('filter QHAZE: no loss alert', await lossBox(), null);

  // ---------- Updates when records change ----------
  await deleteRecord('Lip Balm');
  check('after delete: average, capital (next newest) and best update', await kpis(), ['2', 'in 1 business',
    '25.01%', 'across 2 priced products',                // (30.021 + 20) / 2
    'RM 10,000.00', 'from 1 business',                    // Lip Balm's 12,000 gone -> Rose Serum's 10,000
    'Rose Serum', '30.02% net margin · QHAZE Beauty']);
  check('filter kept after unrelated change', await p.inputValue('#dash-business'), 'qhaze beauty');

  // Rename: move Face Mist to Kopi Co
  const rec = name => p.locator('.record', { has: p.locator('.record-name', { hasText: new RegExp(`^${name}$`) }) });
  await rec('Face Mist').locator('button[data-action="edit"]').click();
  await p.fill('#edit-businessName', 'Kopi Co');
  await p.click('.record-edit button[type="submit"]');
  check('after edit: record moved out of filtered business', [(await kpis())[0], (await table()).map(r => r[0])], ['1', ['Rose SerumSmart pricing']]);
  await filter('');
  check('after edit: Kopi Co now has 3', (await table()).filter(r => r[1] === 'Kopi Co').length, 3);

  // Filtered business disappears -> back to "All"
  await filter('kopi co');
  for (const name of ['Coffee Beans', 'Gift Box', 'Face Mist']) await deleteRecord(name);
  check('filtered business deleted -> filter resets to All', [await p.inputValue('#dash-business'), (await kpis())[0]], ['', '1']);

  // Add a record through the real calculators
  await p.click('#reset-btn');
  for (const [id, v] of Object.entries({ materials: 1000, quantity: 100, 'cap-equipment': 8000, 'sp-rate': 30 })) await p.type(`#${id}`, String(v));
  await p.fill('#record-product', 'Hand Cream'); await p.fill('#record-business', 'QHAZE Beauty');
  await p.click('#record-form button[type="submit"]');
  check('after save from calculators: dashboard updates', await kpis(), ['2', 'in 1 business',
    '30.02%', 'across 2 priced products',                // Rose 30.021 + Hand Cream (14.29 - 10) / 14.29 = 30.021
    'RM 8,000.00', 'from 1 business',                     // newest QHAZE capital
    'Rose Serum', '30.02% net margin · QHAZE Beauty']);
  check('new row in report', (await table()).find(r => r[0].startsWith('Hand Cream')),
    ['Hand CreamSmart pricing', 'QHAZE Beauty', 'RM 10.00', 'RM 14.29', 'RM 4.29', '30.02%', '1,865 units']);   // 8000 / 4.29 = 1864.8 -> 1865

  // Records with no prices at all
  await p.evaluate(() => localStorage.removeItem('qhaze-records-v1')); await p.reload();
  await importBackup({ app: 'qhaze-business-calculator', version: 1, records: [record('x', 'Draft', 'Biz', '2026-11-01T00:00:00.000Z', { costPerUnit: 2 })] });
  check('no priced products: friendly messages', [await kpis(), await bars()], [
    ['1', 'in 1 business', '—', 'No priced products yet', '—', 'No startup capital saved', '—', ''],
    ['No priced products yet. Add a markup or a smart price before saving a record.']]);

  // Hostile names stay text
  await importBackup({ app: 'qhaze-business-calculator', version: 1, records: [
    record('h', '<img src=x onerror="window.__x=1">', '<b>Biz</b>', '2026-11-02T00:00:00.000Z', { sellingPrice: 2, costPerUnit: 1, grossProfit: 1, marginPercent: 50 })] });
  check('names shown as text in dashboard', await p.evaluate(() => [!!window.__x, document.querySelectorAll('#dashboard img, #dashboard b').length,
    document.getElementById('kpi-best').textContent]), [false, 0, '<img src=x onerror="window.__x=1">']);

  // Delete everything -> empty state again
  await p.evaluate(() => localStorage.removeItem('qhaze-records-v1')); await p.reload();
  check('all deleted -> empty state', [await visible('#dashboard-empty'), await visible('#dashboard-content')], [true, false]);

  // ---------- Print ----------
  await importBackup(BACKUP);
  const printed = await p.evaluate(() => {
    let called = false;
    const real = window.print;
    window.print = () => { called = true; };
    document.getElementById('print-btn').click();
    window.print = real;
    return called;
  });
  check('Print button opens the print window', printed, true);

  await p.emulateMedia({ media: 'print' });
  check('print: only header + dashboard', await p.evaluate(() => {
    const shown = sel => [...document.querySelectorAll(sel)].some(e => e.offsetParent !== null || getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0);
    return { header: shown('.site-header'), dashboard: shown('#dashboard'), toolbar: shown('.toolbar'), nav: shown('.section-nav'),
      calculators: shown('.calculator'), records: shown('#records'), footer: shown('.site-footer'), controls: shown('#dashboard-controls') };
  }), { header: true, dashboard: true, toolbar: false, nav: false, calculators: false, records: false, footer: false, controls: false });
  check('print: light background', await p.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
  await p.setViewportSize({ width: 600, height: 900 });
  check('print: table stays a table even on narrow paper', await p.evaluate(() => getComputedStyle(document.querySelector('.report-table thead')).position), 'static');
  await p.screenshot({ path: `${OUTPUT_DIR}/print-preview.png`, fullPage: true });
  await p.setViewportSize({ width: 718, height: 1000 });   // A4 width minus margins
  check('print: all 8 report columns fit the page', await p.evaluate(() =>
    document.querySelector('.report-table').scrollWidth <= document.querySelector('.table-wrap').clientWidth), true);
  check('print: 4 KPIs in one row', await p.evaluate(() =>
    new Set([...document.querySelectorAll('.kpi')].map(k => Math.round(k.getBoundingClientRect().top))).size), 1);
  await p.setViewportSize({ width: 1280, height: 900 });
  const pdf = await p.pdf({ path: `${OUTPUT_DIR}/report.pdf`, format: 'A4', printBackground: true });
  check('PDF generated', pdf.length > 10000 && fs.existsSync(`${OUTPUT_DIR}/report.pdf`), true);
  await p.emulateMedia({ media: 'screen' });

  // ---------- Mobile ----------
  for (const w of [375, 320]) {
    await p.setViewportSize({ width: w, height: 800 });
    check(`${w}px: no sideways scrolling`, await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    check(`${w}px: table rows become labelled cards`, await p.evaluate(() => {
      const td = document.querySelector('#report-body tr td:nth-child(3)');
      return [getComputedStyle(td).display, getComputedStyle(td, '::before').content];
    }), ['flex', '"Cost / unit"']);
  }
  await p.setViewportSize({ width: 375, height: 800 });
  await p.locator('#dashboard').screenshot({ path: `${OUTPUT_DIR}/dashboard-mobile.png` });

  check('no JavaScript errors', errors, []);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
  await b.close();
})();
