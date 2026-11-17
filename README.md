# QHAZE Business Calculator

A simple web app that helps small businesses work out their numbers:

- Product cost
- Selling price
- Gross profit
- Profit margin (%)
- Affiliate commission

Default currency: **RM (Malaysian Ringgit)**. You can change it in `js/app.js` (`CONFIG.currencySymbol`).

## Dashboard and reports

Built from your saved Business Records and updated whenever a record is saved,
edited, deleted or imported:

- **KPI cards**: products, average net margin, total startup capital, best margin
- **Net margin bars** for every priced product (red for products that lose money)
- **Product report table**, filterable by business
- **Print / Save as PDF**: prints a clean, light-coloured report of the dashboard

Each product's figures come from Smart Pricing if it has a smart price, otherwise
from the Product Cost markup after affiliate commission. Startup capital is counted
once per business, using its most recently saved figure.

## Saved inputs

Everything you type is saved automatically in your browser (localStorage) and
restored when you come back. It stays on your device and is never sent anywhere.
**Clear all** empties the form and deletes the saved data.

## Business records

Save the current calculator values under a **product name** and **business name**.
Records are grouped by business and can be searched, loaded back into the
calculators, viewed, renamed, updated and deleted. They are stored in your browser
under a separate key, so **Clear all** never deletes them.

**Export backup** downloads all records as a `.json` file. **Import backup** reads
such a file back in: records with the same ID are replaced, new ones are added,
and anything damaged is skipped. Export regularly: clearing your browser data
deletes records stored in the browser.

## Tech stack

Plain **HTML**, **CSS** and **JavaScript**. No frameworks, no build tools, nothing to install.

## How to run

Open `index.html` in any web browser (double-click it).

## Tests

283 automated browser tests live in `tests/`. Run them with `npm test`
(see `tests/README.md` for the one-time setup). The app itself needs no install.

## Project structure

```
index.html      Page structure
css/style.css   Dark futuristic theme (purple and cyan)
js/app.js       Calculation logic
README.md       This file
tests/          Automated browser tests (npm test)
package.json    Test setup only (the app doesn't need it)
```

## Progress

- [x] Step 1: Project skeleton and theme
- [x] Step 2: Product cost calculator, which also covers:
  - [x] Selling price per unit (from markup %)
  - [x] Gross profit per unit
  - [x] Profit margin (%)
- [x] Step 3: Affiliate commission (with loss warning)
- [x] Step 4: Remember inputs (saved in the browser with localStorage)
- [x] Step 5: Business capital calculator
- [x] Step 6: Smart selling price calculator (linked to Product Cost)
- [x] Step 7: Business records (save, group, search, load, view, edit, delete, JSON backup)
- [x] Step 8: Dashboard and reports (KPIs, margin bars, filterable report, print / PDF)

## Formulas

| Result | Formula |
|---|---|
| Total production cost | materials + packaging + shipping + labour + other |
| Cost per unit | total cost ÷ quantity |
| Selling price per unit | cost per unit × (1 + markup% ÷ 100) |
| Gross profit per unit | selling price − cost per unit |
| Profit margin | gross profit ÷ selling price × 100 |
| Commission per unit | selling price × commission% ÷ 100 |
| Total commission | commission per unit × quantity |
| Net profit per unit | gross profit − commission per unit |
| Net margin | net profit ÷ selling price × 100 |
| Total startup capital | equipment + raw materials + packaging + marketing + rental & utilities + other |
| Category share | category amount ÷ total startup capital × 100 |
| Smart price (target margin) | (cost + fixed fee) ÷ (1 − affiliate% − platform% − margin%), rounded up to the sen |
| Smart price (markup) | cost × (1 + markup% ÷ 100) |
| Platform fees | price × platform% + fixed fee |
| Net profit (smart) | price − cost − affiliate commission − platform fees |
| Minimum price (no loss) | (cost + fixed fee) ÷ (1 − affiliate% − platform%) |
| Wholesale price | retail price × (1 − wholesale discount%) (no affiliate/platform fees) |
| Units to break even | startup capital ÷ net profit per unit, rounded up |

The Smart Pricing cost is linked to the Product Cost "cost per unit" until you type
your own value; **Use Product Cost** links it again.

A loss warning appears when the commission is more than the gross profit.
The highest commission rate you can offer without a loss equals your profit margin.
