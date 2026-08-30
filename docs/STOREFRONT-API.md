# Inventory Core — Storefront API

**Everything a selling app needs to read this catalogue, show stock, and take stock off the shelf when an order is delivered.**

Hand this whole file to whoever — or whatever — builds the storefront. It is written to be sufficient on its own: no other document is needed to integrate.

---

## Contents

1. [The one thing to understand first](#1-the-one-thing-to-understand-first)
2. [Getting a key](#2-getting-a-key)
3. [Connecting: base URL, auth, CORS](#3-connecting)
4. [Endpoint reference](#4-endpoint-reference)
5. [The order lifecycle — reserve, commit, release](#5-the-order-lifecycle)
6. [Prices](#6-prices)
7. [Images](#7-images)
8. [Errors](#8-errors)
9. [Rate limits](#9-rate-limits)
10. [A complete Next.js integration](#10-a-complete-nextjs-integration)
11. [Things that will bite you](#11-things-that-will-bite-you)
12. [Checklist before going live](#12-checklist-before-going-live)

---

## 1. The one thing to understand first

**Stock belongs to a place, not to a product.**

There is no such number as "how many packets of rice do we have". There is only "how many at Shop 1", "how many at Shop 3", "how many at the hub". A customer buying from Shop 1 cannot be sold the packet sitting in Shop 3.

So **every endpoint that touches stock takes a `location`**. If you do not send one:

- **Listing endpoints** still work, but `stock` comes back as `null` — meaning *"you did not ask, so I am not guessing"*. Not `0`, which would read as *out of stock everywhere* and is a different and wrong statement.
- **Reserve** returns **400**. Holding stock at an unnamed shop is not a thing that can happen.

The exception: if a key is bound to exactly one shop and you name no location, that shop is assumed. This is a convenience for single-shop storefronts. **A location you name explicitly always wins over that default** — including one that matches nothing, which is a 400 rather than a silent substitution.

The second thing: **`stock` is what may be *promised*, not what is on the shelf.** It is `on_hand − reserved − allocated − damaged`. Ten packets on the shelf with three held for somebody mid-checkout reports `7`. That is the number to show a customer.

---

## 2. Getting a key

Sign in to the inventory dashboard → **API keys** → **Mint key**.

| Field | What to put |
|---|---|
| **Name** | `Storefront` — it appears in the usage log |
| **Environment** | `LIVE` |
| **Locations** | Tick every shop this storefront may sell from. Leave none ticked only if it may sell from all of them |
| **Scopes** | See below |

### Scopes for a storefront

| Scope | Grant it? | What it opens |
|---|---|---|
| `catalog:read` | **Yes** | Products, categories, locations, prices, images |
| `stock:read` | **Yes** | `GET /api/inventory/order/:id` |
| `reservations:write` | **Yes** | reserve / commit / release |
| `catalog:write` | Only if the storefront edits product names or descriptions | `PATCH /api/products/:sku` |
| `pricing:write` | Only if the storefront sets its own prices | `PUT /api/products/:sku` |
| `cost:read` | **No** | Adds a `cost` field — what you *paid*. A storefront holding this publishes your margin to anyone who opens devtools |

### Or from the command line

The dashboard needs to be reachable and the login to work. The first key is usually the one you want *while* you are still proving the deployment, so there is a script:

```bash
npm run key:mint -- --name "Storefront" --scopes catalog:read,stock:read,reservations:write --locations SH1
```

```
  Storefront — LIVE

  ic_live_9f31c0a4e7b2…

  scopes     catalog:read, stock:read, reservations:write
  locations  SH1
```

Omit `--locations` and the key may sell from **every** shop. Naming a shop that does not exist prints the ones that do and mints nothing — a key silently bound to fewer shops than you asked for works, and fails later, at a shop somebody assumed it covered.

Add `--env SANDBOX` for a `ic_test_…` key.

The key is shown **once**, at creation. It looks like `ic_live_a1b2c3…`. Copy it then; it is stored hashed and cannot be shown again. Lost key → revoke it and mint another.

> **A key bound to Shop 1 cannot read or hold stock anywhere else.** That is enforced by row-level security in the database, not by the API handlers — so it holds even if a handler has a bug.

---

## 3. Connecting

### Base URL

```
https://your-inventory.vercel.app
```

### Authentication

Every request carries the key as a bearer token:

```
Authorization: Bearer ic_live_a1b2c3...
Content-Type: application/json
```

### Call this from your server, never from the browser

The key carries write access to the catalogue and the power to move real stock. In client-side code it is readable by anyone who opens the network tab.

**The pattern:** your storefront's own server routes call the inventory API; your browser code calls your own server routes. A worked example is in [section 10](#10-a-complete-nextjs-integration).

If you genuinely need browser-side calls, set `STOREFRONT_ORIGINS` on the inventory deployment to a comma-separated list of your origins:

```
STOREFRONT_ORIGINS=https://shop.example.com,https://staging-shop.example.com
```

CORS is an **allowlist, not `*`** — deliberately. A wildcard lets any page on the internet call this API with a browser's credentials attached.

### Is it wired up?

```bash
curl https://your-inventory.vercel.app/api/health
```

Unauthenticated, and returns booleans only — no hostnames, no keys. It exists because a deployment once built green, served the login page perfectly, and could not sign anybody in, and the only symptom anyone saw was a wrong error message.

---

## 4. Endpoint reference

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/api/locations` | `catalog:read` | The shop picker |
| `GET` | `/api/categories` | `catalog:read` | Categories with stock |
| `GET` | `/api/products` | `catalog:read` | Product listing |
| `GET` | `/api/products/:slug_or_sku` | `catalog:read` | One product, in full |
| `PATCH` | `/api/products/:slug_or_sku` | `catalog:write` | Edit name, description, category, unit |
| `PUT` | `/api/products/:slug_or_sku` | `pricing:write` | Set retail / MRP / wholesale |
| `POST` | `/api/inventory/reserve` | `reservations:write` | Hold stock for an order |
| `POST` | `/api/inventory/commit` | `reservations:write` | Order delivered — reduce stock |
| `POST` | `/api/inventory/release` | `reservations:write` | Order cancelled — put it back |
| `GET` | `/api/inventory/order/:order_id` | `stock:read` | What happened to an order |
| `GET` | `/api/health` | *none* | Deployment diagnostics |

---

### `GET /api/locations`

The shops this key may sell from. **Call this first** — every other endpoint is location-scoped, and you cannot ask for stock at a shop until you know which shops exist.

```http
GET /api/locations
```

```json
[
  { "id": "SH1", "uuid": "8f2c…", "name": "Andheri West", "type": "shop", "products_in_stock": 142 },
  { "id": "SH3", "uuid": "b41a…", "name": "Dadar",        "type": "shop", "products_in_stock": 118 }
]
```

`id` is the short code — that is what you send back as `location` everywhere else. `uuid` also works if you prefer opaque identifiers.

---

### `GET /api/categories`

```http
GET /api/categories?location=SH1
```

| Query | Type | Notes |
|---|---|---|
| `location` | string | Shop code or uuid |

```json
[
  { "id": "rice-and-grains", "name": "Rice & Grains", "icon": "🌾", "product_count": 24 },
  { "id": "dairy",           "name": "Dairy",         "icon": "🥛", "product_count": 11 }
]
```

**With a location, only categories that actually have stock there.** A storefront that offers an empty category sends the customer to a blank page.

`id` is a URL-safe slug — use it directly in routes (`/category/rice-and-grains`) and pass it back as `?category=`.

---

### `GET /api/products`

```http
GET /api/products?location=SH1&category=dairy&search=milk&in_stock=true&limit=50&offset=0
```

| Query | Type | Default | Notes |
|---|---|---|---|
| `location` | string | — | Shop code or uuid. Without it, `stock` is `null` |
| `category` | string | — | Category slug from `/api/categories` |
| `search` | string | — | Matches product name **or** SKU, case-insensitive |
| `in_stock` | `true` / `false` | `false` | `true` hides anything not sellable right now |
| `limit` | int | 100 | Capped at 200 |
| `offset` | int | 0 | Pagination |

Returns a **plain array** — not wrapped in an envelope:

```json
[
  {
    "id": "3f8a1c2e-…",
    "sku": "PRD-2026-000001",
    "slug": "toned-milk-500ml",
    "name": "Toned Milk 500ml",
    "description": "Pasteurised toned milk",
    "category": "dairy",
    "unit": "500 ml pouch",
    "base_unit": "PCS",
    "retailPrice": 27.5,
    "mrp": 30,
    "wholesalePrice": 24,
    "stock": 48,
    "image_url": "https://…/products/ab/cd/ef…thumb.webp",
    "images": []
  }
]
```

| Field | Meaning |
|---|---|
| `id` | Stable uuid. Use as a React key; never show it |
| `sku` | Internal code. Print on receipts, scan at a counter |
| `slug` | SEO-safe. Use in URLs: `/product/toned-milk-500ml` |
| `category` | Slug, matches the `id` from `/api/categories` |
| `unit` | How it is sold — `"500 ml pouch"`, `"1 kg"`. Display next to the name |
| `base_unit` | The measurement unit: `PCS`, `KG`, `L` |
| `retailPrice` | **What the customer pays.** Rupees, already divided |
| `mrp` | Printed maximum. Show struck through when it exceeds retail |
| `wholesalePrice` | B2B price, or `null`. Show only to trade customers |
| `stock` | Sellable **at this location**. `null` if no location was named |
| `image_url` | Thumbnail, absolute URL, or `null` |
| `cost` | **Only with `cost:read`.** What you paid. Never render this |

**All money is rupees as a JSON number.** No paise arithmetic, no string parsing, no dividing by 100. `27.5` means ₹27.50. Format with `toLocaleString("en-IN", { style: "currency", currency: "INR" })`.

---

### `GET /api/products/:slug_or_sku`

```http
GET /api/products/toned-milk-500ml?location=SH1
GET /api/products/PRD-2026-000001?location=SH1
GET /api/products/3f8a1c2e-…?location=SH1
```

**Slug, SKU code, or uuid — all three work.** A storefront links by slug, a scanner produces a code, an integration holds a uuid, and making any of them look the product up twice is a round trip for nothing.

Everything the listing returns, plus:

```json
{
  "…": "all listing fields",
  "category_name": "Dairy",
  "sold_by_weight": false,
  "shelf_life_days": 4,
  "hsn_code": "0401",
  "tax_rate": 5,
  "location": "SH1",
  "images": [
    { "url": "https://…/full.webp", "thumb_url": "https://…/thumb.webp",
      "alt": "Toned milk pouch, front", "width": 1200, "height": 1200, "primary": true }
  ],
  "available_elsewhere": [
    { "location": "SH3", "name": "Dadar", "stock": 12 }
  ]
}
```

| Field | Use it for |
|---|---|
| `sold_by_weight` | `true` → let the customer pick a weight, not a count |
| `shelf_life_days` | "Best within 4 days" |
| `hsn_code`, `tax_rate` | Invoices and GST lines. `tax_rate` is a percentage |
| `images` | The gallery. Ordered, primary first |
| **`available_elsewhere`** | **Where else it can be bought.** Rather than showing "out of stock" and losing the sale, offer another shop |

`404` if no such product.

---

### `PATCH /api/products/:slug_or_sku` — edit the listing

Scope: `catalog:write`

```json
{
  "name": "Toned Milk 500 ml",
  "description": "Pasteurised toned milk, 3% fat",
  "category": "dairy",
  "unit": "500 ml pouch"
}
```

Every field is optional; omitted fields are left alone. Naming a category that does not exist **creates it** — the display name comes from the first product to use it.

```json
{ "sku": "PRD-2026-000001", "slug": "toned-milk-500ml",
  "name": "Toned Milk 500 ml", "category": "dairy", "unit": "500 ml pouch" }
```

This is a whitelist, not a spread. A column added to the catalogue tomorrow is not writable through this route by accident.

**There is no endpoint that sets a stock number, and that is deliberate.** Stock is the sum of an append-only ledger. An endpoint that assigned a quantity could make the sum and the number disagree, and then nobody can say which is right. Stock moves through reserve / commit / release, or through a movement ticket in the dashboard with an approval behind it.

---

### `PUT /api/products/:slug_or_sku` — set the price

Scope: `pricing:write`. See [section 6](#6-prices).

---

## 5. The order lifecycle

Three calls, in the order things actually happen:

```
customer checks out   →  POST /api/inventory/reserve   stock is HELD
order is delivered    →  POST /api/inventory/commit    stock is GONE, ledger written
order is cancelled    →  POST /api/inventory/release   stock is BACK
```

Between reserve and commit the goods are still physically on the shelf but nobody else can be sold them. That is what a hold *is*.

**If neither commit nor release ever arrives, the hold expires by itself** — 30 minutes by default — and the stock returns. An abandoned checkout does not lock stock forever.

> **The expiry sweeper must be running in production.** It is a pg_cron job, already scheduled on this deployment. Without it, abandoned carts hold stock permanently and the symptom looks exactly like a stockout.

---

### `POST /api/inventory/reserve`

```json
{
  "order_id": "ord_2026_00871",
  "location": "SH1",
  "ttl_seconds": 1800,
  "items": [
    { "sku": "PRD-2026-000001", "quantity": 2 },
    { "sku": "PRD-2026-000042", "quantity": 1 }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `order_id` | **yes** | **Your** order id. Also the idempotency key — see below |
| `location` | **yes** | Shop code or uuid |
| `items[].sku` | **yes** | SKU code |
| `items[].quantity` | **yes** | Positive integer |
| `ttl_seconds` | no | Hold duration, default `1800` (30 minutes) |

**`201 Created` — everything held:**

```json
{
  "ok": true,
  "order_id": "ord_2026_00871",
  "location": "SH1",
  "items": [
    { "sku": "PRD-2026-000001", "requested": 2, "available": 48,
      "reservation_id": "c1d2…", "problem": null }
  ]
}
```

**`409 Conflict` — one line was short, so NOTHING was held:**

```json
{
  "ok": false,
  "order_id": "ord_2026_00871",
  "location": "SH1",
  "message": "Nothing was held. Every line is listed so you can offer a substitute or reduce the quantity.",
  "items": [
    { "sku": "PRD-2026-000001", "requested": 2, "available": 48, "reservation_id": null, "problem": null },
    { "sku": "PRD-2026-000042", "requested": 1, "available": 0,  "reservation_id": null, "problem": "insufficient" }
  ]
}
```

#### All-or-nothing, on purpose

A partial hold means the customer paid for six things and five arrive. Refusing the whole order keeps the decision with the customer while they are still on the page — and the 409 lists **every** line with its true `available`, so you can say *"the paneer is out, everything else is fine"* and offer a substitute in one screen. No second round trip to find out what was short.

#### Idempotent by `order_id`

A reserve call that times out may or may not have landed. **Send it again.** The same `order_id` returns the same holds; it does not take a second set of stock off the shelf.

Two different orders must never share an `order_id`.

---

### `POST /api/inventory/commit` — delivered

```json
{ "order_id": "ord_2026_00871" }
```

```json
{
  "ok": true,
  "order_id": "ord_2026_00871",
  "items": [ { "sku": "PRD-2026-000001", "quantity": 2, "ledger_entry_id": 89231 } ]
}
```

The hold becomes a real reduction and a ledger entry is written. `ledger_entry_id` is the permanent, auditable record — store it against your order.

**Call this on delivery, not on payment.** Until it lands, the goods are still counted as on the shelf, which is true — they are.

Retrying is safe. An order already committed returns:

```json
{ "ok": true, "order_id": "…", "already_committed": true,
  "items": [ { "sku": "…", "quantity": 2, "status": "CONSUMED" } ] }
```

Stock is not reduced twice.

---

### `POST /api/inventory/release` — cancelled

```json
{ "order_id": "ord_2026_00871", "reason": "customer cancelled" }
```

```json
{ "ok": true, "order_id": "ord_2026_00871", "released": 2 }
```

`released` is how many reservation lines went back. Stock is sellable again immediately. `reason` is optional and lands in the audit trail — send something useful.

---

### `GET /api/inventory/order/:order_id` — what happened?

Scope: `stock:read`

```json
{
  "order_id": "ord_2026_00871",
  "status": "held",
  "items": [
    { "sku": "PRD-2026-000001", "quantity": 2,
      "status": "held", "expires_at": "2026-08-30T14:32:00.000Z" }
  ]
}
```

`status` is one word to branch on: **`held`** · **`delivered`** · **`released`**.

`404` means nothing was ever reserved for that id — which tells you a timed-out reserve **did not land**, and is safe to send again.

**This is the endpoint that saves you.** Without it, a timeout leaves two options: reserve again (double-holding real stock) or abandon it and wait out the expiry. Call this instead.

---

## 6. Prices

Three numbers per product, stored in paise, served in rupees:

| Field | Meaning |
|---|---|
| `retailPrice` | What a walk-in customer pays |
| `mrp` | Printed maximum. `retailPrice ≤ mrp` is a database constraint — selling above MRP is illegal, not merely unwise |
| `wholesalePrice` | B2B price, optional. `wholesalePrice ≤ retailPrice` is also enforced |

### Setting a price

```http
PUT /api/products/PRD-2026-000001
```

```json
{ "retailPrice": 27.5, "mrp": 30, "wholesalePrice": 24 }
```

Both `retailPrice` and `mrp` are **required together** — you cannot set one without the other, because the legal ceiling and the price are only meaningful as a pair. Omitting one is a `422`.

```json
{ "sku": "PRD-2026-000001", "location": null,
  "retailPrice": 27.5, "mrp": 30, "wholesalePrice": 24,
  "scope": "all locations" }
```

### Per-shop prices

By default a price applies **everywhere**. Add `?location=SH3` to set an override for one shop:

```http
PUT /api/products/PRD-2026-000001?location=SH3
```

```json
{ "…": "…", "scope": "location" }
```

Reads resolve the override first and fall back to the everywhere price. Most products need no override at all.

### Why cost is not shipped to the browser

An early draft had the storefront compute a B2B price as `cost × 1.15`. Two problems:

1. **It publishes your margin.** Cost in a JSON response is cost in devtools.
2. **It moves under you.** Cost here is a *weighted average* — it changes every time you buy at a different price. B2B prices would drift with nobody deciding they should.

So wholesale is a number somebody sets. `cost` appears only for a key holding `cost:read`, which a storefront should not have.

---

## 7. Images

`image_url` and `images[].url` are **absolute URLs**, ready for `<img src>`. Served straight from Supabase Storage through its CDN — not proxied through the API, so they cache properly and cost nothing to serve.

```jsx
<img src={product.image_url} alt={product.name} loading="lazy" />
```

**Image URLs need no authentication.** A browser will not attach a bearer token to an `<img>` tag, and an authenticated image endpoint would mean fetching every photo as a blob — defeating the browser cache, the CDN and lazy loading at once, on the device least able to afford it.

That is safe because the key in the URL is the **SHA-256 of the file's bytes**. It cannot be guessed or enumerated, and knowing one tells you nothing about any other. Product photographs are also, by design, the pictures a shop wants on a storefront.

- `image_url` — the thumbnail, for listings
- `images[].url` — full size, for the detail gallery
- `images[].thumb_url` — falls back to the full image if no thumbnail exists. A missing thumbnail should cost bandwidth, not show a broken picture
- `images[].alt` — real alt text. Use it
- `images[].width` / `height` — set these on the tag to stop layout shift

For the Next.js `<Image>` component, add the storage host to `next.config.js` → `images.remotePatterns`.

---

## 8. Errors

Every error is JSON with the same shape:

```json
{ "error": "insufficient_scope", "message": "This key does not hold the \"pricing:write\" scope." }
```

| Status | `error` | What it means | What to do |
|---|---|---|---|
| `400` | `bad_request` | Malformed body | Fix the call |
| `400` | `location_required` | No shop named on a stock call | Send `location` |
| `401` | `unauthorized` | Missing or invalid key | Check the header |
| `403` | `insufficient_scope` | Key lacks the scope | Mint a key that has it |
| `403` | `forbidden` | Key is not bound to that shop | Not a retry — the key genuinely may not sell there |
| `404` | `not_found` | No such product or order | — |
| `409` | — | A reserve line was short | Read `items`, offer a substitute |
| `422` | `price_required` | Price sent without MRP | Send both |
| `429` | `rate_limited` | Too many requests | Wait `retry_after` seconds |
| `500` | `error` | Our fault | Retry with backoff; it is logged |
| `503` | — | Database unreachable | Retry with backoff |

`403` is never worth retrying. `429`, `500` and `503` are.

---

## 9. Rate limits

**600 requests per minute** per key by default, as a token bucket with a burst of 600 — so a page that fires forty requests at once is fine, and a client that idles then bursts behaves the way the number suggests it should.

A `429` carries `Retry-After` in the headers and `retry_after` (seconds) in the body. Honour it.

If your storefront is polling the catalogue to keep stock fresh: **don't.** Subscribe to the `stock.changed` and `reservation.expired` webhooks instead — configurable in the dashboard. Polling burns your budget to learn that nothing has changed.

---

## 10. A complete Next.js integration

### `.env.local` on the **storefront** — server-side only, no `NEXT_PUBLIC_`

```bash
INVENTORY_API_URL=https://your-inventory.vercel.app
INVENTORY_API_KEY=ic_live_a1b2c3...
INVENTORY_LOCATION=SH1
```

### `lib/inventory.ts`

```ts
const BASE = process.env.INVENTORY_API_URL!;
const KEY = process.env.INVENTORY_API_KEY!;
export const LOCATION = process.env.INVENTORY_LOCATION!;

if (!BASE || !KEY) throw new Error("Inventory API is not configured");

export type Product = {
  id: string; sku: string; slug: string; name: string;
  description: string | null; category: string | null;
  unit: string | null; base_unit: string;
  retailPrice: number | null; mrp: number | null; wholesalePrice: number | null;
  stock: number | null; image_url: string | null;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    // Catalogue reads may cache briefly. Stock reads must not.
    cache: "no-store",
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const err = new Error(body?.message ?? `Inventory API ${res.status}`);
    Object.assign(err, { status: res.status, code: body?.error, body });
    throw err;
  }
  return body as T;
}

export const listProducts = (params: Record<string, string> = {}) =>
  call<Product[]>(
    "/api/products?" + new URLSearchParams({ location: LOCATION, ...params }));

export const getProduct = (slugOrSku: string) =>
  call<Product & { images: any[]; available_elsewhere: any[] }>(
    `/api/products/${encodeURIComponent(slugOrSku)}?location=${LOCATION}`);

export const listCategories = () =>
  call<{ id: string; name: string; icon: string; product_count: number }[]>(
    `/api/categories?location=${LOCATION}`);

export const reserve = (orderId: string, items: { sku: string; quantity: number }[]) =>
  call<any>("/api/inventory/reserve", {
    method: "POST",
    body: JSON.stringify({ order_id: orderId, location: LOCATION, items }),
  });

export const commit = (orderId: string) =>
  call<any>("/api/inventory/commit", {
    method: "POST", body: JSON.stringify({ order_id: orderId }),
  });

export const release = (orderId: string, reason?: string) =>
  call<any>("/api/inventory/release", {
    method: "POST", body: JSON.stringify({ order_id: orderId, reason }),
  });

export const orderStatus = (orderId: string) =>
  call<{ order_id: string; status: "held" | "delivered" | "released"; items: any[] }>(
    `/api/inventory/order/${encodeURIComponent(orderId)}`);
```

### A product listing page (server component)

```tsx
import { listProducts } from "@/lib/inventory";

export default async function Shop({
  searchParams,
}: { searchParams: Promise<{ category?: string; q?: string }> }) {
  const { category, q } = await searchParams;

  const products = await listProducts({
    ...(category ? { category } : {}),
    ...(q ? { search: q } : {}),
    in_stock: "true",
  });

  return (
    <div className="grid">
      {products.map((p) => (
        <a key={p.id} href={`/product/${p.slug}`}>
          <img src={p.image_url ?? "/placeholder.png"} alt={p.name} loading="lazy" />
          <h3>{p.name}</h3>
          <p>{p.unit}</p>
          <strong>₹{p.retailPrice?.toFixed(2)}</strong>
          {p.mrp && p.retailPrice && p.mrp > p.retailPrice && (
            <s>₹{p.mrp.toFixed(2)}</s>
          )}
          {p.stock !== null && p.stock < 5 && <span>Only {p.stock} left</span>}
        </a>
      ))}
    </div>
  );
}
```

### Checkout — the part that matters

```ts
// app/api/checkout/route.ts — YOUR server route. The browser calls this.
import { reserve, commit, release, orderStatus } from "@/lib/inventory";

export async function POST(req: Request) {
  const { cart } = await req.json();

  // Your order id, generated BEFORE the reserve call — it is the
  // idempotency key, so it has to survive a retry.
  const orderId = await createOrderInYourDatabase(cart);

  let held;
  try {
    held = await reserve(orderId, cart.map((i: any) => ({
      sku: i.sku, quantity: i.quantity,
    })));
  } catch (e: any) {
    // A timeout is not a failure — it is an unknown. Ask.
    if (!e.status) {
      const status = await orderStatus(orderId).catch(() => null);
      if (status?.status === "held") held = { ok: true };
    }

    if (!held && e.status === 409) {
      const short = e.body.items.filter((i: any) => i.problem);
      return Response.json({
        error: "out_of_stock",
        message: `Sorry — ${short.map((s: any) => s.sku).join(", ")} just sold out.`,
        items: e.body.items,          // every line, so the UI can suggest swaps
      }, { status: 409 });
    }
    if (!held) throw e;
  }

  // Stock is now held for 30 minutes. Take the payment.
  try {
    await takePayment(orderId);
  } catch (e) {
    await release(orderId, "payment failed");   // give it back immediately
    throw e;
  }

  // Do NOT commit here. Commit when it is delivered.
  return Response.json({ ok: true, order_id: orderId });
}
```

```ts
// When the delivery is marked complete:
await commit(orderId);

// When the customer cancels:
await release(orderId, "customer cancelled");
```

---

## 11. Things that will bite you

**Sending no `location`.** Products come back with `stock: null` and you render "0 in stock" for a full shelf. Always send it.

**Committing on payment instead of on delivery.** Stock leaves the ledger before it leaves the building. If the delivery is then cancelled you have to correct it by hand.

**Generating `order_id` after the reserve call.** It *is* the idempotency key. Create it first, in your own database, so a retry carries the same one.

**Treating a timeout as a failure.** It may have landed. Call `GET /api/inventory/order/:id` before doing anything else — reserving again with a *new* id holds the stock twice, and both holds are real.

**Trusting `stock` at render time.** It is true when the response is written and can be stale a second later. The reserve call is the only thing that decides whether a sale can happen, and it is atomic — 200 concurrent holds against 100 units yield exactly 100 successes and 100 clean 409s.

**Putting the key in client code.** `NEXT_PUBLIC_INVENTORY_API_KEY` is a key published to the internet.

**Assuming `mrp > retailPrice`.** Often they are equal. Only show a struck-through MRP when it is genuinely higher.

**Rendering `cost` if you ever hold `cost:read`.** That is your buying price on a public page.

---

## 12. Checklist before going live

**On the inventory deployment**

- [ ] `DATABASE_URL` points at the **pooler** — `aws-0-….pooler.supabase.com:6543` — not `db.….supabase.co:5432`, which is IPv6-only and does not resolve from a serverless function
- [ ] `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_DRIVER=supabase` set
- [ ] `ADMIN_EMAIL`, `ADMIN_PASSWORD` set
- [ ] `PUBLIC_BASE_URL` set, so image URLs are absolute and correct
- [ ] `STOREFRONT_ORIGINS` set **only** if the browser calls the API directly
- [ ] The reservation-expiry job is scheduled — it is, via pg_cron; confirm with `npm run db:jobs`
- [ ] `GET /api/health` returns all-green
- [ ] Demo users' passwords changed, or the accounts removed

**On the storefront**

- [ ] Key stored server-side only; no `NEXT_PUBLIC_` prefix
- [ ] Key scoped to the right shops, and **without** `cost:read`
- [ ] `location` sent on every catalogue and stock call
- [ ] `order_id` generated before reserve, stored, reused on retry
- [ ] 409 handled with the per-line detail shown to the customer
- [ ] Commit fires on **delivery**; release fires on cancellation and on payment failure
- [ ] `orderStatus` consulted after any timeout
- [ ] 429 honours `Retry-After`

---

## Quick reference

```bash
export K="ic_live_..."
export B="https://your-inventory.vercel.app"

curl -H "Authorization: Bearer $K" "$B/api/locations"
curl -H "Authorization: Bearer $K" "$B/api/categories?location=SH1"
curl -H "Authorization: Bearer $K" "$B/api/products?location=SH1&limit=3"
curl -H "Authorization: Bearer $K" "$B/api/products/PRD-2026-000001?location=SH1"

curl -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"order_id":"test-1","location":"SH1","items":[{"sku":"PRD-2026-000001","quantity":1}]}' \
  "$B/api/inventory/reserve"

curl -H "Authorization: Bearer $K" "$B/api/inventory/order/test-1"

curl -X POST -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"order_id":"test-1","reason":"just testing"}' \
  "$B/api/inventory/release"
```
