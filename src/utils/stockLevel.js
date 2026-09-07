const LOW_STOCK_THRESHOLD = 3;

function getStockLevel(quantity) {
  if (quantity === 0) return 'red';
  if (quantity <= LOW_STOCK_THRESHOLD) return 'yellow';
  return 'green';
}

module.exports = { getStockLevel, LOW_STOCK_THRESHOLD };
