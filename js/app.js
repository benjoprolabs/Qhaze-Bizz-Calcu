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
 * Returns the results so the Affiliate section can use them,
 * or null if there isn't a selling price yet.
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
    return null;
  }

  // Empty cost fields count as RM 0
  const costs = costResults.map((r) => r.value ?? 0);
  const anyCostEntered = costResults.some((r) => r.value !== null);
  if (!anyCostEntered) {
    setStatus("Start by entering your costs.");
    return null;
  }

  // We can always show the total once any cost is entered
  const totalCost = costs.reduce((sum, cost) => sum + cost, 0);
  setOutput("out-total", formatMoney(totalCost));

  if (quantityResult.value === null) {
    setStatus("Enter the production quantity to see per-unit results.");
    return null;
  }

  // Without a markup we can still show cost per unit
  const markup = markupResult.value ?? 0;
  const r = calculateProductCost(costs, quantityResult.value, markup);
  setOutput("out-unit-cost", formatMoney(r.costPerUnit));

  if (markupResult.value === null) {
    setStatus("Enter a markup % to see selling price and profit.");
    return null;
  }

  setOutput("out-price", formatMoney(r.sellingPrice));
  setOutput("out-profit", formatMoney(r.grossProfit));
  setOutput("out-margin", r.marginPercent === null ? "—" : formatPercent(r.marginPercent));
  setStatus(
    r.marginPercent === null
      ? "All costs are zero, so there is no margin to calculate."
      : "Results update automatically as you type."
  );
  return { ...r, quantity: quantityResult.value }; // "..." copies all fields of r
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
 * Refreshes both calculators. The affiliate section depends on the
 * product cost results, so they always update together, in order.
 */
function updateAll() {
  const product = updateProductCost();
  updateAffiliate(product);
}

// ---------- Start-up ----------

// Show the active currency in the footer.
document.getElementById("currency-label").textContent =
  `Currency: ${CONFIG.currencySymbol}`;

// One listener on the whole form catches typing in ANY of its inputs.
// The "input" event fires on every keystroke, so results are live.
// Changing either form refreshes both, because the affiliate results
// depend on the selling price and profit from the cost form.
const costForm = document.getElementById("cost-form");
const affiliateForm = document.getElementById("affiliate-form");
costForm.addEventListener("input", updateAll);
affiliateForm.addEventListener("input", updateAll);

// Pressing Enter inside a form would normally reload the page; stop that.
[costForm, affiliateForm].forEach((form) =>
  form.addEventListener("submit", (event) => event.preventDefault())
);

// "Clear all" empties both forms, then refreshes the results.
document.getElementById("reset-btn").addEventListener("click", () => {
  costForm.reset();
  affiliateForm.reset();
  updateAll();
});

// Run once at start so the page begins in a consistent state.
updateAll();
