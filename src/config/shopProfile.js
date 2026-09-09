// The shop's own printed-stationery details — used only when rendering the
// invoice PDF. Independent of the app's UI (the app's own branding lives in
// the frontend's design tokens; this is what appears on the physical/legal
// document). Override any of these via env vars without touching this file.
module.exports = {
  name: process.env.SHOP_NAME || 'Sonali Jewellers',
  tagline: process.env.SHOP_TAGLINE || 'Dealers in Fine Gold Ornaments',
  addressLines: (
    process.env.SHOP_ADDRESS ||
    'Shop No. A-002, Rupali Darshan CHS., Near Hanuman Mandir, Bhayandar (E), Thane - 401105.'
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
  phone: process.env.SHOP_PHONE || '',
  gstin: process.env.SHOP_GSTIN || '',
  // Used only to decide CGST+SGST (intra-state) vs IGST (inter-state) on a
  // GST bill — compared against the customer's own state at sale time.
  state: process.env.SHOP_STATE || 'Maharashtra',
  hallmarkLabel: process.env.SHOP_HALLMARK_LABEL || 'BIS 916 Hallmark Jewellery',
  bank: {
    accountName: process.env.SHOP_BANK_ACCOUNT_NAME || '',
    bankName: process.env.SHOP_BANK_NAME || '',
    accountNumber: process.env.SHOP_BANK_ACCOUNT_NUMBER || '',
    ifsc: process.env.SHOP_BANK_IFSC || '',
  },
};
