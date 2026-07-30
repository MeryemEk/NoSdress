const NOM = "dressing";
const VERSION = 1;
let connexion;

function ouvrir() {
  if (connexion) return connexion;
  connexion = new Promise((res, rej) => {
    const r = indexedDB.open(NOM, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("pieces")) db.createObjectStore("pieces", { keyPath: "id" });
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos");
      if (!db.objectStoreNames.contains("tenues")) db.createObjectStore("tenues", { keyPath: "id" });
      if (!db.objectStoreNames.contains("divers")) db.createObjectStore("divers");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return connexion;
}

const attendre = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

export async function tout(magasin) {
  const db = await ouvrir();
  return attendre(db.transaction(magasin).objectStore(magasin).getAll());
}

export async function lire(magasin, cle) {
  const db = await ouvrir();
  return attendre(db.transaction(magasin).objectStore(magasin).get(cle));
}

export async function poser(magasin, valeur, cle) {
  const db = await ouvrir();
  const t = db.transaction(magasin, "readwrite");
  const s = t.objectStore(magasin);
  cle === undefined ? s.put(valeur) : s.put(valeur, cle);
  return new Promise((res, rej) => {
    t.oncomplete = () => res(true);
    t.onerror = () => rej(t.error);
  });
}

export async function oter(magasin, cle) {
  const db = await ouvrir();
  const t = db.transaction(magasin, "readwrite");
  t.objectStore(magasin).delete(cle);
  return new Promise((res, rej) => {
    t.oncomplete = () => res(true);
    t.onerror = () => rej(t.error);
  });
}

export async function toutesLesPhotos() {
  const db = await ouvrir();
  const t = db.transaction("photos");
  const s = t.objectStore("photos");
  const [cles, valeurs] = await Promise.all([attendre(s.getAllKeys()), attendre(s.getAll())]);
  const carte = {};
  cles.forEach((c, i) => { carte[c] = valeurs[i]; });
  return carte;
}

/* Réduit une photo d'appareil photo à une taille raisonnable, et la garde en Blob. */
export function compresser(fichier, max = 1100, qualite = 0.72) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(fichier);
    const img = new Image();
    img.onload = () => {
      const e = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * e);
      c.height = Math.round(img.height * e);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? res(b) : rej(new Error("compression"))), "image/jpeg", qualite);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("lecture image")); };
    img.src = url;
  });
}

export const enBase64 = (blob) => new Promise((res, rej) => {
  const l = new FileReader();
  l.onload = () => res(String(l.result).split(",")[1]);
  l.onerror = () => rej(new Error("base64"));
  l.readAsDataURL(blob);
});

export async function estimerPlace() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { utilise: usage || 0, total: quota || 0 };
}

/* ------------------------------------------------------------------ journal

   Le journal associe une date à une liste de créneaux. Un créneau porte la
   tenue, un libellé de moment et une note libre. Le libellé appartient au
   créneau et non à la tenue : la même tenue peut être "Plage" un jour et
   "Déjeuner" un autre.

   Format : { "2026-07-27": [{ id, tenueId, libelle, note }, ...] }
   Ancien format, encore présent chez les installations existantes :
            { "2026-07-27": "idDeLaTenue" } */

export const LIBELLE_DEFAUT = "Journée";
export const LIBELLES = ["Journée", "Matin", "Déjeuner", "Après-midi", "Plage",
  "Dîner", "Soirée", "Sport", "Voyage"];

/* Identifiant déterministe, pour que rejouer la migration ne change rien. */
const idCreneau = (date, rang) => `${date}#${rang}`;

function normaliserCreneau(brut, date, rang) {
  if (!brut || typeof brut !== "object") return null;
  const tenueId = typeof brut.tenueId === "string" ? brut.tenueId : "";
  if (!tenueId) return null;
  const libelle = typeof brut.libelle === "string" && brut.libelle.trim()
    ? brut.libelle.trim() : LIBELLE_DEFAUT;
  return {
    id: typeof brut.id === "string" && brut.id ? brut.id : idCreneau(date, rang),
    tenueId,
    libelle,
    note: typeof brut.note === "string" ? brut.note : "",
  };
}

/* Convertit un journal vers le format à créneaux. Rejouable : appliquée à un
   journal déjà converti, elle rend exactement le même objet et signale
   change = false, donc aucune duplication possible. */
export function migrerJournal(journal) {
  const source = journal && typeof journal === "object" && !Array.isArray(journal) ? journal : {};
  const sortie = {};

  for (const [date, valeur] of Object.entries(source)) {
    if (Array.isArray(valeur)) {
      const creneaux = valeur
        .map((c, i) => normaliserCreneau(c, date, i))
        .filter(Boolean);
      if (creneaux.length) sortie[date] = creneaux;
    } else if (typeof valeur === "string" && valeur) {
      // Ancien format : une tenue unique devient un créneau unique.
      sortie[date] = [{ id: idCreneau(date, 0), tenueId: valeur, libelle: LIBELLE_DEFAUT, note: "" }];
    }
    // Toute autre valeur est illisible et n'est pas reportée.
  }

  return { journal: sortie, change: JSON.stringify(source) !== JSON.stringify(sortie) };
}

/* Tous les créneaux à plat, pratique pour les statistiques. */
export function creneauxAPlat(journal) {
  return Object.entries(journal || {}).flatMap(([date, liste]) =>
    (Array.isArray(liste) ? liste : []).map((c) => ({ ...c, date })));
}

/* ------------------------------------------------------------------ sauvegarde

   Export et import complets du catalogue (fiches, tenues, journal, photos).
   Le but : ne pas dépendre du stockage du navigateur. Les photos, stockées en
   Blob, sont converties en data URL base64 pour tenir dans un seul fichier JSON,
   et reconstruites en Blob à l'import. */

const blobEnDataURL = (blob) => new Promise((res, rej) => {
  const l = new FileReader();
  l.onload = () => res(String(l.result));
  l.onerror = () => rej(new Error("lecture d'une photo"));
  l.readAsDataURL(blob);
});

/* Reconstruit une image à partir du base64 renvoyé par le serveur. */
export function base64EnBlob(base64, type = "image/jpeg") {
  const binaire = atob(String(base64 || ""));
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
  return new Blob([octets], { type });
}

function dataURLEnBlob(dataURL) {
  const [tete, corps] = String(dataURL).split(",");
  const type = (tete.match(/data:(.*?);base64/) || [])[1] || "image/jpeg";
  const binaire = atob(corps || "");
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
  return new Blob([octets], { type });
}

async function viderMagasin(magasin) {
  const db = await ouvrir();
  const t = db.transaction(magasin, "readwrite");
  t.objectStore(magasin).clear();
  return new Promise((res, rej) => {
    t.oncomplete = () => res(true);
    t.onerror = () => rej(t.error);
  });
}

/* Rassemble tout le catalogue dans un objet sérialisable en JSON. */
export async function exporterDonnees() {
  const [pieces, tenues, journal, photos] = await Promise.all([
    tout("pieces"), tout("tenues"), lire("divers", "journal"), toutesLesPhotos(),
  ]);
  const photosEncodees = {};
  for (const [id, blob] of Object.entries(photos || {})) {
    photosEncodees[id] = await blobEnDataURL(blob);
  }
  return {
    format: "dressing",
    version: 2, // 2 : journal à créneaux
    exporte: new Date().toISOString(),
    pieces: pieces || [],
    tenues: tenues || [],
    journal: migrerJournal(journal).journal,
    photos: photosEncodees,
  };
}

/* Compte ce que contient un fichier avant de proposer de le restaurer. */
export function resumerSauvegarde(data) {
  if (!data || data.format !== "dressing" || !Array.isArray(data.pieces)) {
    throw new Error("Fichier non reconnu. Attendu : un export Dressing (.json).");
  }
  const journal = migrerJournal(data.journal).journal;
  return {
    pieces: data.pieces.length,
    tenues: Array.isArray(data.tenues) ? data.tenues.length : 0,
    photos: data.photos ? Object.keys(data.photos).length : 0,
    jours: Object.keys(journal).length,
    creneaux: creneauxAPlat(journal).length,
    exporte: data.exporte || "",
  };
}

/* Remplace intégralement le contenu local par la sauvegarde fournie. */
export async function importerDonnees(data) {
  resumerSauvegarde(data); // valide le format, lève une erreur claire sinon
  await Promise.all([
    viderMagasin("pieces"), viderMagasin("tenues"),
    viderMagasin("photos"), viderMagasin("divers"),
  ]);
  for (const p of data.pieces) await poser("pieces", p);
  for (const t of (data.tenues || [])) await poser("tenues", t);
  // Une sauvegarde à l'ancien format est convertie au passage.
  await poser("divers", migrerJournal(data.journal).journal, "journal");
  for (const [id, dataURL] of Object.entries(data.photos || {})) {
    await poser("photos", dataURLEnBlob(dataURL), id);
  }
  return resumerSauvegarde(data);
}
