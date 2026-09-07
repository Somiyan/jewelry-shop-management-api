const mongoose = require('mongoose');

const sizeLengthSchema = new mongoose.Schema(
  {
    value: { type: Number },
    unit: { type: String, enum: ['mm', 'cm', 'inch', 'size'] },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['ring', 'necklace', 'bracelet', 'earring', 'pendant'], required: true },
    metalType: { type: String, enum: ['gold', 'silver'], required: true },

    // Purity is the actual purity PERCENTAGE of the metal (e.g. 91.6 for 22K gold),
    // never a karat label. See docs/migration notes for the karat->percentage map.
    purity: {
      type: Number,
      required: true,
      min: [0.0001, 'purity must be greater than 0'],
      max: [100, 'purity must be less than or equal to 100'],
    },

    // Purity, wastage and making-charge are intentionally separate fields —
    // they are three different domain concepts and must never be collapsed
    // into a single combined number.
    grossWeight: { type: Number, required: true, min: [0.0001, 'grossWeight must be greater than 0'] },
    netWeight: {
      type: Number,
      required: true,
      min: [0.0001, 'netWeight must be greater than 0'],
      validate: {
        validator: function validateNetWeight(v) {
          return this.grossWeight == null || v <= this.grossWeight;
        },
        message: 'netWeight cannot exceed grossWeight',
      },
    },
    wastagePercentage: { type: Number, default: 0, min: 0 },
    sizeLength: { type: sizeLengthSchema, default: undefined },

    makingChargeType: { type: String, enum: ['percentage', 'per_gram'], default: 'percentage' },
    makingChargeValue: { type: Number, default: 0, min: 0 },

    // Frozen snapshot of the metal rate at the moment this product was created,
    // and the purchase cost computed from it. Neither is ever recalculated
    // automatically after creation — a live rate change must never silently
    // alter historical purchase cost.
    purchaseMetalRate: { type: Number, required: true, min: 0 },
    purchaseCost: { type: Number, required: true, min: 0 },

    sku: { type: String, required: true, unique: true, trim: true },
    quantity: { type: Number, default: 0, min: 0 },
    image: { type: String, default: '' },
    description: { type: String, default: '' },
    barcode: { type: String, trim: true, default: undefined },
    category: { type: String, trim: true, default: '' },
    // GST harmonized system code, e.g. 7113 for gold jewellery. Optional —
    // printed on the invoice line when set.
    hsnCode: { type: String, trim: true, default: '' },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

productSchema.index({ barcode: 1 }, { unique: true, sparse: true });

// Backward-compatible alias: any code still reading/writing `product.weightGrams`
// (the old single-weight field) transparently maps onto the new `netWeight` field.
productSchema
  .virtual('weightGrams')
  .get(function getWeightGrams() {
    return this.netWeight;
  })
  .set(function setWeightGrams(v) {
    this.netWeight = v;
  });

module.exports = mongoose.model('Product', productSchema);
