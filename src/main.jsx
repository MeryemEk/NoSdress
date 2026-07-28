import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("racine")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  /* Vrai au premier chargement seulement : sert à distinguer une première
     installation, où il ne faut pas recharger, d'une mise à jour, où il faut. */
  const premiereFois = !navigator.serviceWorker.controller;
  let dejaRecharge = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
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
