// Client-side cart (localStorage), fully React. Holds courses AND donations; checkout posts
// course slugs + donation lines to the plugin BFF (/aq/v1/course-checkout → Stripe).
export type DonationMeta = { mode?: "global" | "local"; countries?: string[]; groups?: string[]; topics?: string[] };
export type CartItem = {
  slug: string;        // course slug, or a unique "donation-…" id for donations
  title: string;
  price: number;
  currency: string;
  product_id: number;
  kind?: "course" | "donation";
  meta?: DonationMeta; // donation targeting
};

const KEY = "aq_cart";
const read = (): CartItem[] => {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
};
const write = (items: CartItem[]) => {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event("aq-cart"));
};

export const getCart = (): CartItem[] => read();
export const cartCount = (): number => read().length;
/** Add a donation as a cart line (unique id each time, so multiple are allowed). */
export function addDonation(amount: number, currency: string, product_id: number, meta: DonationMeta, title: string) {
  const slug = `donation-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const c = read();
  c.push({ slug, title, price: amount, currency, product_id, kind: "donation", meta });
  write(c);
}
export function removeFromCart(slug: string) { write(read().filter((i) => i.slug !== slug)); }
export function clearCart() { write([]); }
/** Subscribe to cart changes (same tab via custom event, other tabs via storage). */
export function onCartChange(fn: () => void): () => void {
  window.addEventListener("aq-cart", fn);
  window.addEventListener("storage", fn);
  return () => { window.removeEventListener("aq-cart", fn); window.removeEventListener("storage", fn); };
}
