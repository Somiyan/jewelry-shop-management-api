const test = require('node:test');
const assert = require('node:assert');
const { deriveStatus } = require('../src/services/paymentService');
const { userHasPermission, PERMISSIONS } = require('../src/middleware/permissions');

test('unpaid: zero paid', () => {
  assert.strictEqual(deriveStatus(0, 1000), 'pending');
});

test('partial: paid > 0 and < total', () => {
  assert.strictEqual(deriveStatus(300, 1000), 'partial');
});

test('paid: paid >= total', () => {
  assert.strictEqual(deriveStatus(1000, 1000), 'paid');
  assert.strictEqual(deriveStatus(1200, 1000), 'paid'); // overpayment still reads as paid
});

test('boundary: one paisa under total is still partial', () => {
  assert.strictEqual(deriveStatus(999.99, 1000), 'partial');
});

test('staff can add payments but not edit or reverse', () => {
  const staff = { role: 'staff', permissions: [] };
  assert.ok(userHasPermission(staff, PERMISSIONS.ADD_PAYMENT));
  assert.ok(userHasPermission(staff, PERMISSIONS.VIEW_CUSTOMER_BALANCE));
  assert.ok(userHasPermission(staff, PERMISSIONS.VIEW_PURCHASE_HISTORY));
  assert.strictEqual(userHasPermission(staff, PERMISSIONS.EDIT_PAYMENT), false);
  assert.strictEqual(userHasPermission(staff, PERMISSIONS.REVERSE_PAYMENT), false);
});

test('manager can edit and reverse payments', () => {
  const manager = { role: 'manager', permissions: [] };
  assert.ok(userHasPermission(manager, PERMISSIONS.EDIT_PAYMENT));
  assert.ok(userHasPermission(manager, PERMISSIONS.REVERSE_PAYMENT));
});

test('admin holds every payment permission', () => {
  const admin = { role: 'admin', permissions: [] };
  for (const p of Object.values(PERMISSIONS)) assert.ok(userHasPermission(admin, p), p);
});
