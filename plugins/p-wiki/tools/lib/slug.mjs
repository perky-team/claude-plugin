const TRANSLIT = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'e', ж:'zh', з:'z', и:'i', й:'i',
  к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f',
  х:'h', ц:'c', ч:'ch', ш:'sh', щ:'sch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
};

function transliterate(s) {
  let out = '';
  for (const ch of s) out += TRANSLIT[ch] ?? ch;
  return out;
}

export function kebab(title) {
  const t = transliterate(title.toLowerCase());
  return t
    .replace(/['''`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function withDateSuffix(slug, isoDate) {
  return `${slug}-${isoDate}`;
}

export function stripDatePrefix(slug) {
  return slug.replace(/^\d{4}-\d{2}-\d{2}-/, '');
}
