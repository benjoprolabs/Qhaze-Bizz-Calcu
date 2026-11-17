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
 * Turns a number into a money string, e.g. 1234.5 -> "RM 1,234.50".
 */
function formatMoney(amount) {
  const formatted = amount.toLocaleString(CONFIG.locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${CONFIG.currencySymbol} ${formatted}`;
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

// ---------- 2. Reading and validating inputs ----------

/**
 * Reads one input box and checks it.
 * Returns { value, error }:
 *   value = the number, or null if the box is empty or invalid
 *   error = a message to show the user, or "" if everything is fine
 */
function readField(id, { wholeNumber = false, min = 0 } = {}) {
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
  if (value > CONFIG.maxAmount) {
    return { value: null, error: "That number is too large." };
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
 * Runs every time the user types. Reads all inputs, validates them,
 * calculates, and writes the results (or "—" where we can't calculate yet).
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
    return;
  }

  // Empty cost fields count as RM 0
  const costs = costResults.map((r) => r.value ?? 0);
  const anyCostEntered = costResults.some((r) => r.value !== null);
  if (!anyCostEntered) {
    setStatus("Start by entering your costs.");
    return;
  }

  // We can always show the total once any cost is entered
  const totalCost = costs.reduce((sum, cost) => sum + cost, 0);
  setOutput("out-total", formatMoney(totalCost));

  if (quantityResult.value === null) {
    setStatus("Enter the production quantity to see per-unit results.");
    return;
  }

  // Without a markup we can still show cost per unit
  const markup = markupResult.value ?? 0;
  const r = calculateProductCost(costs, quantityResult.value, markup);
  setOutput("out-unit-cost", formatMoney(r.costPerUnit));

  if (markupResult.value === null) {
    setStatus("Enter a markup % to see selling price and profit.");
    return;
  }

  setOutput("out-price", formatMoney(r.sellingPrice));
  setOutput("out-profit", formatMoney(r.grossProfit));
  setOutput("out-margin", r.marginPercent === null ? "—" : formatPercent(r.marginPercent));
  setStatus(
    r.marginPercent === null
      ? "All costs are zero, so there is no margin to calculate."
      : "Results update automatically as you type."
  );
}

// ---------- Start-up ----------

// Show the active currency in the footer.
document.getElementById("currency-label").textContent =
  `Currency: ${CONFIG.currencySymbol}`;

// One listener on the whole form catches typing in ANY of its inputs.
// The "input" event fires on every keystroke, so results are live.
const costForm = document.getElementById("cost-form");
costForm.addEventListener("input", updateProductCost);

// "Clear all" empties the form, then refreshes the results.
document.getElementById("reset-btn").addEventListener("click", () => {
  costForm.reset();
  updateProductCost();
});

// Run once at start so the page begins in a consistent state.
updateProductCost();
