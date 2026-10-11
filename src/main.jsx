import { noter, afficherDiag } from "./diag.js";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

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
  /* Un seul rechargement par minute, mémorisé au-delà du rechargement lui-même :
     sans cela, un service worker qui se réinstallerait à chaque ouverture
     ferait recharger la page sans fin. */
  const CLE_RECHARGE = "dressing:recharge";
  const dejaRecharge = () => {
    try { return Date.now() - Number(sessionStorage.getItem(CLE_RECHARGE) || 0) < 60000; } catch (e) { return true; }
  };

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const deja = dejaRecharge();
    noter("nouveau service worker", premiereFois ? "première fois" : deja ? "déjà rechargé" : "rechargement");
    if (premiereFois || deja) return;
    try { sessionStorage.setItem(CLE_RECHARGE, String(Date.now())); } catch (e) { return; }
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
