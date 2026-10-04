import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

/* Journal de diagnostic. Note chaque démarrage et chaque erreur dans le
   stockage local, puis les affiche par-dessus l'application si elle a
   redémarré plusieurs fois en peu de temps. Indépendant de React, pour rester
   lisible même si l'interface elle-même plante. */
const CLE_DIAG = "dressing:diag";
const journalDiag = () => { try { return JSON.parse(localStorage.getItem(CLE_DIAG) || "[]"); } catch (e) { return []; } };
const noter = (type, detail = "") => {
  try {
    const l = journalDiag();
    l.push({ t: Date.now(), type, detail: String(detail).slice(0, 400) });
    localStorage.setItem(CLE_DIAG, JSON.stringify(l.slice(-60)));
  } catch (e) { /* stockage indisponible */ }
};
const nav = (performance.getEntriesByType && performance.getEntriesByType("navigation")[0]) || {};
noter("démarrage", `${nav.type || "?"} · ${navigator.serviceWorker && navigator.serviceWorker.controller ? "sw" : "sans sw"} · ${innerWidth}×${innerHeight}`);
addEventListener("error", (e) => noter("erreur", `${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener("unhandledrejection", (e) => noter("promesse", e.reason && (e.reason.stack || e.reason.message) || e.reason));
addEventListener("pagehide", () => noter("fermeture"));
document.addEventListener("visibilitychange", () => noter(document.visibilityState === "hidden" ? "masquée" : "visible"));
window.__noterDiag = noter;

function afficherDiag(force) {
  const l = journalDiag();
  const recents = l.filter((x) => x.type === "démarrage" && Date.now() - x.t < 60000).length;
  if (!force && recents < 3) return;
  const boite = document.createElement("div");
  boite.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;max-height:60vh;overflow:auto;z-index:99;" +
    "background:#fff;border:1px solid #A2503C;padding:12px;font:12px/1.4 -apple-system,sans-serif;color:#23231F";
  const h = (x) => new Date(x.t).toLocaleTimeString("fr-FR") + "  " + x.type + (x.detail ? "  " + x.detail : "");
  boite.innerHTML = `<b>Diagnostic : ${recents} démarrages dans la dernière minute.</b>
    <p>Fais une capture d'écran de ce cadre et envoie-la.</p><pre style="white-space:pre-wrap;margin:0"></pre>
    <button style="margin-top:8px;border:1px solid #ccc;padding:6px 10px">Fermer</button>`;
  boite.querySelector("pre").textContent = l.slice(-25).reverse().map(h).join("\n");
  boite.querySelector("button").onclick = () => boite.remove();
  document.body.appendChild(boite);
}
window.__afficherDiag = () => afficherDiag(true);
setTimeout(() => afficherDiag(false), 1500);

/* Une erreur d'affichage est notée au journal au lieu de laisser un écran vide. */
class Filet extends React.Component {
  state = { erreur: null };
  static getDerivedStateFromError(erreur) { return { erreur }; }
  componentDidCatch(e, info) { noter("plantage", `${e && e.message} ${(info.componentStack || "").slice(0, 200)}`); }
  render() {
    if (!this.state.erreur) return this.props.children;
    return (
      <div style={{ padding: 18 }}>
        <p>L'application a rencontré une erreur : {String(this.state.erreur.message || this.state.erreur)}</p>
        <button className="bouton plein" onClick={() => location.reload()}>Recharger</button>
      </div>
    );
  }
}

createRoot(document.getElementById("racine")).render(
  <React.StrictMode>
    <Filet><App /></Filet>
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  /* Vrai au premier chargement seulement : sert à distinguer une première
     installation, où il ne faut pas recharger, d'une mise à jour, où il faut. */
  const premiereFois = !navigator.serviceWorker.controller;
  let dejaRecharge = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    noter("nouveau service worker", premiereFois ? "première fois" : dejaRecharge ? "déjà rechargé" : "rechargement");
    if (premiereFois || dejaRecharge) return;
    dejaRecharge = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js")
      .then((inscription) => {
        // Cherche une version plus récente à chaque ouverture de l'application.
        inscription.update().catch(() => {});
      })
      .catch(() => { /* hors ligne indisponible, sans gravité */ });
  });
}
