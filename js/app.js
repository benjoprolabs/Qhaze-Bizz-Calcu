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
    return;
  }
  if (product === null) {
    say("Complete the Product Cost calculator first (costs, quantity and markup).");
    return;
  }
  if (rateResult.value === null) {
    say("Enter a commission rate to see your take-home profit.");
    return;
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
    return;
  }
  if (fields.cost.value === null) {
    say("Enter a product cost to begin.");
    return;
  }
  if (fields.rate.value === null) {
    say(method === "margin" ? "Enter your target profit margin %." : "Enter your markup %.");
    return;
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
    return;
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
  if (capitalTotal === null) {
    setOutput("out-sp-breakeven", "Fill in Business Capital");
  } else {
    setOutput("out-sp-capital", formatMoney(capitalTotal));
    const units = calculateBreakEvenUnits(capitalTotal, r.netProfit);
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
}

// ---------- 4. Saving and restoring inputs (localStorage) ----------

/**
 * Saves every input's current text to localStorage.
 * Returns true if it worked, false if the browser blocked it.
 */
function saveInputs() {
  // Build a plain object like { materials: "500", packaging: "", ... }
  const values = {};
  SAVED_FIELDS.forEach((id) => {
    values[id] = document.getElementById(id).value;
  });
  // Two extra settings that aren't plain text boxes (stored as text too)
  values["sp-method"] = document.querySelector('input[name="sp-method"]:checked').value;
  values["sp-cost-manual"] = String(spCostManual); // true -> "true"

  // localStorage can only store text, so we convert the object to a
  // JSON string. It can throw an error (private mode, storage full),
  // so we "try" it and "catch" the error instead of crashing.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
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
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return;

  // Only restore fields we know about, and only if the value is text.
  // We never trust stored data blindly.
  SAVED_FIELDS.forEach((id) => {
    if (typeof saved[id] === "string") {
      document.getElementById(id).value = saved[id];
    }
  });

  // Only accept the exact values we expect for the two extra settings
  if (saved["sp-method"] === "margin" || saved["sp-method"] === "markup") {
    document.querySelector(`input[name="sp-method"][value="${saved["sp-method"]}"]`).checked = true;
  }
  spCostManual = saved["sp-cost-manual"] === "true";
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
  updateAffiliate(product.pricing);
  const capitalTotal = updateCapital();
  updateSmartPrice(product.costPerUnit, capitalTotal);
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

// On page load: put saved values back FIRST, then calculate. The results
// are worked out exactly as if the user had just typed those values.
restoreInputs();
updateAll();
