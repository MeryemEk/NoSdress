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
    version: 1,
    exporte: new Date().toISOString(),
    pieces: pieces || [],
    tenues: tenues || [],
    journal: journal || {},
    photos: photosEncodees,
  };
}

/* Compte ce que contient un fichier avant de proposer de le restaurer. */
export function resumerSauvegarde(data) {
  if (!data || data.format !== "dressing" || !Array.isArray(data.pieces)) {
    throw new Error("Fichier non reconnu. Attendu : un export Dressing (.json).");
  }
  return {
    pieces: data.pieces.length,
    tenues: Array.isArray(data.tenues) ? data.tenues.length : 0,
    photos: data.photos ? Object.keys(data.photos).length : 0,
    jours: data.journal ? Object.keys(data.journal).length : 0,
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
  await poser("divers", data.journal || {}, "journal");
  for (const [id, dataURL] of Object.entries(data.photos || {})) {
    await poser("photos", dataURLEnBlob(dataURL), id);
  }
  return resumerSauvegarde(data);
}
