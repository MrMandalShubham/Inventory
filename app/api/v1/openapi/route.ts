import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/v1/openapi — the published contract.
 *
 * Deliberately unauthenticated: a developer has to be able to read
 * the spec before they have a key. It describes shapes, never data.
 */
const SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Inventory Core API",
    version: "1.0.0",
    description:
      "Stock as a system of record. Every write requires an Idempotency-Key: a network " +
      "timeout is indistinguishable from a failure, so clients retry, and without a key " +
      "the retry takes a second unit off the shelf.",
  },
  servers: [{ url: "/api/v1" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http", scheme: "bearer",
        description: "An API key: Authorization: Bearer ic_live_… (or ic_test_… on a sandbox deployment).",
      },
    },
    parameters: {
      IdempotencyKey: {
        name: "Idempotency-Key", in: "header", required: true,
        schema: { type: "string" },
        description:
          "Reuse the SAME key when retrying. The original response is returned verbatim, " +
          "with Idempotent-Replay: true. Reusing a key for a different request is a 422.",
      },
    },
    schemas: {
      Reservation: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          product_id: { type: "string", format: "uuid" },
          location_id: { type: "string", format: "uuid" },
          quantity: { type: "integer" },
          status: { type: "string", enum: ["HELD", "CONFIRMED", "CONSUMED", "RELEASED"] },
          order_ref: { type: "string", nullable: true },
          expires_at: { type: "string", format: "date-time", nullable: true },
        },
      },
      StockLine: {
        type: "object",
        properties: {
          product_id: { type: "string", format: "uuid" },
          sku_code: { type: "string" },
          location_code: { type: "string" },
          on_hand: { type: "integer" },
          reserved: { type: "integer" },
          available: {
            type: "integer",
            description:
              "What may actually be sold. Sell against this, never against on_hand.",
          },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: { code: { type: "string" }, message: { type: "string" } },
          },
        },
      },
    },
  },
  paths: {
    "/stock": {
      get: {
        summary: "Current stock",
        description: "Sell against `available`, never `on_hand`.",
        parameters: [
          { name: "product_id", in: "query", schema: { type: "string" } },
          { name: "location_id", in: "query", schema: { type: "string" } },
          { name: "sku_code", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Stock lines this key may see" } },
      },
    },
    "/products": {
      get: {
        summary: "Search the catalogue",
        parameters: [
          {
            name: "q", in: "query", schema: { type: "string" },
            description: "Exact match on code or barcode ranks above a fuzzy name match.",
          },
        ],
        responses: { "200": { description: "Products" } },
      },
    },
    "/reservations": {
      post: {
        summary: "Hold stock for a checkout",
        description:
          "Held at CHECKOUT, not at add-to-cart: holding at cart makes one browsing " +
          "shopper look like a stockout to everyone else. Returns 409 insufficient_stock " +
          "when the quantity is not available — never a partial hold.",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["product_id", "location_id", "quantity"],
                properties: {
                  product_id: { type: "string", format: "uuid" },
                  location_id: { type: "string", format: "uuid" },
                  quantity: { type: "integer", minimum: 1 },
                  order_ref: { type: "string" },
                  ttl_seconds: { type: "integer", default: 900 },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Held" },
          "409": { description: "insufficient_stock" },
        },
      },
      get: { summary: "List reservations", responses: { "200": { description: "Reservations" } } },
    },
    "/reservations/{id}/confirm": {
      post: {
        summary: "The customer paid — the hold stops expiring",
        description: "Nothing moves. The stock is still on the shelf and still not sold.",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        responses: { "200": { description: "Confirmed" } },
      },
    },
    "/reservations/{id}/consume": {
      post: {
        summary: "The goods left — writes the ledger entry",
        description: "The only step in the lifecycle that moves stock.",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        responses: { "200": { description: "Consumed" } },
      },
    },
    "/reservations/{id}/release": {
      post: {
        summary: "Abandoned or cancelled — the stock becomes available again",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        responses: { "200": { description: "Released" } },
      },
    },
    "/ledger": {
      get: {
        summary: "The history book",
        description:
          "Pass as_of to reconstruct the position on a past date — free because the log " +
          "is append-only, and impossible without it.",
        parameters: [
          { name: "as_of", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "product_id", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Entries, or a point-in-time position" } },
      },
    },
    "/movements": {
      get: { summary: "Movement tickets", responses: { "200": { description: "Movements" } } },
    },
  },
  "x-scopes": {
    "catalog:read": "Read products, images and barcodes",
    "catalog:write": "Add product images",
    "stock:read": "Read stock, reservations and the ledger",
    "reservations:write": "Hold, confirm, consume and release stock",
    "movements:read": "Read movement tickets",
    "*": "Everything — issue sparingly",
  },
  "x-webhooks": {
    "stock.changed": "A quantity moved at a location this key can see",
    "stock.low": "A product crossed its reorder point",
    "movement.closed": "A ticket reached CLOSED",
    "reservation.expired": "The sweeper released an abandoned hold",
  },
};

export async function GET() {
  return NextResponse.json(SPEC, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
