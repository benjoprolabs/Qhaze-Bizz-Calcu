/* =========================================================
   QHAZE Business Calculator — Logic
   ========================================================= */

// ---------- Settings ----------
// Everything you might want to change lives in one place.
const CONFIG = {
  currencySymbol: "RM",   // Malaysian Ringgit
  locale: "en-MY",        // controls number formatting (e.g. 1,234.50)
};

// ---------- Helpers ----------

/**
 * Turns a number into a money string, e.g. 1234.5 -> "RM 1,234.50".
 * We will use this in every calculator so all prices look the same.
 */
function formatMoney(amount) {
  const formatted = amount.toLocaleString(CONFIG.locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${CONFIG.currencySymbol} ${formatted}`;
}

// ---------- Start-up ----------
// Show the active currency in the footer. This also proves the
// JavaScript file is connected to the page.
document.getElementById("currency-label").textContent =
  `Currency: ${CONFIG.currencySymbol}`;
