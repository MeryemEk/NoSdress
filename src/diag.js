/* Journal de diagnostic. Note chaque démarrage et chaque erreur dans le
   stockage local. Indépendant de React, pour rester lisible même si
   l'interface elle-même plante. */
const CLE_DIAG = "dressing:diag";

export const journalDiag = () => { try { return JSON.parse(localStorage.getItem(CLE_DIAG) || "[]"); } catch (e) { return []; } };

export const noter = (type, detail = "") => {
  try {
    const l = journalDiag();
    l.push({ t: Date.now(), type, detail: String(detail).slice(0, 400) });
    localStorage.setItem(CLE_DIAG, JSON.stringify(l.slice(-60)));
  } catch (e) { /* stockage indisponible */ }
};

export const demarragesRecents = () =>
  journalDiag().filter((x) => x.type === "démarrage" && Date.now() - x.t < 60000).length;

const nav = (performance.getEntriesByType && performance.getEntriesByType("navigation")[0]) || {};
noter("démarrage", `${nav.type || "?"} · ${navigator.serviceWorker && navigator.serviceWorker.controller ? "sw" : "sans sw"} · ${innerWidth}×${innerHeight}`);

/* Mode allégé : l'application vient de redémarrer plusieurs fois de suite,
   signe qu'iOS la coupe faute de mémoire. On ouvre alors sans les photos et
   sans le rattrapage des miniatures, pour casser la boucle et laisser un écran
   stable. Décidé une fois, au chargement. */
export const MODE_ALLEGE = demarragesRecents() >= 3;
if (MODE_ALLEGE) noter("mode allégé");

/* Photos dont le traitement a coïncidé avec un arrêt de l'application. Avant de
   traiter une photo au démarrage on note sa clé, on l'efface après. Une clé
   encore présente à l'ouverture suivante désigne donc la photo en cours au
   moment de l'arrêt : au deuxième arrêt sur la même, on ne la retente plus. */
const CLE_EN_COURS = "dressing:enCours";
const CLE_ARRETS = "dressing:arrets";
const lireArrets = () => { try { return JSON.parse(localStorage.getItem(CLE_ARRETS) || "{}"); } catch (e) { return {}; } };
try {
  const restee = localStorage.getItem(CLE_EN_COURS);
  if (restee) {
    const a = lireArrets();
    a[restee] = (a[restee] || 0) + 1;
    localStorage.setItem(CLE_ARRETS, JSON.stringify(a));
    localStorage.removeItem(CLE_EN_COURS);
    noter("arrêt pendant", `${restee} (${a[restee]})`);
  }
} catch (e) { /* stockage indisponible */ }

export const aEviter = (cle) => (lireArrets()[cle] || 0) >= 2;
export const debuter = (cle) => { try { localStorage.setItem(CLE_EN_COURS, cle); } catch (e) { /* idem */ } };
export const terminer = () => { try { localStorage.removeItem(CLE_EN_COURS); } catch (e) { /* idem */ } };

addEventListener("error", (e) => noter("erreur", `${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener("unhandledrejection", (e) => noter("promesse", e.reason && (e.reason.stack || e.reason.message) || e.reason));
addEventListener("pagehide", () => noter("fermeture"));
document.addEventListener("visibilitychange", () => noter(document.visibilityState === "hidden" ? "masquée" : "visible"));

const ligne = (x) => new Date(x.t).toLocaleTimeString("fr-FR") + "  " + x.type + (x.detail ? "  " + x.detail : "");

/* Affiche le journal par-dessus l'application : de lui-même si elle a redémarré
   plusieurs fois en peu de temps, ou à la demande depuis l'onglet données. */
export function afficherDiag(force) {
  const recents = demarragesRecents();
  if (!force && recents < 3) return;
  const texte = journalDiag().slice(-40).reverse().map(ligne).join("\n");
  const boite = document.createElement("div");
  boite.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;max-height:60vh;overflow:auto;z-index:99;" +
    "background:#fff;border:1px solid #A2503C;padding:12px;font:12px/1.4 -apple-system,sans-serif;color:#23231F";
  boite.innerHTML = `<b>Diagnostic : ${recents} démarrages dans la dernière minute.</b>
    <p>Touche « Copier » et colle le texte dans un message.</p>
    <button data-r="copier" style="border:1px solid #23231F;padding:8px 12px;margin-right:8px">Copier</button>
    <button data-r="fermer" style="border:1px solid #ccc;padding:8px 12px">Fermer</button>
    <pre style="white-space:pre-wrap;margin:10px 0 0;user-select:text;-webkit-user-select:text"></pre>`;
  boite.querySelector("pre").textContent = texte;
  boite.querySelector('[data-r="fermer"]').onclick = () => boite.remove();
  const copier = boite.querySelector('[data-r="copier"]');
  copier.onclick = async () => {
    try { await navigator.clipboard.writeText(texte); copier.textContent = "Copié"; }
    catch (e) { copier.textContent = "Copie refusée : sélectionne le texte"; }
  };
  document.body.appendChild(boite);
}
