const MODELE = "claude-sonnet-5";

export const CATS = ["Haut", "Bas", "Robe", "Veste", "Chaussures", "Sac", "Accessoire", "Bijou"];
export const SAISONS = ["Printemps", "Été", "Automne", "Hiver"];
export const FORM = { 1: "Très décontracté", 2: "Décontracté", 3: "Soigné", 4: "Habillé", 5: "Très habillé" };

/* Suggestions de saisie proposées dans le formulaire (aide, pas contrainte). */
export const TYPES = [
  "T-shirt", "Chemise", "Chemisier", "Blouse", "Pull", "Gilet", "Cardigan", "Débardeur", "Top", "Sweat",
  "Jean", "Pantalon", "Chino", "Legging", "Jupe", "Short",
  "Robe", "Combinaison",
  "Manteau", "Trench", "Blazer", "Veste", "Doudoune", "Imperméable",
  "Escarpin", "Ballerine", "Mocassin", "Basket", "Botte", "Bottine", "Sandale",
  "Sac à main", "Cabas", "Pochette", "Sac à dos",
  "Ceinture", "Écharpe", "Foulard", "Chapeau", "Casquette", "Gants",
  "Collier", "Bracelet", "Boucles d'oreilles", "Bague", "Montre",
];
export const MATIERES = [
  "Coton", "Lin", "Laine", "Cachemire", "Soie", "Cuir", "Daim", "Denim", "Velours", "Maille",
  "Polyester", "Viscose", "Nylon", "Élasthanne", "Satin", "Mousseline", "Tweed", "Jersey", "Feutre",
];
export const COULEURS = [
  "Noir", "Blanc", "Gris", "Beige", "Écru", "Camel", "Marron", "Bordeaux", "Rouge", "Rose",
  "Orange", "Moutarde", "Jaune", "Vert", "Kaki", "Bleu", "Marine", "Violet", "Doré", "Argenté",
];

export const codeLocal = {
  lire: () => localStorage.getItem("dressing:code") || "",
  ecrire: (v) => localStorage.setItem("dressing:code", v),
};

/* Parcourt un texte en ignorant ce qui se trouve entre guillemets, et rend la
   liste des fermetures encore attendues. Sert à réparer une réponse coupée. */
function fermeturesManquantes(s) {
  const pile = [];
  let dansTexte = false, echappe = false;
  for (const ch of s) {
    if (echappe) { echappe = false; continue; }
    if (dansTexte) {
      if (ch === "\\") echappe = true;
      else if (ch === '"') dansTexte = false;
      continue;
    }
    if (ch === '"') dansTexte = true;
    else if (ch === "{") pile.push("}");
    else if (ch === "[") pile.push("]");
    else if (ch === "}" || ch === "]") pile.pop();
  }
  return { pile, dansTexte };
}

function extraireJSON(texte) {
  const propre = String(texte || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!propre) throw new Error("le modèle n'a rien renvoyé");

  const debut = propre.indexOf("{");
  if (debut < 0) throw new Error(`réponse sans JSON : « ${propre.slice(0, 100)} »`);
  const corps = propre.slice(debut);

  // 1) Cas normal : on tente chaque accolade fermante, de la dernière vers le début.
  for (let fin = corps.lastIndexOf("}"); fin > 0; fin = corps.lastIndexOf("}", fin - 1)) {
    try { return JSON.parse(corps.slice(0, fin + 1)); } catch (e) { /* candidat suivant */ }
  }

  // 2) Réponse coupée en cours de route : on referme ce qui est resté ouvert.
  //    On essaie le texte tel quel, puis des coupes de plus en plus courtes,
  //    après chaque objet complet puis avant chaque virgule, de façon à jeter
  //    un dernier élément écrit à moitié.
  const candidats = [corps];
  for (let f = corps.lastIndexOf("}"), n = 0; f > 0 && n < 40; f = corps.lastIndexOf("}", f - 1), n++) {
    candidats.push(corps.slice(0, f + 1));
  }
  for (let f = corps.lastIndexOf(","), n = 0; f > 0 && n < 40; f = corps.lastIndexOf(",", f - 1), n++) {
    candidats.push(corps.slice(0, f));
  }
  for (const base of candidats) {
    const { pile, dansTexte } = fermeturesManquantes(base);
    if (dansTexte || !pile.length) continue;
    try { return JSON.parse(base + pile.reverse().join("")); } catch (e) { /* candidat suivant */ }
  }

  throw new Error(`réponse illisible : « ${propre.slice(0, 100)}… »`);
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
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error("Code d'accès refusé");
    if (!r.ok) {
      // L'API renvoie parfois une chaîne, parfois un objet {type, message}.
      const detail = typeof data.error === "string" ? data.error
        : (data.error && data.error.message) || data.detail || "";
      throw new Error(detail ? `Appel refusé : ${detail}` : `Appel refusé (code ${r.status})`);
    }

    const blocs = Array.isArray(data.content) ? data.content : [];
    const texte = blocs.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const coupee = data.stop_reason === "max_tokens";

    if (!texte.trim()) {
      throw new Error(coupee
        ? "Réponse coupée avant d'avoir rien produit. Réessaie."
        : "Le modèle n'a renvoyé aucun texte. Réessaie.");
    }
    try {
      return extraireJSON(texte);
    } catch (e) {
      if (coupee) throw new Error("Réponse coupée avant la fin, la liste était trop longue. Réessaie.");
      throw e;
    }
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
"taille":"taille si elle est lisible sur une étiquette (ex: 38, M, 40, EU 39), sinon null",
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
    taille: f.taille && f.taille !== "null" ? String(f.taille) : "",
    motif: f.motif || "",
    saisons: Array.isArray(f.saisons) ? f.saisons.filter((s) => SAISONS.includes(s)) : [...SAISONS],
    styles: Array.isArray(f.styles) ? f.styles.slice(0, 4) : [],
    formalite: Number(f.formalite) >= 1 && Number(f.formalite) <= 5 ? Number(f.formalite) : 3,
    confiance: ["haute", "moyenne", "basse"].includes(f.confiance) ? f.confiance : "basse",
  };
}

export async function identifier(base64, web, contexte) {
  const consigne = (web ? CONSIGNE + CONSIGNE_WEB : CONSIGNE) + (contexte
    ? `\n\nInformations lues sur la fiche produit du site. Utilise-les si elles concordent
avec l'image, notamment pour la marque, la matière et la taille. Ignore-les si elles
contredisent ce que tu vois :\n${contexte}`
    : "");
  const brut = await appeler([
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
    { type: "text", text: consigne },
  ], { web });
  return normaliser(brut);
}

const CONSIGNE_GROUPE = `Cette photo montre plusieurs vêtements posés à plat, côte à côte.

Identifie CHAQUE article distinct visible. Un vêtement plié compte pour un seul article.
Un ensemble posé l'un sur l'autre, par exemple un sweat et un pantalon superposés, compte
pour deux articles. Ignore le sol, les papiers, les post-it, les étiquettes volantes et
tout ce qui n'est pas un vêtement, une chaussure, un sac ou un accessoire.

Pour chaque article, donne aussi son cadre dans l'image, exprimé en pourcentages :
x et y sont le coin haut gauche, l la largeur, h la hauteur. Le cadre doit entourer
l'article entier sans déborder sur ses voisins.

Réponds uniquement avec un objet JSON valide, sans texte autour ni balise markdown :
{"pieces":[{"nom":"nom court et descriptif en français, 2 à 4 mots",
"categorie":"Haut|Bas|Robe|Veste|Chaussures|Sac|Accessoire|Bijou",
"sousCategorie":"ex: chemise, jean droit, escarpin",
"couleurs":["1 à 3 couleurs en français"],
"marque":"marque uniquement si un logo ou une étiquette est lisible, sinon null",
"matiere":"matière apparente ou null",
"taille":"taille si lisible sur une étiquette, sinon null",
"motif":"uni, rayé, imprimé, à carreaux, etc.",
"saisons":["Printemps","Été","Automne","Hiver"],
"styles":["2 à 3 mots-clés"],
"formalite":3,
"confiance":"haute|moyenne|basse",
"cadre":{"x":0,"y":0,"l":0,"h":0}}]}
formalite va de 1 à 5. confiance porte sur la marque.
N'invente jamais une marque absente de la photo.`;

/* Identifie d'un coup tous les vêtements d'une photo de groupe. Un seul appel
   pour tout un sac, donc nettement moins cher que pièce par pièce. */
export async function identifierGroupe(base64) {
  const brut = await appeler([
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
    { type: "text", text: CONSIGNE_GROUPE },
  ], { tokens: 3000 });

  const liste = Array.isArray(brut.pieces) ? brut.pieces : [];
  return liste.map((p) => ({ ...normaliser(p), cadre: p && p.cadre }));
}

/* Demande au serveur de lire une page produit et d'en rapporter l'image. */
export async function lirePage(url) {
  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), 35000);
  try {
    const r = await fetch("/api/page", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dressing-code": codeLocal.lire() },
      body: JSON.stringify({ url }),
      signal: stop.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error("Code d'accès refusé");
    if (!r.ok) throw new Error(data.error || "Lecture de la page impossible");
    return data;
  } finally {
    clearTimeout(minuteur);
  }
}

/* Saisons codées sur une lettre, * quand la pièce se porte toute l'année. */
const codeSaisons = (s) => (Array.isArray(s) && s.length && s.length < 4
  ? s.map((x) => (x === "Été" ? "E" : x[0])).join("")
  : "*");

/* Une ligne par pièce plutôt qu'un objet JSON. Même information, environ trois
   fois moins de texte envoyé : le JSON répète les noms de champs et les
   guillemets pour chaque pièce, ce qui devient coûteux sur une grande
   garde-robe. C'est ce qui garde le prix d'une demande à peu près stable. */
function catalogueCompact(pieces) {
  return pieces.map((p) => [
    p.id,
    CATS.includes(p.categorie) ? p.categorie : "Haut",
    p.sousCategorie || p.nom || "",
    (p.couleurs || []).join("/"),
    codeSaisons(p.saisons),
    Number(p.formalite) >= 1 && Number(p.formalite) <= 5 ? Number(p.formalite) : 3,
    (p.styles || []).slice(0, 2).join("/"),
  ].join("|")).join("\n");
}

export async function suggerer({ pieces, contexte, recentes, date }) {
  const prompt = `Ma garde-robe complète, une pièce par ligne, colonnes séparées par | :
id|catégorie|type|couleurs|saisons|formalité|styles
Saisons : P printemps, E été, A automne, H hiver, * toute l'année.
Formalité : 1 très décontracté à 5 très habillé.

${catalogueCompact(pieces)}

Contexte pour aujourd'hui : ${contexte || "journée ordinaire, pas de contrainte particulière"}
Nous sommes le ${date}.
Pièces portées ces derniers jours : ${recentes.length ? recentes.join(", ") : "aucune"}

Compose 3 tenues en puisant dans TOUTE la garde-robe ci-dessus. Chaque pièce est
disponible, y compris celles portées récemment et celles portées souvent : ne t'interdis
aucune pièce. Les pièces portées ces derniers jours sont indiquées uniquement pour que
les 3 propositions ne soient pas la copie de ce que je viens de porter ; réutilise-les
sans hésiter si elles servent la tenue. Cherche surtout à ce que les 3 propositions
soient différentes entre elles.

Chaque tenue contient soit une robe soit un haut et un bas, des chaussures si la
garde-robe en contient, et 0 à 2 accessoires. Reste cohérente sur le registre de
formalité et sur la saison.
Réponds uniquement avec un objet JSON valide, sans texte autour ni balise markdown :
{"tenues":[{"nom":"nom court en français","itemIds":["id","id"],"pourquoi":"une phrase courte"}]}`;
  const brut = await appeler([{ type: "text", text: prompt }], { tokens: 2000 });
  return (brut.tenues || [])
    .map((t) => ({ ...t, itemIds: (t.itemIds || []).filter((id) => pieces.some((p) => p.id === id)) }))
    .filter((t) => t.itemIds.length >= 1);
}
