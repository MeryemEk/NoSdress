import React, { useState, useEffect, useRef, useMemo } from "react";
import { tout, lire, poser, oter, toutesLesPhotos, compresser, enBase64, base64EnBlob,
  exporterDonnees, importerDonnees, resumerSauvegarde, estimerPlace } from "./db.js";
import { identifier, lirePage, suggerer, normaliser, codeLocal,
  CATS, SAISONS, FORM, TYPES, MATIERES, COULEURS } from "./ai.js";

const JOURS = ["L", "M", "M", "J", "V", "S", "D"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
  "août", "septembre", "octobre", "novembre", "décembre"];

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
/* Les photos du jour vivent dans le même magasin que celles des pièces, sous une
   clé préfixée : elles suivent donc l'export et l'import sans traitement à part. */
const clePhotoJour = (date) => `jour:${date}`;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const joli = (s) => {
  const [a, m, j] = s.split("-");
  return `${Number(j)} ${MOIS[Number(m) - 1]} ${a}`;
};

export default function App() {
  const [vue, setVue] = useState("pieces");
  const [pret, setPret] = useState(false);
  const [pieces, setPieces] = useState([]);
  const [tenues, setTenues] = useState([]);
  const [journal, setJournal] = useState({});
  const [urls, setUrls] = useState({});
  const [ouvert, setOuvert] = useState(null);
  const [erreur, setErreur] = useState("");

  const boite = useRef({ pieces: [], tenues: [], journal: {} });

  useEffect(() => {
    (async () => {
      try {
        const [p, t, j, photos] = await Promise.all([
          tout("pieces"), tout("tenues"), lire("divers", "journal"), toutesLesPhotos(),
        ]);
        boite.current = { pieces: p || [], tenues: t || [], journal: j || {} };
        const carte = {};
        // On ignore une éventuelle entrée sans image valide : une seule photo
        // corrompue ne doit pas empêcher toute la garde-robe de s'ouvrir.
        Object.entries(photos).forEach(([id, blob]) => {
          if (blob instanceof Blob) carte[id] = URL.createObjectURL(blob);
        });
        setPieces(boite.current.pieces);
        setTenues(boite.current.tenues);
        setJournal(boite.current.journal);
        setUrls(carte);
      } catch (e) {
        setErreur("Base locale inaccessible. Vérifie que la navigation privée est désactivée.");
      }
      setPret(true);
    })();
  }, []);

  const rafraichir = () => {
    setPieces([...boite.current.pieces]);
    setTenues([...boite.current.tenues]);
    setJournal({ ...boite.current.journal });
  };

  const ajouterPiece = async (fiche, blob) => {
    const piece = { ...fiche, id: uid(), ajoute: iso(new Date()) };
    await poser("pieces", piece);
    // La photo n'est enregistrée que si la compression a réellement produit une
    // image. Sans elle, la fiche existe quand même et l'aperçu reste vide.
    if (blob instanceof Blob) {
      await poser("photos", blob, piece.id);
      setUrls((u) => ({ ...u, [piece.id]: URL.createObjectURL(blob) }));
    }
    boite.current.pieces = [piece, ...boite.current.pieces];
    rafraichir();
    return piece;
  };

  const majPiece = async (piece) => {
    await poser("pieces", piece);
    boite.current.pieces = boite.current.pieces.map((p) => (p.id === piece.id ? piece : p));
    rafraichir();
  };

  const supprimerPiece = async (id) => {
    await oter("pieces", id);
    await oter("photos", id);
    boite.current.pieces = boite.current.pieces.filter((p) => p.id !== id);
    const touchees = boite.current.tenues.filter((t) => t.itemIds.includes(id));
    boite.current.tenues = boite.current.tenues.map((t) => ({ ...t, itemIds: t.itemIds.filter((x) => x !== id) }));
    for (const t of touchees) await poser("tenues", { ...t, itemIds: t.itemIds.filter((x) => x !== id) });
    setUrls((u) => { const n = { ...u }; if (n[id]) URL.revokeObjectURL(n[id]); delete n[id]; return n; });
    rafraichir();
  };

  const ajouterTenue = async (t) => {
    const tenue = { id: uid(), cree: iso(new Date()), ...t };
    await poser("tenues", tenue);
    boite.current.tenues = [tenue, ...boite.current.tenues];
    rafraichir();
    return tenue;
  };

  const supprimerTenue = async (id) => {
    await oter("tenues", id);
    boite.current.tenues = boite.current.tenues.filter((t) => t.id !== id);
    const j = { ...boite.current.journal };
    Object.keys(j).forEach((d) => { if (j[d] === id) delete j[d]; });
    boite.current.journal = j;
    await poser("divers", j, "journal");
    rafraichir();
  };

  const marquerJour = async (date, tenueId) => {
    const j = { ...boite.current.journal };
    if (tenueId) j[date] = tenueId; else delete j[date];
    boite.current.journal = j;
    await poser("divers", j, "journal");
    rafraichir();
  };

  /* Photo de ce qui a réellement été porté un jour donné, indépendante de la
     tenue planifiée : on peut l'ajouter le jour même ou bien après coup. */
  const ajouterPhotoJour = async (date, fichier) => {
    const b = await compresser(fichier);
    const cle = clePhotoJour(date);
    await poser("photos", b, cle);
    setUrls((u) => {
      const n = { ...u };
      if (n[cle]) URL.revokeObjectURL(n[cle]);
      n[cle] = URL.createObjectURL(b);
      return n;
    });
  };

  const retirerPhotoJour = async (date) => {
    const cle = clePhotoJour(date);
    await oter("photos", cle);
    setUrls((u) => {
      const n = { ...u };
      if (n[cle]) URL.revokeObjectURL(n[cle]);
      delete n[cle];
      return n;
    });
  };

  const stats = useMemo(() => {
    const parTenue = {}; const parPiece = {}; const today = iso(new Date());
    Object.entries(journal).forEach(([d, tid]) => {
      if (d > today) return;
      parTenue[tid] = parTenue[tid] || { n: 0, last: "" };
      parTenue[tid].n += 1;
      if (d > parTenue[tid].last) parTenue[tid].last = d;
      const t = tenues.find((x) => x.id === tid);
      (t?.itemIds || []).forEach((pid) => {
        parPiece[pid] = parPiece[pid] || { n: 0, last: "" };
        parPiece[pid].n += 1;
        if (d > parPiece[pid].last) parPiece[pid].last = d;
      });
    });
    return { parTenue, parPiece };
  }, [journal, tenues]);

  const c = {
    pieces, tenues, journal, urls, stats, setVue, setOuvert, setErreur,
    piece: (id) => pieces.find((p) => p.id === id),
    ajouterPiece, majPiece, supprimerPiece, ajouterTenue, supprimerTenue, marquerJour,
    ajouterPhotoJour, retirerPhotoJour,
  };

  return (
    <div className="app">
      <header className="haut">
        <h1>dressing</h1>
        <nav className="onglets">
          {[["pieces", "pièces"], ["tenues", "tenues"], ["calendrier", "calendrier"], ["idees", "suggestions"], ["donnees", "données"]]
            .map(([k, l]) => (
              <button key={k} className="onglet" data-actif={vue === k ? "1" : "0"} onClick={() => setVue(k)}>{l}</button>
            ))}
        </nav>
      </header>

      {erreur && (
        <div className="corps">
          <div className="avertissement">
            <p>{erreur}</p>
            {/Code/i.test(erreur) && <ChampCode onOk={() => setErreur("")} />}
            <button className="bouton discret" style={{ marginTop: 10 }} onClick={() => setErreur("")}>Fermer</button>
          </div>
        </div>
      )}

      {!pret ? <div className="corps"><p className="note">Ouverture…</p></div>
        : vue === "pieces" ? <VuePieces {...c} />
        : vue === "tenues" ? <VueTenues {...c} />
        : vue === "calendrier" ? <VueCalendrier {...c} />
        : vue === "idees" ? <VueIdees {...c} />
        : <VueDonnees {...c} />}

      {ouvert && <FichePiece {...c} id={ouvert} />}
    </div>
  );
}

function ChampCode({ onOk }) {
  const [v, setV] = useState(codeLocal.lire());
  return (
    <div style={{ marginTop: 10 }}>
      <div className="champ">
        <label>Code d'accès</label>
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder="celui défini sur Vercel" />
      </div>
      <button className="bouton contour" onClick={() => { codeLocal.ecrire(v.trim()); onOk(); }}>Enregistrer le code</button>
    </div>
  );
}

/* ------------------------------------------------------------------ pièces */

function VuePieces(c) {
  const { pieces, urls, setOuvert } = c;
  const [ajout, setAjout] = useState(false);

  const groupes = CATS.map((k) => [k, pieces.filter((p) => p.categorie === k)]).filter(([, l]) => l.length);

  return (
    <>
      <div className="corps">
        {!pieces.length ? (
          <div className="vide-etat">
            <p className="note" style={{ marginTop: 0 }}>
              L'armoire est vide. Photographie une première pièce, elle sera identifiée et classée.
            </p>
            <button className="bouton plein" onClick={() => setAjout(true)}>Ajouter une pièce</button>
          </div>
        ) : groupes.map(([cat, liste]) => (
          <section className="section" key={cat}>
            <div className="entete">{cat} · {liste.length}</div>
            <div className="grille">
              {liste.map((p) => (
                <button className="piece" key={p.id} onClick={() => setOuvert(p.id)}>
                  <div className="photo">{urls[p.id] && <img src={urls[p.id]} alt={p.nom} loading="lazy" />}</div>
                  <div className="legende"><b>{p.nom}</b>{p.marque || p.sousCategorie}</div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      {pieces.length > 0 && (
        <div className="socle">
          <button className="bouton plein" onClick={() => setAjout(true)}>Ajouter une pièce</button>
        </div>
      )}

      {ajout && <Ajout {...c} fermer={() => setAjout(false)} />}
    </>
  );
}

function Ajout({ ajouterPiece, fermer, setErreur }) {
  const [etape, setEtape] = useState("choix");
  const [blob, setBlob] = useState(null);
  const [apercu, setApercu] = useState("");
  const [fiche, setFiche] = useState(null);
  const [progres, setProgres] = useState("");
  const [web, setWeb] = useState(false);
  const [souci, setSouci] = useState("");
  const [lien, setLien] = useState("");
  const champ = useRef(null);

  /* Import depuis une page produit : le serveur lit la page et rapporte l'image,
     qui repasse ensuite par la compression et l'identification habituelles. */
  const importerLien = async (url) => {
    setSouci("");
    setEtape("lecture");
    try {
      const page = await lirePage(url);
      const b = await compresser(base64EnBlob(page.image, page.typeImage));
      setBlob(b);
      setApercu(URL.createObjectURL(b));
      setEtape("analyse");
      const f = await identifier(await enBase64(b), web, page.contexte);
      if (!f.marque && page.marque) f.marque = page.marque;
      setFiche(f);
      setEtape("fiche");
    } catch (e) {
      setEtape("choix");
      setSouci(e && e.message ? e.message : String(e));
    }
  };

  const traiter = async (fichiers) => {
    const liste = Array.from(fichiers || []);
    if (!liste.length) return;

    if (liste.length > 1) {
      setEtape("lot");
      let rates = 0;
      for (let k = 0; k < liste.length; k++) {
        setProgres(`${k + 1} sur ${liste.length}`);
        try {
          const b = await compresser(liste[k]);
          const f = await identifier(await enBase64(b), web);
          await ajouterPiece(f, b);
        } catch (e) { rates += 1; }
      }
      if (rates) setErreur(`${rates} photo(s) n'ont pas pu être identifiées.`);
      fermer();
      return;
    }

    setEtape("lecture");
    try {
      const b = await compresser(liste[0]);
      setBlob(b);
      setApercu(URL.createObjectURL(b));
      setEtape("analyse");
      const f = await identifier(await enBase64(b), web);
      setFiche(f);
      setEtape("fiche");
    } catch (e) {
      setFiche(normaliser({}));
      setEtape("fiche");
      setSouci(`${e.message}. La photo est là, remplis la fiche à la main.`);
    }
  };

  return (
    <>
      <div className="rideau" onClick={etape === "choix" || etape === "fiche" ? fermer : undefined} />
      <div className="panneau">
        <div className="poignee" />

        {etape === "choix" && (
          <>
            <h2 style={{ fontWeight: 300, fontSize: 22, margin: "0 0 8px" }}>Nouvelle pièce</h2>
            <p className="note" style={{ margin: "0 0 18px" }}>
              Fond neutre, pièce à plat ou sur cintre. Une étiquette visible aide à retrouver la marque.
              Tu peux sélectionner plusieurs photos d'un coup.
            </p>
            <button className="bouton plein" onClick={() => champ.current && champ.current.click()}>Choisir une photo</button>
            <div className="pastilles" style={{ marginTop: 14 }}>
              <button className="pastille" data-actif={web ? "1" : "0"} onClick={() => setWeb(!web)}>
                Confirmer la marque sur le web
              </button>
            </div>
            <p className="note" style={{ marginTop: 10 }}>
              La confirmation web ne se déclenche que si une étiquette est lisible. Elle ajoute une dizaine
              de secondes par pièce, laisse-la éteinte pour un gros import.
            </p>

            <div className="champ" style={{ marginTop: 22 }}>
              <label>Ou depuis un lien de boutique</label>
              <input value={lien} onChange={(e) => setLien(e.target.value)} inputMode="url"
                placeholder="https://..." />
            </div>
            <button className="bouton contour" disabled={!lien.trim()}
              onClick={() => importerLien(lien.trim())}>Importer depuis le lien</button>
            <p className="note" style={{ marginTop: 10 }}>
              La photo du produit et sa description sont récupérées sur la page. Certaines
              boutiques bloquent cette lecture, tu le sauras tout de suite.
            </p>

            {souci && <p className="note" style={{ marginTop: 12, color: "var(--alerte)" }}>{souci}</p>}
          </>
        )}

        {(etape === "lecture" || etape === "analyse" || etape === "lot") && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "24px 0" }}>
            <div className="rouet" />
            <span className="note">
              {etape === "lecture" ? "Préparation de la photo"
                : etape === "analyse" ? "Identification en cours"
                : `Identification, ${progres}`}
            </span>
          </div>
        )}

        {etape === "fiche" && (
          <>
            {souci && <p className="note" style={{ color: "var(--alerte)", marginTop: 0 }}>{souci}</p>}
            <Formulaire
              depart={fiche} apercu={apercu}
              valider={async (f) => {
                try { await ajouterPiece(f, blob); fermer(); }
                catch (e) { setSouci("Enregistrement impossible : " + (e && e.message ? e.message : e)); }
              }}
              annuler={fermer}
            />
          </>
        )}

        <input ref={champ} type="file" accept="image/*" multiple
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          onChange={(e) => { traiter(e.target.files); e.target.value = ""; }} />
      </div>
    </>
  );
}

function Formulaire({ depart, apercu, valider, annuler }) {
  const [f, setF] = useState({ taille: "", ...depart });
  const sur = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const bascule = (k, v) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const liste = (k) => (e) => setF({ ...f, [k]: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) });
  const basculeCouleur = (col) => {
    const c = col.toLowerCase();
    const existe = f.couleurs.some((x) => x.toLowerCase() === c);
    setF({ ...f, couleurs: existe ? f.couleurs.filter((x) => x.toLowerCase() !== c) : [...f.couleurs, c] });
  };

  return (
    <>
      <div style={{ display: "flex", gap: 14, marginBottom: 18 }}>
        {apercu && <img src={apercu} alt="" style={{ width: 84, height: 112, objectFit: "cover" }} />}
        <div>
          <h2 style={{ fontWeight: 300, fontSize: 20, margin: "0 0 4px" }}>Fiche de la pièce</h2>
          <p className="note" style={{ margin: 0 }}>Corrige ce qui ne va pas, puis range la pièce.</p>
        </div>
      </div>

      <div className="champ"><label>Nom</label><input value={f.nom} onChange={sur("nom")} /></div>
      <div className="duo">
        <div className="champ"><label>Catégorie</label>
          <select value={f.categorie} onChange={sur("categorie")}>{CATS.map((k) => <option key={k}>{k}</option>)}</select>
        </div>
        <div className="champ"><label>Marque</label>
          <input value={f.marque} placeholder="inconnue"
            onChange={(e) => setF({ ...f, marque: e.target.value, confiance: "haute" })} />
        </div>
      </div>
      <div className="duo">
        <div className="champ"><label>Type</label>
          <input value={f.sousCategorie} onChange={sur("sousCategorie")} list="aide-types" placeholder="ex: chemise" />
        </div>
        <div className="champ"><label>Taille</label>
          <input value={f.taille} onChange={sur("taille")} placeholder="ex: 38, M" />
        </div>
      </div>
      <div className="champ"><label>Matière</label>
        <input value={f.matiere} onChange={sur("matiere")} list="aide-matieres" placeholder="ex: coton" />
      </div>
      <div className="champ"><label>Couleurs</label>
        <input value={f.couleurs.join(", ")} onChange={liste("couleurs")} />
        <div className="pastilles" style={{ marginTop: 8 }}>
          {COULEURS.map((col) => (
            <button key={col} type="button" className="pastille"
              data-actif={f.couleurs.some((x) => x.toLowerCase() === col.toLowerCase()) ? "1" : "0"}
              onClick={() => basculeCouleur(col)}>{col}</button>
          ))}
        </div>
      </div>
      <datalist id="aide-types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
      <datalist id="aide-matieres">{MATIERES.map((m) => <option key={m} value={m} />)}</datalist>
      <div className="champ"><label>Mots-clés</label><input value={f.styles.join(", ")} onChange={liste("styles")} /></div>
      <div className="champ"><label>Saisons</label>
        <div className="pastilles">
          {SAISONS.map((s) => (
            <button key={s} className="pastille" data-actif={f.saisons.includes(s) ? "1" : "0"}
              onClick={() => bascule("saisons", s)}>{s}</button>
          ))}
        </div>
      </div>
      <div className="champ"><label>Registre</label>
        <div className="pastilles">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className="pastille" data-actif={f.formalite === n ? "1" : "0"}
              onClick={() => setF({ ...f, formalite: n })}>{FORM[n]}</button>
          ))}
        </div>
      </div>

      <div className="duo" style={{ marginTop: 18 }}>
        <button className="bouton discret" onClick={annuler}>Annuler</button>
        <button className="bouton plein" onClick={() => valider(f)}>Ranger la pièce</button>
      </div>
    </>
  );
}

function FichePiece({ id, pieces, urls, stats, majPiece, supprimerPiece, setOuvert, setErreur }) {
  const p = pieces.find((x) => x.id === id);
  const [edition, setEdition] = useState(false);
  const [confirme, setConfirme] = useState(false);
  if (!p) return null;
  const u = stats.parPiece[id];

  return (
    <>
      <div className="rideau" onClick={() => setOuvert(null)} />
      <div className="panneau">
        <div className="poignee" />
        {edition ? (
          <Formulaire depart={p} apercu={urls[id]}
            valider={async (f) => {
              try { await majPiece({ ...p, ...f }); setEdition(false); }
              catch (e) { setErreur("Enregistrement impossible : " + (e && e.message ? e.message : e)); }
            }}
            annuler={() => setEdition(false)} />
        ) : (
          <>
            {urls[id] && <img src={urls[id]} alt={p.nom}
              style={{ width: "100%", maxHeight: "44vh", objectFit: "contain", marginBottom: 18 }} />}
            <div className="fiche">
              <div className="marque">
                {p.marque || "sans marque"}
                {p.marque && p.confiance !== "haute" && <span style={{ letterSpacing: 0, textTransform: "none", marginLeft: 8 }}>à confirmer</span>}
              </div>
              <div className="titre">{p.nom}</div>
              <dl>
                <dt>Catégorie</dt><dd>{p.categorie}{p.sousCategorie ? `, ${p.sousCategorie}` : ""}</dd>
                {p.couleurs.length > 0 && <><dt>Couleurs</dt><dd>{p.couleurs.join(", ")}</dd></>}
                {p.matiere && <><dt>Matière</dt><dd>{p.matiere}</dd></>}
                {p.taille && <><dt>Taille</dt><dd>{p.taille}</dd></>}
                {p.motif && <><dt>Motif</dt><dd>{p.motif}</dd></>}
                <dt>Saisons</dt><dd>{p.saisons.join(", ") || "toutes"}</dd>
                <dt>Registre</dt><dd>{FORM[p.formalite]}</dd>
                {p.styles.length > 0 && <><dt>Mots-clés</dt><dd>{p.styles.join(", ")}</dd></>}
                <dt>Portée</dt><dd>{u ? `${u.n} fois, la dernière le ${joli(u.last)}` : "jamais encore"}</dd>
              </dl>
            </div>
            <div className="duo" style={{ marginTop: 18 }}>
              <button className="bouton discret" onClick={() => setEdition(true)}>Modifier</button>
              {confirme
                ? <button className="bouton danger" onClick={async () => { await supprimerPiece(id); setOuvert(null); }}>Confirmer</button>
                : <button className="bouton danger" onClick={() => setConfirme(true)}>Retirer</button>}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ tenues */

function VueTenues(c) {
  const { tenues, pieces, marquerJour } = c;
  const [compo, setCompo] = useState(false);
  const today = iso(new Date());

  return (
    <>
      <div className="corps">
        {!tenues.length ? (
          <div className="vide-etat">
            <p className="note" style={{ marginTop: 0 }}>
              Aucune tenue. Une tenue peut contenir une seule pièce ou dix, elle devient réutilisable et planifiable.
            </p>
            <button className="bouton plein" disabled={!pieces.length} onClick={() => setCompo(true)}>
              {pieces.length ? "Composer une tenue" : "Ajoute d'abord une pièce"}
            </button>
          </div>
        ) : (
          <section className="section">
            <div className="entete">mes tenues · {tenues.length}</div>
            {tenues.map((t) => (
              <CarteTenue key={t.id} t={t} {...c}
                action={<button className="bouton discret" onClick={() => marquerJour(today, t.id)}>Portée aujourd'hui</button>} />
            ))}
          </section>
        )}
      </div>
      {tenues.length > 0 && (
        <div className="socle">
          <button className="bouton plein" onClick={() => setCompo(true)}>Composer une tenue</button>
        </div>
      )}
      {compo && <Compositeur {...c} fermer={() => setCompo(false)} />}
    </>
  );
}

function CarteTenue({ t, urls, piece, stats, supprimerTenue, action }) {
  const u = stats.parTenue[t.id];
  const [confirme, setConfirme] = useState(false);
  return (
    <div className="carte">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 300 }}>{t.nom}</div>
          {t.note && <p className="note" style={{ margin: "4px 0 0" }}>{t.note}</p>}
        </div>
        {supprimerTenue && (confirme
          ? <button style={{ fontSize: 12, color: "var(--alerte)" }} onClick={() => supprimerTenue(t.id)}>confirmer</button>
          : <button style={{ fontSize: 12, color: "var(--gris)" }} onClick={() => setConfirme(true)}>retirer</button>)}
      </div>
      <div className="bande">
        {t.itemIds.map((id) => urls[id]
          ? <img key={id} src={urls[id]} alt={piece(id)?.nom || ""} loading="lazy" />
          : <div key={id} className="vide" />)}
      </div>
      <div className="info">{u ? `Portée ${u.n} fois, la dernière le ${joli(u.last)}` : "Jamais portée"}</div>
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

/* dateDefaut : jour visé quand la composition part du calendrier, sert au nom
   par défaut. apres : reçoit la tenue créée, pour l'assigner dans la foulée. */
function Compositeur({ pieces, urls, ajouterTenue, fermer, dateDefaut, apres }) {
  const [choix, setChoix] = useState([]);
  const [nom, setNom] = useState("");
  const groupes = CATS.map((k) => [k, pieces.filter((p) => p.categorie === k)]).filter(([, l]) => l.length);

  return (
    <>
      <div className="rideau" onClick={fermer} />
      <div className="panneau">
        <div className="poignee" />
        <h2 style={{ fontWeight: 300, fontSize: 22, margin: "0 0 8px" }}>Composer une tenue</h2>
        <p className="note" style={{ margin: "0 0 16px" }}>
          {dateDefaut ? `Une pièce suffit. Elle sera assignée au ${joli(dateDefaut)}.` : "Une pièce suffit."}
        </p>
        <div className="champ"><label>Nom</label>
          <input value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Lundi comité de direction" /></div>
        {groupes.map(([cat, liste]) => (
          <section className="section" key={cat}>
            <div className="entete">{cat}</div>
            <div className="grille">
              {liste.map((p) => (
                <button className="piece" key={p.id} data-choisie={choix.includes(p.id) ? "1" : "0"}
                  onClick={() => setChoix(choix.includes(p.id) ? choix.filter((x) => x !== p.id) : [...choix, p.id])}>
                  <div className="photo">{urls[p.id] && <img src={urls[p.id]} alt={p.nom} loading="lazy" />}</div>
                  <div className="legende"><b>{p.nom}</b>{p.marque || p.sousCategorie}</div>
                </button>
              ))}
            </div>
          </section>
        ))}
        <div className="duo" style={{ marginTop: 20 }}>
          <button className="bouton discret" onClick={fermer}>Annuler</button>
          <button className="bouton plein" disabled={!choix.length}
            onClick={async () => {
              const t = await ajouterTenue({
                nom: nom.trim() || `Tenue du ${joli(dateDefaut || iso(new Date()))}`,
                itemIds: choix, note: "",
              });
              if (apres) await apres(t);
              fermer();
            }}>Enregistrer ({choix.length})</button>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ calendrier */

function VueCalendrier({ tenues, journal, urls, marquerJour, pieces, ajouterTenue,
  ajouterPhotoJour, retirerPhotoJour, setErreur }) {
  const maintenant = new Date();
  const [curseur, setCurseur] = useState({ a: maintenant.getFullYear(), m: maintenant.getMonth() });
  const [jour, setJour] = useState(null);
  const [compo, setCompo] = useState(null); // date pour laquelle on compose depuis la garde-robe
  const [enregistrePhoto, setEnregistrePhoto] = useState(false);
  const champPhoto = useRef(null);
  const today = iso(maintenant);

  const decalage = (new Date(curseur.a, curseur.m, 1).getDay() + 6) % 7;
  const nb = new Date(curseur.a, curseur.m + 1, 0).getDate();
  const cases = [...Array(decalage).fill(null), ...Array.from({ length: nb }, (_, k) => k + 1)];

  const bouger = (d) => {
    const m = curseur.m + d;
    setCurseur({ a: curseur.a + Math.floor(m / 12), m: ((m % 12) + 12) % 12 });
  };

  /* La photo réellement portée prime sur l'aperçu de la tenue planifiée. */
  const vignette = (date) => {
    const propre = urls[clePhotoJour(date)];
    if (propre) return propre;
    const t = tenues.find((x) => x.id === journal[date]);
    if (!t) return null;
    const id = t.itemIds.find((x) => urls[x]);
    return id ? urls[id] : null;
  };

  const traiterPhoto = async (fichiers) => {
    const f = (fichiers || [])[0];
    if (!f || !jour) return;
    setEnregistrePhoto(true);
    try { await ajouterPhotoJour(jour, f); }
    catch (e) { setErreur("Photo impossible à enregistrer : " + (e && e.message ? e.message : e)); }
    setEnregistrePhoto(false);
  };

  return (
    <div className="corps">
      <div className="mois">
        <button onClick={() => bouger(-1)} aria-label="Mois précédent" style={{ fontSize: 20, color: "var(--gris)", padding: "4px 12px" }}>‹</button>
        <span>{MOIS[curseur.m]} {curseur.a}</span>
        <button onClick={() => bouger(1)} aria-label="Mois suivant" style={{ fontSize: 20, color: "var(--gris)", padding: "4px 12px" }}>›</button>
      </div>
      <div className="calendrier">{JOURS.map((d, k) => <div className="jourNom" key={k}>{d}</div>)}</div>
      <div className="calendrier" style={{ marginTop: 2 }}>
        {cases.map((n, k) => {
          if (!n) return <div key={k} />;
          const date = iso(new Date(curseur.a, curseur.m, n));
          const v = vignette(date);
          return (
            <button className="jour" key={k} onClick={() => setJour(date)}
              data-aujourdhui={date === today ? "1" : "0"}
              data-prevu={date > today && journal[date] ? "1" : "0"}
              data-img={v ? "1" : "0"}>
              <em>{n}</em>
              {v && <img src={v} alt="" loading="lazy" />}
            </button>
          );
        })}
      </div>
      <p className="note" style={{ marginTop: 16 }}>
        Cadre plein : tenue portée. Cadre pointillé : tenue prévue. Touche un jour pour composer
        une tenue ou y ajouter la photo de ce que tu as porté.
      </p>

      {jour && (
        <>
          <div className="rideau" onClick={() => setJour(null)} />
          <div className="panneau">
            <div className="poignee" />
            <h2 style={{ fontWeight: 300, fontSize: 20, margin: "0 0 6px" }}>{joli(jour)}</h2>
            <p className="note" style={{ margin: "0 0 16px" }}>
              {jour > today ? "Quelle tenue prévois-tu ?" : "Quelle tenue as-tu portée ?"}
            </p>

            {/* Photo réellement portée : proposée en premier pour aujourd'hui et
                les jours passés, reléguée en bas pour un jour à venir. */}
            {jour <= today && (
              <BlocPhotoJour jour={jour} urls={urls} champPhoto={champPhoto}
                enregistrePhoto={enregistrePhoto} retirerPhotoJour={retirerPhotoJour} />
            )}

            <button className="bouton contour" disabled={!pieces.length}
              onClick={() => { setCompo(jour); setJour(null); }}>
              {pieces.length ? "Composer à partir de ma garde-robe" : "Ajoute d'abord une pièce"}
            </button>

            {tenues.length > 0 && (
              <div className="entete" style={{ marginTop: 22 }}>ou reprendre une tenue</div>
            )}
            {!tenues.length && (
              <p className="note" style={{ marginTop: 14 }}>Aucune tenue enregistrée pour l'instant.</p>
            )}
            {tenues.map((t) => (
              <button key={t.id} style={{ display: "block", width: "100%", textAlign: "left" }}
                onClick={async () => { await marquerJour(jour, t.id); setJour(null); }}>
                <div className="carte" style={{ borderColor: journal[jour] === t.id ? "var(--encre)" : "var(--ligne)" }}>
                  <div style={{ fontSize: 17, fontWeight: 300 }}>{t.nom}</div>
                  <div className="bande">
                    {t.itemIds.slice(0, 5).map((id) => urls[id]
                      ? <img key={id} src={urls[id]} alt="" loading="lazy" />
                      : <div key={id} className="vide" />)}
                  </div>
                </div>
              </button>
            ))}
            {jour > today && (
              <BlocPhotoJour jour={jour} urls={urls} champPhoto={champPhoto}
                enregistrePhoto={enregistrePhoto} retirerPhotoJour={retirerPhotoJour} />
            )}

            {journal[jour] && (
              <button className="bouton danger" style={{ marginTop: 18 }}
                onClick={async () => { await marquerJour(jour, null); setJour(null); }}>
                Retirer la tenue de ce jour
              </button>
            )}

            <input ref={champPhoto} type="file" accept="image/*"
              style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
              onChange={(e) => { traiterPhoto(e.target.files); e.target.value = ""; }} />
          </div>
        </>
      )}

      {compo && (
        <Compositeur pieces={pieces} urls={urls} ajouterTenue={ajouterTenue}
          dateDefaut={compo}
          apres={async (t) => { await marquerJour(compo, t.id); }}
          fermer={() => setCompo(null)} />
      )}
    </div>
  );
}

/* Photo de ce qui a été porté un jour donné, ajoutée sur le moment ou après coup. */
function BlocPhotoJour({ jour, urls, champPhoto, enregistrePhoto, retirerPhotoJour }) {
  const photo = urls[clePhotoJour(jour)];
  const [confirme, setConfirme] = useState(false);

  return (
    <section className="section">
      <div className="entete">photo portée</div>
      {enregistrePhoto ? (
        <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 0" }}>
          <div className="rouet" />
          <span className="note">Enregistrement de la photo</span>
        </div>
      ) : photo ? (
        <>
          <img src={photo} alt="Tenue portée ce jour-là"
            style={{ width: "100%", maxHeight: "38vh", objectFit: "contain", marginBottom: 12 }} />
          <div className="duo">
            <button className="bouton discret" onClick={() => champPhoto.current && champPhoto.current.click()}>
              Remplacer
            </button>
            {confirme
              ? <button className="bouton danger" onClick={async () => { await retirerPhotoJour(jour); setConfirme(false); }}>Confirmer</button>
              : <button className="bouton danger" onClick={() => setConfirme(true)}>Retirer la photo</button>}
          </div>
        </>
      ) : (
        <button className="bouton discret" onClick={() => champPhoto.current && champPhoto.current.click()}>
          Ajouter une photo de ce que j'ai porté
        </button>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ suggestions */

function VueIdees(c) {
  const { pieces, tenues, journal, stats, ajouterTenue, marquerJour, setErreur, setOuvert, urls } = c;
  const [contexte, setContexte] = useState("");
  const [charge, setCharge] = useState(false);
  const [propositions, setPropositions] = useState([]);

  const jamais = pieces.filter((p) => !stats.parPiece[p.id]);

  const demander = async () => {
    setCharge(true); setPropositions([]);
    const today = iso(new Date());
    const recentes = [...new Set(Object.entries(journal)
      .filter(([d]) => d <= today).sort().slice(-6)
      .flatMap(([, tid]) => tenues.find((t) => t.id === tid)?.itemIds || []))];
    try {
      const r = await suggerer({ pieces, contexte, recentes, date: joli(today) });
      if (!r.length) setErreur("Aucune proposition exploitable. Reformule le contexte ou ajoute des pièces.");
      setPropositions(r);
    } catch (e) {
      setErreur(e.message);
    }
    setCharge(false);
  };

  return (
    <div className="corps">
      {pieces.length < 4 ? (
        <div className="vide-etat">
          <p className="note" style={{ margin: 0 }}>
            Il faut au moins quatre pièces pour que les suggestions aient du sens. Tu en as {pieces.length}.
          </p>
        </div>
      ) : (
        <>
          <div className="champ"><label>Contexte du jour</label>
            <textarea value={contexte} onChange={(e) => setContexte(e.target.value)}
              placeholder="Comité de direction le matin, dîner en ville le soir, 14 degrés et pluie" /></div>
          <button className="bouton plein" disabled={charge} onClick={demander}>
            {charge ? "Composition…" : "Proposer trois tenues"}
          </button>

          {propositions.length > 0 && (
            <section className="section">
              <div className="entete">propositions</div>
              {propositions.map((t, k) => (
                <CarteTenue key={k} t={{ ...t, id: `p${k}`, note: t.pourquoi }} {...c} supprimerTenue={null}
                  action={
                    <div className="duo">
                      <button className="bouton discret"
                        onClick={() => ajouterTenue({ nom: t.nom, itemIds: t.itemIds, note: t.pourquoi })}>Garder</button>
                      <button className="bouton discret"
                        onClick={async () => {
                          const n = await ajouterTenue({ nom: t.nom, itemIds: t.itemIds, note: t.pourquoi });
                          await marquerJour(iso(new Date()), n.id);
                        }}>Je la porte</button>
                    </div>
                  } />
              ))}
            </section>
          )}

          {jamais.length > 0 && (
            <section className="section">
              <div className="entete">jamais portées · {jamais.length}</div>
              <div className="grille">
                {jamais.slice(0, 8).map((p) => (
                  <button className="piece" key={p.id} onClick={() => setOuvert(p.id)}>
                    <div className="photo">{urls[p.id] && <img src={urls[p.id]} alt={p.nom} loading="lazy" />}</div>
                    <div className="legende"><b>{p.nom}</b>{p.marque || p.sousCategorie}</div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ données */

function telecharger(nomFichier, texte) {
  const blob = new Blob([texte], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomFichier;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function poids(octets) {
  if (!octets) return "0 Mo";
  return `${(octets / 1048576).toFixed(1)} Mo`;
}

function VueDonnees({ pieces, tenues, journal, setErreur }) {
  const [occupe, setOccupe] = useState(false);
  const [etat, setEtat] = useState("");
  const [enAttente, setEnAttente] = useState(null); // { data, resume } avant confirmation
  const [place, setPlace] = useState(null);
  const [code, setCode] = useState(codeLocal.lire());
  const [codeEnregistre, setCodeEnregistre] = useState(false);
  const champ = useRef(null);

  const jours = Object.keys(journal || {}).length;

  const enregistrerCode = () => {
    codeLocal.ecrire(code.trim());
    setCodeEnregistre(true);
    setTimeout(() => setCodeEnregistre(false), 2500);
  };

  useEffect(() => {
    estimerPlace().then(setPlace).catch(() => setPlace(null));
  }, [pieces.length, tenues.length]);

  const exporter = async () => {
    setOccupe(true); setEtat("");
    try {
      const data = await exporterDonnees();
      telecharger(`dressing-${iso(new Date())}.json`, JSON.stringify(data));
      setEtat(`Sauvegarde créée : ${data.pieces.length} pièces, ${data.tenues.length} tenues, ${Object.keys(data.photos).length} photos.`);
    } catch (e) {
      setErreur("Export impossible. " + e.message);
    }
    setOccupe(false);
  };

  const lireFichier = (fichiers) => {
    const f = (fichiers || [])[0];
    if (!f) return;
    setEtat("");
    const l = new FileReader();
    l.onload = () => {
      try {
        const data = JSON.parse(String(l.result));
        setEnAttente({ data, resume: resumerSauvegarde(data) });
      } catch (e) {
        setErreur("Fichier illisible. " + e.message);
      }
    };
    l.onerror = () => setErreur("Lecture du fichier impossible.");
    l.readAsText(f);
  };

  const confirmerImport = async () => {
    setOccupe(true);
    try {
      await importerDonnees(enAttente.data);
      // On recharge pour repartir d'un état propre : photos, aperçus et journal.
      location.reload();
    } catch (e) {
      setErreur("Import impossible. " + e.message);
      setOccupe(false);
      setEnAttente(null);
    }
  };

  return (
    <div className="corps">
      <section className="section" style={{ marginTop: 8 }}>
        <div className="entete">code d'accès</div>
        <p className="note" style={{ marginTop: 0 }}>
          Le code que tu as défini sur Vercel (variable DRESSING_CODE). Il est demandé
          une seule fois pour autoriser l'identification automatique des photos, puis
          retenu sur cet appareil. L'enregistrement des pièces à la main n'en a pas besoin.
        </p>
        <div className="champ">
          <label>Code</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="celui défini sur Vercel" />
        </div>
        <button className="bouton contour" onClick={enregistrerCode}>Enregistrer le code</button>
        {codeEnregistre && <p className="note" style={{ marginTop: 10, color: "var(--olive)" }}>Code enregistré.</p>}
      </section>

      <section className="section">
        <div className="entete">sauvegarde</div>
        <p className="note" style={{ marginTop: 0 }}>
          Ton catalogue vit dans ce navigateur. Exporte-le régulièrement dans un fichier
          que tu gardes ailleurs : il contient tes fiches, tes tenues, ton journal et tes photos.
        </p>
        <p className="note">
          {pieces.length} pièces · {tenues.length} tenues · {jours} jour(s) au journal
          {place && place.total ? ` · ${poids(place.utilise)} utilisés` : ""}
        </p>
        <button className="bouton plein" disabled={occupe || !pieces.length} onClick={exporter}>
          {occupe ? "Un instant…" : "Exporter le catalogue"}
        </button>
        {!pieces.length && (
          <p className="note" style={{ marginTop: 8 }}>Rien à exporter pour l'instant.</p>
        )}
        {etat && <p className="note" style={{ marginTop: 10, color: "var(--olive)" }}>{etat}</p>}
      </section>

      <section className="section">
        <div className="entete">restauration</div>
        <p className="note" style={{ marginTop: 0 }}>
          Importe un fichier exporté depuis Dressing. Le contenu actuel de ce navigateur
          sera remplacé par celui de la sauvegarde.
        </p>
        <button className="bouton contour" disabled={occupe} onClick={() => champ.current && champ.current.click()}>
          Choisir un fichier
        </button>
        <input ref={champ} type="file" accept="application/json,.json"
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          onChange={(e) => { lireFichier(e.target.files); e.target.value = ""; }} />
      </section>

      {enAttente && (
        <>
          <div className="rideau" onClick={() => !occupe && setEnAttente(null)} />
          <div className="panneau">
            <div className="poignee" />
            <h2 style={{ fontWeight: 300, fontSize: 22, margin: "0 0 8px" }}>Remplacer le catalogue ?</h2>
            <p className="note" style={{ margin: "0 0 16px" }}>
              Cette sauvegarde contient {enAttente.resume.pieces} pièces, {enAttente.resume.tenues} tenues,
              {" "}{enAttente.resume.photos} photos et {enAttente.resume.jours} jour(s) de journal.
              {enAttente.resume.exporte ? ` Exportée le ${enAttente.resume.exporte.slice(0, 10)}.` : ""}
            </p>
            <p className="note" style={{ margin: "0 0 16px", color: "var(--alerte)" }}>
              Le contenu présent dans ce navigateur ({pieces.length} pièces, {tenues.length} tenues)
              sera effacé et remplacé. Pense à l'exporter d'abord si tu veux le garder.
            </p>
            <div className="duo">
              <button className="bouton discret" disabled={occupe} onClick={() => setEnAttente(null)}>Annuler</button>
              <button className="bouton plein" disabled={occupe} onClick={confirmerImport}>
                {occupe ? "Restauration…" : "Remplacer et recharger"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
