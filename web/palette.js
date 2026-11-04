export const VENDOR = {
  claude: { label: 'Claude', css: '#e8743b', accent: 0xe8743b, shirts: [0xe9825f, 0xf2a07b, 0xd96c4f, 0xf4b183, 0xe39a6c, 0xc9573e], helperShirts: [0xf7c5ad, 0xf9d3b8, 0xf3b89b, 0xfbdcc4], screen: 0xffb48a },
  codex:  { label: 'Codex',  css: '#35a08e', accent: 0x35a08e, shirts: [0x3fa796, 0x5ec4b6, 0x2e8b7a, 0x7fd1c3, 0x3a9a8f, 0x8fd9c4], helperShirts: [0xa8e3d6, 0xbfe9df, 0x9bdccc, 0xcdeee8], screen: 0x9fe8d8 },
  // Cursor: graphite suits and a near-white screen. Gemini: deep royal blue-indigo, darker and more saturated than the
  // reviewer periwinkle (#6c7fd9) and bluer than the helper lavender (#9b7bd6).
  cursor: { label: 'Cursor', css: '#4a4e57', accent: 0x4a4e57, shirts: [0x3f434b, 0x565a62, 0x2f3238, 0x6b6f77, 0x484b53, 0x7d8189], helperShirts: [0xb8bbc1, 0xc9cbd0, 0xa8acb3, 0xd6d8dc], screen: 0xedf0f4 },
  gemini: { label: 'Gemini', css: '#3f51e0', accent: 0x3f51e0, shirts: [0x3f51e0, 0x2c3fb8, 0x5566ee, 0x3a62d8, 0x4a45c9, 0x2f4fc4], helperShirts: [0xbcc6f8, 0xc9d0fb, 0xaab6f3, 0xd6dcfd], screen: 0xc7d0ff },
  // any other tool (one the office only knows through the drop-in folder): a quiet olive-grey, nobody else's colour
  other: { label: 'Agent', css: '#7d8467', accent: 0x7d8467, shirts: [0x8a9174, 0x6f7558, 0xa0a689, 0x5f6549, 0x949b7e, 0x7b8165], helperShirts: [0xb9bea6, 0xc6cab4, 0xadb298, 0xd0d4c0], screen: 0xe6ead4 },
  helper: { label: 'helper', css: '#9b7bd6', accent: 0x9b7bd6, shirts: [0xb39ddb, 0x9b7bd6, 0xc8b6e8, 0x8e78c9], screen: 0xd8c8f5 },
};
// six skin tones, light to deep, picked with equal weight
export const SKIN = [0xffe0cb, 0xf5ceb0, 0xe6b48e, 0xcc9670, 0xa86d47, 0x7a4b30];
// [colour, weight]: natural shades carry the crowd; the two muted dyes (dusty rose, denim) turn up rarely
export const HAIR = [
  [0x2a2530, 19], // ink black
  [0x553728, 19], // dark brown
  [0x7d4b2f, 14], // chestnut
  [0x9a6b47, 13], // soft brown
  [0xa4502f, 9],  // auburn
  [0xc9a063, 11], // dark blonde
  [0xb9b2aa, 7],  // warm grey
  [0xdf9fb4, 4],  // dusty rose (dye)
  [0x6d85aa, 4],  // denim (dye)
];
// [colour, weight]: everyday trouser shades, all off the brand palette: charcoal, slate grey, khaki, oat, olive
export const PANTS = [[0x3d3a46, 24], [0x5f6878, 22], [0xb8a07a, 18], [0xd8c9ab, 14], [0x6f7358, 16]];
// [colour, weight]: white trainers, brown leather, ink
export const SHOES = [[0xf4f1ea, 36], [0x7a5a44, 34], [0x3a3340, 30]];
// [form, weight] for plain members (leads, helpers and reviewers keep their outfits). The vendor colour is always the
// main top colour: the tee, the sweater, the cardigan (open over a light tee), the vest (over a light collared shirt),
// the shirt with rolled sleeves.
export const GARMENTS = [['tee', 24], ['sweater', 20], ['cardigan', 18], ['vest', 16], ['rolled', 22]];
// what shows under a cardigan or a vest, and the stripes on a striped tee: cream, white, pale blue
export const UNDERSHIRT = [0xf3eadb, 0xfaf7f0, 0xcfdcef];
// [shape, weight]: brows and the mouth at rest. Expressions still drive them (brows raise and knit, the mouth opens to
// talk and beams when happy).
export const BROWS = [['straight', 4], ['arched', 3], ['soft', 3]];
export const MOUTHS = [['smile', 4], ['dot', 3], ['o', 2]];
export const FRECKLE_CHANCE = 0.15;
// [style, weight]: ten silhouettes (character.js builds each from a few cached shapes). The big afro puff is about one
// in twenty: a striking silhouette when rare, a cloud bank when common.
export const HAIR_STYLES = [['short', 15], ['sidepart', 11], ['spiky', 8], ['bob', 11], ['long', 10], ['ponytail', 10], ['bun', 10], ['twin', 7], ['curly', 10], ['afro', 5]];
// [accessory, weight] for the ACC_CHANCE of people who wear one (reviewers always wear their glasses)
export const ACC_CHANCE = 0.45;
export const ACCESSORIES = [['glasses', 9], ['headphones', 9], ['neckphones', 5], ['beanie', 9], ['cap', 8], ['scarf', 6], ['clip', 6]];
// wearable colours for hats, scarves and headphones: soft and muted, never a vendor's brand colour
export const ACC_COLORS = [0xf2e8d5, 0x45404c, 0xd8c4a2, 0xd8909f, 0xd8a444, 0x8fad88, 0x5d7798, 0xc4704f, 0x8a5a78];
export const CLIP_COLORS = [0xe88aa8, 0xd8a444, 0xf6efe2, 0x8fad88, 0x8fb8d8];
export const FRAMES = [[0x3a3340, 6], [0x7a4a36, 3], [0xc9a35a, 2]]; // glasses: ink, tortoiseshell, gold

export const ROLE = { lead: { label: 'lead', css: '#f0b23a', icon: '★' }, member: { label: '', css: '#9aa0b0', icon: '' }, helper: { label: 'helper', css: '#7457c0', icon: '↳' }, reviewer: { label: 'reviewer', css: '#46627f', icon: '✓' } };
export const NAMES = ['Mochi', 'Yuzu', 'Kiko', 'Momo', 'Hana', 'Sora', 'Nori', 'Taro', 'Kumo', 'Suzu', 'Pico', 'Umi', 'Riku', 'Mame',
  'Koko', 'Nana', 'Fuku', 'Poco', 'Tama', 'Mikan', 'Anzu', 'Haru', 'Ren', 'Yui', 'Aki', 'Tsuki', 'Nico', 'Beni', 'Gin', 'Kuri'];

export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export function pick(arr, h, salt = 0) { return arr[(h + salt * 7919) % arr.length]; }
export function rand01(h, salt = 0) { return ((h ^ (salt * 0x9e3779b1)) >>> 0) % 10000 / 10000; }
/** an independent, well-mixed 32-bit value per (hash, salt): picks with different salts do not move together */
export function mix(h, salt = 0) {
  let x = (h ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b); x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
export function roll(h, salt = 0) { return mix(h, salt) / 4294967296; }
/** weighted pick from [[value, weight], ...] */
export function pickW(list, h, salt = 0) {
  let total = 0; for (const e of list) total += e[1];
  let r = roll(h, salt) * total;
  for (const e of list) { r -= e[1]; if (r < 0) return e[0]; }
  return list[list.length - 1][0];
}
