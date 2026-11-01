// Synthetic "shop-api" source files at each point in the demo story. Shared by the fixture
// git repo (fixtures/repo.ts) and the transcript generator (fixtures/gen.ts).

export const README = `# shop-api

Tiny demo API used by Grasp's fixtures.
`;

export const PACKAGE_JSON = `{
  "name": "shop-api",
  "private": true,
  "type": "module"
}
`;

export const SESSION_V1 = `import { randomUUID } from 'node:crypto';

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, Session>();

export function createSession(userId: string, now = Date.now()): Session {
  const session = { id: randomUUID(), userId, expiresAt: now + TTL_MS };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string, now = Date.now()): Session | null {
  const session = sessions.get(id);
  if (!session || session.expiresAt <= now) {
    sessions.delete(id);
    return null;
  }
  return session;
}
`;

export const SESSION_V2 = `${SESSION_V1}
export function refreshSession(id: string, now = Date.now()): Session | null {
  const current = getSession(id, now);
  if (!current) return null;
  sessions.delete(id);
  return createSession(current.userId, now);
}
`;

export const PRICING_V1 = `export interface LineItem {
  sku: string;
  unitPrice: number;
  qty: number;
}

export interface Discount {
  code: string;
  percent: number;
  minSubtotal?: number;
}

export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
}

export function applyDiscount(amount: number, discount?: Discount): number {
  if (!discount) return amount;
  if (discount.minSubtotal && amount < discount.minSubtotal) return amount;
  const off = Math.round(amount * discount.percent) / 100;
  return Math.max(0, amount - off);
}

export function taxFor(amount: number, region: string): number {
  const rates: Record<string, number> = { US: 0.07, EU: 0.2, BD: 0.15 };
  return Math.round(amount * (rates[region] ?? 0) * 100) / 100;
}
`;

export const PRICING_V2 = `${PRICING_V1}
export function bulkDiscount(items: LineItem[]): number {
  const units = items.reduce((n, item) => n + item.qty, 0);
  return units >= 10 ? 0.05 : 0;
}
`;

export const PRICING_V3 = `${PRICING_V2}
export function shippingFee(subtotalAfterDiscount: number): number {
  return subtotalAfterDiscount >= 50 ? 0 : 5;
}
`;

const CHECKOUT_HEAD = `import { applyDiscount, bulkDiscount, subtotal, taxFor, type Discount, type LineItem } from './pricing';
import { formatMoney } from '../utils/format';

export interface Cart {
  items: LineItem[];
  region: string;
  discount?: Discount;
}
`;

export const CHECKOUT_V1 = `${CHECKOUT_HEAD}
export function checkoutTotal(cart: Cart): number {
  const base = subtotal(cart.items);
  const discounted = applyDiscount(base, cart.discount);
  const bulk = discounted * (1 - bulkDiscount(cart.items));
  const total = applyDiscount(bulk, cart.discount) + taxFor(bulk, cart.region);
  return Math.round(total * 100) / 100;
}

export function receiptLine(cart: Cart): string {
  return \`Total: \${formatMoney(checkoutTotal(cart))}\`;
}
`;

/** The human's hand edit: the receipt shows the region. */
export const CHECKOUT_V1H = CHECKOUT_V1.replace('`Total: ', '`Total (${cart.region}): ');

/** Claude's fix for the double discount, after the human's correction. */
export const CHECKOUT_V2 = CHECKOUT_V1H.replace(
  '  const total = applyDiscount(bulk, cart.discount) + taxFor(bulk, cart.region);',
  '  const total = bulk + taxFor(bulk, cart.region);',
);

/** Today's change: shipping fee. Not committed yet in the demo. */
export const CHECKOUT_V3 = CHECKOUT_V2.replace(
  "import { applyDiscount, bulkDiscount, subtotal, taxFor, type Discount, type LineItem } from './pricing';",
  "import { applyDiscount, bulkDiscount, shippingFee, subtotal, taxFor, type Discount, type LineItem } from './pricing';",
).replace(
  '  const total = bulk + taxFor(bulk, cart.region);',
  '  const total = bulk + taxFor(bulk, cart.region) + shippingFee(bulk);',
);

export const FORMAT_V1 = `export function formatMoney(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}
`;

/** The human's hand edit: locale parameter. */
export const FORMAT_V2 = `export function formatMoney(amount: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}
`;

export const FORMAT_V3 = `${FORMAT_V2}
export function formatPercent(fraction: number): string {
  return \`\${Math.round(fraction * 1000) / 10}%\`;
}
`;

export const MIGRATIONS_V1 = `export const migrations = [
  \`CREATE TABLE orders (id TEXT PRIMARY KEY, total REAL NOT NULL, created_at TEXT NOT NULL)\`,
  \`CREATE TABLE order_items (order_id TEXT NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL)\`,
];

export function pending(applied: number): string[] {
  return migrations.slice(applied);
}
`;

export const MIGRATIONS_V2 = `export const migrations = [
  \`CREATE TABLE orders (id TEXT PRIMARY KEY, total REAL NOT NULL, created_at TEXT NOT NULL)\`,
  \`CREATE TABLE order_items (order_id TEXT NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL)\`,
  \`CREATE INDEX orders_created ON orders (created_at)\`,
  \`CREATE INDEX order_items_order ON order_items (order_id)\`,
];

export function pending(applied: number): string[] {
  return migrations.slice(applied);
}
`;

export const DAILY_REPORT = `import { migrations } from '../db/migrations';

export interface DailyTotals {
  day: string;
  orders: number;
  revenue: number;
}

export function dailyTotals(rows: { created_at: string; total: number }[]): DailyTotals[] {
  const byDay = new Map<string, DailyTotals>();
  for (const r of rows) {
    const day = r.created_at.slice(0, 10);
    const t = byDay.get(day) ?? { day, orders: 0, revenue: 0 };
    t.orders += 1;
    t.revenue += r.total;
    byDay.set(day, t);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export const schemaVersion = () => migrations.length;
`;

const toLines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));

/** A single structuredPatch-style hunk from `before` to `after`, with up to `ctx` context lines. */
export function hunk(before: string, after: string, ctx = 3) {
  const a = toLines(before);
  const b = toLines(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const start = Math.max(0, p - ctx);
  const endA = Math.min(a.length, a.length - s + ctx);
  const endB = Math.min(b.length, b.length - s + ctx);
  const lines = [
    ...a.slice(start, p).map((l) => ` ${l}`),
    ...a.slice(p, a.length - s).map((l) => `-${l}`),
    ...b.slice(p, b.length - s).map((l) => `+${l}`),
    ...a.slice(a.length - s, endA).map((l) => ` ${l}`),
  ];
  return { oldStart: start + 1, oldLines: endA - start, newStart: start + 1, newLines: endB - start, lines };
}
