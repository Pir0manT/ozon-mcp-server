// Pure parsers over Ozon's composer-api JSON. No browser, no network here —
// every function takes a parsed composer-api response object and returns
// plain data. Kept side-effect-free so it can be unit-tested against saved
// samples.

function widgetName(key) {
  return String(key).split("-")[0];
}

function widget(page, name) {
  const ws = page?.widgetStates || {};
  const key = Object.keys(ws).find((k) => widgetName(k) === name);
  if (!key) return null;
  try {
    return JSON.parse(ws[key]);
  } catch {
    return null;
  }
}

function widgets(page, name) {
  const ws = page?.widgetStates || {};
  return Object.keys(ws)
    .filter((k) => widgetName(k) === name)
    .map((k) => {
      try {
        return JSON.parse(ws[k]);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function priceToNumber(text) {
  if (typeof text !== "string") return null;
  const digits = text.replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
}

function cleanUrl(link) {
  if (!link) return null;
  const path = String(link).split("?")[0];
  return path.startsWith("http") ? path : `https://www.ozon.ru${path}`;
}

function skuFromUrl(url) {
  const m = String(url || "").match(/-(\d+)\/?(?:\?|$)/) || String(url || "").match(/(\d{6,})/);
  return m ? m[1] : null;
}

// ── search ────────────────────────────────────────────────────────────────────

function parseSearchItem(it) {
  if (!it) return null;
  const ms = Array.isArray(it.mainState) ? it.mainState : [];

  const priceBlock = ms.find((s) => s.type === "priceV2")?.priceV2;
  const prices = priceBlock?.price || [];
  const price = priceToNumber(prices.find((p) => p.textStyle === "PRICE")?.text);
  const oldPrice = priceToNumber(prices.find((p) => p.textStyle === "ORIGINAL_PRICE")?.text);

  const name = ms.find((s) => s.id === "name")?.textDS?.text || null;

  let rating = null;
  let reviews = null;
  const ratingList = ms.find(
    (s) => s.labelListV2 && JSON.stringify(s.labelListV2).includes("ic_s_star")
  )?.labelListV2?.items;
  if (Array.isArray(ratingList)) {
    const texts = ratingList.filter((x) => x.type === "text").map((x) => x.text?.text);
    if (texts[0]) rating = parseFloat(String(texts[0]).replace(",", "."));
    if (texts[1]) reviews = priceToNumber(texts[1]);
  }

  const BADGE = /^(стало дешевле|оригинал|хит|новинка|акция|распродажа|выбор|бестселлер|ozon|premium|самовывоз|скидка)/i;
  let brand = null;
  const labelLists = ms
    .filter((s) => s.labelListV2 && !JSON.stringify(s.labelListV2).includes("ic_s_star"))
    .map((s) => s.labelListV2);
  for (const ll of labelLists) {
    const cand = (ll.items || []).find((x) => x.type === "text")?.text?.text?.trim();
    if (cand && !BADGE.test(cand)) {
      brand = cand;
      break;
    }
  }

  const url = cleanUrl(it.action?.link);
  const sku = String(it.sku || it.id || skuFromUrl(url) || "") || null;

  const image =
    it.tileImage?.items?.find((x) => x.image?.link)?.image?.link ||
    it.tileImage?.coverImage ||
    null;

  if (!sku || !price) return null;
  return {
    sku,
    name,
    price,
    oldPrice: oldPrice && oldPrice > price ? oldPrice : null,
    discount: priceBlock?.discount || null,
    rating,
    reviews,
    brand,
    url,
    image,
  };
}

export function parseSearch(page, limit = 12) {
  const grid = widget(page, "tileGridDesktop");
  const raw = grid?.items || [];
  const items = raw.map(parseSearchItem).filter(Boolean).slice(0, limit);
  return { count: items.length, items };
}

// ── product details ───────────────────────────────────────────────────────────

function rsText(arr) {
  return (arr || [])
    .map((v) => v.text || v.content)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseShortCharacteristics(page) {
  const w = widget(page, "webShortCharacteristics");
  const out = {};
  for (const c of w?.characteristics || []) {
    const title = rsText(c.title?.textRs) || (typeof c.title === "string" ? c.title : null);
    const value = rsText(c.values || c.contentRS || c.valueRs);
    if (title && value) out[title] = value;
  }
  return out;
}

function parseProductScore(page) {
  const w = widget(page, "webSingleProductScore") || widget(page, "webReviewProductScore");
  const text = w?.text || JSON.stringify(w || {});
  let rating = null;
  let reviews = null;
  const rm = text.match(/(\d[.,]\d)/);
  if (rm) rating = parseFloat(rm[1].replace(",", "."));
  const cm = text.match(/(\d[\d\s]*)\s*отзыв/);
  if (cm) reviews = priceToNumber(cm[1]);
  return { rating, reviews };
}

function parseSeller(page) {
  const w = widget(page, "webCurrentSeller");
  if (!w) return null;
  const name = w.sellerCell?.centerBlock?.title?.text || w.title?.text || null;
  const rating = parseFloat(String(w.rating?.title?.text || "").replace(",", ".")) || null;
  const url = cleanUrl(w.sellerCell?.common?.action?.link);
  if (!name) return null;
  return { name, rating, url };
}

export function parseDescription(page2) {
  if (!page2) return { text: "", images: [] };
  const w = widgets(page2, "webDescription").find((x) => x.richAnnotationJson);
  if (!w) return { text: "", images: [] };
  let ra = w.richAnnotationJson;
  if (typeof ra === "string") {
    try {
      ra = JSON.parse(ra);
    } catch {
      return { text: "", images: [] };
    }
  }
  const texts = [];
  const images = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object") return;
    if (n.type === "text" && typeof n.content === "string") texts.push(n.content);
    if (n.img?.src) images.push(n.img.src);
    if (Array.isArray(n.items))
      n.items.forEach((it) => {
        if (it?.type === "text" && typeof it.content === "string") texts.push(it.content);
      });
    for (const k in n) if (n[k] && typeof n[k] === "object") walk(n[k]);
  };
  walk(ra.content || ra);
  return {
    text: texts.join(" ").replace(/\s+/g, " ").trim(),
    images: [...new Set(images)],
  };
}

export function parseDetails(basePage, page2) {
  const heading = widget(basePage, "webProductHeading");
  const price = widget(basePage, "webPrice");
  const gallery = widget(basePage, "webGallery");

  const sku =
    String(
      gallery?.sku ||
        (basePage?.layoutTrackingInfo &&
          JSON.parse(basePage.layoutTrackingInfo || "{}").sku) ||
        ""
    ) ||
    skuFromUrl(basePage?.seo?.link?.[0]?.href) ||
    null;

  const url =
    cleanUrl(basePage?.seo?.link?.[0]?.href) ||
    (sku ? `https://www.ozon.ru/product/${sku}/` : null);

  const { rating, reviews } = parseProductScore(basePage);

  const images = [];
  if (gallery?.coverImage) images.push(gallery.coverImage);
  for (const im of gallery?.images || []) {
    const src = im?.src || im?.image || im;
    if (typeof src === "string") images.push(src);
  }

  return {
    sku,
    name: heading?.title || basePage?.seo?.title || null,
    url,
    price: priceToNumber(price?.cardPrice) ?? priceToNumber(price?.price),
    priceRegular: priceToNumber(price?.price),
    oldPrice: priceToNumber(price?.originalPrice),
    available: price?.isAvailable ?? null,
    rating,
    reviews,
    seller: parseSeller(basePage),
    images: [...new Set(images)].slice(0, 10),
    characteristics: parseShortCharacteristics(basePage),
    description: parseDescription(page2),
  };
}

// ── reviews ───────────────────────────────────────────────────────────────────

function unixToDate(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function parseReviews(page, limit = 10) {
  const w = widget(page, "webListReviews");
  const raw = w?.reviews || w?.items || [];
  const { rating, reviews: total } = parseProductScore(page);

  const reviews = raw.slice(0, limit).map((r) => {
    const c = r.content || {};
    const author =
      r.author?.title ||
      [r.author?.firstName, r.author?.lastName].filter(Boolean).join(" ") ||
      (r.isAnonymous ? "Аноним" : null);
    return {
      author: author || null,
      score: typeof c.score === "number" ? c.score : null,
      comment: c.comment || "",
      pros: c.positive || "",
      cons: c.negative || "",
      date: unixToDate(r.publishedAt || r.createdAt),
      useful: r.usefulness?.useful ?? null,
      purchased: r.isItemPurchased ?? null,
      hasPhotos: Array.isArray(c.photos) && c.photos.length > 0,
    };
  });

  return { rating, totalReviews: total, count: reviews.length, reviews };
}

export const _internal = { priceToNumber, cleanUrl, skuFromUrl, widget };
