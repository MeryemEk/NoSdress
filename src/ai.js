const MODELE = "claude-sonnet-5";

export const CATS = ["Haut", "Bas", "Robe", "Veste", "Chaussures", "Sac", "Accessoire", "Bijou"];
export const SAISONS = ["Printemps", "Été", "Automne", "Hiver"];
export const FORM = { 1: "Très décontracté", 2: "Décontracté", 3: "Soigné", 4: "Habillé", 5: "Très habillé" };

export const codeLocal = {
  lire: () => localStorage.getItem("dressing:code") || "",
  ecrire: (v) => localStorage.setItem("dressing:code", v),
};

function extraireJSON(texte) {
  const propre = texte.replace(/```json/g, "").replace(/```/g, "").trim();
  const fin = propre.lastIndexOf("}");
  if (fin < 0) throw new Error("réponse illisible");
  for (let i = 0; i < fin; i++) {
    if (propre[i] !== "{") continue;
    try { return JSON.parse(propre.slice(i, fin + 1)); } catch (e) { /* candidat suivant */ }
  }
  throw new Error("réponse illisible");
}

async function appeler(contenu, { web = false, tokens = 1200 } = {}) {
  const corps = { model: MODELE, max_tokens: tokens, messages: [{ role: "user", content: contenu }] };
  if (web) corps.tools = [{ type: "web_search_20250305", name: "web_search" }];

  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), 70000);
  try {
    const r = await fetch("/api/claude", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dressing-code": codeLocal.lire() },
      body: JSON.stringify(corps),
      signal: stop.signal,
    });
    const data = await r.json();
    if (r.status === 401) throw new Error("Code d'accès refusé");
    if (!r.ok) throw new Error(data.error || "Appel refusé");
    const texte = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return extraireJSON(texte);
  } finally {
    clearTimeout(minuteur);
  }
}

const CONSIGNE = `Analyse ce vêtement, cette chaussure ou cet accessoire photographié.
Réponds uniquement avec un objet JSON valide, sans texte autour ni balise markdown :
{"nom":"nom court et descriptif en français, 2 à 4 mots",
"categorie":"Haut|Bas|Robe|Veste|Chaussures|Sac|Accessoire|Bijou",
"sousCategorie":"ex: chemise, jean droit, escarpin",
"couleurs":["1 à 3 couleurs en français"],
"marque":"marque uniquement si un logo ou une étiquette est lisible, sinon null",
"matiere":"matière apparente ou null",
"motif":"uni, rayé, imprimé, à carreaux, etc.",
"saisons":["Printemps","Été","Automne","Hiver"],
"styles":["2 à 3 mots-clés: business, casual, soirée, sport, minimal, bohème..."],
"formalite":3,
"confiance":"haute|moyenne|basse"}
formalite va de 1 (très décontracté) à 5 (très habillé). confiance porte sur la marque.
N'invente jamais une marque absente de la photo. Si rien n'est lisible : marque null, confiance "basse".`;

const CONSIGNE_WEB = `

Si un logo, une étiquette ou un texte de marque est lisible sur la photo, utilise la recherche web
pour confirmer la marque et préciser le modèle ou la matière. Recherche le texte que tu lis réellement
sur l'image, jamais une description visuelle. Si rien n'est lisible, ne cherche pas. Une correspondance
incertaine ne justifie pas d'élever la confiance.`;

export function normaliser(f = {}) {
  return {
    nom: f.nom || "Pièce sans nom",
    categorie: CATS.includes(f.categorie) ? f.categorie : "Haut",
    sousCategorie: f.sousCategorie || "",
    couleurs: Array.isArray(f.couleurs) ? f.couleurs.slice(0, 3) : [],
    marque: f.marque && f.marque !== "null" ? f.marque : "",
    matiere: f.matiere && f.matiere !== "null" ? f.matiere : "",
    motif: f.motif || "",
    saisons: Array.isArray(f.saisons) ? f.saisons.filter((s) => SAISONS.includes(s)) : [...SAISONS],
    styles: Array.isArray(f.styles) ? f.styles.slice(0, 4) : [],
    formalite: Number(f.formalite) >= 1 && Number(f.formalite) <= 5 ? Number(f.formalite) : 3,
    confiance: ["haute", "moyenne", "basse"].includes(f.confiance) ? f.confiance : "basse",
  };
}

export async function identifier(base64, web) {
  const brut = await appeler([
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
    { type: "text", text: web ? CONSIGNE + CONSIGNE_WEB : CONSIGNE },
  ], { web });
  return normaliser(brut);
}

export async function suggerer({ pieces, contexte, recentes, date }) {
  const catalogue = pieces.map((p) => ({
    id: p.id, nom: p.nom, categorie: p.categorie, couleurs: p.couleurs,
    marque: p.marque || undefined, styles: p.styles, saisons: p.saisons, formalite: p.formalite,
  }));
  const prompt = `Voici ma garde-robe, en JSON :
${JSON.stringify(catalogue)}

Contexte pour aujourd'hui : ${contexte || "journée ordinaire, pas de contrainte particulière"}
Pièces portées récemment, à éviter si possible : ${JSON.stringify(recentes)}
Nous sommes le ${date}.

Compose 3 tenues cohérentes en utilisant uniquement les identifiants ci-dessus.
Chaque tenue contient soit une robe soit un haut et un bas, des chaussures si la garde-robe en contient,
et 0 à 2 accessoires. Reste cohérente sur le registre de formalité et sur la saison.
Réponds uniquement avec un objet JSON valide, sans texte autour ni balise markdown :
{"tenues":[{"nom":"nom court en français","itemIds":["id","id"],"pourquoi":"une phrase courte"}]}`;
  const brut = await appeler([{ type: "text", text: prompt }], { tokens: 1500 });
  return (brut.tenues || [])
    .map((t) => ({ ...t, itemIds: (t.itemIds || []).filter((id) => pieces.some((p) => p.id === id)) }))
    .filter((t) => t.itemIds.length >= 1);
}
