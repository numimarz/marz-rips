# Marz Rips launch connections

The public site is still in free demo mode. Live pack sales and shipping are deliberately disabled in `mr_settings`. No real inventory has been added. Accounts use the existing Supabase project, with separate Marz tables and browser session storage.

## Owner access

Verify the owner's exact email with Bri before adding the corresponding `auth.users.id` to `mr_admins`. Never infer ownership from a matching account alone. The admin page is `/marz-rips/admin.html`; its data API independently checks the server-maintained admin table on every request.

## Account email delivery

Add `https://numimarz.github.io/marz-rips/` to Supabase Auth's allowed redirect URLs without replacing Buddy's Site URL or redirects. Verify production SMTP can send verification and recovery messages to public customers. Test signup, verification, password sign-in, password recovery, account reload, another device, and sign-out using an owner-controlled test account. Confirmation and recovery links can also be pasted into the site's verification field. No SMS is enabled.

## Billing

The deployed `marz-rips-api` function reads `MARZ_STRIPE_SECRET_KEY` and `MARZ_STRIPE_WEBHOOK_SECRET` from server-side Edge Function secrets. Never put these secrets in GitHub or frontend config. Configure a Stripe webhook to the function URL with `?webhook=1`, selecting `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, and `charge.refunded`.

Webhook signatures are checked against the raw request body with a five-minute timestamp tolerance. Subscription status is fetched from Stripe and activated only for a paid $1/month USD plan. Pack purchases require a reserved inventory record and a matching paid checkout. A success-page redirect never creates an entitlement. The billing portal must support cancellation. Test renewal, cancellation, failed payment, duplicate webhook delivery, expired checkout, refunds, and inventory exhaustion before live billing. Refund events are flagged for owner review, not automatically resolved.

## Inventory and fulfillment

Use the dashboard to add one row per physically held card and label the sleeve with its SKU. Add separate $1 bonus inventory before paid sales; demo cards are never real stock. The bonus threshold is 10 paid openings; bonus opens do not advance it. Inventory is reserved before pack checkout and its identity stays hidden until the verified open. An earned bonus pack also reserves a physical card.

Keep sales and shipping disabled until pricing, checkout, stock, shipping quotes, fees, policies and recovery are tested. Shipping fees are collected and verified separately; the dashboard records paid or owner-waived fees. Shipping requests stay in a separate notification queue until fulfilled with a real carrier and tracking number. Account ownership is retained; there is no card-forfeiture timer or store credit in this build.

## Verification and backup

`tests/transactions.sql` uses temporary transaction fixtures and rolls all changes back. It checks subscription gates, unpaid/other-owner denials, idempotent opens, one bonus at 10 paid openings, bonus exclusion, expired membership shipping denial, duplicate shipment denial, admin denial, and public-role permissions. All Marz tables have RLS; sensitive backend tables have no public grants. Commerce RPCs are executable only by `service_role` and use invoker privileges. Customer transactions are serialized with advisory locks.

The old layout is retained in `classic.html` and prior Git commits. The in-page Classic layout switch remains. Guest demo storage keeps its existing key; signing in starts an account-specific binder and allows deliberate guest import. Failed cloud demo saves retain a local account-specific recovery copy. Do not reset demo progress until Bri authorizes a launch reset; real payments and shipping records must not be reset with demo data.

Known launch limitations: admin grids show the latest 500 records, contacts are limited to 100 collectors, no automated shipping-price checkout or refunds, no monitoring email alerts, and no public production billing test has been completed. Increase pagination/monitoring before operating at larger volume.

## Subscriber trading

Apply `backend/schema.sql` followed by `backend/trading.sql` on a fresh deployment. Active subscribers may list held, inventory-backed cards for an instant one-for-one exchange with any held card from the same pack tier. This is a pack-tier rule, not an appraisal or a claim of equal market value. Listing requires explicit authorization; taking a listing requires confirmation of both cards. Demo cards cannot enter the pool.

Both subscribers and both cards are checked again in the transaction. Ownership transfers together, competing requests are rejected, and retry IDs prevent duplicate swaps. Withdrawals and shipping requests cancel live listings. Marz retains the physical inventory; the new owner may keep the card in their binder, relist it, or request shipping while subscribed. Trading does not require shipping and does not reset paid-opening reward history.

`tests/trading.sql` rolls back its fixtures and checks membership, ownership, same-tier rules, stale listings, retry behavior, listing withdrawal, paid reward history, shipping exclusion, and public-role restrictions. Real trading remains unavailable until billing and real inventory are connected; no demo progress is reset.
