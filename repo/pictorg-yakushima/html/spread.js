// ── Spread ("見開き") layout engine ──────────────────────────────────
// Pure geometry, same shape as src/lib/masonryLayout.ts: takes photos with
// aspect ratios + a container width, returns absolutely-positioned tiles
// grouped into spreads. No DOM. The point of the form is that a spread
// deliberately does NOT fill the width — 余白 is the primary material.

const DEFAULT_RATIO = 3 / 2;

// Each template declares: how many photos it eats, what orientations it
// wants, and a place() that returns tiles in a normalised 0..1 x-space.
const TEMPLATES = {
  // one photo edge-to-edge — the "loud" beat, used to open and to punctuate
  'full-bleed': {
    n: 1, wants: (r) => r[0] >= 1.25,
    place: (W, ph) => {
      const h = W / ph[0].ratio;
      return { tiles: [{ i: 0, x: 0, y: 0, w: W, h }], height: h,
               caption: { x: W * 0.60, y: h + 26, mode: 'h', of: 0 } };
    },
  },
  // 58% right-aligned, huge left void, caption set vertically in the void
  'solo-right': {
    n: 1, wants: () => true,
    place: (W, ph) => {
      const w = W * 0.575, h = w / ph[0].ratio, x = W - w;
      return { tiles: [{ i: 0, x, y: 0, w, h }], height: h,
               caption: { x: x - 46, y: h * 0.42, mode: 'v', of: 0 } };
    },
  },
  // 52% left-aligned, caption block top-right under a hairline
  'solo-left': {
    n: 1, wants: () => true,
    place: (W, ph) => {
      const w = W * 0.52, h = w / ph[0].ratio;
      return { tiles: [{ i: 0, x: 0, y: 0, w, h }], height: h,
               caption: { x: w + W * 0.10, y: h * 0.14, mode: 'h', of: 0, rule: W * 0.30 } };
    },
  },
  // two unequal photos, the second dropped a beat — the core "quiet" spread
  'pair-offset': {
    n: 2, wants: (r) => r.some((x) => x < 1),
    place: (W, ph) => {
      const wA = W * 0.405, hA = wA / ph[0].ratio;
      const wB = W * 0.295, hB = wB / ph[1].ratio;
      const yB = hA * 0.26;
      const xB = wA + W * 0.075;
      return { tiles: [{ i: 0, x: 0, y: 0, w: wA, h: hA },
                       { i: 1, x: xB, y: yB, w: wB, h: hB }],
               height: Math.max(hA, yB + hB),
               caption: { x: xB, y: yB + hB + 22, mode: 'h', of: 1 } };
    },
  },
  // two narrow landscapes, block shifted off-centre to the right
  'duo-narrow': {
    n: 2, wants: (r) => r.every((x) => x >= 1.2),
    place: (W, ph) => {
      const w = W * 0.365, gap = W * 0.045, x0 = W - (w * 2 + gap);
      const h0 = w / ph[0].ratio, h1 = w / ph[1].ratio;
      return { tiles: [{ i: 0, x: x0, y: 0, w, h: h0 },
                       { i: 1, x: x0 + w + gap, y: 0, w, h: h1 }],
               height: Math.max(h0, h1),
               caption: { x: x0, y: Math.max(h0, h1) + 24, mode: 'h', of: 0 } };
    },
  },
  // three small photos clustered upper-left, big void lower-right
  'trio-cluster': {
    n: 3, wants: () => true,
    place: (W, ph) => {
      const wA = W * 0.335, hA = wA / ph[0].ratio;
      const wB = W * 0.215, hB = wB / ph[1].ratio;
      const wC = W * 0.185, hC = wC / ph[2].ratio;
      const xB = wA + W * 0.05, yB = hA * 0.18;
      const xC = W * 0.105, yC = hA + W * 0.038;
      return { tiles: [{ i: 0, x: 0, y: 0, w: wA, h: hA },
                       { i: 1, x: xB, y: yB, w: wB, h: hB },
                       { i: 2, x: xC, y: yC, w: wC, h: hC }],
               height: Math.max(hA, yB + hB, yC + hC),
               caption: { x: xC + wC + W * 0.06, y: yC + 8, mode: 'v', of: 2 } };
    },
  },
};

// A fixed cadence so the book breathes instead of repeating. When the next
// photos don't suit the cadence's pick, fall through to the next candidate.
const CADENCE = ['full-bleed', 'solo-right', 'pair-offset', 'duo-narrow',
                 'trio-cluster', 'solo-left', 'full-bleed', 'pair-offset',
                 'solo-right', 'trio-cluster'];
const ORDER = Object.keys(TEMPLATES);

/**
 * Uniformly shrink a placed spread so it fits `maxHeight`. Only paged output
 * needs this — a scrolling page has no height ceiling, but a printed page box
 * does, and a tall portrait in `solo-right` can easily exceed it. Scaling
 * keeps the composition (and just yields more 余白) rather than switching to
 * a different template mid-sequence.
 */
function fitHeight(spread, maxHeight) {
  if (!maxHeight || spread.height <= maxHeight) return spread;
  const k = maxHeight / spread.height;
  const cap = { ...spread.caption, x: spread.caption.x * k, y: spread.caption.y * k };
  if (cap.rule) cap.rule *= k;
  return {
    ...spread,
    tiles: spread.tiles.map((t) => ({ ...t, x: t.x * k, y: t.y * k, w: t.w * k, h: t.h * k })),
    height: spread.height * k,
    caption: cap,
    scaled: k,
  };
}

/**
 * photos: [{ratio, ...}] → [{name, tiles, height, caption, photos}]
 * `maxHeight` (optional) caps each spread — see fitHeight.
 */
function planSpreads(photos, containerWidth, { maxHeight } = {}) {
  if (containerWidth <= 0 || !photos.length) return [];
  const q = photos.map((p) => ({
    ...p, ratio: p.ratio > 0 && isFinite(p.ratio) ? p.ratio : DEFAULT_RATIO,
  }));
  const spreads = [];
  let i = 0, beat = 0;

  while (i < q.length) {
    const left = q.length - i;
    // candidates: cadence pick first, then the rest, then anything that fits
    // Rotate the cadence from the current beat so a miss falls to the *next*
    // beat rather than collapsing back to the loudest template.
    const rot = CADENCE.map((_, k) => CADENCE[(beat + k) % CADENCE.length]);
    const cands = [...new Set([...rot, ...ORDER])];
    const lastTwoBleed = spreads.slice(-2).every((s) => s.name === 'full-bleed')
      && spreads.length >= 2;
    let chosen = null;
    for (const key of cands) {
      const t = TEMPLATES[key];
      if (t.n > left) continue;
      // never three loud beats in a row, and never the same beat twice
      if (key === 'full-bleed' && lastTwoBleed) continue;
      if (spreads.length && spreads[spreads.length - 1].name === key) continue;
      const slice = q.slice(i, i + t.n);
      if (!t.wants(slice.map((p) => p.ratio))) continue;
      chosen = { key, t, slice }; break;
    }
    if (!chosen) { // tail: whatever consumes what's left
      const key = left >= 2 ? 'pair-offset' : 'solo-right';
      chosen = { key, t: TEMPLATES[key], slice: q.slice(i, i + Math.min(TEMPLATES[key].n, left)) };
    }
    const out = chosen.t.place(containerWidth, chosen.slice);
    spreads.push(fitHeight({ name: chosen.key, photos: chosen.slice, ...out }, maxHeight));
    i += chosen.slice.length; beat++;
  }
  return spreads;
}

module.exports = { planSpreads, fitHeight, TEMPLATES, CADENCE };
