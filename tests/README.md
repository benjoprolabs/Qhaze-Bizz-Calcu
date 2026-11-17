# Tests

Browser tests for QHAZE Business Calculator. Each file opens `index.html` in a
real (headless) Chromium browser, types into the calculators like a user would,
and checks the results.

| File | What it checks |
|---|---|
| `01-product-cost.test.js` | Product cost calculations, validation, mobile layout |
| `02-affiliate-commission.test.js` | Commission, net profit, loss warning |
| `03-remember-inputs.test.js` | Saving and restoring inputs (localStorage) |
| `04-business-capital.test.js` | Startup capital total and breakdown |
| `05-smart-pricing.test.js` | Smart selling price, link to Product Cost, break-even |
| `06-business-records.test.js` | Records: save, group, search, load, edit, delete, backup |
| `07-dashboard.test.js` | Dashboard KPIs, margin bars, report table, filter, print / PDF |

## Running them

You need [Node.js](https://nodejs.org) (version 18 or newer). Then, once:

```
npm install
npx playwright install chromium
```

Run everything:

```
npm test
```

Or one file: `node tests/05-smart-pricing.test.js`

Screenshots are written to `tests/output/` (not committed to Git).
