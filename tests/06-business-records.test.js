const { chromium } = require('playwright');
const { APP_URL, OUTPUT_DIR } = require('./helpers');
const fs = require('fs');
const URL = APP_URL;
const RKEY = 'qhaze-records-v1', IKEY = 'qhaze-calculator-inputs-v1';
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`));
}
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await p.goto(URL);

  const msg = () => p.textContent('#records-status');
  const isErr = () => p.evaluate(() => document.getElementById('records-status').classList.contains('is-error'));
  // Groups as [business, count, [product names]]
  const groups = () => p.evaluate(() => [...document.querySelectorAll('.record-group')].map(g => [
    g.querySelector('.record-group-title').firstChild.textContent,
    g.querySelector('.record-count').textContent,
    [...g.querySelectorAll('.record-name')].map(n => n.textContent)]));
  const empty = () => p.evaluate(() => document.querySelector('#records-list .records-empty')?.textContent ?? null);
  const stored = () => p.evaluate(k => JSON.parse(localStorage.getItem(k)), RKEY);
  const rec = name => p.locator('.record', { has: p.locator('.record-name', { hasText: new RegExp(`^${name}$`) }) });
  const click = (name, action) => rec(name).locator(`button[data-action="${action}"]`).click();
  async function calc(values, method = 'margin') {
    await p.click('#reset-btn');
    await p.click(`.segmented input[value="${method}"] + span`);
    for (const [id, v] of Object.entries(values)) await p.type(`#${id}`, String(v));
  }
  async function save(product, business) {
    await p.fill('#record-product', product);
    await p.fill('#record-business', business);
    await p.click('#record-form button[type="submit"]');
  }
  const ROSE = { materials: 1000, quantity: 100, markup: 50, commission: 10, 'cap-equipment': 6000, 'cap-marketing': 4000, 'sp-rate': 30 };

  // ---------- 1. Save ----------
  check('empty state', await empty(), 'No saved records yet. Fill in the calculators, then save your first product above.');
  await p.click('#record-form button[type="submit"]');
  check('save: names required', [await p.textContent('#record-product-error'), await p.textContent('#record-business-error')],
    ['Enter a product name.', 'Enter a business name.']);
  await save('Empty', 'Nothing');
  check('save: needs calculator values', [await msg(), await isErr()], ['Fill in at least one calculator before saving a record.', true]);
  await save('   ', 'X');
  check('save: spaces-only name rejected', await p.textContent('#record-product-error'), 'Enter a product name.');

  await calc(ROSE);
  await save('Rose Serum', 'QHAZE Beauty');
  check('save: success message', [await msg(), await isErr()], ['Saved "Rose Serum" in QHAZE Beauty.', false]);
  check('save: product box cleared, business kept', [await p.inputValue('#record-product'), await p.inputValue('#record-business')], ['', 'QHAZE Beauty']);
  check('save: errors cleared', await p.textContent('#record-product-error'), '');
  const meta = await rec('Rose Serum').locator('.record-meta').textContent();
  check('save: summary line', meta.replace(/^Saved [^·]+· /, ''), 'Cost/unit RM 10.00 · Price RM 14.29');
  const r0 = (await stored())[0];
  check('save: stored inputs', [r0.inputs.materials, r0.inputs.quantity, r0.inputs['sp-rate'], r0.inputs['sp-method'], r0.inputs['sp-cost-manual']],
    ['1000', '100', '30', 'margin', 'false']);
  check('save: stored result numbers', [r0.results.costPerUnit, r0.results.sellingPrice, r0.results.netProfit, r0.results.capitalTotal,
    r0.results.smartPrice, r0.results.breakEvenUnits], [10, 15, 3.5, 10000, 14.29, 2332]);
  check('save: id and dates', [typeof r0.id, r0.id.length > 8, !isNaN(Date.parse(r0.createdAt)), r0.createdAt === r0.updatedAt], ['string', true, true, true]);

  // ---------- 8. Separate from auto-saved inputs ----------
  check('records under their own key', await p.evaluate(([a, b]) => [!!localStorage.getItem(a), !!localStorage.getItem(b), a !== b], [RKEY, IKEY]), [true, true, true]);

  await save('rose serum', 'qhaze beauty');
  check('duplicate (any capitals) blocked', [await msg(), (await stored()).length],
    ['"Rose Serum" already exists in QHAZE Beauty. Use a different name, or use Edit on that record to update it.', 1]);

  // ---------- 2. Group by business ----------
  await calc({ materials: 300, quantity: 100, markup: 100 });
  await save('Lip Balm', 'qhaze beauty');            // different capitals -> same group
  await calc({ 'sp-cost': 8, 'sp-rate': 25 });         // manual smart cost only
  await save('Coffee Beans', 'Kopi Co');
  check('grouped by business, A-Z, products A-Z', await groups(), [
    ['Kopi Co', '1 product', ['Coffee Beans']],
    ['QHAZE Beauty', '2 products', ['Lip Balm', 'Rose Serum']],
  ]);
  check('business suggestions', await p.evaluate(() => [...document.querySelectorAll('#business-suggestions option')].map(o => o.value)),
    ['Kopi Co', 'QHAZE Beauty']);   // one spelling per business
  check('different capitals reuse existing spelling', (await stored()).find(r => r.productName === 'Lip Balm').businessName, 'QHAZE Beauty');

  // ---------- 3. Search ----------
  await p.fill('#record-search', 'LIP');
  check('search by product (any capitals)', await groups(), [['QHAZE Beauty', '1 product', ['Lip Balm']]]);
  await p.fill('#record-search', 'kopi');
  check('search by business', await groups(), [['Kopi Co', '1 product', ['Coffee Beans']]]);
  await p.fill('#record-search', 'zzz');
  check('search with no match', [await groups(), await empty()], [[], 'No records match "zzz".']);
  await p.fill('#record-search', '');
  check('clearing search shows all', (await groups()).length, 2);

  // ---------- Clear all keeps records ----------
  await p.click('#reset-btn');
  check('Clear all keeps records', [(await stored()).length, (await groups()).length, await p.inputValue('#materials')], [3, 2, '']);

  // ---------- 4. Load ----------
  await click('Rose Serum', 'load');
  check('load: inputs back', await p.evaluate(() => ['materials','quantity','markup','commission','cap-equipment','sp-rate'].map(i => document.getElementById(i).value)),
    ['1000', '100', '50', '10', '6000', '30']);
  check('load: results recalculated', await p.evaluate(() => ['out-price','out-net-profit','out-capital-total','out-sp-price','out-sp-breakeven'].map(i => document.getElementById(i).textContent)),
    ['RM 15.00', 'RM 3.50', 'RM 10,000.00', 'RM 14.29', '2,332 units']);
  check('load: message', await msg(), 'Loaded "Rose Serum" into the calculators.');
  check('load: auto-saved inputs updated too', await p.evaluate(k => JSON.parse(localStorage.getItem(k)).materials, IKEY), '1000');
  await click('Coffee Beans', 'load');
  check('load: other fields emptied, manual cost restored', [await p.inputValue('#materials'), await p.inputValue('#sp-cost'),
    await p.textContent('#sp-cost-note'), await p.textContent('#out-sp-price')], ['', '8', 'Typed by hand (not linked).', 'RM 10.67']);

  // ---------- 5. View ----------
  await click('Rose Serum', 'view');
  const details = rec('Rose Serum').locator('.record-details');
  check('view: panel open, button says Hide', [await details.isVisible(), await rec('Rose Serum').locator('button[data-action="view"]').textContent(),
    await rec('Rose Serum').locator('button[data-action="view"]').getAttribute('aria-expanded')], [true, 'Hide', 'true']);
  const rows = await details.evaluate(d => [...d.querySelectorAll('.result-row')].map(r => r.querySelector('dt').textContent + ' = ' + r.querySelector('dd').textContent));
  for (const want of ['Raw materials cost = RM 1,000.00', 'Production quantity = 100 units', 'Markup = 50.00%',
                      'Equipment & machinery = RM 6,000.00', 'Smart pricing method = Target margin',
                      'Smart retail price = RM 14.29', 'Units to break even = 2,332 units', 'Net profit after commission = RM 3.50']) {
    check(`view shows "${want}"`, rows.includes(want), true);
  }
  check('view: empty inputs not listed', rows.some(r => r.startsWith('Shipping cost')), false);
  await p.fill('#record-search', 'rose');
  check('view stays open after re-render', await rec('Rose Serum').locator('.record-details').isVisible(), true);
  await p.fill('#record-search', '');
  await click('Rose Serum', 'view');
  check('hide closes panel', await rec('Rose Serum').locator('.record-details').isVisible(), false);

  // ---------- 6. Edit / rename ----------
  await click('Rose Serum', 'edit');
  check('edit form opens with current names', [await p.inputValue('#edit-productName'), await p.inputValue('#edit-businessName'),
    await p.evaluate(() => document.activeElement.id)], ['Rose Serum', 'QHAZE Beauty', 'edit-productName']);
  await p.fill('#edit-productName', '');
  await p.click('.record-edit button[type="submit"]');
  check('edit: empty name rejected', await p.textContent('.record-edit .error'), "Product and business names can't be empty.");
  await p.fill('#edit-productName', 'LIP BALM');
  await p.click('.record-edit button[type="submit"]');
  check('edit: duplicate rejected', await p.textContent('.record-edit .error'), 'Another record is already called "LIP BALM" in QHAZE Beauty.');
  await p.click('.record-edit button[data-action="cancel-edit"]');
  check('cancel: nothing changed', [await p.locator('.record-edit').count(), (await groups())[1][2]], [0, ['Lip Balm', 'Rose Serum']]);

  const before = (await stored()).find(r => r.productName === 'Rose Serum');
  await p.waitForTimeout(20);
  await click('Rose Serum', 'edit');
  await p.fill('#edit-productName', 'Rose Serum 50ml');
  await p.fill('#edit-businessName', 'QHAZE Skincare');
  await p.click('.record-edit button[type="submit"]');
  const after = (await stored()).find(r => r.id === before.id);
  check('rename: moved to new group', await groups(), [
    ['Kopi Co', '1 product', ['Coffee Beans']], ['QHAZE Beauty', '1 product', ['Lip Balm']], ['QHAZE Skincare', '1 product', ['Rose Serum 50ml']]]);
  check('rename: numbers kept, date updated, same id', [after.results.smartPrice, after.updatedAt > before.updatedAt, after.createdAt === before.createdAt],
    [14.29, true, true]);
  check('rename: message', await msg(), 'Renamed to "Rose Serum 50ml" in QHAZE Skincare.');

  // Edit + replace numbers with current calculator values
  await calc({ materials: 2000, quantity: 100, 'sp-rate': 50 });
  await click('Rose Serum 50ml', 'edit');
  await p.check('.record-edit input[name="replace"]');
  await p.click('.record-edit button[type="submit"]');
  const replaced = (await stored()).find(r => r.id === before.id);
  check('replace numbers: inputs and results updated', [replaced.inputs.materials, replaced.results.costPerUnit, replaced.results.smartPrice, replaced.results.capitalTotal],
    ['2000', 20, 40, null]);
  check('replace numbers: message', await msg(), 'Updated "Rose Serum 50ml" with the current calculator values.');

  // ---------- 7. Delete with confirmation ----------
  p.once('dialog', d => { check('delete asks first', d.message(), 'Delete "Lip Balm" from QHAZE Beauty? This can\'t be undone.'); d.dismiss(); });
  await click('Lip Balm', 'delete');
  check('delete cancelled: still there', (await stored()).some(r => r.productName === 'Lip Balm'), true);
  p.once('dialog', d => d.accept());
  await click('Lip Balm', 'delete');
  check('delete confirmed: gone, empty group removed', [(await stored()).length, (await groups()).map(g => g[0]), await msg()],
    [2, ['Kopi Co', 'QHAZE Skincare'], 'Deleted "Lip Balm".']);

  // Persistence
  await p.reload();
  check('records survive refresh', (await groups()).map(g => g[2][0]), ['Coffee Beans', 'Rose Serum 50ml']);

  // ---------- 9. Export ----------
  const [download] = await Promise.all([p.waitForEvent('download'), p.click('#export-btn')]);
  const file = `${OUTPUT_DIR}/backup.json`;
  await download.saveAs(file);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('export: file name', /^qhaze-records-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), true);
  check('export: contents', [backup.app, backup.version, backup.records.length, backup.records.map(r => r.productName).sort()],
    ['qhaze-business-calculator', 1, 2, ['Coffee Beans', 'Rose Serum 50ml']]);
  check('export: message', await msg(), 'Exported 2 records. Keep the file somewhere safe.');

  // ---------- 9. Import ----------
  const importJSON = async (obj, name = 'backup.json', answer = 'accept') => {
    const handler = d => d[answer]();
    p.once('dialog', handler);
    await p.setInputFiles('#import-file', { name, mimeType: 'application/json', buffer: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)) });
    await p.waitForTimeout(200);
    p.off('dialog', handler);
  };
  await p.evaluate(k => localStorage.removeItem(k), RKEY);
  await p.reload();
  check('records wiped (simulates new device)', await empty(), 'No saved records yet. Fill in the calculators, then save your first product above.');
  await importJSON(backup, 'b.json', 'dismiss');
  check('import cancelled: nothing added', await empty() !== null, true);
  await importJSON(backup);
  check('import: restored', [await msg(), (await groups()).map(g => g[2][0])], ['Imported: 2 added, 0 replaced.', ['Coffee Beans', 'Rose Serum 50ml']]);
  check('import: data identical to export', JSON.stringify((await stored()).sort((a, b) => a.id.localeCompare(b.id))),
    JSON.stringify(backup.records.sort((a, b) => a.id.localeCompare(b.id))));
  await importJSON(backup);
  check('import again: replaced, not doubled', [await msg(), (await stored()).length], ['Imported: 0 added, 2 replaced.', 2]);
  await importJSON('{oops not json');
  check('import: broken file', [await msg(), await isErr()], ["That file isn't a valid backup (it couldn't be read as JSON).", true]);
  await importJSON({ hello: 'world' });
  check('import: wrong kind of JSON', await msg(), "That file isn't a QHAZE Business Calculator backup.");
  await importJSON({ app: 'qhaze-business-calculator', version: 1, records: [1, 'x', {}] });
  check('import: nothing usable', await msg(), 'No usable records were found in that backup.');

  // Tampered / hostile backup
  await importJSON({ app: 'qhaze-business-calculator', version: 1, records: [
    { id: 'evil-1', productName: '<img src=x onerror="window.__xss=1">', businessName: 'Hacker <b>Inc</b>',
      inputs: { materials: '50', quantity: 5, hacked: 'yes' }, results: { costPerUnit: '999', smartPrice: 12.5, extra: 1 }, isAdmin: true },
    { productName: '', businessName: 'No name' },
    null,
  ] });
  check('import: damaged entries skipped and counted', await msg(), 'Imported: 1 added, 0 replaced. 2 damaged entries were skipped.');
  check('hostile name shown as plain text, never run', await p.evaluate(() => [
    !!window.__xss, document.querySelectorAll('#records-list img, #records-list b').length,
    [...document.querySelectorAll('.record-name')].some(n => n.textContent === '<img src=x onerror="window.__xss=1">')]), [false, 0, true]);
  const evil = (await stored()).find(r => r.id === 'evil-1');
  check('tampered fields cleaned', [Object.keys(evil).sort(), evil.inputs, evil.results.costPerUnit, evil.results.smartPrice, 'extra' in evil.results],
    [['businessName', 'createdAt', 'id', 'inputs', 'productName', 'results', 'updatedAt'], { materials: '50' }, null, 12.5, false]);
  await click('<img src=x onerror="window.__xss=1">', 'view');
  check('view of cleaned record works', await rec('<img src=x onerror="window.__xss=1">').locator('.record-details').isVisible(), true);

  // Too large
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.json', { type: 'application/json' }));
    const input = document.getElementById('import-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
  await p.waitForTimeout(200);
  check('import: oversized file refused', await msg(), 'That file is too large to be a QHAZE backup.');

  // Export with no records
  await p.evaluate(k => localStorage.removeItem(k), RKEY); await p.reload();
  await p.click('#export-btn');
  check('export with nothing', await msg(), 'There are no records to export yet.');

  // Damaged records storage
  await p.evaluate(k => localStorage.setItem(k, '{broken'), RKEY); await p.reload();
  check('damaged records storage: page still works', [await empty() !== null, await p.textContent('#out-sp-price') !== null], [true, true]);
  await p.evaluate(k => localStorage.setItem(k, JSON.stringify([{ productName: 'Good', businessName: 'Biz', inputs: {}, results: {} }, 42])), RKEY);
  await p.reload();
  check('partly damaged storage: good records kept', (await groups()), [['Biz', '1 product', ['Good']]]);

  // Old auto-saved inputs still load next to records
  check('calculators unaffected by records', await p.evaluate(() => typeof updateAll === 'function'), true);

  // ---------- Mobile ----------
  await p.evaluate(k => localStorage.removeItem(k), RKEY); await p.reload();
  await importJSON(backup);
  for (const w of [375, 320]) {
    await p.setViewportSize({ width: w, height: 740 });
    await click('Rose Serum 50ml', 'view');
    await click('Coffee Beans', 'edit');
    check(`${w}px: no sideways scrolling (records, details, edit open)`, await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await p.click('.record-edit button[data-action="cancel-edit"]');
    await click('Rose Serum 50ml', 'view');
  }
  await p.setViewportSize({ width: 375, height: 740 });
  await click('Rose Serum 50ml', 'view');
  await p.locator('#records').screenshot({ path: `${OUTPUT_DIR}/records-mobile.png` });
  await p.setViewportSize({ width: 1280, height: 900 });
  await click('Coffee Beans', 'edit');
  await p.locator('#records').screenshot({ path: `${OUTPUT_DIR}/records.png` });

  // ---------- Blocked storage ----------
  const blocked = await b.newContext();
  await blocked.addInitScript(k => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === k) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, key, value);
    };
  }, RKEY);
  const bp = await blocked.newPage();
  bp.on('pageerror', e => errors.push(e.message));
  await bp.goto(URL);
  await bp.type('#materials', '100');
  await bp.fill('#record-product', 'Test'); await bp.fill('#record-business', 'Biz');
  await bp.click('#record-form button[type="submit"]');
  check('storage full: honest error, record kept for export', [
    await bp.textContent('#records-status'),
    await bp.evaluate(() => document.querySelectorAll('.record').length)],
    ["Couldn't save to this browser's storage (blocked or full). Your change is kept until you close the page. Use Export backup to keep a copy.", 1]);

  check('no JavaScript errors', errors, []);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
  await b.close();
})();
