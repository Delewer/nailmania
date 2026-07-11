const MARKS_RE = /[\u0300-\u036f]/g;
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;
const NUM_RE = /^\d+$/;

export function normalizeSearchText(value){
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(MARKS_RE, "")
    .replace(/[№#º]/g, " no ")
    .replace(/[’'`´]/g, "")
    .replace(NON_WORD_RE, " ")
    .trim();
}

const tokensOf = (value)=> normalizeSearchText(value).split(/\s+/).filter(Boolean);
const exactNumber = (token, numbers, code, codeNumber)=>
  numbers.has(token) || code === token || (token.length >= 4 && codeNumber === token);

function searchableText(p){
  return [
    p.name, p.nameRu, p.ro, p.ru, p.brand, p.code, p.cat,
    ...(p.specs || []).flatMap(s=>[s.label, s.value])
  ].filter(Boolean).join(" ");
}

function scoreProduct(p, query, terms){
  const haystack = normalizeSearchText(searchableText(p));
  const textTokens = haystack.split(/\s+/).filter(Boolean);
  const tokenSet = new Set(textTokens);
  const numbers = new Set(textTokens.filter(t=>NUM_RE.test(t)));
  const name = normalizeSearchText([p.name, p.nameRu, p.ro, p.ru].filter(Boolean).join(" "));
  const brand = normalizeSearchText(p.brand);
  const code = normalizeSearchText(p.code);
  const codeNumber = code.replace(/^[a-z]+/, "");

  for(const term of terms){
    if(NUM_RE.test(term)){
      if(!exactNumber(term, numbers, code, codeNumber)) return 0;
      continue;
    }
    const found = textTokens.some(t=> t === term || t.startsWith(term) || (term.length >= 3 && t.includes(term)));
    if(!found) return 0;
  }

  let score = 0;
  if(code && (code === query || codeNumber === query)) score += 260;
  if(code && code.startsWith(query)) score += 120;
  if(name === query) score += 220;
  if(name.startsWith(query)) score += 150;
  if(name.includes(query)) score += 90;
  if(brand === query) score += 80;
  if(brand.startsWith(query)) score += 40;

  for(const term of terms){
    if(NUM_RE.test(term)){
      score += numbers.has(term) ? 70 : 50;
    }else if(tokenSet.has(term)){
      score += 42;
    }else if(textTokens.some(t=>t.startsWith(term))){
      score += 24;
    }else{
      score += 10;
    }
  }
  if(typeof p.stock !== "number" || p.stock > 0) score += 4;
  return score;
}

export function searchProducts(products, rawQuery, {limit=Infinity}={}){
  const query = normalizeSearchText(rawQuery);
  if(!query) return [];
  const terms = tokensOf(query);
  if(!terms.length) return [];

  const scored = [];
  for(const product of products){
    const score = scoreProduct(product, query, terms);
    if(score > 0) scored.push({product, score});
  }
  scored.sort((a,b)=>
    b.score - a.score ||
    String(a.product.name || a.product.ro || "").localeCompare(String(b.product.name || b.product.ro || ""))
  );
  return scored.slice(0, limit).map(x=>x.product);
}
