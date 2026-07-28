export const config = { maxDuration: 30 };

/* Lit une page produit et en extrait l'image principale et quelques informations.
   Le navigateur ne peut pas le faire lui-même : une page d'un autre domaine est
   bloquée par la politique d'origine. On passe donc par le serveur, qui n'a pas
   cette restriction, et qui renvoie l'image déjà encodée. */

const PRIVE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$)/i;

const decoder = (s) => String(s)
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
  .replace(/&nbsp;/g, " ")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .trim();

/* Récupère les balises meta (og:, twitter:, description) sans dépendance externe. */
function metas(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const cle = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (cle && val !== undefined && !out[cle.toLowerCase()]) out[cle.toLowerCase()] = decoder(val);
  }
  return out;
}

/* Beaucoup de boutiques décrivent le produit en JSON-LD : marque, matière, couleur. */
function donneesProduit(html) {
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const brut = JSON.parse(m[1].trim());
      const liste = Array.isArray(brut) ? brut : [brut, ...(brut["@graph"] || [])];
      for (const n of liste) {
        if (!n || typeof n !== "object") continue;
        const type = String(n["@type"] || "").toLowerCase();
        if (!type.includes("product")) continue;
        return {
          nom: typeof n.name === "string" ? n.name : "",
          marque: typeof n.brand === "string" ? n.brand : (n.brand && n.brand.name) || "",
          matiere: typeof n.material === "string" ? n.material : "",
          couleur: typeof n.color === "string" ? n.color : "",
          description: typeof n.description === "string" ? n.description : "",
        };
      }
    } catch (e) { /* bloc illisible, on essaie le suivant */ }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const code = process.env.DRESSING_CODE;
  if (code && req.headers["x-dressing-code"] !== code) {
    return res.status(401).json({ error: "Code invalide" });
  }

  let cible;
  try {
    cible = new URL(String((req.body || {}).url || "").trim());
  } catch (e) {
    return res.status(400).json({ error: "Adresse illisible. Colle un lien complet commençant par https://" });
  }
  if (!/^https?:$/.test(cible.protocol) || PRIVE.test(cible.hostname)) {
    return res.status(400).json({ error: "Adresse non autorisée." });
  }

  const entetes = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    "accept": "text/html,application/xhtml+xml",
    "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
  };

  try {
    const r = await fetch(cible.href, { headers: entetes, redirect: "follow" });
    if (!r.ok) {
      return res.status(502).json({
        error: `La boutique a refusé la lecture de la page (code ${r.status}). Enregistre plutôt la photo à la main.`,
      });
    }
    const html = (await r.text()).slice(0, 600000);
    const m = metas(html);
    const produit = donneesProduit(html) || {};

    const source = m["og:image:secure_url"] || m["og:image"] || m["twitter:image"] || m["twitter:image:src"];
    if (!source) {
      return res.status(422).json({ error: "Aucune image de produit trouvée sur cette page." });
    }

    const ri = await fetch(new URL(source, cible.href).href, {
      headers: { ...entetes, accept: "image/*", referer: cible.href },
      redirect: "follow",
    });
    if (!ri.ok) return res.status(502).json({ error: "L'image du produit est inaccessible." });

    const octets = Buffer.from(await ri.arrayBuffer());
    if (!octets.length) return res.status(502).json({ error: "Image vide." });
    if (octets.length > 8000000) return res.status(413).json({ error: "Image trop lourde." });

    const titreBrut = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const infos = [
      produit.nom || m["og:title"] || m["twitter:title"] || decoder(titreBrut),
      produit.marque || m["og:site_name"] || "",
      produit.couleur ? `couleur annoncée : ${produit.couleur}` : "",
      produit.matiere ? `matière annoncée : ${produit.matiere}` : "",
      produit.description || m["og:description"] || m.description || "",
    ].filter(Boolean).join("\n").slice(0, 900);

    return res.status(200).json({
      image: octets.toString("base64"),
      typeImage: (ri.headers.get("content-type") || "image/jpeg").split(";")[0],
      contexte: infos,
      marque: produit.marque || m["og:site_name"] || "",
      source: cible.href,
    });
  } catch (e) {
    return res.status(502).json({ error: "Page illisible depuis le serveur. " + String(e && e.message ? e.message : e) });
  }
}
