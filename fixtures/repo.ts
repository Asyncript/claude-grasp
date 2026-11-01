import * as F from './files';

/** Day 0 of the demo story. Demo mode shifts everything so day 0 is today. */
export const FIXTURE_ANCHOR = Date.UTC(2026, 9, 30);

export const SESSION_IDS = {
  plan: 'd0000000-0000-4000-8000-000000000001',
  pricing: 'd0000000-0000-4000-8000-000000000002',
  fix: 'd0000000-0000-4000-8000-000000000003',
  today: 'd0000000-0000-4000-8000-000000000004',
  headless: 'd0000000-0000-4000-8000-000000000005',
  readonly: 'd0000000-0000-4000-8000-000000000006',
};

export const FIXTURE_AUTHOR = { name: 'Dana Dev', email: 'dana@example.com' };

const TRAILER = '\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

export interface FixtureCommit {
  day: number;
  time: string;
  message: string;
  files: Record<string, string>;
}

/**
 * The demo repo's history. Expected attribution per file:
 * - README.md, package.json: prior (before Claude touched anything)
 * - src/auth/session.ts: claude (c2)
 * - src/orders/checkout.ts: ambiguous (c3), human (c4), claude (c5)
 * - src/utils/format.ts: ambiguous (c3), human (c6)
 * - src/orders/pricing.ts, src/db/migrations.ts: ambiguous (c3)
 */
export const FIXTURE_COMMITS: FixtureCommit[] = [
  { day: -7, time: '09:00', message: 'Initial commit', files: { 'README.md': F.README, 'package.json': F.PACKAGE_JSON } },
  { day: -6, time: '12:00', message: `Add in-memory sessions with refresh${TRAILER}`, files: { 'src/auth/session.ts': F.SESSION_V2 } },
  {
    day: -4,
    time: '18:00',
    message: 'Add pricing, checkout and migrations',
    files: {
      'src/orders/pricing.ts': F.PRICING_V2,
      'src/orders/checkout.ts': F.CHECKOUT_V1,
      'src/utils/format.ts': F.FORMAT_V1,
      'src/db/migrations.ts': F.MIGRATIONS_V1,
    },
  },
  { day: -3, time: '11:00', message: 'checkout: show region on receipt', files: { 'src/orders/checkout.ts': F.CHECKOUT_V1H } },
  { day: -2, time: '16:00', message: `Fix double discount in checkout total${TRAILER}`, files: { 'src/orders/checkout.ts': F.CHECKOUT_V2 } },
  { day: -1, time: '09:30', message: 'format: accept a locale', files: { 'src/utils/format.ts': F.FORMAT_V2 } },
];
