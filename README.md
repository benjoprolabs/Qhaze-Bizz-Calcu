# QHAZE Business Calculator

A simple web app that helps small businesses work out their numbers:

- Product cost
- Selling price
- Gross profit
- Profit margin (%)
- Affiliate commission

Default currency: **RM (Malaysian Ringgit)**. You can change it in `js/app.js` (`CONFIG.currencySymbol`).

## Tech stack

Plain **HTML**, **CSS** and **JavaScript**. No frameworks, no build tools, nothing to install.

## How to run

Open `index.html` in any web browser (double-click it).

## Project structure

```
index.html      Page structure
css/style.css   Dark futuristic theme (purple and cyan)
js/app.js       Calculation logic
README.md       This file
```

## Progress

- [x] Step 1: Project skeleton and theme
- [x] Step 2: Product cost calculator, which also covers:
  - [x] Selling price per unit (from markup %)
  - [x] Gross profit per unit
  - [x] Profit margin (%)
- [x] Step 3: Affiliate commission (with loss warning)
- [ ] Next: polish and extra features

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

A loss warning appears when the commission is more than the gross profit.
The highest commission rate you can offer without a loss equals your profit margin.
