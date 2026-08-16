export const config = { maxDuration: 60 };

const MODELES = ["claude-sonnet-5", "claude-haiku-4-5-20251001"];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) return res.status(500).json({ error: "ANTHROPIC_API_KEY absente des variables d'environnement" });

  const code = process.env.DRESSING_CODE;
  if (code && req.headers["x-dressing-code"] !== code) {
    return res.status(401).json({ error: "Code invalide" });
  }

  const corps = req.body;
  if (!corps || !MODELES.includes(corps.model)) {
    return res.status(400).json({ error: "Modèle non autorisé" });
  }
  // 4000 pour laisser passer l'identification d'une photo de groupe, qui décrit
  // une dizaine de pièces d'un coup. Les autres appels demandent bien moins.
  if (Number(corps.max_tokens) > 4000) corps.max_tokens = 4000;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cle,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(corps),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: "Appel impossible", detail: String(e) });
  }
}
