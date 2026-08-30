// The catalogue: ten categories and everything that sits in them.
//
// ── Why this is a module and not part of seed.mjs ──
//
// Two things need this list and they need it to agree. seed.mjs
// rebuilds a database from nothing; catalogue-load.mjs adds what is
// missing to a database that already has stock and orders in it and
// must not be truncated. Two copies of a hundred products would drift
// on the first edit, and the symptom would be a shop whose catalogue
// depends on which script last ran.
//
// ── The categories are the storefront's ──
//
// They are the ten tiles a customer sees, in the order they see them.
// The inventory used to have its own list — Staples, Dairy, Fruit &
// Veg, Beauty, Household — which was nobody's list: not the shelf
// layout, not the storefront's, not a supplier's. A product's category
// is a shopping decision, so it belongs to the app doing the shopping.
//
// ── Money ──
//
// cost, retail, mrp and wholesale are RUPEES PER PACK, because that is
// how a shopkeeper says them. The ledger wants paise per base unit, so
// `unitCostPaise` below does that one conversion in one place. Writing
// "14 paise per gram" a hundred times is how a decimal point ends up
// in the wrong column.
//
// mrp is the printed ceiling and retail must not exceed it — the
// database enforces that, because selling above MRP is illegal.

/** The ten tiles, in the order the storefront shows them. */
export const CATEGORIES = [
  { id: "fruits-veggies",     name: "Fruits & Veggies",     icon: "🥬" },
  { id: "dairy-bread-eggs",   name: "Dairy, Bread & Eggs",  icon: "🥛" },
  { id: "atta-rice-dal",      name: "Atta, Rice & Dal",     icon: "🌾" },
  { id: "oil-ghee-masala",    name: "Oil, Ghee & Masala",   icon: "🛢️" },
  { id: "snacks-namkeen",     name: "Snacks & Namkeen",     icon: "🍿" },
  { id: "cold-drinks",        name: "Cold Drinks",          icon: "🥤" },
  { id: "instant-noodles",    name: "Instant & Noodles",    icon: "🍜" },
  { id: "bakery-biscuits",    name: "Bakery & Biscuits",    icon: "🍪" },
  { id: "cleaning-household", name: "Cleaning & Household", icon: "🧽" },
  { id: "personal-care",      name: "Personal Care",        icon: "🧴" },
];

/**
 * The old free-text categories, and where their products now live.
 *
 * Migration 0052 uses the same mapping. It is here as well because a
 * database seeded fresh never had the old names, and one that was
 * migrated did — and both have to end up identical.
 */
export const RETIRED_CATEGORIES = {
  "Staples":     "Atta, Rice & Dal",
  "Dairy":       "Dairy, Bread & Eggs",
  "Fruit & Veg": "Fruits & Veggies",
  "Beauty":      "Personal Care",
  "Household":   "Cleaning & Household",
};

// name, uom, packBase, pack, cost, retail, mrp, wholesale, hsn, gst%, opts
//
//   packBase — base units in one pack. Stock is counted in grams and
//              millilitres; nobody buys 500 millilitres, they buy a
//              bottle, and this is the bridge between the two.
//   opts     — batch: shelf life in days (implies BATCH tracking)
//              weighed: sold loose, by weight
//              serial: tracked individually
//              barcode: EAN, where the demo has one
const P = [
  // ─────────────── Fruits & Veggies ───────────────
  ["Tomatoes",                "G",  1000, "1 kg",   22,  40,  45,  35, "0702",  0, { batch: 4,  weighed: true }],
  ["Onions",                  "G",  1000, "1 kg",   24,  38,  42,  33, "0703",  0, { batch: 21, weighed: true }],
  ["Bananas",                 "G",  1000, "6 pcs",  36,  55,  60,  48, "0803",  0, { batch: 6,  weighed: true }],
  ["Potatoes",                "G",  1000, "1 kg",   20,  32,  36,  27, "0701",  0, { batch: 30, weighed: true }],
  ["Cauliflower",             "G",  1000, "1 pc",   26,  42,  48,  36, "0704",  0, { batch: 5,  weighed: true }],
  ["Green Capsicum",          "G",  1000, "500 g",  38,  60,  68,  52, "0709",  0, { batch: 7,  weighed: true }],
  ["Carrots",                 "G",  1000, "500 g",  28,  45,  50,  38, "0706",  0, { batch: 12, weighed: true }],
  ["Lady Finger",             "G",  1000, "500 g",  32,  52,  58,  44, "0709",  0, { batch: 5,  weighed: true }],
  ["Spinach Bunch",           "G",   250, "1 bunch", 12, 20,  25,  16, "0709",  0, { batch: 3,  weighed: true }],
  ["Shimla Apples",           "G",  1000, "1 kg",   95, 145, 160, 125, "0808",  0, { batch: 20, weighed: true }],
  ["Pomegranate",             "G",  1000, "1 kg",  110, 168, 185, 145, "0810",  0, { batch: 14, weighed: true }],
  ["Green Grapes",            "G",   500, "500 g",  42,  68,  75,  58, "0806",  0, { batch: 8,  weighed: true }],
  ["Lemons",                  "G",   250, "250 g",  16,  28,  32,  23, "0805",  0, { batch: 15, weighed: true }],

  // ─────────────── Dairy, Bread & Eggs ───────────────
  ["Full Cream Milk 500ml",   "ML",  500, "500 ml", 30,  34,  35,  31, "0401",  0, { batch: 5,  barcode: "8901234500059" }],
  ["Curd 400g",               "G",   400, "400 g",  32,  42,  45,  38, "0403",  0, { batch: 7,  barcode: "8901234500066" }],
  ["Paneer 200g",             "G",   200, "200 g",  84,  99, 110,  89, "0406",  0, { batch: 10 }],
  ["Toned Milk 1L",           "ML", 1000, "1 L",    58,  68,  72,  62, "0401",  0, { batch: 5,  barcode: "8901234510001" }],
  ["Butter 100g",             "G",   100, "100 g",  48,  62,  66,  56, "0405", 12, { batch: 180, barcode: "8901234510002" }],
  ["Cheese Slices 200g",      "G",   200, "200 g",  98, 135, 145, 122, "0406", 12, { batch: 120, barcode: "8901234510003" }],
  ["Fresh Cream 200ml",       "ML",  200, "200 ml", 52,  72,  78,  64, "0401", 12, { batch: 45, barcode: "8901234510004" }],
  ["Brown Bread 400g",        "G",   400, "400 g",  32,  45,  50,  40, "1905",  5, { batch: 4,  barcode: "8901234510005" }],
  ["White Bread 400g",        "G",   400, "400 g",  28,  40,  45,  35, "1905",  5, { batch: 4,  barcode: "8901234510006" }],
  ["Farm Eggs 6 pcs",         "PCS",   6, "6 pcs",  42,  60,  66,  53, "0407",  0, { batch: 21 }],
  ["Sweet Lassi 200ml",       "ML",  200, "200 ml", 16,  25,  28,  21, "0403", 12, { batch: 15, barcode: "8901234510007" }],
  ["Buttermilk 500ml",        "ML",  500, "500 ml", 18,  28,  32,  24, "0403", 12, { batch: 10, barcode: "8901234510008" }],
  ["Mozzarella Cheese 200g",  "G",   200, "200 g", 118, 165, 180, 148, "0406", 12, { batch: 90, barcode: "8901234510009" }],

  // ─────────────── Atta, Rice & Dal ───────────────
  ["Toor Dal 1kg",            "G",  1000, "1 kg",  140, 165, 180, 148, "0713",  5, { barcode: "8901234500011" }],
  ["Basmati Rice 5kg",        "G",  5000, "5 kg",  600, 640, 699, 575, "1006",  5, { barcode: "8901234500028" }],
  ["Atta 10kg",               "G", 10000, "10 kg", 400, 445, 480, 399, "1101",  5, { barcode: "8901234500035" }],
  ["Chana Dal 1kg",           "G",  1000, "1 kg",   82,  98, 108,  89, "0713",  5, { barcode: "8901234510010" }],
  ["Moong Dal 1kg",           "G",  1000, "1 kg",  118, 142, 155, 128, "0713",  5, { barcode: "8901234510011" }],
  ["Masoor Dal 1kg",          "G",  1000, "1 kg",   88, 108, 118,  98, "0713",  5, { barcode: "8901234510012" }],
  ["Urad Dal 500g",           "G",   500, "500 g",  62,  78,  85,  70, "0713",  5, { barcode: "8901234510013" }],
  ["Rajma 1kg",               "G",  1000, "1 kg",  132, 162, 178, 146, "0713",  5, { barcode: "8901234510014" }],
  ["Kabuli Chana 1kg",        "G",  1000, "1 kg",  105, 128, 140, 116, "0713",  5, { barcode: "8901234510015" }],
  ["Sona Masoori Rice 5kg",   "G",  5000, "5 kg",  345, 398, 435, 360, "1006",  5, { barcode: "8901234510016" }],
  ["Poha 500g",               "G",   500, "500 g",  28,  38,  42,  34, "1104",  5, { barcode: "8901234510017" }],
  ["Suji Rava 500g",          "G",   500, "500 g",  26,  36,  40,  32, "1103",  5, { barcode: "8901234510018" }],
  ["Besan 500g",              "G",   500, "500 g",  48,  62,  68,  56, "1106",  5, { barcode: "8901234510019" }],

  // ─────────────── Oil, Ghee & Masala ───────────────
  ["Refined Sunflower Oil 1L","ML", 1000, "1 L",   130, 149, 165, 134, "1512",  5, { barcode: "8901234500042" }],
  ["Mustard Oil 1L",          "ML", 1000, "1 L",   142, 168, 185, 152, "1514",  5, { barcode: "8901234510020" }],
  ["Groundnut Oil 1L",        "ML", 1000, "1 L",   165, 195, 215, 176, "1508",  5, { barcode: "8901234510021" }],
  ["Desi Ghee 500ml",         "ML",  500, "500 ml",295, 345, 380, 312, "0405", 12, { batch: 365, barcode: "8901234510022" }],
  ["Turmeric Powder 200g",    "G",   200, "200 g",  42,  58,  64,  52, "0910",  5, { batch: 540, barcode: "8901234510023" }],
  ["Red Chilli Powder 200g",  "G",   200, "200 g",  58,  78,  85,  70, "0904",  5, { batch: 540, barcode: "8901234510024" }],
  ["Coriander Powder 200g",   "G",   200, "200 g",  38,  52,  58,  47, "0909",  5, { batch: 540, barcode: "8901234510025" }],
  ["Garam Masala 100g",       "G",   100, "100 g",  52,  72,  80,  65, "0910",  5, { batch: 540, barcode: "8901234510026" }],
  ["Cumin Seeds 100g",        "G",   100, "100 g",  48,  68,  75,  61, "0909",  5, { batch: 540, barcode: "8901234510027" }],
  ["Mustard Seeds 100g",      "G",   100, "100 g",  18,  26,  30,  23, "1207",  5, { batch: 540, barcode: "8901234510028" }],
  ["Iodised Salt 1kg",        "G",  1000, "1 kg",   18,  28,  30,  24, "2501",  0, { barcode: "8901234510029" }],

  // ─────────────── Snacks & Namkeen ───────────────
  ["Aloo Bhujia 200g",        "G",   200, "200 g",  38,  52,  55,  46, "2106", 12, { batch: 120, barcode: "8901234510030" }],
  ["Potato Chips 90g",        "G",    90, "90 g",   14,  20,  20,  17, "2005", 12, { batch: 120, barcode: "8901234510031" }],
  ["Mixture Namkeen 400g",    "G",   400, "400 g",  72,  98, 105,  88, "2106", 12, { batch: 120, barcode: "8901234510032" }],
  ["Moong Dal Namkeen 200g",  "G",   200, "200 g",  42,  58,  62,  52, "2106", 12, { batch: 120, barcode: "8901234510033" }],
  ["Salted Peanuts 200g",     "G",   200, "200 g",  32,  45,  50,  40, "2008", 12, { batch: 180, barcode: "8901234510034" }],
  ["Methi Khakhra 200g",      "G",   200, "200 g",  46,  65,  70,  58, "1905",  5, { batch: 90,  barcode: "8901234510035" }],
  ["Popcorn 70g",             "G",    70, "70 g",   22,  35,  40,  30, "2008", 12, { batch: 150, barcode: "8901234510036" }],
  ["Nachos 150g",             "G",   150, "150 g",  52,  75,  80,  66, "1905", 12, { batch: 120, barcode: "8901234510037" }],
  ["Roasted Chana 200g",      "G",   200, "200 g",  28,  42,  45,  37, "2008", 12, { batch: 180, barcode: "8901234510038" }],
  ["Banana Chips 200g",       "G",   200, "200 g",  48,  68,  72,  60, "2008", 12, { batch: 90,  barcode: "8901234510039" }],

  // ─────────────── Cold Drinks ───────────────
  ["Cola 750ml",              "ML",  750, "750 ml", 28,  40,  40,  35, "2202", 28, { batch: 180, barcode: "8901234510040" }],
  ["Lemon Soda 750ml",        "ML",  750, "750 ml", 28,  40,  40,  35, "2202", 28, { batch: 180, barcode: "8901234510041" }],
  ["Orange Drink 600ml",      "ML",  600, "600 ml", 26,  38,  40,  33, "2202", 28, { batch: 150, barcode: "8901234510042" }],
  ["Mango Drink 600ml",       "ML",  600, "600 ml", 26,  38,  40,  33, "2202", 28, { batch: 150, barcode: "8901234510043" }],
  ["Packaged Water 1L",       "ML", 1000, "1 L",     8,  20,  20,  16, "2201", 18, { batch: 365, barcode: "8901234510044" }],
  ["Soda Water 750ml",        "ML",  750, "750 ml", 16,  25,  25,  22, "2201", 18, { batch: 240, barcode: "8901234510045" }],
  ["Iced Tea Lemon 400ml",    "ML",  400, "400 ml", 22,  35,  38,  30, "2202", 28, { batch: 150, barcode: "8901234510046" }],
  ["Apple Juice 1L",          "ML", 1000, "1 L",    72,  99, 110,  88, "2009", 12, { batch: 180, barcode: "8901234510047" }],
  ["Mixed Fruit Juice 1L",    "ML", 1000, "1 L",    68,  95, 105,  84, "2009", 12, { batch: 180, barcode: "8901234510048" }],
  ["Energy Drink 250ml",      "ML",  250, "250 ml", 78, 110, 115,  98, "2202", 28, { batch: 270, barcode: "8901234510049" }],

  // ─────────────── Instant & Noodles ───────────────
  ["Masala Noodles 70g",      "G",    70, "70 g",   10,  14,  14,  12, "1902", 12, { batch: 240, barcode: "8901234510050" }],
  ["Masala Noodles 4 pack",   "G",   280, "4 pack", 38,  56,  56,  49, "1902", 12, { batch: 240, barcode: "8901234510051" }],
  ["Cup Noodles 70g",         "G",    70, "70 g",   28,  40,  42,  35, "1902", 12, { batch: 210, barcode: "8901234510052" }],
  ["Instant Pasta 70g",       "G",    70, "70 g",   16,  25,  25,  22, "1902", 12, { batch: 240, barcode: "8901234510053" }],
  ["Vermicelli 400g",         "G",   400, "400 g",  34,  48,  52,  42, "1902",  5, { batch: 300, barcode: "8901234510054" }],
  ["Ready Poha Mix 200g",     "G",   200, "200 g",  32,  46,  50,  40, "1904", 12, { batch: 180, barcode: "8901234510055" }],
  ["Instant Upma Mix 200g",   "G",   200, "200 g",  34,  48,  52,  42, "1904", 12, { batch: 180, barcode: "8901234510056" }],
  ["Tomato Soup Sachet 50g",  "G",    50, "50 g",   14,  22,  25,  19, "2104", 12, { batch: 300, barcode: "8901234510057" }],
  ["Macaroni 500g",           "G",   500, "500 g",  46,  65,  70,  57, "1902", 12, { batch: 300, barcode: "8901234510058" }],
  ["Instant Idli Mix 500g",   "G",   500, "500 g",  62,  85,  92,  76, "1901", 12, { batch: 180, barcode: "8901234510059" }],

  // ─────────────── Bakery & Biscuits ───────────────
  ["Glucose Biscuits 200g",   "G",   200, "200 g",  16,  25,  25,  22, "1905", 18, { batch: 180, barcode: "8901234510060" }],
  ["Marie Biscuits 250g",     "G",   250, "250 g",  24,  35,  35,  31, "1905", 18, { batch: 180, barcode: "8901234510061" }],
  ["Cream Biscuits 150g",     "G",   150, "150 g",  18,  28,  30,  24, "1905", 18, { batch: 180, barcode: "8901234510062" }],
  ["Digestive Biscuits 250g", "G",   250, "250 g",  52,  75,  80,  66, "1905", 18, { batch: 180, barcode: "8901234510063" }],
  ["Rusk Toast 300g",         "G",   300, "300 g",  32,  45,  50,  40, "1905",  5, { batch: 90,  barcode: "8901234510064" }],
  ["Chocolate Cookies 200g",  "G",   200, "200 g",  62,  88,  95,  78, "1905", 18, { batch: 180, barcode: "8901234510065" }],
  ["Salted Crackers 200g",    "G",   200, "200 g",  34,  48,  52,  42, "1905", 18, { batch: 180, barcode: "8901234510066" }],
  ["Chocolate Muffin 2 pcs",  "PCS",   2, "2 pcs",  34,  50,  55,  44, "1905", 18, { batch: 12,  barcode: "8901234510067" }],
  ["Fruit Cake 250g",         "G",   250, "250 g",  58,  82,  90,  73, "1905", 18, { batch: 45,  barcode: "8901234510068" }],
  ["Pav Bun 6 pcs",           "PCS",   6, "6 pcs",  22,  32,  35,  28, "1905",  5, { batch: 4,   barcode: "8901234510069" }],

  // ─────────────── Cleaning & Household ───────────────
  ["Dishwash Bar 200g",       "G",   200, "200 g",  18,  25,  28,  22, "3401", 18, { barcode: "8901234500097" }],
  ["Floor Cleaner 1L",        "ML", 1000, "1 L",   110, 185, 199, 159, "3402", 18, { barcode: "8901234500103" }],
  ["Steel Water Bottle 1L",   "PCS",   1, "1 L",   320, 549, 699, 475, "7323", 18, { serial: true, barcode: "8901234500110" }],
  ["Detergent Powder 1kg",    "G",  1000, "1 kg",   98, 135, 145, 122, "3402", 18, { barcode: "8901234510070" }],
  ["Detergent Bar 250g",      "G",   250, "250 g",  14,  22,  25,  19, "3402", 18, { barcode: "8901234510071" }],
  ["Dishwash Liquid 500ml",   "ML",  500, "500 ml", 82, 115, 125, 103, "3402", 18, { barcode: "8901234510072" }],
  ["Toilet Cleaner 500ml",    "ML",  500, "500 ml", 68,  98, 108,  88, "3402", 18, { barcode: "8901234510073" }],
  ["Glass Cleaner 500ml",     "ML",  500, "500 ml", 72, 102, 112,  92, "3402", 18, { barcode: "8901234510074" }],
  ["White Phenyl 1L",         "ML", 1000, "1 L",    58,  85,  95,  76, "3808", 18, { barcode: "8901234510075" }],
  ["Garbage Bags 30 pcs",     "PCS",  30, "30 pcs", 62,  89,  99,  80, "3923", 18, { barcode: "8901234510076" }],
  ["Scrub Pad 3 pcs",         "PCS",   3, "3 pcs",  22,  35,  40,  30, "6805", 18, { barcode: "8901234510077" }],
  ["Room Freshener 220ml",    "ML",  220, "220 ml",108, 152, 165, 136, "3307", 18, { batch: 730, barcode: "8901234510078" }],
  ["Mosquito Refill 45ml",    "ML",   45, "45 ml",  52,  78,  85,  70, "3808", 18, { batch: 730, barcode: "8901234510079" }],

  // ─────────────── Personal Care ───────────────
  ["Face Wash 100ml",         "ML",  100, "100 ml", 95, 149, 175, 129, "3304", 18, { batch: 540, barcode: "8901234500073" }],
  ["Shampoo 340ml",           "ML",  340, "340 ml",211, 299, 340, 259, "3305", 18, { batch: 730, barcode: "8901234500080" }],
  ["Bathing Soap 100g",       "G",   100, "100 g",  28,  42,  45,  37, "3401", 18, { batch: 730, barcode: "8901234510080" }],
  ["Toothpaste 200g",         "G",   200, "200 g",  78, 112, 125, 100, "3306", 18, { batch: 730, barcode: "8901234510081" }],
  ["Toothbrush 2 pcs",        "PCS",   2, "2 pcs",  38,  59,  65,  52, "9603", 18, { barcode: "8901234510082" }],
  ["Coconut Hair Oil 200ml",  "ML",  200, "200 ml", 88, 125, 138, 112, "3305", 18, { batch: 730, barcode: "8901234510083" }],
  ["Body Lotion 200ml",       "ML",  200, "200 ml",118, 168, 185, 150, "3304", 18, { batch: 730, barcode: "8901234510084" }],
  ["Deodorant 150ml",         "ML",  150, "150 ml",128, 185, 199, 165, "3307", 18, { batch: 730, barcode: "8901234510085" }],
  ["Shaving Cream 70g",       "G",    70, "70 g",   52,  78,  85,  70, "3307", 18, { batch: 730, barcode: "8901234510086" }],
  ["Hand Wash 200ml",         "ML",  200, "200 ml", 62,  89,  99,  80, "3401", 18, { batch: 730, barcode: "8901234510087" }],
  ["Talcum Powder 100g",      "G",   100, "100 g",  48,  72,  80,  64, "3304", 18, { batch: 730, barcode: "8901234510088" }],
  ["Sanitary Pads 10 pcs",    "PCS",  10, "10 pcs", 62,  92,  99,  82, "9619",  0, { batch: 730, barcode: "8901234510089" }],
];

// Which category each block belongs to, by position in the list above.
// Kept as a parallel run-length list rather than repeated on every row
// because a hundred copies of "cleaning-household" is a hundred chances
// to typo one of them.
const BLOCKS = [
  ["Fruits & Veggies",     13],
  ["Dairy, Bread & Eggs",  13],
  ["Atta, Rice & Dal",     13],
  ["Oil, Ghee & Masala",   11],
  ["Snacks & Namkeen",     10],
  ["Cold Drinks",          10],
  ["Instant & Noodles",    10],
  ["Bakery & Biscuits",    10],
  ["Cleaning & Household", 13],
  ["Personal Care",        12],
];

function build() {
  const out = [];
  let i = 0;

  for (const [category, count] of BLOCKS) {
    for (let n = 0; n < count; n++, i++) {
      const row = P[i];
      if (!row) throw new Error(`catalogue: BLOCKS expects ${i + 1} rows, list has ${P.length}`);

      const [name, uom, packBase, pack, cost, retail, mrp, wholesale, hsn, gst, opts = {}] = row;

      // Paise per base unit, which is what the ledger and the weighted
      // average are denominated in. Rounding to a whole paise is fine
      // for money but NOT fine at zero: migration 0032 showed that a
      // line entering at no value silently reports the stock as
      // worthless, so refuse rather than seed a lie.
      const unitCostPaise = Math.round((cost * 100) / packBase);
      if (unitCostPaise < 1) {
        throw new Error(
          `catalogue: "${name}" costs ₹${cost} for ${packBase} ${uom}, which rounds to ` +
          "0 paise per unit. Stock would enter the ledger at no value.");
      }

      if (retail > mrp) {
        throw new Error(`catalogue: "${name}" retails at ₹${retail} above its MRP of ₹${mrp}`);
      }
      if (wholesale > retail) {
        throw new Error(`catalogue: "${name}" wholesales at ₹${wholesale} above retail ₹${retail}`);
      }

      out.push({
        name, category, pack, packBase,
        base_uom: uom,
        hsn_code: hsn,
        tax_rate: gst,
        tracking_mode: opts.serial ? "SERIAL" : opts.batch ? "BATCH" : "NONE",
        ...(opts.batch ? { shelf_life_days: opts.batch } : {}),
        ...(opts.weighed ? { is_weighed: true } : {}),
        ...(opts.barcode ? { barcode: opts.barcode } : {}),
        unitCostPaise,
        retailPaise: retail * 100,
        mrpPaise: mrp * 100,
        wholesalePaise: wholesale * 100,
      });
    }
  }

  if (i !== P.length) {
    throw new Error(`catalogue: ${P.length - i} row(s) fall outside every block`);
  }
  return out;
}

export const PRODUCTS = build();

// A barcode identifies one product. Two products sharing one is not a
// data-entry detail: a scanner at the counter would ring up whichever
// row the database happened to return.
{
  const seen = new Map();
  for (const p of PRODUCTS) {
    if (!p.barcode) continue;
    if (seen.has(p.barcode)) {
      throw new Error(
        `catalogue: barcode ${p.barcode} is on both "${seen.get(p.barcode)}" and "${p.name}"`);
    }
    seen.set(p.barcode, p.name);
  }

  const names = new Set();
  for (const p of PRODUCTS) {
    if (names.has(p.name)) throw new Error(`catalogue: "${p.name}" appears twice`);
    names.add(p.name);
  }

  const known = new Set(CATEGORIES.map((c) => c.name));
  for (const p of PRODUCTS) {
    if (!known.has(p.category)) {
      throw new Error(`catalogue: "${p.name}" is in "${p.category}", which is not one of the ten`);
    }
  }
}

/** What catalog.import_products() wants. */
export function importRows() {
  return PRODUCTS.map((p) => ({
    name: p.name,
    category: p.category,
    base_uom: p.base_uom,
    tracking_mode: p.tracking_mode,
    hsn_code: p.hsn_code,
    tax_rate: p.tax_rate,
    ...(p.shelf_life_days ? { shelf_life_days: p.shelf_life_days } : {}),
    ...(p.is_weighed ? { is_weighed: true } : {}),
    ...(p.barcode ? { barcode: p.barcode } : {}),
  }));
}

/** Products per category, for a one-line summary after a load. */
export function countByCategory() {
  const counts = new Map(CATEGORIES.map((c) => [c.name, 0]));
  for (const p of PRODUCTS) counts.set(p.category, counts.get(p.category) + 1);
  return counts;
}
