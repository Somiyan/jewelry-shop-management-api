const test = require('node:test');
const assert = require('node:assert');
const cron = require('node-cron');
const { userHasPermission, permissionsFor, PERMISSIONS } = require('../src/middleware/permissions');
const { CRON_EXPRESSION, CRON_TIMEZONE } = require('../src/jobs/rateSyncJob');
const { rateStatusLabel } = require('../src/services/rateService');

test('admin holds every rate permission', () => {
  const admin = { role: 'admin', permissions: [] };
  for (const p of Object.values(PERMISSIONS)) assert.ok(userHasPermission(admin, p), p);
});

test('staff may view but not edit or fetch', () => {
  const staff = { role: 'staff', permissions: [] };
  assert.ok(userHasPermission(staff, PERMISSIONS.VIEW_RATES));
  assert.ok(userHasPermission(staff, PERMISSIONS.VIEW_RATE_HISTORY));
  assert.strictEqual(userHasPermission(staff, PERMISSIONS.EDIT_RATES), false);
  assert.strictEqual(userHasPermission(staff, PERMISSIONS.FETCH_LIVE_RATES), false);
});

test('an explicit grant on the user record widens a role', () => {
  const staff = { role: 'staff', permissions: [PERMISSIONS.EDIT_RATES] };
  assert.ok(userHasPermission(staff, PERMISSIONS.EDIT_RATES));
});

test('manager may edit and fetch', () => {
  const manager = { role: 'manager', permissions: [] };
  assert.ok(userHasPermission(manager, PERMISSIONS.EDIT_RATES));
  assert.ok(userHasPermission(manager, PERMISSIONS.FETCH_LIVE_RATES));
});

test('no user holds nothing', () => {
  assert.strictEqual(userHasPermission(null, PERMISSIONS.VIEW_RATES), false);
  assert.deepStrictEqual(permissionsFor(null), []);
});

test('cron is a valid expression scheduled for 14:00 Asia/Kolkata', () => {
  assert.ok(cron.validate(CRON_EXPRESSION), `invalid: ${CRON_EXPRESSION}`);
  assert.strictEqual(CRON_EXPRESSION, '0 14 * * *');
  assert.strictEqual(CRON_TIMEZONE, 'Asia/Kolkata');
});

test("Vercel's UTC cron entry lands at 14:00 IST", () => {
  // vercel.json runs "30 8 * * *" in UTC, since Vercel Cron has no timezone.
  const ist = new Date(Date.UTC(2026, 8, 8, 8, 30)).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  assert.strictEqual(ist, '14:00');
});

test('status label distinguishes live, manual and stale', () => {
  const now = new Date();
  const old = new Date(Date.now() - 72 * 36e5);
  assert.strictEqual(rateStatusLabel({ sourceType: 'LIVE_API', effectiveAt: now }), 'LIVE');
  assert.strictEqual(rateStatusLabel({ sourceType: 'MANUAL', effectiveAt: now }), 'MANUAL');
  assert.strictEqual(rateStatusLabel({ sourceType: 'LIVE_API', effectiveAt: old }), 'STALE');
  assert.strictEqual(rateStatusLabel(null), 'NONE');
});
