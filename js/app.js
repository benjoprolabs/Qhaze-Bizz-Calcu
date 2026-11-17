/* =========================================================
   QHAZE Business Calculator — Logic
   ========================================================= */

// ---------- Settings ----------
// Everything you might want to change lives in one place.
const CONFIG = {
  currencySymbol: "RM",   // Malaysian Ringgit
  locale: "en-MY",        // controls number formatting (e.g. 1,234.50)
  maxAmount: 1e9,         // largest number we accept (RM 1 billion)
};

// IDs of the five cost inputs. They are all validated and added the same way.
const COST_FIELDS = ["materials", "packaging", "shipping", "labour", "other"];

// The six startup capital inputs, with the names shown in the breakdown.
const CAPITAL_FIELDS = [
  { id: "cap-equipment", label: "Equipment & machinery" },
  { id: "cap-materials", label: "Initial raw materials" },
  { id: "cap-packaging", label: "Packaging capital" },
  { id: "cap-marketing", label: "Marketing budget" },
  { id: "cap-rental", label: "Rental & utilities" },
  { id: "cap-other", label: "Other startup expenses" },
];

// The Smart Pricing number inputs.
const SMART_FIELDS = ["sp-cost", "sp-rate", "sp-wholesale", "sp-affiliate", "sp-platform", "sp-fixed-fee"];

// Every input on the page that should be remembered between visits.
// map() turns the list of capital objects into a list of just their ids.
const SAVED_FIELDS = [
  ...COST_FIELDS, "quantity", "markup", "commission",
  ...CAPITAL_FIELDS.map((field) => field.id),
  ...SMART_FIELDS,
];

// Is the Smart Pricing cost typed by hand (true) or linked to the
// Product Cost calculator (false)? It changes when the user types in the
// box or clicks "Use Product Cost", so it is a "let", not a "const".
let spCostManual = false;

// The name our data is stored under in localStorage. The "v1" lets us
// change the format later without confusing old saved data.
const STORAGE_KEY = "qhaze-calculator-inputs-v1";

// ---------- Formatting helpers ----------

/**
 * Turns a number into a money string, e.g. 1234.5 -> "RM 1,234.50"
 * and -2.5 -> "-RM 2.50".
 */
function formatMoney(amount) {
  // Round to whole sen first, so a tiny value like -0.001 shows as "RM 0.00", not "-RM 0.00"
  const sen = Math.round(amount * 100);
  const sign = sen < 0 ? "-" : "";
  const formatted = (Math.abs(sen) / 100).toLocaleString(CONFIG.locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${CONFIG.currencySymbol} ${formatted}`;
}

/**
 * Turns a number into a percentage string, e.g. 33.3333 -> "33.33%".
 */
function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}

// ---------- 1. Calculation (pure maths, no web page involved) ----------

/**
 * Works out every result from plain numbers.
 * Because it never touches the page, we can test it on its own.
 *
 * @param {number[]} costs     the five batch costs
 * @param {number}   quantity  units produced (1 or more)
 * @param {number}   markup    % added on top of the cost per unit
 */
function calculateProductCost(costs, quantity, markup) {
  // reduce() walks the list and keeps a running total, starting at 0
  const totalCost = costs.reduce((sum, cost) => sum + cost, 0);
  const costPerUnit = totalCost / quantity;
  const sellingPrice = costPerUnit * (1 + markup / 100);
  const grossProfit = sellingPrice - costPerUnit;
  // Guard against dividing by zero (if every cost is 0, the price is 0 too)
  const marginPercent = sellingPrice > 0 ? (grossProfit / sellingPrice) * 100 : null;

  return { totalCost, costPerUnit, sellingPrice, grossProfit, marginPercent };
}

/**
 * Works out the affiliate commission and what's left for you.
 * Commission is a percentage of the SELLING PRICE (not of profit).
 *
 * @param {number} sellingPrice  price per unit
 * @param {number} grossProfit   profit per unit before commission
 * @param {number} ratePercent   commission rate, 0-100
 */
function calculateAffiliate(sellingPrice, grossProfit, ratePercent) {
  const commission = sellingPrice * (ratePercent / 100);
  const netProfit = grossProfit - commission;
  const netMarginPercent = sellingPrice > 0 ? (netProfit / sellingPrice) * 100 : null;

  // Compare in whole sen (cents). Computers store decimals slightly
  // inexactly (0.1 + 0.2 = 0.30000000000000004), so comparing the raw
  // numbers could call a break-even sale a tiny "loss".
  const netSen = Math.round(netProfit * 100);
  const isLoss = netSen < 0;
  const isBreakEven = netSen === 0;

  return { commission, netProfit, netMarginPercent, isLoss, isBreakEven };
}

/**
 * Works out the total startup capital and each category's share.
 *
 * @param {{label: string, amount: number}[]} items  one entry per category
 * @returns {{ total: number,
 *             items: {label: string, amount: number, percent: number}[],
 *             largest: {label: string, amount: number, percent: number} | null }}
 *   items are sorted biggest first; largest is null when everything is 0.
 */
function calculateCapital(items) {
  const total = items.reduce((sum, item) => sum + item.amount, 0);

  const withShares = items
    .map((item) => ({
      ...item,
      // Each category's share of the total, as a percentage (no ÷ 0)
      percent: total > 0 ? (item.amount / total) * 100 : 0,
    }))
    // sort() with (a, b) => b - a puts the biggest amounts first
    .sort((a, b) => b.amount - a.amount);

  const largest = total > 0 ? withShares[0] : null;
  return { total, items: withShares, largest };
}

/**
 * Rounds money to whole sen (2 decimal places).
 * "up" always rounds upwards, so a recommended price never ends up
 * a fraction of a sen too low (which would miss the target margin).
 */
function roundToSen(amount, direction = "nearest") {
  const sen = amount * 100;
  // The tiny 0.000001 stops floating-point noise (e.g. 1500.0000000002)
  // from being rounded UP to the next sen by mistake.
  const rounded = direction === "up" ? Math.ceil(sen - 0.000001) : Math.round(sen);
  return rounded / 100;
}

/**
 * The Smart Selling Price calculation. Pure maths: numbers in, numbers out.
 *
 * @param {object} input
 *   cost          product cost per unit (RM)
 *   method        "margin" or "markup"
 *   rate          target margin % or markup %, depending on method
 *   wholesalePct  discount off the retail price for wholesale buyers
 *   affiliatePct  affiliate commission, % of the selling price
 *   platformPct   platform fee, % of the selling price
 *   fixedFee      fixed platform fee per sale (RM)
 * @returns {object} { possible: false } if no price can reach the target,
 *   otherwise every result (see the return statement below).
 */
function calculateSmartPrice(input) {
  const affiliate = input.affiliatePct / 100; // 10% -> 0.10
  const platform = input.platformPct / 100;

  let price;
  if (input.method === "margin") {
    // We want: price - cost - fees = margin x price.
    // Fees = (affiliate + platform) x price + fixedFee. Rearranged:
    //   price = (cost + fixedFee) / (1 - affiliate - platform - margin)
    const keep = 1 - affiliate - platform - input.rate / 100;
    if (keep <= 0) {
      return { possible: false }; // fees + margin take 100% or more of the price
    }
    price = roundToSen((input.cost + input.fixedFee) / keep, "up");
  } else {
    price = roundToSen(input.cost * (1 + input.rate / 100));
  }

  // From here on, everything uses the rounded price the customer pays
  const affiliateFee = price * affiliate;
  const platformFees = price * platform + input.fixedFee;
  const grossProfit = price - input.cost;
  const netProfit = grossProfit - affiliateFee - platformFees;

  // Lowest price with no loss: where net profit = 0
  const feeShare = 1 - affiliate - platform;
  const minPrice = feeShare > 0 ? roundToSen((input.cost + input.fixedFee) / feeShare, "up") : null;

  // Wholesale: sold directly, so no affiliate or platform fees
  const wholesalePrice = roundToSen(price * (1 - input.wholesalePct / 100));
  const wholesaleProfit = wholesalePrice - input.cost;

  // Percentages; null where we would divide by zero
  const percentOf = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

  return {
    possible: true,
    price,
    markupPercent: percentOf(grossProfit, input.cost),
    grossMarginPercent: percentOf(grossProfit, price),
    grossProfit,
    affiliateFee,
    platformFees,
    netProfit,
    netMarginPercent: percentOf(netProfit, price),
    minPrice,
    wholesalePrice,
    wholesaleProfit,
    wholesaleMarginPercent: percentOf(wholesaleProfit, wholesalePrice),
  };
}

/**
 * How many units must be sold to earn back the startup capital?
 * Returns null if each sale makes no profit (you would never break even).
 */
function calculateBreakEvenUnits(capital, netProfitPerUnit) {
  if (Math.round(netProfitPerUnit * 100) <= 0) return null;
  // Round UP: selling 99.2 units isn't possible, you need the 100th
  return Math.ceil(capital / netProfitPerUnit - 0.000001);
}

// ---------- 2. Reading and validating inputs ----------

/**
 * Reads one input box and checks it.
 * Returns { value, error }:
 *   value = the number, or null if the box is empty or invalid
 *   error = a message to show the user, or "" if everything is fine
 */
function readField(id, { wholeNumber = false, min = 0, max = CONFIG.maxAmount } = {}) {
  const input = document.getElementById(id);
  const raw = input.value.trim();

  // badInput = the browser saw text it can't turn into a number (e.g. "1..2")
  if (input.validity.badInput) {
    return { value: null, error: "Please enter a valid number." };
  }
  if (raw === "") {
    return { value: null, error: "" }; // empty is allowed; the caller decides what it means
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return { value: null, error: "Please enter a valid number." };
  }
  if (value < 0) {
    return { value: null, error: "Cannot be negative." };
  }
  if (value < min) {
    return { value: null, error: `Must be at least ${min}.` };
  }
  if (wholeNumber && !Number.isInteger(value)) {
    return { value: null, error: "Must be a whole number." };
  }
  if (value > max) {
    return {
      value: null,
      error: max === CONFIG.maxAmount ? "That number is too large." : `Cannot be more than ${max}.`,
    };
  }
  return { value, error: "" };
}

/**
 * Shows or clears the error message under one field.
 */
function showFieldError(id, message) {
  document.getElementById(`${id}-error`).textContent = message;
  // closest() finds the nearest parent with class "field"
  document.getElementById(id).closest(".field").classList.toggle("invalid", message !== "");
}

// ---------- 3. Updating the page ----------

function setOutput(id, text) {
  document.getElementById(id).textContent = text;
}

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

/**
 * Reads all Product Cost inputs, validates them, calculates, and writes
 * the results (or "—" where we can't calculate yet).
 * Returns an object with two parts, so other sections can use them:
 *   costPerUnit  number, or null if costs/quantity aren't ready yet
 *   pricing      the full results (selling price, profit...), or null
 *                if there's no markup yet. Used by the Affiliate section.
 */
function updateProductCost() {
  // Read and validate all fields
  const costResults = COST_FIELDS.map((id) => readField(id));
  const quantityResult = readField("quantity", { wholeNumber: true, min: 1 });
  const markupResult = readField("markup");

  // Show or clear each field's error message
  COST_FIELDS.forEach((id, i) => showFieldError(id, costResults[i].error));
  showFieldError("quantity", quantityResult.error);
  showFieldError("markup", markupResult.error);

  // Start with every result showing "—", then fill in what we can
  ["out-total", "out-unit-cost", "out-price", "out-profit", "out-margin"]
    .forEach((id) => setOutput(id, "—"));

  const hasError =
    costResults.some((r) => r.error) || quantityResult.error || markupResult.error;
  if (hasError) {
    setStatus("Please fix the highlighted fields.", true);
    return { costPerUnit: null, pricing: null };
  }

  // Empty cost fields count as RM 0
  const costs = costResults.map((r) => r.value ?? 0);
  const anyCostEntered = costResults.some((r) => r.value !== null);
  if (!anyCostEntered) {
    setStatus("Start by entering your costs.");
    return { costPerUnit: null, pricing: null };
  }

  // We can always show the total once any cost is entered
  const totalCost = costs.reduce((sum, cost) => sum + cost, 0);
  setOutput("out-total", formatMoney(totalCost));

  if (quantityResult.value === null) {
    setStatus("Enter the production quantity to see per-unit results.");
    return { costPerUnit: null, pricing: null };
  }

  // Without a markup we can still show cost per unit
  const markup = markupResult.value ?? 0;
  const r = calculateProductCost(costs, quantityResult.value, markup);
  setOutput("out-unit-cost", formatMoney(r.costPerUnit));

  if (markupResult.value === null) {
    setStatus("Enter a markup % to see selling price and profit.");
    return { costPerUnit: r.costPerUnit, pricing: null };
  }

  setOutput("out-price", formatMoney(r.sellingPrice));
  setOutput("out-profit", formatMoney(r.grossProfit));
  setOutput("out-margin", r.marginPercent === null ? "—" : formatPercent(r.marginPercent));
  setStatus(
    r.marginPercent === null
      ? "All costs are zero, so there is no margin to calculate."
      : "Results update automatically as you type."
  );
  // "..." copies all fields of r into the new object
  return { costPerUnit: r.costPerUnit, pricing: { ...r, quantity: quantityResult.value } };
}

/**
 * Updates the Affiliate Commission section.
 * @param {object|null} product  results from updateProductCost()
 * Returns the affiliate results, or null if they can't be worked out yet.
 */
function updateAffiliate(product) {
  const rateResult = readField("commission", { max: 100 });
  showFieldError("commission", rateResult.error);

  // Reset outputs, loss styling and warning, then fill in what we can
  const outputs = ["out-commission", "out-commission-total", "out-net-profit", "out-net-margin"];
  outputs.forEach((id) => {
    setOutput(id, "—");
    document.getElementById(id).classList.remove("is-loss");
  });
  const warning = document.getElementById("loss-warning");
  warning.hidden = true;

  const status = document.getElementById("affiliate-status");
  const say = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  };

  if (rateResult.error) {
    say("Please fix the commission rate.", true);
    return null;
  }
  if (product === null) {
    say("Complete the Product Cost calculator first (costs, quantity and markup).");
    return null;
  }
  if (rateResult.value === null) {
    say("Enter a commission rate to see your take-home profit.");
    return null;
  }

  const a = calculateAffiliate(product.sellingPrice, product.grossProfit, rateResult.value);

  setOutput("out-commission", formatMoney(a.commission));
  setOutput("out-commission-total", formatMoney(a.commission * product.quantity));
  setOutput("out-net-profit", formatMoney(a.netProfit));
  setOutput("out-net-margin", a.netMarginPercent === null ? "—" : formatPercent(a.netMarginPercent));

  if (a.isLoss) {
    // Turn the profit figures red and explain the problem
    document.getElementById("out-net-profit").classList.add("is-loss");
    document.getElementById("out-net-margin").classList.add("is-loss");
    // The highest safe commission rate equals the current profit margin
    const maxSafeRate = product.marginPercent ?? 0;
    // Build the message with createElement + textContent (never raw HTML strings):
    // it's safer and keeps the text exactly as written.
    const title = document.createElement("strong");
    title.textContent = "⚠ This sale makes a loss.";
    const detail = document.createElement("p");
    detail.textContent =
      `The commission (${formatMoney(a.commission)}) is more than your gross profit ` +
      `(${formatMoney(product.grossProfit)}), so you lose ${formatMoney(Math.abs(a.netProfit))} ` +
      `on every unit sold. Keep the commission at or below ${formatPercent(maxSafeRate)}, ` +
      `or increase your markup.`;
    warning.replaceChildren(title, detail); // swap in the new message
    warning.hidden = false;
    say("Commission is higher than your profit.", true);
  } else if (a.isBreakEven) {
    say("Break-even: the commission uses up all of your profit.");
  } else {
    say("Results update automatically as you type.");
  }
  return a;
}

/**
 * Updates the Business Capital section.
 * It doesn't depend on the other calculators: startup capital is
 * money for the whole business, not for one product.
 * Returns the total startup capital (used for break-even), or null.
 */
function updateCapital() {
  const results = CAPITAL_FIELDS.map((field) => readField(field.id));
  CAPITAL_FIELDS.forEach((field, i) => showFieldError(field.id, results[i].error));

  // Reset outputs first
  setOutput("out-capital-total", "—");
  setOutput("out-capital-largest", "—");
  const list = document.getElementById("capital-breakdown");
  list.replaceChildren(); // removes all old rows

  const status = document.getElementById("capital-status");
  const say = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  };

  if (results.some((r) => r.error)) {
    say("Please fix the highlighted fields.", true);
    return null;
  }
  if (results.every((r) => r.value === null)) {
    say("Start by entering your startup costs.");
    return null;
  }

  // Empty fields count as RM 0
  const items = CAPITAL_FIELDS.map((field, i) => ({
    label: field.label,
    amount: results[i].value ?? 0,
  }));
  const capital = calculateCapital(items);

  setOutput("out-capital-total", formatMoney(capital.total));

  if (capital.largest === null) {
    say("All amounts are zero.");
    return 0;
  }
  setOutput("out-capital-largest", capital.largest.label);

  // One row per category that has money in it:
  // label + amount (share %) on top, a progress bar below.
  capital.items
    .filter((item) => item.amount > 0)
    .forEach((item) => {
      const row = document.createElement("li");

      const label = document.createElement("div");
      label.className = "breakdown-label";
      const name = document.createElement("span");
      name.textContent = item.label;
      const amount = document.createElement("span");
      amount.textContent = `${formatMoney(item.amount)} (${formatPercent(item.percent)})`;
      label.append(name, amount);

      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = `${item.percent}%`; // the bar's length = its share
      bar.append(fill);

      row.append(label, bar);
      list.append(row);
    });

  say("Results update automatically as you type.");
  return capital.total;
}

/**
 * Updates the Smart Selling Price section.
 * @param {number|null} linkedCost    cost per unit from Product Cost
 * @param {number|null} capitalTotal  startup capital from Business Capital
 * Returns the smart pricing results (plus cost and break-even units), or null.
 */
function updateSmartPrice(linkedCost, capitalTotal) {
  const costInput = document.getElementById("sp-cost");
  const note = document.getElementById("sp-cost-note");
  const relink = document.getElementById("sp-relink");

  // 1. Linked mode: copy the Product Cost value into the box.
  //    toFixed(2) shows it in RM and sen, e.g. 5.416666 -> "5.42".
  //    We then calculate with exactly the value the user can see.
  if (!spCostManual) {
    costInput.value = linkedCost === null ? "" : linkedCost.toFixed(2);
    note.textContent = linkedCost === null
      ? "Linked to Product Cost: fill it in above, or type a cost here."
      : "Linked to Product Cost (cost per unit).";
    note.classList.remove("is-manual");
    relink.hidden = true;
  } else {
    note.textContent = "Typed by hand (not linked).";
    note.classList.add("is-manual");
    relink.textContent = linkedCost === null
      ? "Link to Product Cost"
      : `Use Product Cost (${formatMoney(linkedCost)})`;
    relink.hidden = false;
  }

  // 2. The pricing method changes the label and the rules for the rate
  const method = document.querySelector('input[name="sp-method"]:checked').value;
  document.getElementById("sp-rate-label").textContent =
    method === "margin" ? "Target profit margin (after fees)" : "Markup on cost";

  // 3. Read and validate
  const fields = {
    cost: readField("sp-cost"),
    // A margin can never reach 100% (that would need an infinite price)
    rate: readField("sp-rate", method === "margin" ? { max: 99.99 } : {}),
    wholesale: readField("sp-wholesale", { max: 100 }),
    affiliate: readField("sp-affiliate", { max: 100 }),
    platform: readField("sp-platform", { max: 100 }),
    fixedFee: readField("sp-fixed-fee"),
  };
  showFieldError("sp-cost", fields.cost.error);
  showFieldError("sp-rate", fields.rate.error);
  showFieldError("sp-wholesale", fields.wholesale.error);
  showFieldError("sp-affiliate", fields.affiliate.error);
  showFieldError("sp-platform", fields.platform.error);
  showFieldError("sp-fixed-fee", fields.fixedFee.error);

  // 4. Reset every output, the red styling and the warning
  const outputIds = [
    "out-sp-price", "out-sp-ratio", "out-sp-gross", "out-sp-affiliate", "out-sp-platform",
    "out-sp-net", "out-sp-net-margin", "out-sp-wholesale", "out-sp-wholesale-profit",
    "out-sp-wholesale-margin", "out-sp-min-price", "out-sp-capital", "out-sp-breakeven",
  ];
  outputIds.forEach((id) => {
    setOutput(id, "—");
    document.getElementById(id).classList.remove("is-loss");
  });
  const warning = document.getElementById("sp-warning");
  warning.hidden = true;
  warning.replaceChildren();

  const status = document.getElementById("sp-status");
  const say = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  };

  // 5. Stop early if something is missing or wrong
  if (Object.values(fields).some((f) => f.error)) {
    say("Please fix the highlighted fields.", true);
    return null;
  }
  if (fields.cost.value === null) {
    say("Enter a product cost to begin.");
    return null;
  }
  if (fields.rate.value === null) {
    say(method === "margin" ? "Enter your target profit margin %." : "Enter your markup %.");
    return null;
  }

  // 6. Calculate (empty optional fields count as 0)
  const r = calculateSmartPrice({
    cost: fields.cost.value,
    method,
    rate: fields.rate.value,
    wholesalePct: fields.wholesale.value ?? 0,
    affiliatePct: fields.affiliate.value ?? 0,
    platformPct: fields.platform.value ?? 0,
    fixedFee: fields.fixedFee.value ?? 0,
  });

  if (!r.possible) {
    const total = fields.rate.value + (fields.affiliate.value ?? 0) + (fields.platform.value ?? 0);
    say(`Margin + fees add up to ${formatPercent(total)}. They must stay below 100%, ` +
        "or no price can reach your target. Lower the margin or the fees.", true);
    return null;
  }

  // 7. Show the results
  const pct = (value) => (value === null ? "—" : formatPercent(value));
  setOutput("out-sp-price", formatMoney(r.price));
  setOutput("out-sp-ratio", `${pct(r.markupPercent)} markup · ${pct(r.grossMarginPercent)} gross margin`);
  setOutput("out-sp-gross", formatMoney(r.grossProfit));
  setOutput("out-sp-affiliate", formatMoney(r.affiliateFee));
  setOutput("out-sp-platform", formatMoney(r.platformFees));
  setOutput("out-sp-net", formatMoney(r.netProfit));
  setOutput("out-sp-net-margin", pct(r.netMarginPercent));
  setOutput("out-sp-wholesale", formatMoney(r.wholesalePrice));
  setOutput("out-sp-wholesale-profit", formatMoney(r.wholesaleProfit));
  setOutput("out-sp-wholesale-margin", pct(r.wholesaleMarginPercent));
  setOutput("out-sp-min-price", r.minPrice === null ? "Not possible" : formatMoney(r.minPrice));

  // Break-even uses the startup capital from the Business Capital section
  let units = null;
  if (capitalTotal === null) {
    setOutput("out-sp-breakeven", "Fill in Business Capital");
  } else {
    setOutput("out-sp-capital", formatMoney(capitalTotal));
    units = calculateBreakEvenUnits(capitalTotal, r.netProfit);
    if (units === null) {
      setOutput("out-sp-breakeven", "Never (no profit per sale)");
    } else {
      // toLocaleString adds thousands separators: 1667 -> "1,667"
      setOutput("out-sp-breakeven", `${units.toLocaleString(CONFIG.locale)} units`);
    }
  }

  // 8. Warnings (compare in whole sen to avoid floating-point false alarms)
  const messages = [];
  if (Math.round(r.netProfit * 100) < 0) {
    ["out-sp-net", "out-sp-net-margin"].forEach((id) =>
      document.getElementById(id).classList.add("is-loss"));
    messages.push([
      "⚠ Retail sales make a loss.",
      `After fees you lose ${formatMoney(Math.abs(r.netProfit))} on every unit. ` +
        (r.minPrice === null
          ? "Your fees take 100% of the price, so lower them."
          : `Charge at least ${formatMoney(r.minPrice)} to avoid a loss.`),
    ]);
  }
  if (Math.round(r.wholesaleProfit * 100) < 0) {
    ["out-sp-wholesale-profit", "out-sp-wholesale-margin"].forEach((id) =>
      document.getElementById(id).classList.add("is-loss"));
    messages.push([
      "⚠ Wholesale price is below cost.",
      `${formatMoney(r.wholesalePrice)} is less than your cost of ${formatMoney(fields.cost.value)}. ` +
        "Lower the wholesale discount.",
    ]);
  }
  messages.forEach(([title, detail]) => {
    const strong = document.createElement("strong");
    strong.textContent = title;
    const p = document.createElement("p");
    p.textContent = detail;
    warning.append(strong, p);
  });
  warning.hidden = messages.length === 0;

  say(messages.length > 0 ? "Check the warnings above." : "Results update automatically as you type.",
      messages.length > 0);
  return { ...r, cost: fields.cost.value, breakEvenUnits: units };
}

// ---------- 4. Saving and restoring inputs (localStorage) ----------

/**
 * Saves every input's current text to localStorage.
 * Returns true if it worked, false if the browser blocked it.
 */
function saveInputs() {
  // localStorage can only store text, so we convert the object to a
  // JSON string. It can throw an error (private mode, storage full),
  // so we "try" it and "catch" the error instead of crashing.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectInputs()));
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Puts previously saved values back into the inputs.
 * Anything missing, damaged or unexpected is simply ignored.
 */
function restoreInputs() {
  let saved;
  try {
    const text = localStorage.getItem(STORAGE_KEY); // null if nothing saved yet
    if (text === null) return;
    saved = JSON.parse(text);                       // text -> object
  } catch (error) {
    return; // storage blocked or data damaged: start with an empty form
  }

  // Make sure we got an object, not e.g. a number or a list
  if (!isPlainObject(saved)) return;
  applyInputs(saved);
}

/**
 * Reads every calculator input into a plain object, e.g.
 * { materials: "500", packaging: "", ..., "sp-method": "margin" }.
 * Used by auto-save AND by Business Records.
 */
function collectInputs() {
  const values = {};
  SAVED_FIELDS.forEach((id) => {
    values[id] = document.getElementById(id).value;
  });
  // Two extra settings that aren't plain text boxes (stored as text too)
  values["sp-method"] = document.querySelector('input[name="sp-method"]:checked').value;
  values["sp-cost-manual"] = String(spCostManual); // true -> "true"
  return values;
}

/**
 * Writes an object made by collectInputs() back into the calculators.
 * Missing or unexpected values become empty / default.
 * We never trust stored data blindly.
 */
function applyInputs(values) {
  SAVED_FIELDS.forEach((id) => {
    document.getElementById(id).value = typeof values[id] === "string" ? values[id] : "";
  });
  // Only accept the exact values we expect for the two extra settings
  const method = values["sp-method"] === "markup" ? "markup" : "margin";
  document.querySelector(`input[name="sp-method"][value="${method}"]`).checked = true;
  spCostManual = values["sp-cost-manual"] === "true";
}

/**
 * True for a normal {...} object (not null, not a list, not a number).
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deletes the saved data.
 */
function clearSavedInputs() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    // Nothing to do: if storage is blocked, nothing was saved anyway
  }
}

/**
 * Updates the message in the toolbar.
 */
function showSaveStatus(isWorking) {
  document.getElementById("save-status").classList.toggle("is-off", !isWorking);
  document.getElementById("save-status-text").textContent = isWorking
    ? "Your inputs are saved on this device automatically."
    : "Saving is turned off in this browser. Your inputs will be lost when you leave.";
}

/**
 * Refreshes every calculator, in order, passing results along:
 *   Product Cost  -> Affiliate (selling price, profit)
 *   Product Cost  -> Smart Pricing (cost per unit)
 *   Capital       -> Smart Pricing (startup capital for break-even)
 */
function updateAll() {
  const product = updateProductCost();
  const affiliate = updateAffiliate(product.pricing);
  const capitalTotal = updateCapital();
  const smart = updateSmartPrice(product.costPerUnit, capitalTotal);

  // A "snapshot" of the key numbers, saved inside Business Records.
  // "?." (optional chaining) gives undefined instead of crashing when the
  // thing on the left is null; "?? null" then turns that into null.
  return {
    totalCost: product.pricing?.totalCost ?? null,
    costPerUnit: product.costPerUnit,
    sellingPrice: product.pricing?.sellingPrice ?? null,
    grossProfit: product.pricing?.grossProfit ?? null,
    marginPercent: product.pricing?.marginPercent ?? null,
    commissionPerUnit: affiliate?.commission ?? null,
    netProfit: affiliate?.netProfit ?? null,
    netMarginPercent: affiliate?.netMarginPercent ?? null,
    capitalTotal,
    smartCost: smart?.cost ?? null,
    smartPrice: smart?.price ?? null,
    smartNetProfit: smart?.netProfit ?? null,
    smartNetMarginPercent: smart?.netMarginPercent ?? null,
    wholesalePrice: smart?.wholesalePrice ?? null,
    breakEvenUnits: smart?.breakEvenUnits ?? null,
  };
}

// ---------- 5. Business Records (localStorage) ----------

// Records live under their OWN key, separate from the auto-saved inputs,
// so "Clear all" (which deletes STORAGE_KEY) never touches them.
const RECORDS_KEY = "qhaze-records-v1";
const MAX_NAME_LENGTH = 100;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB: far more than any real backup

// Labels and formats used by "View" to describe a record.
// Each entry: [key, label, kind]. kind decides how the value is shown.
const INPUT_INFO = [
  ["materials", "Raw materials cost", "money"],
  ["packaging", "Packaging cost", "money"],
  ["shipping", "Shipping cost", "money"],
  ["labour", "Labour cost", "money"],
  ["other", "Other expenses", "money"],
  ["quantity", "Production quantity", "units"],
  ["markup", "Markup", "percent"],
  ["commission", "Affiliate commission rate", "percent"],
  ...CAPITAL_FIELDS.map((field) => [field.id, field.label, "money"]),
  ["sp-cost", "Smart pricing: cost per unit", "money"],
  ["sp-rate", "Smart pricing: margin / markup", "percent"],
  ["sp-wholesale", "Wholesale discount", "percent"],
  ["sp-affiliate", "Smart pricing: affiliate", "percent"],
  ["sp-platform", "Platform fee", "percent"],
  ["sp-fixed-fee", "Fixed fee per sale", "money"],
];
const RESULT_INFO = [
  ["totalCost", "Total production cost", "money"],
  ["costPerUnit", "Cost per unit", "money"],
  ["sellingPrice", "Selling price (markup)", "money"],
  ["grossProfit", "Gross profit per unit", "money"],
  ["marginPercent", "Profit margin", "percent"],
  ["commissionPerUnit", "Affiliate commission per unit", "money"],
  ["netProfit", "Net profit after commission", "money"],
  ["netMarginPercent", "Net margin after commission", "percent"],
  ["capitalTotal", "Total startup capital", "money"],
  ["smartCost", "Smart pricing cost per unit", "money"],
  ["smartPrice", "Smart retail price", "money"],
  ["smartNetProfit", "Smart net profit per unit", "money"],
  ["smartNetMarginPercent", "Smart net margin", "percent"],
  ["wholesalePrice", "Wholesale price", "money"],
  ["breakEvenUnits", "Units to break even", "units"],
];

// The app's records, kept in memory while the page is open.
let records = [];
let editingId = null;            // id of the record being edited, or null
const openDetails = new Set();   // ids whose "View" panel is open

/**
 * Formats one stored value for display, based on its kind.
 */
function formatValue(value, kind) {
  const n = Number(value);
  if (kind === "money") return formatMoney(n);
  if (kind === "percent") return formatPercent(n);
  return `${n.toLocaleString(CONFIG.locale)} units`;
}

/**
 * A unique id for a new record. crypto.randomUUID() is built into modern
 * browsers; the fallback covers older ones.
 */
function makeId() {
  if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Tidies a name: must be text, spaces trimmed, 1-100 characters.
 * Returns the cleaned name, or null if it isn't acceptable.
 */
function cleanName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

/**
 * Checks one record (from storage OR an imported file) and returns a clean
 * copy containing only what we expect, or null if it's unusable.
 * This is our defence against damaged or tampered data.
 */
function cleanRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const productName = cleanName(raw.productName);
  const businessName = cleanName(raw.businessName);
  if (productName === null || businessName === null) return null;

  // Inputs: only known keys, only short text values
  const inputs = {};
  const rawInputs = isPlainObject(raw.inputs) ? raw.inputs : {};
  [...SAVED_FIELDS, "sp-method", "sp-cost-manual"].forEach((key) => {
    const value = rawInputs[key];
    if (typeof value === "string" && value.length <= 50) inputs[key] = value;
  });

  // Results: only known keys, only real numbers (or null)
  const results = {};
  const rawResults = isPlainObject(raw.results) ? raw.results : {};
  RESULT_INFO.forEach(([key]) => {
    const value = rawResults[key];
    results[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
  });

  const validDate = (value) =>
    typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
  const id = typeof raw.id === "string" && raw.id.length > 0 && raw.id.length <= 100 ? raw.id : makeId();

  return {
    id,
    productName,
    businessName,
    createdAt: validDate(raw.createdAt),
    updatedAt: validDate(raw.updatedAt),
    inputs,
    results,
  };
}

/**
 * Reads records from localStorage. Bad entries are skipped.
 */
function loadRecords() {
  try {
    const text = localStorage.getItem(RECORDS_KEY);
    if (text === null) return [];
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    // map() cleans each one; filter() drops the ones that came back null
    return data.map(cleanRecord).filter((record) => record !== null);
  } catch (error) {
    return [];
  }
}

/**
 * Writes all records to localStorage. Returns true if it worked.
 */
function saveRecords() {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Shows a message under the records toolbar.
 */
function recordsMessage(message, isError = false) {
  const status = document.getElementById("records-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

/**
 * Called after EVERY change to the records (save, edit, delete, import):
 * refreshes the dashboard, saves, and reports a problem if storage failed.
 * Returns true if saved.
 */
function persistRecords(successMessage) {
  renderDashboard(); // the records changed, so the dashboard must too
  if (saveRecords()) {
    recordsMessage(successMessage);
    return true;
  }
  recordsMessage("Couldn't save to this browser's storage (blocked or full). " +
    "Your change is kept until you close the page. Use Export backup to keep a copy.", true);
  return false;
}

/**
 * Case-insensitive "same name" check, ignoring spaces at the ends.
 */
function sameName(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Finds another record with the same product AND business name.
 */
function findDuplicate(productName, businessName, ignoreId = null) {
  return records.find((record) =>
    record.id !== ignoreId &&
    sameName(record.productName, productName) &&
    sameName(record.businessName, businessName));
}

/**
 * If a business with this name already exists (ignoring capital letters),
 * returns its existing spelling, so "qhaze beauty" becomes "QHAZE Beauty"
 * and each business keeps one consistent name.
 */
function matchBusinessSpelling(name, ignoreId = null) {
  const existing = records.find((r) => r.id !== ignoreId && sameName(r.businessName, name));
  return existing ? existing.businessName : name;
}

/**
 * "Save as record": stores the current calculator inputs and results.
 */
function saveCurrentAsRecord() {
  const productName = cleanName(document.getElementById("record-product").value);
  let businessName = cleanName(document.getElementById("record-business").value);
  showFieldError("record-product", productName === null ? "Enter a product name." : "");
  showFieldError("record-business", businessName === null ? "Enter a business name." : "");
  if (productName === null || businessName === null) return;
  businessName = matchBusinessSpelling(businessName);

  const inputs = collectInputs();
  // Is there anything to save? (any calculator box filled in)
  if (SAVED_FIELDS.every((id) => inputs[id].trim() === "")) {
    recordsMessage("Fill in at least one calculator before saving a record.", true);
    return;
  }
  const duplicate = findDuplicate(productName, businessName);
  if (duplicate) {
    recordsMessage(`"${duplicate.productName}" already exists in ${duplicate.businessName}. ` +
      "Use a different name, or use Edit on that record to update it.", true);
    return;
  }

  const now = new Date().toISOString();
  records.push({
    id: makeId(),
    productName,
    businessName,
    createdAt: now,
    updatedAt: now,
    inputs,
    results: updateAll(), // recalculate and take the snapshot
  });
  persistRecords(`Saved "${productName}" in ${businessName}.`);
  document.getElementById("record-product").value = "";
  renderRecords();
}

/**
 * Puts a record's inputs back into the calculators.
 */
function loadRecord(id) {
  const record = records.find((r) => r.id === id);
  if (!record) return;
  applyInputs(record.inputs);
  updateAll();                       // recalculate from the loaded inputs
  showSaveStatus(saveInputs());      // and auto-save them as usual
  recordsMessage(`Loaded "${record.productName}" into the calculators.`);
  document.getElementById("product-cost").scrollIntoView();
}

/**
 * Deletes a record after the user confirms.
 */
function deleteRecord(id) {
  const record = records.find((r) => r.id === id);
  if (!record) return;
  // confirm() shows the browser's OK / Cancel box and returns true or false
  const ok = window.confirm(`Delete "${record.productName}" from ${record.businessName}? This can't be undone.`);
  if (!ok) return;
  records = records.filter((r) => r.id !== id);
  openDetails.delete(id);
  if (editingId === id) editingId = null;
  persistRecords(`Deleted "${record.productName}".`);
  renderRecords();
}

/**
 * Saves the inline Edit form: rename and/or replace the numbers.
 */
function saveEdit(id, form) {
  const record = records.find((r) => r.id === id);
  if (!record) return;
  const productName = cleanName(form.querySelector('[name="productName"]').value);
  let businessName = cleanName(form.querySelector('[name="businessName"]').value);
  const replaceNumbers = form.querySelector('[name="replace"]').checked;
  const error = form.querySelector(".error");

  if (productName === null || businessName === null) {
    error.textContent = "Product and business names can't be empty.";
    return;
  }
  businessName = matchBusinessSpelling(businessName, id);
  if (findDuplicate(productName, businessName, id)) {
    error.textContent = `Another record is already called "${productName}" in ${businessName}.`;
    return;
  }

  record.productName = productName;
  record.businessName = businessName;
  if (replaceNumbers) {
    record.inputs = collectInputs();
    record.results = updateAll();
  }
  record.updatedAt = new Date().toISOString();
  editingId = null;
  persistRecords(replaceNumbers
    ? `Updated "${productName}" with the current calculator values.`
    : `Renamed to "${productName}" in ${businessName}.`);
  renderRecords();
}

/**
 * Small helper: create an element with a class and text in one line.
 */
function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text; // textContent: names can never run as code
  return node;
}

function smallButton(text, action, id, extraClass = "") {
  const button = el("button", `btn-secondary btn-small ${extraClass}`.trim(), text);
  button.type = "button";
  // data-* attributes store which action and which record this button is for
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

/**
 * Builds the "View" panel: saved inputs and results.
 */
function buildDetails(record) {
  const panel = el("div", "record-details");
  panel.hidden = !openDetails.has(record.id);

  const makeGroup = (title, rows) => {
    const group = el("div");
    group.append(el("h4", "results-subhead", title));
    const list = el("dl", "result-list");
    rows.forEach(([label, value]) => {
      const row = el("div", "result-row");
      row.append(el("dt", "", label), el("dd", "dd-text", value));
      list.append(row);
    });
    if (rows.length === 0) list.append(el("p", "record-meta", "Nothing entered."));
    group.append(list);
    return group;
  };

  // Only show inputs that were filled in, and only valid numbers
  const inputRows = INPUT_INFO
    .filter(([key]) => (record.inputs[key] ?? "").trim() !== "" && Number.isFinite(Number(record.inputs[key])))
    .map(([key, label, kind]) => [label, formatValue(record.inputs[key], kind)]);
  if ((record.inputs["sp-rate"] ?? "").trim() !== "") {
    inputRows.push(["Smart pricing method", record.inputs["sp-method"] === "markup" ? "Markup" : "Target margin"]);
  }
  const resultRows = RESULT_INFO
    .filter(([key]) => record.results[key] !== null)
    .map(([key, label, kind]) => [label, formatValue(record.results[key], kind)]);

  panel.append(makeGroup("Saved inputs", inputRows), makeGroup("Saved results", resultRows));
  return panel;
}

/**
 * Builds the inline Edit form for one record.
 */
function buildEditForm(record) {
  const form = el("form", "record-edit");
  form.dataset.id = record.id;
  form.noValidate = true;

  const grid = el("div", "field-grid");
  [["productName", "Product name", record.productName],
   ["businessName", "Business name", record.businessName]].forEach(([name, label, value]) => {
    const field = el("div", "field");
    const inputId = `edit-${name}`;
    const labelEl = el("label", "", label);
    labelEl.htmlFor = inputId;
    const wrap = el("div", "input-wrap");
    const input = el("input");
    input.id = inputId;
    input.name = name;
    input.type = "text";
    input.maxLength = MAX_NAME_LENGTH;
    input.value = value;
    if (name === "businessName") input.setAttribute("list", "business-suggestions");
    wrap.append(input);
    field.append(labelEl, wrap);
    grid.append(field);
  });

  const checkLabel = el("label", "checkbox-row");
  const checkbox = el("input");
  checkbox.type = "checkbox";
  checkbox.name = "replace";
  checkLabel.append(checkbox, el("span", "", "Also replace the saved numbers with the values in the calculators right now"));

  const buttons = el("div", "record-buttons");
  const save = el("button", "btn-primary btn-small", "Save changes");
  save.type = "submit";
  buttons.append(save, smallButton("Cancel", "cancel-edit", record.id));

  form.append(grid, checkLabel, el("p", "error"), buttons);
  return form;
}

/**
 * Builds one record row (name, summary, buttons, details, edit form).
 */
function buildRecord(record) {
  const item = el("li", "record");
  item.dataset.id = record.id;

  const main = el("div", "record-main");
  const info = el("div", "record-info");
  info.append(el("p", "record-name", record.productName));

  // Short summary: date + cost and price if we have them
  const date = new Date(record.updatedAt).toLocaleDateString(CONFIG.locale,
    { day: "numeric", month: "short", year: "numeric" });
  const parts = [`Saved ${date}`];
  const cost = record.results.costPerUnit ?? record.results.smartCost;
  const price = record.results.smartPrice ?? record.results.sellingPrice;
  if (cost !== null) parts.push(`Cost/unit ${formatMoney(cost)}`);
  if (price !== null) parts.push(`Price ${formatMoney(price)}`);
  info.append(el("p", "record-meta", parts.join(" · ")));

  const buttons = el("div", "record-buttons");
  const isOpen = openDetails.has(record.id);
  const view = smallButton(isOpen ? "Hide" : "View", "view", record.id);
  view.setAttribute("aria-expanded", String(isOpen));
  buttons.append(
    smallButton("Load", "load", record.id),
    view,
    smallButton("Edit", "edit", record.id),
    smallButton("Delete", "delete", record.id, "btn-danger"),
  );
  main.append(info, buttons);
  item.append(main, buildDetails(record));
  if (editingId === record.id) item.append(buildEditForm(record));
  return item;
}

/**
 * Redraws the whole records list: filter by search, group by business.
 */
function renderRecords() {
  const list = document.getElementById("records-list");
  list.replaceChildren();

  // Business name suggestions for the save and edit forms
  const businesses = [...new Set(records.map((r) => r.businessName))]
    .sort((a, b) => a.localeCompare(b));
  const datalist = document.getElementById("business-suggestions");
  datalist.replaceChildren(...businesses.map((name) => {
    const option = el("option");
    option.value = name;
    return option;
  }));

  if (records.length === 0) {
    list.append(el("p", "records-empty", "No saved records yet. Fill in the calculators, then save your first product above."));
    return;
  }

  // Search: keep records whose product OR business name contains the text
  const query = document.getElementById("record-search").value.trim().toLowerCase();
  const matches = records.filter((r) =>
    r.productName.toLowerCase().includes(query) || r.businessName.toLowerCase().includes(query));

  if (matches.length === 0) {
    list.append(el("p", "records-empty", `No records match "${query}".`));
    return;
  }

  // Group: { "QHAZE Beauty": [record, record], "Other Co": [record] }
  const groups = {};
  matches.forEach((record) => {
    // Group names ignore capital letters, so "qhaze" and "QHAZE" go together
    const key = record.businessName.toLowerCase();
    if (!groups[key]) groups[key] = [];
    groups[key].push(record);
  });

  Object.keys(groups).sort().forEach((key) => {
    const groupRecords = groups[key].sort((a, b) => a.productName.localeCompare(b.productName));
    const section = el("section", "record-group");
    const title = el("h3", "record-group-title", groupRecords[0].businessName);
    const count = groupRecords.length;
    title.append(el("span", "record-count", `${count} ${count === 1 ? "product" : "products"}`));
    const ul = el("ul", "record-list");
    groupRecords.forEach((record) => ul.append(buildRecord(record)));
    section.append(title, ul);
    list.append(section);
  });
}

// ---------- 6. Backup: export and import (JSON files) ----------

/**
 * Downloads all records as a .json file.
 */
function exportRecords() {
  if (records.length === 0) {
    recordsMessage("There are no records to export yet.", true);
    return;
  }
  const backup = {
    app: "qhaze-business-calculator",
    version: 1,
    exportedAt: new Date().toISOString(),
    records,
  };
  // A Blob is file content held in memory; createObjectURL gives it a
  // temporary address that a download link can point to.
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `qhaze-records-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();               // start the download
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // free the memory
  const n = records.length;
  recordsMessage(`Exported ${n} ${n === 1 ? "record" : "records"}. Keep the file somewhere safe.`);
}

/**
 * Reads a backup file chosen by the user and merges it into the records.
 * "async" lets us "await" the file being read without freezing the page.
 */
async function importRecords(file) {
  if (file.size > MAX_IMPORT_BYTES) {
    recordsMessage("That file is too large to be a QHAZE backup.", true);
    return;
  }
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (error) {
    recordsMessage("That file isn't a valid backup (it couldn't be read as JSON).", true);
    return;
  }
  if (!isPlainObject(data) || data.app !== "qhaze-business-calculator" || !Array.isArray(data.records)) {
    recordsMessage("That file isn't a QHAZE Business Calculator backup.", true);
    return;
  }

  const cleaned = data.records.map(cleanRecord).filter((record) => record !== null);
  const skipped = data.records.length - cleaned.length;
  if (cleaned.length === 0) {
    recordsMessage("No usable records were found in that backup.", true);
    return;
  }

  const ok = window.confirm(`Import ${cleaned.length} ${cleaned.length === 1 ? "record" : "records"}? ` +
    "Records you already have with the same ID will be replaced by the backup copy. Other records are kept.");
  if (!ok) return;

  // Merge: same id -> replace, new id -> add
  let added = 0;
  let replaced = 0;
  cleaned.forEach((record) => {
    const index = records.findIndex((r) => r.id === record.id);
    if (index === -1) {
      records.push(record);
      added += 1;
    } else {
      records[index] = record;
      replaced += 1;
    }
  });

  let message = `Imported: ${added} added, ${replaced} replaced.`;
  if (skipped > 0) message += ` ${skipped} damaged ${skipped === 1 ? "entry was" : "entries were"} skipped.`;
  persistRecords(message);
  renderRecords();
}

// ---------- 7. Dashboard and reports ----------

// The business shown by the dashboard filter ("" = all businesses).
// Stored in lower case, the same way records are grouped.
let dashboardBusiness = "";

/**
 * Picks ONE consistent set of numbers for a record (never a mix):
 *   1. Smart Pricing, if the record has a smart price
 *   2. otherwise Product Cost markup (net after affiliate commission)
 *   3. otherwise "not priced"
 */
function recordMetrics(record) {
  const r = record.results;
  if (r.smartPrice !== null) {
    return {
      source: "Smart pricing",
      cost: r.smartCost,
      price: r.smartPrice,
      netProfit: r.smartNetProfit,
      netMargin: r.smartNetMarginPercent,
      breakEven: r.breakEvenUnits,
    };
  }
  if (r.sellingPrice !== null) {
    return {
      source: r.netProfit !== null ? "Markup + commission" : "Markup",
      cost: r.costPerUnit,
      price: r.sellingPrice,
      netProfit: r.netProfit ?? r.grossProfit,
      netMargin: r.netMarginPercent ?? r.marginPercent,
      breakEven: null,
    };
  }
  return {
    source: "Not priced",
    cost: r.costPerUnit ?? r.smartCost,
    price: null,
    netProfit: null,
    netMargin: null,
    breakEven: null,
  };
}

/**
 * All dashboard numbers for a list of records. Pure: no page access.
 */
function calculateDashboard(list) {
  // One row per record, sorted by business then product
  const rows = list
    .map((record) => ({ record, ...recordMetrics(record) }))
    .sort((a, b) =>
      a.record.businessName.localeCompare(b.record.businessName) ||
      a.record.productName.localeCompare(b.record.productName));

  const priced = rows.filter((row) => row.netMargin !== null);

  // Simple average: every priced product counts equally
  const averageMargin = priced.length > 0
    ? priced.reduce((sum, row) => sum + row.netMargin, 0) / priced.length
    : null;

  // Best margin (on a tie, the first in A-Z order wins)
  const best = priced.reduce((top, row) => (top === null || row.netMargin > top.netMargin ? row : top), null);

  // Startup capital: ONCE per business, from its most recently updated record.
  // (ISO dates like "2026-11-17T..." sort correctly as plain text.)
  const latestCapital = {};
  rows.forEach((row) => {
    const amount = row.record.results.capitalTotal;
    if (amount === null) return;
    const key = row.record.businessName.toLowerCase();
    const previous = latestCapital[key];
    if (!previous || row.record.updatedAt > previous.updatedAt) {
      latestCapital[key] = { amount, updatedAt: row.record.updatedAt };
    }
  });
  const capitalValues = Object.values(latestCapital).map((c) => c.amount);
  const totalCapital = capitalValues.length > 0 ? capitalValues.reduce((a, b) => a + b, 0) : null;

  // Products that lose money per sale (compared in whole sen)
  const losses = rows.filter((row) => row.netProfit !== null && Math.round(row.netProfit * 100) < 0);

  const businessCount = new Set(rows.map((row) => row.record.businessName.toLowerCase())).size;

  return {
    rows,
    productCount: rows.length,
    businessCount,
    pricedCount: priced.length,
    averageMargin,
    best,
    totalCapital,
    capitalBusinessCount: capitalValues.length,
    losses,
    // Bars: highest margin first
    bars: [...priced].sort((a, b) => b.netMargin - a.netMargin),
  };
}

/**
 * "1 product" / "2 products": picks the right word for the number.
 * Irregular words pass their plural: plural(2, "business", "businesses").
 */
function plural(count, word, pluralWord = `${word}s`) {
  return `${count.toLocaleString(CONFIG.locale)} ${count === 1 ? word : pluralWord}`;
}

/**
 * Fills the business filter dropdown, keeping the current choice if it
 * still exists.
 */
function renderBusinessFilter() {
  const select = document.getElementById("dash-business");
  const names = {};
  records.forEach((r) => { names[r.businessName.toLowerCase()] = r.businessName; });
  const keys = Object.keys(names).sort();

  // If the chosen business no longer has records, go back to "all"
  if (dashboardBusiness !== "" && !keys.includes(dashboardBusiness)) dashboardBusiness = "";

  const all = el("option", "", "All businesses");
  all.value = "";
  select.replaceChildren(all, ...keys.map((key) => {
    const option = el("option", "", names[key]);
    option.value = key;
    return option;
  }));
  select.value = dashboardBusiness;
}

/**
 * The line under the dashboard title, e.g.
 * "Report generated 17 Nov 2026 · All businesses · 3 products".
 */
function updateReportMeta(productCount) {
  const date = new Date().toLocaleDateString(CONFIG.locale, { day: "numeric", month: "short", year: "numeric" });
  const select = document.getElementById("dash-business");
  const scope = dashboardBusiness === "" ? "All businesses" : select.options[select.selectedIndex].textContent;
  document.getElementById("report-meta").textContent =
    `Report generated ${date} · ${scope} · ${plural(productCount, "product")}`;
}

/**
 * Redraws the whole dashboard from the saved records.
 * Called on start-up and after every change to the records.
 */
function renderDashboard() {
  const empty = records.length === 0;
  document.getElementById("dashboard-empty").hidden = !empty;
  document.getElementById("dashboard-content").hidden = empty;
  document.getElementById("dashboard-controls").hidden = empty;
  if (empty) {
    dashboardBusiness = "";
    document.getElementById("report-meta").textContent = "Based on your saved records.";
    return;
  }

  renderBusinessFilter();
  const shown = dashboardBusiness === ""
    ? records
    : records.filter((r) => r.businessName.toLowerCase() === dashboardBusiness);
  const d = calculateDashboard(shown);
  updateReportMeta(d.productCount);

  // ----- KPI cards -----
  setOutput("kpi-products", d.productCount.toLocaleString(CONFIG.locale));
  setOutput("kpi-products-sub", `in ${plural(d.businessCount, "business", "businesses")}`);
  setOutput("kpi-margin", d.averageMargin === null ? "—" : formatPercent(d.averageMargin));
  setOutput("kpi-margin-sub", d.pricedCount === 0
    ? "No priced products yet"
    : `across ${plural(d.pricedCount, "priced product")}`);
  setOutput("kpi-capital", d.totalCapital === null ? "—" : formatMoney(d.totalCapital));
  setOutput("kpi-capital-sub", d.totalCapital === null
    ? "No startup capital saved"
    : `from ${plural(d.capitalBusinessCount, "business", "businesses")}`);
  setOutput("kpi-best", d.best === null ? "—" : d.best.record.productName);
  setOutput("kpi-best-sub", d.best === null
    ? ""
    : `${formatPercent(d.best.netMargin)} net margin · ${d.best.record.businessName}`);

  // ----- Loss alert -----
  const lossBox = document.getElementById("dash-loss");
  lossBox.replaceChildren();
  lossBox.hidden = d.losses.length === 0;
  if (d.losses.length > 0) {
    lossBox.append(
      el("strong", "", `⚠ ${plural(d.losses.length, "product")} ${d.losses.length === 1 ? "loses" : "lose"} money on each sale.`),
      el("p", "", d.losses.map((row) => `${row.record.productName} (${formatMoney(row.netProfit)})`).join(", ")));
  }

  // ----- Margin bars -----
  const bars = document.getElementById("margin-bars");
  bars.replaceChildren();
  if (d.bars.length === 0) {
    bars.append(el("li", "dash-none", "No priced products yet. Add a markup or a smart price before saving a record."));
  }
  d.bars.forEach((row) => {
    const item = el("li");
    const label = el("div", "breakdown-label");
    const name = dashboardBusiness === ""
      ? `${row.record.productName} · ${row.record.businessName}`
      : row.record.productName;
    const value = el("span", row.netMargin < 0 ? "is-loss" : "", formatPercent(row.netMargin));
    label.append(el("span", "", name), value);

    const bar = el("div", "bar");
    const fill = el("div", row.netMargin < 0 ? "bar-fill is-negative" : "bar-fill");
    // Bar length = margin %, kept between 0% and 100% of the track.
    // Negative margins show a red bar sized by how big the loss is.
    fill.style.width = `${Math.min(Math.abs(row.netMargin), 100)}%`;
    bar.append(fill);
    item.append(label, bar);
    bars.append(item);
  });

  // ----- Report table -----
  const body = document.getElementById("report-body");
  body.replaceChildren();
  d.rows.forEach((row) => {
    const tr = el("tr");
    const cell = (label, text, className = "") => {
      const td = el("td", className, text);
      td.dataset.label = label; // used as the label on phones
      return td;
    };
    const productCell = cell("Product", "");
    productCell.append(el("span", "report-product", row.record.productName), el("span", "report-source", row.source));
    const money = (value) => (value === null ? "—" : formatMoney(value));
    const isLoss = row.netProfit !== null && Math.round(row.netProfit * 100) < 0;
    const updated = new Date(row.record.updatedAt).toLocaleDateString(CONFIG.locale,
      { day: "numeric", month: "short", year: "numeric" });

    tr.append(
      productCell,
      cell("Business", row.record.businessName),
      cell("Cost / unit", money(row.cost), "num"),
      cell("Price", money(row.price), "num"),
      cell("Net profit / unit", money(row.netProfit), isLoss ? "num is-loss" : "num"),
      cell("Net margin", row.netMargin === null ? "—" : formatPercent(row.netMargin), isLoss ? "num is-loss" : "num"),
      cell("Break-even", row.breakEven === null ? "—" : plural(row.breakEven, "unit"), "num"),
      cell("Updated", updated),
    );
    body.append(tr);
  });
}

// ---------- Start-up ----------

// Show the active currency in the footer.
document.getElementById("currency-label").textContent =
  `Currency: ${CONFIG.currencySymbol}`;

// One listener on the whole form catches typing in ANY of its inputs.
// The "input" event fires on every keystroke, so results are live.
// Typing in any form: recalculate everything (the affiliate results depend
// on the cost form), then save all inputs.
const costForm = document.getElementById("cost-form");
const affiliateForm = document.getElementById("affiliate-form");
const capitalForm = document.getElementById("capital-form");
const smartForm = document.getElementById("smart-form");

function handleInput(event) {
  // Typing in the Smart Pricing cost box switches it to manual.
  // (Our own code changing the box doesn't fire "input" events,
  // so this only happens when a person types.)
  if (event && event.target.id === "sp-cost") {
    spCostManual = true;
  }
  updateAll();
  showSaveStatus(saveInputs());
}
costForm.addEventListener("input", handleInput);
affiliateForm.addEventListener("input", handleInput);
capitalForm.addEventListener("input", handleInput);
// Radio buttons fire "change" rather than reliably firing "input" everywhere
smartForm.addEventListener("input", handleInput);
smartForm.addEventListener("change", handleInput);

// "Use Product Cost" link: go back to the linked value
document.getElementById("sp-relink").addEventListener("click", () => {
  spCostManual = false;
  updateAll();
  showSaveStatus(saveInputs());
});

// Pressing Enter inside a form would normally reload the page; stop that.
[costForm, affiliateForm, capitalForm, smartForm].forEach((form) =>
  form.addEventListener("submit", (event) => event.preventDefault())
);

// "Clear all" empties every form, deletes the saved data,
// then refreshes the results.
document.getElementById("reset-btn").addEventListener("click", () => {
  costForm.reset();
  affiliateForm.reset();
  capitalForm.reset();
  smartForm.reset();       // also puts the method back to "Target margin"
  spCostManual = false;    // and the cost back to linked
  clearSavedInputs();
  updateAll();
});

// ----- Business Records events -----
document.getElementById("record-form").addEventListener("submit", (event) => {
  event.preventDefault(); // stay on the page
  saveCurrentAsRecord();
});

document.getElementById("record-search").addEventListener("input", renderRecords);

// One click listener for ALL record buttons ("event delegation").
// Each button carries data-action and data-id, so we know what to do.
const recordsList = document.getElementById("records-list");
recordsList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;

  if (action === "load") loadRecord(id);
  if (action === "delete") deleteRecord(id);
  if (action === "view") {
    // A Set can add/delete/has; here we flip the panel open or closed
    if (openDetails.has(id)) openDetails.delete(id); else openDetails.add(id);
    renderRecords();
  }
  if (action === "edit") {
    editingId = id;
    renderRecords();
    document.getElementById("edit-productName").focus();
  }
  if (action === "cancel-edit") {
    editingId = null;
    renderRecords();
  }
});

// The edit form's "Save changes" button submits the form
recordsList.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target.closest("form.record-edit");
  if (form) saveEdit(form.dataset.id, form);
});

// Backup buttons
document.getElementById("export-btn").addEventListener("click", exportRecords);
const importFile = document.getElementById("import-file");
document.getElementById("import-btn").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  if (importFile.files.length > 0) {
    await importRecords(importFile.files[0]);
  }
  importFile.value = ""; // so choosing the same file again still triggers "change"
});

// On page load: put saved values back FIRST, then calculate. The results
// are worked out exactly as if the user had just typed those values.
restoreInputs();
updateAll();

// ----- Dashboard events -----
document.getElementById("dash-business").addEventListener("change", (event) => {
  dashboardBusiness = event.target.value;
  renderDashboard();
});
// window.print() opens the browser's print window, which offers "Save as PDF"
document.getElementById("print-btn").addEventListener("click", () => window.print());
// Refresh the date line just before printing, in case the page was open overnight
window.addEventListener("beforeprint", () => {
  if (records.length > 0) renderDashboard();
});

// Load and show the saved records, then the dashboard built from them
records = loadRecords();
renderRecords();
renderDashboard();
