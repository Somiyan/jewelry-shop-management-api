const path = require('path');
const PDFDocument = require('pdfkit');
const shop = require('../config/shopProfile');

const PAGE_MARGIN = 28;
const RED = '#c0392b';
const INK = '#1a1a1a';
const MUTED = '#555555';
const LINE = '#333333';
const HEADER_FILL = '#eeeeee';

const DEVANAGARI_REGULAR = path.join(__dirname, '../assets/fonts/NotoSansDevanagari-Regular.woff');
const DEVANAGARI_BOLD = path.join(__dirname, '../assets/fonts/NotoSansDevanagari-Bold.woff');

function money(n) {
  const value = Number(n) || 0;
  return value.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function weight(n) {
  if (n == null) return '';
  return Number(n).toFixed(3);
}

function fmtDate(d) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
}

/** Registers the fonts this renderer uses. Devanagari is only for the old-gold
 * section's Marathi/Hindi labels — everything else stays on Helvetica, since
 * the Devanagari font subset has no Latin punctuation glyphs (no colons etc). */
function registerFonts(doc) {
  doc.registerFont('Regular', 'Helvetica');
  doc.registerFont('Bold', 'Helvetica-Bold');
  doc.registerFont('Devanagari', DEVANAGARI_REGULAR);
  doc.registerFont('DevanagariBold', DEVANAGARI_BOLD);
}

function rect(doc, x, y, w, h, strokeColor = LINE) {
  doc.rect(x, y, w, h).lineWidth(0.75).strokeColor(strokeColor).stroke();
}

function hLine(doc, x1, x2, y, color = LINE, width = 0.75) {
  doc.moveTo(x1, y).lineTo(x2, y).lineWidth(width).strokeColor(color).stroke();
}

function vLine(doc, x, y1, y2, color = LINE, width = 0.75) {
  doc.moveTo(x, y1).lineTo(x, y2).lineWidth(width).strokeColor(color).stroke();
}

function text(doc, str, x, y, opts = {}) {
  doc.font(opts.bold ? 'Bold' : 'Regular')
    .fontSize(opts.size || 9)
    .fillColor(opts.color || INK)
    .text(str == null ? '' : String(str), x, y, {
      width: opts.width,
      align: opts.align || 'left',
      lineBreak: opts.lineBreak !== false,
    });
}

/** The item table's column widths, left to right. Sums to CONTENT_WIDTH. */
function buildColumns(contentWidth) {
  const cols = [
    { key: 'sr', label: 'Sr.\nNo.', width: 24, align: 'center' },
    { key: 'desc', label: 'Description', width: contentWidth - (24 + 42 + 34 + 24 + 42 + 42 + 46 + 42 + 62), align: 'left' },
    { key: 'hsn', label: 'HSN\nCode', width: 42, align: 'center' },
    { key: 'purity', label: 'Purity', width: 34, align: 'center' },
    { key: 'qty', label: 'Qty.', width: 24, align: 'center' },
    { key: 'gross', label: 'Gross', width: 42, align: 'right' },
    { key: 'net', label: 'Net', width: 42, align: 'right' },
    { key: 'rate', label: 'Rate', width: 46, align: 'right' },
    { key: 'labour', label: 'Labour', width: 42, align: 'right' },
    { key: 'amount', label: 'Amount', width: 62, align: 'right' },
  ];
  return cols;
}

/**
 * Renders one invoice, in the shop's own printed tax-invoice format, into
 * `res` (a writable stream). This deliberately does NOT use the app's own UI
 * design tokens — it reproduces the shop's existing paper stationery, which
 * is a separate, legally-relevant document convention from the app's chrome.
 */
function renderInvoicePdf(invoice, res) {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
  registerFonts(doc);
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const left = PAGE_MARGIN;
  const right = pageWidth - PAGE_MARGIN;
  const contentWidth = right - left;
  // `bottom` bounds how far a page-spanning divider (e.g. the footer's column
  // rules) may extend; the outer border itself is drawn at the end, sized to
  // the content actually rendered rather than the full page.
  const bottom = pageHeight - PAGE_MARGIN;

  let y = PAGE_MARGIN;

  // ---- header: logo + shop identity, hallmark badge on the right -----
  const headerHeight = 92;
  const badgeR = 26;
  doc.circle(left + 20 + badgeR - 6, y + headerHeight / 2 - 4, badgeR)
    .lineWidth(1.5)
    .strokeColor(RED)
    .stroke();
  doc.font('Bold').fontSize(15).fillColor(RED).text('SJ', left + 20, y + headerHeight / 2 - 12, {
    width: badgeR * 2 - 12,
    align: 'center',
  });

  const shopBlockX = left + 20 + badgeR * 2 + 8;
  const shopBlockWidth = contentWidth - (shopBlockX - left) - 140;
  doc.font('Bold').fontSize(26).fillColor(RED).text(shop.name, shopBlockX, y + 10, {
    width: shopBlockWidth,
  });
  doc.font('Bold').fontSize(10).fillColor(INK).text(shop.tagline.toUpperCase(), shopBlockX, y + 42, {
    width: shopBlockWidth,
  });
  doc.font('Regular').fontSize(8.5).fillColor(MUTED).text(shop.addressLines.join(', '), shopBlockX, y + 58, {
    width: shopBlockWidth,
  });
  if (shop.gstin) {
    text(doc, `GSTIN: ${shop.gstin}`, shopBlockX, y + 78, { size: 8.5, color: MUTED });
  }

  // Hallmark badge, top-right.
  const badgeW = 120;
  const badgeX = right - badgeW;
  rect(doc, badgeX, y + 6, badgeW, headerHeight - 16, LINE);
  doc.polygon([badgeX + badgeW / 2, y + 14], [badgeX + badgeW / 2 - 12, y + 32], [badgeX + badgeW / 2 + 12, y + 32])
    .lineWidth(1)
    .strokeColor(INK)
    .stroke();
  doc.circle(badgeX + badgeW / 2, y + 25, 2).fillColor(INK).fill();
  const [hallmarkTop, ...hallmarkRest] = shop.hallmarkLabel.split(' ');
  text(doc, hallmarkTop, badgeX, y + 38, { size: 10, bold: true, align: 'center', width: badgeW });
  text(doc, hallmarkRest.join(' '), badgeX, y + 50, { size: 8, bold: true, align: 'center', width: badgeW });
  if (shop.phone) {
    text(doc, shop.phone, badgeX, y + headerHeight - 8, { size: 8, align: 'center', width: badgeW, color: MUTED });
  }

  y += headerHeight;
  hLine(doc, left, right, y);

  // ---- TAX INVOICE bar -------------------------------------------------
  const barHeight = 20;
  text(doc, 'TAX INVOICE', left, y + 5, { size: 13, bold: true, color: RED, align: 'center', width: contentWidth });
  y += barHeight;
  hLine(doc, left, right, y);

  // ---- customer info | invoice no./date --------------------------------
  const infoHeight = 78;
  const infoSplit = left + contentWidth * 0.62;
  vLine(doc, infoSplit, y, y + infoHeight);

  const customer = invoice.customerId || {};
  const rowGap = 15;
  let iy = y + 8;
  text(doc, 'Name :', left + 8, iy, { size: 9, bold: true });
  text(doc, customer.name || '', left + 55, iy, { size: 9, width: infoSplit - left - 63 });
  iy += rowGap;
  text(doc, 'Address :', left + 8, iy, { size: 9, bold: true });
  text(doc, customer.address || customer.billingAddress || '', left + 55, iy, {
    size: 9,
    width: infoSplit - left - 63,
  });
  iy += rowGap;
  text(doc, 'State :', left + 8, iy, { size: 9, bold: true });
  const customerGstin = invoice.customerGstin || customer.gstin || '';
  const stateValue = customerGstin ? `${customer.state || ''}   GSTIN: ${customerGstin}` : customer.state || '';
  text(doc, stateValue, left + 55, iy, { size: 9, width: infoSplit - left - 63 });
  iy += rowGap;
  text(doc, 'Contact No. :', left + 8, iy, { size: 9, bold: true });
  text(doc, customer.phone || '', left + 78, iy, { size: 9 });
  text(doc, 'Email :', left + 190, iy, { size: 9, bold: true });
  text(doc, customer.email || '', left + 228, iy, { size: 9, width: infoSplit - left - 236 });

  let ry = y + 12;
  text(doc, 'Invoice No.', infoSplit + 12, ry, { size: 9, bold: true });
  text(doc, invoice.invoiceNumber, infoSplit + 90, ry, { size: 13, bold: true });
  ry += 24;
  text(doc, 'Date :', infoSplit + 12, ry, { size: 9, bold: true });
  text(doc, fmtDate(invoice.invoiceDate), infoSplit + 50, ry, { size: 9 });

  y += infoHeight;
  hLine(doc, left, right, y);

  // ---- item table --------------------------------------------------------
  const cols = buildColumns(contentWidth);
  const headerRowHeight = 30;
  let cx = left;
  const colX = cols.map((c) => {
    const x = cx;
    cx += c.width;
    return x;
  });

  const grossIdx = cols.findIndex((c) => c.key === 'gross');
  const spanX = colX[grossIdx];
  const spanW = cols[grossIdx].width + cols[grossIdx + 1].width;
  const subHeaderH = 13;

  doc.rect(left, y, contentWidth, headerRowHeight).fillColor(HEADER_FILL).fill();
  // "GOLD / SILVER / DIAMOND" spans the Gross+Net sub-columns, matching the source form's two-row header.
  text(doc, 'GOLD / SILVER / DIAMOND', spanX + 1, y + 3, {
    size: 5.5,
    bold: true,
    align: 'center',
    width: spanW - 2,
    lineBreak: false,
  });
  hLine(doc, spanX, spanX + spanW, y + subHeaderH);
  cols.forEach((c, i) => {
    const isSplit = c.key === 'gross' || c.key === 'net';
    const labelY = isSplit ? y + subHeaderH + 3 : y + 7;
    text(doc, c.label, colX[i] + 2, labelY, { size: 7.5, bold: true, align: c.align, width: c.width - 4 });
    if (i > 0) vLine(doc, colX[i], y, y + headerRowHeight);
  });
  y += headerRowHeight;
  hLine(doc, left, right, y);

  const rowHeight = 30;
  const items = invoice.items || [];
  const maxRows = Math.max(items.length, 2);
  for (let i = 0; i < maxRows; i += 1) {
    const item = items[i];
    cols.forEach((c, ci) => {
      if (ci > 0) vLine(doc, colX[ci], y, y + rowHeight);
    });
    if (item) {
      const cells = {
        sr: String(i + 1),
        desc: item.name,
        hsn: item.hsnCode || '',
        purity: item.purity != null ? `${item.purity}%` : '',
        qty: String(item.quantity),
        gross: weight(item.grossWeight),
        net: weight(item.netWeight),
        rate: item.ratePerGram != null ? money(item.ratePerGram) : '',
        labour: item.labourCharge != null ? money(item.labourCharge) : '',
        amount: money(item.totalPrice),
      };
      cols.forEach((c, ci) => {
        text(doc, cells[c.key], colX[ci] + 3, y + 4, {
          size: 8.5,
          align: c.align,
          width: c.width - 6,
        });
      });
    }
    y += rowHeight;
    hLine(doc, left, right, y);
  }

  // ---- order no. / date / total row --------------------------------------
  const summaryRowHeight = 18;
  const thirdW = contentWidth / 3;
  text(doc, `Order No. : ${invoice.orderId ? String(invoice.orderId).slice(-8) : ''}`, left + 6, y + 4, { size: 8.5 });
  vLine(doc, left + thirdW, y, y + summaryRowHeight);
  text(doc, `Date : ${fmtDate(invoice.invoiceDate)}`, left + thirdW + 6, y + 4, { size: 8.5 });
  vLine(doc, left + thirdW * 2, y, y + summaryRowHeight);
  text(doc, 'TOTAL', left + thirdW * 2 + 6, y + 4, { size: 8.5, bold: true });
  text(doc, money(invoice.subtotal), right - 70, y + 4, { size: 9, bold: true, align: 'right', width: 64 });
  y += summaryRowHeight;
  hLine(doc, left, right, y);

  // ---- three-part footer strip: old-gold | advance receipt | tax box ----
  const stripTop = y;
  const oldGoldW = thirdW;
  const advanceW = thirdW;
  const taxBoxW = contentWidth - oldGoldW - advanceW;
  const advanceX = left + oldGoldW;
  const taxBoxX = advanceX + advanceW;
  const balanceDue = invoice.finalAmount - (invoice.amountPaid || 0);
  const showBalanceDue = invoice.paymentStatus === 'partial' && balanceDue > 0;
  // Precompute the strip's height (old-gold and advance are fixed at 4 rows;
  // the tax box grows by one row when a balance-due line is needed) so the
  // column dividers can be drawn up front instead of stretching to the page.
  const stripContentHeight = Math.max(16 + 4 * 15, 4 * 17 + 20 + (showBalanceDue ? 18 : 0));
  const stripBottom = stripTop + stripContentHeight;
  vLine(doc, advanceX, stripTop, stripBottom);
  vLine(doc, taxBoxX, stripTop, stripBottom);

  // Old gold exchange (Devanagari labels, values in a bordered mini-table).
  let ogy = stripTop + 6;
  doc.font('DevanagariBold').fontSize(9.5).fillColor(INK).text('जुने सोने तपशील', left + 6, ogy, { width: oldGoldW - 12 });
  ogy += 16;
  const og = invoice.oldGoldExchange || {};
  const ogLabelW = 60;
  const ogRows = [
    ['तारीख', fmtDate(og.date)],
    ['वजन', og.weight != null ? weight(og.weight) : ''],
    ['दर', og.rate != null ? money(og.rate) : ''],
    ['ए. किंमत', og.amount != null ? money(og.amount) : ''],
  ];
  ogRows.forEach(([label, value]) => {
    doc.font('Devanagari').fontSize(8.5).fillColor(INK).text(label, left + 6, ogy, { width: ogLabelW });
    hLine(doc, left + ogLabelW + 6, left + oldGoldW - 6, ogy + 10, MUTED, 0.5);
    text(doc, value, left + ogLabelW + 10, ogy, { size: 8.5, width: oldGoldW - ogLabelW - 20 });
    ogy += 15;
  });

  // Advance receipt details.
  let ady = stripTop + 6;
  text(doc, 'ADVANCE RECEIPT DETAILS', advanceX + 6, ady, { size: 8.5, bold: true, width: advanceW - 12 });
  ady += 16;
  const methodCellFor = { cash: 'CASH', card: 'CARD', cheque: 'CHEQUE' };
  const activeCell = methodCellFor[invoice.paymentMethod] || 'BANK';
  const receiptRows = ['BANK', 'CHEQUE', 'CARD', 'CASH'];
  receiptRows.forEach((label) => {
    text(doc, label, advanceX + 6, ady, { size: 8.5, bold: label === activeCell });
    if (label === activeCell && invoice.amountPaid) {
      text(doc, money(invoice.amountPaid), advanceX + 6, ady, {
        size: 8.5,
        bold: true,
        align: 'right',
        width: advanceW - 12,
      });
    }
    hLine(doc, advanceX + 55, advanceX + advanceW - 6, ady + 10, MUTED, 0.5);
    ady += 15;
  });

  // Tax / grand total box. `billingType`/`isInterState`/cgst-sgst-igst are
  // absent on invoices created before the GST-aware Sales module existed —
  // those are treated as the GST + intra-state bills they always were, and
  // fall back to splitting taxAmount evenly, exactly as this renderer always
  // did. A Non-GST bill prints one row stating tax does not apply, per the
  // module's requirement that a Non-GST invoice clearly say so rather than
  // silently show a zeroed tax line.
  const taxPct = invoice.subtotal ? (invoice.taxAmount / invoice.subtotal) * 100 : 0;
  const halfPct = (taxPct / 2).toFixed(2);
  const isNonGst = invoice.billingType === 'NON_GST';
  const isInterState = invoice.billingType === 'GST' && invoice.isInterState === true;

  let gstRows;
  if (isNonGst) {
    gstRows = [['GST', 'Not Applicable']];
  } else if (isInterState) {
    const igstPct = invoice.subtotal ? ((invoice.igstAmount || invoice.taxAmount) / invoice.subtotal) * 100 : 0;
    gstRows = [[`IGST ${igstPct.toFixed(2)}%`, invoice.taxAmount ? money(invoice.igstAmount || invoice.taxAmount) : '']];
  } else {
    const sgst = invoice.sgstAmount != null ? invoice.sgstAmount : invoice.taxAmount / 2;
    const cgst = invoice.cgstAmount != null ? invoice.cgstAmount : invoice.taxAmount / 2;
    gstRows = [
      [`SGST ${halfPct}%`, invoice.taxAmount ? money(sgst) : ''],
      [`CGST ${halfPct}%`, invoice.taxAmount ? money(cgst) : ''],
    ];
  }

  const taxRows = [
    ...gstRows,
    ['DISCOUNT', invoice.discount ? money(invoice.discount) : ''],
    ['ADVANCE', invoice.paymentStatus === 'partial' ? money(invoice.amountPaid) : ''],
  ];
  let tby = stripTop;
  const taxLabelW = taxBoxW * 0.55;
  taxRows.forEach(([label, value]) => {
    hLine(doc, taxBoxX, right, tby, MUTED, 0.5);
    text(doc, label, taxBoxX + 6, tby + 4, { size: 8.5 });
    text(doc, value, taxBoxX + taxLabelW, tby + 4, { size: 8.5, align: 'right', width: taxBoxW - taxLabelW - 8 });
    tby += 17;
  });
  hLine(doc, taxBoxX, right, tby, LINE, 0.75);
  doc.rect(taxBoxX, tby, taxBoxW, 20).fillColor(HEADER_FILL).fill();
  text(doc, 'GRAND TOTAL', taxBoxX + 6, tby + 5, { size: 9, bold: true });
  text(doc, money(invoice.finalAmount), taxBoxX + taxLabelW, tby + 5, {
    size: 9,
    bold: true,
    align: 'right',
    width: taxBoxW - taxLabelW - 8,
  });
  tby += 20;
  if (showBalanceDue) {
    hLine(doc, taxBoxX, right, tby, LINE, 0.75);
    text(doc, 'Balance due', taxBoxX + 6, tby + 5, { size: 8.5, bold: true, color: RED });
    text(doc, money(balanceDue), taxBoxX + taxLabelW, tby + 5, {
      size: 8.5,
      bold: true,
      color: RED,
      align: 'right',
      width: taxBoxW - taxLabelW - 8,
    });
    tby += 18;
  }

  hLine(doc, left, right, stripBottom);

  // ---- compliance note + payment status stamp area -----------------------
  let ny = stripBottom + 8;
  text(
    doc,
    'No E-way bill is required to be generated as the goods covered under this invoice are exempted as per ' +
      'Serial No. 4/5 to the Annexure to Rule 138(14) of the CGST Rules.',
    left + 6,
    ny,
    { size: 7, color: MUTED, width: contentWidth * 0.62 - 12 }
  );
  if (invoice.paymentStatus === 'paid') {
    doc.save();
    doc.rotate(-8, { origin: [left + contentWidth * 0.75, ny + 10] });
    text(doc, 'PAID', left + contentWidth * 0.68, ny, { size: 20, bold: true, color: RED, align: 'center', width: 100 });
    doc.restore();
  }
  ny += 30;
  hLine(doc, left, right, ny);

  // ---- footer: verification | bank details | authorised signatory --------
  // Fixed, compact height — hugs the actual content instead of stretching to
  // the page bottom, so a short invoice doesn't leave a large dead gap.
  const footerTop = ny;
  const footerHeight = 92;
  const footerBottom = footerTop + footerHeight;
  const footThird = contentWidth / 3;
  vLine(doc, left + footThird, footerTop, footerBottom);
  vLine(doc, left + footThird * 2, footerTop, footerBottom);

  let fy = footerTop + 8;
  ['Weight & Pieces Verified & Check', 'Found Satisfactory', 'Confirm Received Delivery'].forEach((line) => {
    text(doc, line, left + 6, fy, { size: 8, width: footThird - 12 });
    fy += 13;
  });
  text(doc, 'Customer Signature', left + 6, footerBottom - 16, { size: 8, width: footThird - 12 });

  let by = footerTop + 8;
  text(doc, 'Bank Details (For RTGS/NEFT)', left + footThird + 6, by, { size: 8.5, bold: true });
  by += 14;
  [
    ['A/c: M/s.', shop.bank.accountName],
    ['Bank:', shop.bank.bankName],
    ['A/C NO.:', shop.bank.accountNumber],
    ['IFSC CODE:', shop.bank.ifsc],
  ].forEach(([label, value]) => {
    text(doc, `${label} ${value || ''}`, left + footThird + 6, by, { size: 8, width: footThird - 12 });
    by += 13;
  });

  const signColX = left + footThird * 2;
  text(doc, `For ${shop.name.toUpperCase()}`, signColX, footerTop + 8, {
    size: 10,
    bold: true,
    color: RED,
    align: 'center',
    width: footThird,
  });
  text(doc, 'Authorised Signatory', signColX, footerBottom - 16, {
    size: 8,
    align: 'center',
    width: footThird,
  });

  // The outer border hugs the actual content — not the full page — so short
  // invoices don't render with a large empty lower half.
  doc.rect(left, PAGE_MARGIN, contentWidth, footerBottom - PAGE_MARGIN).lineWidth(0.75).strokeColor(LINE).stroke();

  doc.end();
}

module.exports = { renderInvoicePdf };
