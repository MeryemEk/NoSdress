import React, { useState, useEffect, useRef, useMemo } from "react";
import { tout, lire, poser, oter, toutesLesPhotos, compresser, decouper, enBase64, base64EnBlob,
  exporterDonnees, importerDonnees, resumerSauvegarde, estimerPlace,
  migrerJournal, creneauxAPlat, LIBELLES, LIBELLE_DEFAUT,
  harmoniser, ressemblances } from "./db.js";
import { identifier, identifierGroupe, lirePage, suggerer, normaliser, codeLocal,
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
        // Le journal peut être à l'ancien format, une seule tenue par date.
        // On le convertit et on ne réécrit la base que si quelque chose a bougé.
        const migre = migrerJournal(j);
        if (migre.change) await poser("divers", migre.journal, "journal");
        boite.current = { pieces: p || [], tenues: t || [], journal: migre.journal };
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
    const connues = [...new Set(boite.current.pieces.map((x) => x.marque).filter(Boolean))];
    const piece = { ...fiche, marque: harmoniser(connues, fiche.marque), id: uid(), ajoute: iso(new Date()) };
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

  const majPiece = async (brute) => {
    const connues = [...new Set(boite.current.pieces
      .filter((x) => x.id !== brute.id).map((x) => x.marque).filter(Boolean))];
    const piece = { ...brute, marque: harmoniser(connues, brute.marque) };
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
    // Les créneaux qui pointaient vers cette tenue disparaissent, les autres
    // créneaux de la même journée sont conservés.
    const j = {};
    Object.entries(boite.current.journal).forEach(([d, liste]) => {
      const reste = liste.filter((c) => c.tenueId !== id);
      if (reste.length) j[d] = reste;
    });
    boite.current.journal = j;
    await poser("divers", j, "journal");
    rafraichir();
  };

  /* Écrit le journal et rafraîchit l'affichage. */
  const poserJournal = async (j) => {
    boite.current.journal = j;
    await poser("divers", j, "journal");
    rafraichir();
  };

  const ajouterCreneau = async (date, { tenueId, libelle, note }) => {
    const creneau = {
      id: uid(),
      tenueId,
      libelle: (libelle || "").trim() || LIBELLE_DEFAUT,
      note: (note || "").trim(),
    };
    const j = { ...boite.current.journal, [date]: [...(boite.current.journal[date] || []), creneau] };
    await poserJournal(j);
    return creneau;
  };

  const majCreneau = async (date, creneauId, modif) => {
    const liste = (boite.current.journal[date] || []).map((c) => (c.id === creneauId
      ? { ...c, ...modif, libelle: ((modif.libelle ?? c.libelle) || "").trim() || LIBELLE_DEFAUT }
      : c));
    await poserJournal({ ...boite.current.journal, [date]: liste });
  };

  const retirerCreneau = async (date, creneauId) => {
    const reste = (boite.current.journal[date] || []).filter((c) => c.id !== creneauId);
    const j = { ...boite.current.journal };
    if (reste.length) j[date] = reste; else delete j[date];
    await poserJournal(j);
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

  /* La Cave : les pièces rangées hors saison sortent de la garde-robe courante
     mais restent dans la base. L'historique et les tenues qui les contiennent
     ne sont pas touchés, seule leur disponibilité change. */
  const rangerEnCave = async (ids, sac) => {
    const nom = (sac || "").trim() || "Sans nom";
    const depuis = iso(new Date());
    const vises = new Set(ids);
    const modifiees = boite.current.pieces
      .filter((p) => vises.has(p.id))
      .map((p) => ({ ...p, cave: { sac: nom, depuis } }));
    for (const p of modifiees) await poser("pieces", p);
    const parId = new Map(modifiees.map((p) => [p.id, p]));
    boite.current.pieces = boite.current.pieces.map((p) => parId.get(p.id) || p);
    rafraichir();
  };

  /* Création en lot depuis une photo de groupe : les pièces naissent
     directement dans la cave, sans passer par la garde-robe. */
  const ajouterPiecesEnCave = async (liste, sac) => {
    const nom = (sac || "").trim() || "Sans nom";
    const depuis = iso(new Date());
    const creees = [];
    for (const { fiche, blob } of liste) {
      const connues = [...new Set(boite.current.pieces.map((x) => x.marque).filter(Boolean)),
        ...creees.map((x) => x.marque).filter(Boolean)];
      const piece = { ...fiche, marque: harmoniser(connues, fiche.marque),
        id: uid(), ajoute: depuis, cave: { sac: nom, depuis } };
      delete piece.cadre; // le cadre a servi au découpage, il n'a plus d'usage
      await poser("pieces", piece);
      if (blob instanceof Blob) {
        await poser("photos", blob, piece.id);
        setUrls((u) => ({ ...u, [piece.id]: URL.createObjectURL(blob) }));
      }
      creees.push(piece);
    }
    boite.current.pieces = [...creees, ...boite.current.pieces];
    rafraichir();
    return creees;
  };

  const sortirDeCave = async (ids) => {
    const vises = new Set(ids);
    const modifiees = boite.current.pieces
      .filter((p) => vises.has(p.id))
      .map((p) => { const n = { ...p }; delete n.cave; return n; });
    for (const p of modifiees) await poser("pieces", p);
    const parId = new Map(modifiees.map((p) => [p.id, p]));
    boite.current.pieces = boite.current.pieces.map((p) => parId.get(p.id) || p);
    rafraichir();
  };

  /* Chaque créneau compte pour un port : deux tenues le même jour comptent
     deux fois, et la même tenue portée matin et soir compte deux fois aussi. */
  const stats = useMemo(() => {
    const parTenue = {}; const parPiece = {}; const today = iso(new Date());
    creneauxAPlat(journal).forEach(({ date: d, tenueId }) => {
      if (d > today) return;
      parTenue[tenueId] = parTenue[tenueId] || { n: 0, last: "" };
      parTenue[tenueId].n += 1;
      if (d > parTenue[tenueId].last) parTenue[tenueId].last = d;
      const t = tenues.find((x) => x.id === tenueId);
      (t?.itemIds || []).forEach((pid) => {
        parPiece[pid] = parPiece[pid] || { n: 0, last: "" };
        parPiece[pid].n += 1;
        if (d > parPiece[pid].last) parPiece[pid].last = d;
      });
    });
    return { parTenue, parPiece };
  }, [journal, tenues]);

  // Marques déjà saisies, proposées à la frappe et servant à unifier la casse.
  const marques = [...new Set(pieces.map((p) => p.marque).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "fr"));

  const actives = pieces.filter((p) => !p.cave);
  const enCave = pieces.filter((p) => p.cave);
  // Noms de sacs déjà utilisés, pour les reproposer au lieu de les retaper.
  const sacs = [...new Set(enCave.map((p) => p.cave.sac))].sort((a, b) => a.localeCompare(b, "fr"));

  const c = {
    // pieces ne contient que la garde-robe courante : tout ce qui composait déjà
    // l'application ignore donc la cave sans autre changement.
    pieces: actives, toutes: pieces, cave: enCave, sacs, marques,
    tenues, journal, urls, stats, setVue, setOuvert, setErreur,
    piece: (id) => pieces.find((p) => p.id === id), // cherche aussi dans la cave
    ajouterPiece, majPiece, supprimerPiece, ajouterTenue, supprimerTenue,
    ajouterCreneau, majCreneau, retirerCreneau,
    ajouterPhotoJour, retirerPhotoJour, rangerEnCave, sortirDeCave, ajouterPiecesEnCave,
  };

  return (
    <div className="app">
      <header className="haut">
        <h1>dressing</h1>
        <nav className="onglets">
          {[["pieces", "pièces"], ["tenues", "tenues"], ["calendrier", "calendrier"],
            ["idees", "suggestions"], ["cave", "cave"], ["donnees", "données"]]
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
        : vue === "cave" ? <VueCave {...c} />
        : <VueDonnees {...c} />}

      {ouvert && <FichePiece {...c} id={ouvert} />}
    </div>
  );
}

/* Fermeture d'un panneau. Remplace l'ancienne poignée, qui suggérait un glissement
   sans en offrir un. Zone tactile d'environ 44 px, la taille visée sur iPhone. */
function BoutonFermer({ onClick, desactive }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", margin: "0 -8px 6px 0", minHeight: 34 }}>
      {onClick && (
        <button onClick={onClick} disabled={desactive} aria-label="Fermer"
          style={{
            fontSize: 24, lineHeight: 1, color: "var(--gris)",
            padding: "6px 12px", opacity: desactive ? 0.35 : 1,
          }}>×</button>
      )}
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

/* ------------------------------------------------------------------ cave */

/* Choix du sac de rangement. Les sacs déjà utilisés sont proposés en boutons
   pour éviter les doublons dus à une faute de frappe. */
function FormulaireSac({ sacs, depart, combien, valider, annuler }) {
  const [sac, setSac] = useState(depart || "");

  // Si le nom saisi correspond à un sac existant à la casse près, on garde
  // l'orthographe déjà en place plutôt que d'en créer un second.

  return (
    <div className="carte">
      <p className="note" style={{ margin: "0 0 12px" }}>
        {combien > 1
          ? `${combien} pièces vont être rangées. Dans quel sac les mets-tu ?`
          : "Dans quel sac ranges-tu cette pièce ?"}
      </p>

      {sacs.length > 0 && (
        <div className="champ">
          <label>Sacs déjà utilisés</label>
          <div className="pastilles">
            {sacs.map((s) => (
              <button key={s} className="pastille" data-actif={sac.trim().toLowerCase() === s.toLowerCase() ? "1" : "0"}
                onClick={() => setSac(s)}>{s}</button>
            ))}
          </div>
        </div>
      )}

      <div className="champ">
        <label>{sacs.length ? "Ou un nouveau sac" : "Nom du sac"}</label>
        <input value={sac} onChange={(e) => setSac(e.target.value)}
          placeholder="Sac bleu du haut, carton hiver…" />
      </div>

      <div className="duo">
        <button className="bouton discret" onClick={annuler}>Annuler</button>
        <button className="bouton plein" disabled={!sac.trim()}
          onClick={() => valider(harmoniser(sacs, sac))}>Ranger à la cave</button>
      </div>
    </div>
  );
}

/* Une photo, plusieurs vêtements, un seul appel : l'app détecte les pièces,
   découpe une vignette pour chacune, puis les crée directement dans un sac. */
function AjoutGroupe({ sacs, ajouterPiecesEnCave, fermer, setErreur, marques, toutes }) {
  const [etape, setEtape] = useState("choix");
  const [apercu, setApercu] = useState("");
  const [trouvees, setTrouvees] = useState([]);  // { fiche, blob, apercu, decoupee, garder }
  const [sac, setSac] = useState("");
  const [souci, setSouci] = useState("");
  const champ = useRef(null);

  const analyser = async (fichiers) => {
    const f = (fichiers || [])[0];
    if (!f) return;
    setSouci("");
    setEtape("lecture");
    try {
      // Résolution plus élevée que pour une pièce seule : chaque vêtement
      // n'occupe qu'une fraction de l'image et doit rester lisible.
      const b = await compresser(f, 1600, 0.78);
      setApercu(URL.createObjectURL(b));
      setEtape("analyse");

      const liste = await identifierGroupe(await enBase64(b));
      if (!liste.length) {
        setEtape("choix");
        setSouci("Aucun vêtement reconnu sur cette photo. Étale les pièces sur un fond uni, sans les superposer.");
        return;
      }

      const preparees = [];
      for (const fiche of liste) {
        const morceau = await decouper(b, fiche.cadre);
        preparees.push({
          fiche,
          blob: morceau || b,
          apercu: morceau ? URL.createObjectURL(morceau) : URL.createObjectURL(b),
          decoupee: !!morceau,
          garder: true,
        });
      }
      setTrouvees(preparees);
      setEtape("verif");
    } catch (e) {
      setEtape("choix");
      setSouci(e && e.message ? e.message : String(e));
    }
  };

  const modifier = (k, modif) => setTrouvees((l) => l.map((x, i) => (i === k ? { ...x, ...modif } : x)));
  const retenues = trouvees.filter((x) => x.garder);
  const sansDecoupe = retenues.filter((x) => !x.decoupee).length;

  const enregistrer = async () => {
    setEtape("enregistrement");
    try {
      await ajouterPiecesEnCave(retenues.map((x) => ({ fiche: x.fiche, blob: x.blob })), sac);
      fermer();
    } catch (e) {
      setEtape("verif");
      setErreur("Enregistrement impossible : " + (e && e.message ? e.message : e));
    }
  };

  return (
    <>
      <div className="rideau" onClick={etape === "choix" || etape === "verif" ? fermer : undefined} />
      <div className="panneau">
        <BoutonFermer onClick={etape === "choix" || etape === "verif" ? fermer : null} />

        {etape === "choix" && (
          <>
            <h2 style={{ fontWeight: 300, fontSize: 22, margin: "0 0 8px" }}>Remplir un sac depuis une photo</h2>
            <p className="note" style={{ margin: "0 0 18px" }}>
              Étale le contenu du sac sur un fond uni, les pièces côte à côte sans se
              chevaucher, puis photographie l'ensemble. Une seule analyse suffit pour tout
              le sac, c'est moins cher que pièce par pièce.
            </p>
            <button className="bouton plein" onClick={() => champ.current && champ.current.click()}>
              Choisir la photo du sac
            </button>
            {souci && <p className="note" style={{ marginTop: 12, color: "var(--alerte)" }}>{souci}</p>}
          </>
        )}

        {(etape === "lecture" || etape === "analyse" || etape === "enregistrement") && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "24px 0" }}>
            <div className="rouet" />
            <span className="note">
              {etape === "lecture" ? "Préparation de la photo"
                : etape === "analyse" ? "Identification des pièces"
                : "Rangement dans la cave"}
            </span>
          </div>
        )}

        {etape === "verif" && (
          <>
            <h2 style={{ fontWeight: 300, fontSize: 22, margin: "0 0 6px" }}>
              {trouvees.length} pièce(s) reconnue(s)
            </h2>
            <p className="note" style={{ margin: "0 0 4px" }}>
              Décoche ce qui n'est pas un vêtement, corrige les noms, puis nomme le sac.
            </p>
            {sansDecoupe > 0 && (
              <p className="note" style={{ margin: "0 0 14px", color: "var(--alerte)" }}>
                {sansDecoupe} vignette(s) n'ont pas pu être découpées : ces pièces gardent
                la photo entière du sac.
              </p>
            )}

            {apercu && <img src={apercu} alt="" style={{ width: "100%", maxHeight: "26vh",
              objectFit: "contain", margin: "10px 0 16px" }} />}

            {trouvees.map((x, k) => (
              <div className="carte" key={k} style={{ opacity: x.garder ? 1 : 0.45 }}>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ width: 54, height: 72, flexShrink: 0, background: "#E5E1D8", overflow: "hidden" }}>
                    <img src={x.apercu} alt="" loading="lazy"
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="champ" style={{ marginBottom: 8 }}>
                      <input value={x.fiche.nom}
                        onChange={(e) => modifier(k, { fiche: { ...x.fiche, nom: e.target.value } })} />
                    </div>
                    <div className="duo" style={{ gap: 8 }}>
                      <div className="champ" style={{ marginBottom: 0 }}>
                        <select value={x.fiche.categorie}
                          onChange={(e) => modifier(k, { fiche: { ...x.fiche, categorie: e.target.value } })}>
                          {CATS.map((n) => <option key={n}>{n}</option>)}
                        </select>
                      </div>
                      <div className="champ" style={{ marginBottom: 0 }}>
                        <input value={x.fiche.marque} placeholder="marque" list="aide-marques"
                          onChange={(e) => modifier(k, {
                            fiche: { ...x.fiche, marque: e.target.value, confiance: "haute" },
                          })} />
                      </div>
                    </div>
                  </div>
                </div>
                {(() => {
                  const proches = ressemblances(x.fiche, toutes);
                  return proches.length > 0 && (
                    <p className="note" style={{ margin: "8px 0 0", color: "var(--alerte)" }}>
                      Ressemble à « {proches[0].piece.nom} », déjà dans ton catalogue.
                    </p>
                  );
                })()}
                <div className="pastilles" style={{ marginTop: 10 }}>
                  <button className="pastille" data-actif={x.garder ? "1" : "0"}
                    onClick={() => modifier(k, { garder: !x.garder })}>
                    {x.garder ? "à ranger" : "ignorée"}
                  </button>
                </div>
              </div>
            ))}

            <datalist id="aide-marques">{marques.map((m) => <option key={m} value={m} />)}</datalist>

            <section className="section">
              <div className="entete">sac de rangement</div>
              {sacs.length > 0 && (
                <div className="champ">
                  <label>Sacs déjà utilisés</label>
                  <div className="pastilles">
                    {sacs.map((s) => (
                      <button key={s} className="pastille"
                        data-actif={sac.trim().toLowerCase() === s.toLowerCase() ? "1" : "0"}
                        onClick={() => setSac(s)}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="champ">
                <label>{sacs.length ? "Ou un nouveau sac" : "Nom du sac"}</label>
                <input value={sac} onChange={(e) => setSac(e.target.value)}
                  placeholder="Sac bleu du haut, carton hiver…" />
              </div>
            </section>

            <div className="duo" style={{ marginTop: 8 }}>
              <button className="bouton discret" onClick={fermer}>Annuler</button>
              <button className="bouton plein" disabled={!retenues.length || !sac.trim()}
                onClick={enregistrer}>
                Ranger {retenues.length} pièce(s)
              </button>
            </div>
          </>
        )}

        <input ref={champ} type="file" accept="image/*"
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          onChange={(e) => { analyser(e.target.files); e.target.value = ""; }} />
      </div>
    </>
  );
}

function VueCave(c) {
  const { cave, sacs, urls, setOuvert, sortirDeCave, setVue } = c;
  const [confirme, setConfirme] = useState(null);
  const [groupe, setGroupe] = useState(false);

  const boutonGroupe = (
    <button className="bouton contour" onClick={() => setGroupe(true)}>
      Remplir un sac depuis une photo
    </button>
  );

  if (!cave.length) {
    return (
      <div className="corps">
        <div className="vide-etat">
          <p className="note" style={{ marginTop: 0 }}>
            La cave est vide. Range ici ce que tu ne portes pas en ce moment, hors saison
            ou mis de côté : ces pièces sortent de la garde-robe et des suggestions,
            sans être supprimées.
          </p>
          {boutonGroupe}
          <button className="bouton discret" style={{ marginTop: 8 }}
            onClick={() => setVue("pieces")}>Aller à la garde-robe</button>
        </div>
        {groupe && <AjoutGroupe {...c} fermer={() => setGroupe(false)} />}
      </div>
    );
  }

  return (
    <div className="corps">
      <p className="note" style={{ marginTop: 0 }}>
        {cave.length} pièce(s) rangée(s) dans {sacs.length} sac(s). Elles n'apparaissent ni dans
        la garde-robe, ni dans les suggestions, tant qu'elles sont ici.
      </p>
      {boutonGroupe}
      {groupe && <AjoutGroupe {...c} fermer={() => setGroupe(false)} />}

      {sacs.map((s) => {
        const dedans = cave.filter((p) => p.cave.sac === s);
        return (
          <section className="section" key={s}>
            <div className="entete">{s} · {dedans.length}</div>
            <div className="grille">
              {dedans.map((p) => (
                <button className="piece" key={p.id} onClick={() => setOuvert(p.id)}>
                  <div className="photo">
                    {urls[p.id] && <img src={urls[p.id]} alt={p.nom} loading="lazy" />}
                  </div>
                  <div className="legende"><b>{p.nom}</b>{p.marque || p.sousCategorie}</div>
                </button>
              ))}
            </div>
            {confirme === s
              ? (
                <div className="duo" style={{ marginTop: 12 }}>
                  <button className="bouton discret" onClick={() => setConfirme(null)}>Annuler</button>
                  <button className="bouton plein" onClick={async () => {
                    await sortirDeCave(dedans.map((p) => p.id));
                    setConfirme(null);
                  }}>Confirmer, tout ressortir</button>
                </div>
              )
              : (
                <button className="bouton discret" style={{ marginTop: 12 }}
                  onClick={() => setConfirme(s)}>Ressortir tout ce sac</button>
              )}
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ pièces */

function VuePieces(c) {
  const { pieces, urls, setOuvert, cave, sacs, rangerEnCave, setVue } = c;
  const [ajout, setAjout] = useState(false);
  const [selection, setSelection] = useState(null); // null = navigation, [] = mode rangement
  const [sacOuvert, setSacOuvert] = useState(false);

  const groupes = CATS.map((k) => [k, pieces.filter((p) => p.categorie === k)]).filter(([, l]) => l.length);
  const enMode = selection !== null;
  const basculer = (id) => setSelection(selection.includes(id)
    ? selection.filter((x) => x !== id) : [...selection, id]);

  return (
    <>
      <div className="corps">
        {!pieces.length ? (
          <div className="vide-etat">
            <p className="note" style={{ marginTop: 0 }}>
              {cave.length
                ? `La garde-robe courante est vide, mais ${cave.length} pièce(s) attendent à la cave.`
                : "L'armoire est vide. Photographie une première pièce, elle sera identifiée et classée."}
            </p>
            <button className="bouton plein" onClick={() => (cave.length ? setVue("cave") : setAjout(true))}>
              {cave.length ? "Ouvrir la cave" : "Ajouter une pièce"}
            </button>
          </div>
        ) : (
          <>
            {enMode && (
              <p className="note" style={{ marginTop: 0 }}>
                Touche les pièces à ranger, puis choisis le sac.
              </p>
            )}
            {groupes.map(([cat, liste]) => (
              <section className="section" key={cat}>
                <div className="entete">{cat} · {liste.length}</div>
                <div className="grille">
                  {liste.map((p) => (
                    <button className="piece" key={p.id}
                      data-choisie={enMode && selection.includes(p.id) ? "1" : "0"}
                      onClick={() => (enMode ? basculer(p.id) : setOuvert(p.id))}>
                      <div className="photo">{urls[p.id] && <img src={urls[p.id]} alt={p.nom} loading="lazy" />}</div>
                      <div className="legende"><b>{p.nom}</b>{p.marque || p.sousCategorie}</div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>

      {pieces.length > 0 && (
        <div className="socle">
          {enMode ? (
            <div className="duo">
              <button className="bouton discret" onClick={() => { setSelection(null); setSacOuvert(false); }}>
                Annuler
              </button>
              <button className="bouton plein" disabled={!selection.length}
                onClick={() => setSacOuvert(true)}>
                Ranger {selection.length || ""} pièce(s)
              </button>
            </div>
          ) : (
            <div className="duo">
              <button className="bouton discret" onClick={() => setSelection([])}>Ranger à la cave</button>
              <button className="bouton plein" onClick={() => setAjout(true)}>Ajouter une pièce</button>
            </div>
          )}
        </div>
      )}

      {sacOuvert && (
        <>
          <div className="rideau" onClick={() => setSacOuvert(false)} />
          <div className="panneau">
            <BoutonFermer onClick={() => setSacOuvert(false)} />
            <h2 style={{ fontWeight: 300, fontSize: 22, margin: "0 0 12px" }}>Ranger à la cave</h2>
            <FormulaireSac sacs={sacs} combien={selection.length}
              valider={async (sac) => {
                await rangerEnCave(selection, sac);
                setSacOuvert(false);
                setSelection(null);
              }}
              annuler={() => setSacOuvert(false)} />
          </div>
        </>
      )}

      {ajout && <Ajout {...c} fermer={() => setAjout(false)} />}
    </>
  );
}

function Ajout({ ajouterPiece, fermer, setErreur, marques, toutes, urls }) {
  const [etape, setEtape] = useState("choix");
  const [blob, setBlob] = useState(null);
  const [apercu, setApercu] = useState("");
  const [fiche, setFiche] = useState(null);
  const [progres, setProgres] = useState("");
  const [web, setWeb] = useState(false);
  const [souci, setSouci] = useState("");
  const [lien, setLien] = useState("");
  const [doubleIgnore, setDoubleIgnore] = useState(false);
  const champ = useRef(null);

  // Comparaison avec le catalogue existant, sans appel au modèle.
  const sosies = fiche ? ressemblances(fiche, toutes) : [];

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
        <BoutonFermer onClick={etape === "choix" || etape === "fiche" ? fermer : null} />

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
              Lien d'une page produit, ou lien direct d'une image. Certaines enseignes,
              dont Zara et Oysho, bloquent la lecture de leurs pages : dans ce cas, appui
              long sur la photo dans Safari, « Ajouter aux photos », puis ajoute-la ci-dessus.
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
            {sosies.length > 0 && !doubleIgnore && (
              <div className="avertissement" style={{ marginBottom: 14 }}>
                <p>
                  {sosies.length === 1 ? "Une pièce très proche existe déjà" : "Des pièces très proches existent déjà"} :
                  {" "}{sosies.map((x) => x.piece.nom).join(", ")}. Si c'est la même, annule plutôt que d'ajouter un doublon.
                </p>
                <div className="bande" style={{ marginTop: 10 }}>
                  {sosies.map((x) => (urls[x.piece.id]
                    ? <img key={x.piece.id} src={urls[x.piece.id]} alt={x.piece.nom} loading="lazy" />
                    : <div key={x.piece.id} className="vide" />))}
                </div>
                <button className="bouton discret" style={{ marginTop: 10 }}
                  onClick={() => setDoubleIgnore(true)}>C'est une autre pièce</button>
              </div>
            )}
            <Formulaire
              marques={marques}
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

function Formulaire({ depart, apercu, valider, annuler, marques = [] }) {
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
          <input value={f.marque} placeholder="inconnue" list="aide-marques"
            onChange={(e) => setF({ ...f, marque: e.target.value, confiance: "haute" })} />
        </div>
        <datalist id="aide-marques">{marques.map((m) => <option key={m} value={m} />)}</datalist>
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

function FichePiece({ id, toutes, urls, stats, majPiece, supprimerPiece, setOuvert, setErreur,
  sacs, rangerEnCave, sortirDeCave, marques }) {
  const p = toutes.find((x) => x.id === id);
  const [edition, setEdition] = useState(false);
  const [confirme, setConfirme] = useState(false);
  const [rangement, setRangement] = useState(false);
  if (!p) return null;
  const u = stats.parPiece[id];

  return (
    <>
      <div className="rideau" onClick={() => setOuvert(null)} />
      <div className="panneau">
        <BoutonFermer onClick={() => setOuvert(null)} />
        {edition ? (
          <Formulaire depart={p} apercu={urls[id]} marques={marques}
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
                {p.cave && <><dt>Cave</dt><dd>{p.cave.sac}, depuis le {joli(p.cave.depuis)}</dd></>}
              </dl>
            </div>

            <section className="section">
              {rangement ? (
                <FormulaireSac sacs={sacs} depart={p.cave ? p.cave.sac : ""} combien={1}
                  valider={async (sac) => { await rangerEnCave([id], sac); setRangement(false); }}
                  annuler={() => setRangement(false)} />
              ) : p.cave ? (
                <div className="duo">
                  <button className="bouton discret" onClick={() => setRangement(true)}>Changer de sac</button>
                  <button className="bouton contour" onClick={async () => { await sortirDeCave([id]); }}>
                    Remettre dans la garde-robe
                  </button>
                </div>
              ) : (
                <button className="bouton discret" onClick={() => setRangement(true)}>Ranger à la cave</button>
              )}
            </section>

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
  const { tenues, pieces, ajouterCreneau } = c;
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
                action={<button className="bouton discret"
                  onClick={() => ajouterCreneau(today, { tenueId: t.id, libelle: LIBELLE_DEFAUT })}>
                  Portée aujourd'hui
                </button>} />
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
        {t.itemIds.map((id) => {
          // Une pièce rangée à la cave reste dans la tenue, en retrait.
          const rangee = !!piece(id)?.cave;
          return urls[id]
            ? <img key={id} src={urls[id]} alt={piece(id)?.nom || ""} loading="lazy"
                style={rangee ? { opacity: 0.4 } : undefined} />
            : <div key={id} className="vide" />;
        })}
      </div>
      {(() => {
        const sacsUtiles = [...new Set(t.itemIds.map((id) => piece(id)?.cave?.sac).filter(Boolean))];
        return sacsUtiles.length > 0 && (
          <div className="info" style={{ color: "var(--alerte)" }}>
            Pièce(s) à la cave : {sacsUtiles.join(", ")}
          </div>
        );
      })()}
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
        <BoutonFermer onClick={fermer} />
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

const JOURS_COURTS = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"];

const jourDe = (s) => { const [a, m, j] = s.split("-").map(Number); return new Date(a, m - 1, j); };
const decaler = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const lundiDe = (d) => decaler(d, -((d.getDay() + 6) % 7));

function VueCalendrier({ tenues, journal, urls, pieces, ajouterTenue,
  ajouterCreneau, majCreneau, retirerCreneau,
  ajouterPhotoJour, retirerPhotoJour, setErreur }) {
  const maintenant = new Date();
  const today = iso(maintenant);

  const [mode, setMode] = useState("semaine");
  const [curseur, setCurseur] = useState({ a: maintenant.getFullYear(), m: maintenant.getMonth() });
  const [ancre, setAncre] = useState(iso(lundiDe(maintenant)));
  const [jour, setJour] = useState(null);
  const [compo, setCompo] = useState(null);      // date pour laquelle on compose
  const [preselection, setPreselection] = useState(null); // tenue tout juste composée
  const [enregistrePhoto, setEnregistrePhoto] = useState(false);
  const champPhoto = useRef(null);

  const creneauxDu = (date) => journal[date] || [];

  const imageTenue = (tenueId) => {
    const t = tenues.find((x) => x.id === tenueId);
    const id = (t?.itemIds || []).find((x) => urls[x]);
    return id ? urls[id] : null;
  };

  /* Vue mois : la photo réellement portée prime sur l'aperçu de la tenue. */
  const vignette = (date) => {
    const propre = urls[clePhotoJour(date)];
    if (propre) return propre;
    const premier = creneauxDu(date)[0];
    return premier ? imageTenue(premier.tenueId) : null;
  };

  const traiterPhoto = async (fichiers) => {
    const f = (fichiers || [])[0];
    if (!f || !jour) return;
    setEnregistrePhoto(true);
    try { await ajouterPhotoJour(jour, f); }
    catch (e) { setErreur("Photo impossible à enregistrer : " + (e && e.message ? e.message : e)); }
    setEnregistrePhoto(false);
  };

  /* ---- mois ---- */
  const decalage = (new Date(curseur.a, curseur.m, 1).getDay() + 6) % 7;
  const nb = new Date(curseur.a, curseur.m + 1, 0).getDate();
  const cases = [...Array(decalage).fill(null), ...Array.from({ length: nb }, (_, k) => k + 1)];
  const bougerMois = (d) => {
    const m = curseur.m + d;
    setCurseur({ a: curseur.a + Math.floor(m / 12), m: ((m % 12) + 12) % 12 });
  };

  /* ---- semaine ---- */
  const debut = jourDe(ancre);
  const septJours = Array.from({ length: 7 }, (_, k) => iso(decaler(debut, k)));
  const fin = decaler(debut, 6);
  const bougerSemaine = (d) => setAncre(iso(decaler(debut, d * 7)));
  const semaineCourante = ancre === iso(lundiDe(maintenant));
  const titreSemaine = debut.getMonth() === fin.getMonth()
    ? `${debut.getDate()} – ${fin.getDate()} ${MOIS[fin.getMonth()]}`
    : `${debut.getDate()} ${MOIS[debut.getMonth()]} – ${fin.getDate()} ${MOIS[fin.getMonth()]}`;

  return (
    <div className="corps">
      <div className="pastilles" style={{ marginBottom: 16 }}>
        <button className="pastille" data-actif={mode === "semaine" ? "1" : "0"}
          onClick={() => setMode("semaine")}>Semaine</button>
        <button className="pastille" data-actif={mode === "mois" ? "1" : "0"}
          onClick={() => setMode("mois")}>Mois</button>
      </div>

      {mode === "semaine" ? (
        <>
          <div className="mois">
            <button onClick={() => bougerSemaine(-1)} aria-label="Semaine précédente"
              style={{ fontSize: 20, color: "var(--gris)", padding: "4px 12px" }}>‹</button>
            <span>{titreSemaine}</span>
            <button onClick={() => bougerSemaine(1)} aria-label="Semaine suivante"
              style={{ fontSize: 20, color: "var(--gris)", padding: "4px 12px" }}>›</button>
          </div>

          {!semaineCourante && (
            <button onClick={() => setAncre(iso(lundiDe(new Date())))}
              style={{ display: "block", margin: "0 auto 14px", fontSize: 12, color: "var(--olive)" }}>
              Revenir à cette semaine
            </button>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {septJours.map((date, k) => (
              <LigneSemaine key={date} date={date} nomJour={JOURS_COURTS[k]} aujourdhui={date === today}
                creneaux={creneauxDu(date)} tenues={tenues} imageTenue={imageTenue}
                ouvrir={() => setJour(date)} />
            ))}
          </div>

          <p className="note" style={{ marginTop: 16 }}>
            Touche un jour pour y ajouter une tenue, un moment et une note.
            Une journée peut contenir plusieurs créneaux.
          </p>
        </>
      ) : (
        <>
          <div className="mois">
            <button onClick={() => bougerMois(-1)} aria-label="Mois précédent"
              style={{ fontSize: 20, color: "var(--gris)", padding: "4px 12px" }}>‹</button>
            <span>{MOIS[curseur.m]} {curseur.a}</span>
            <button onClick={() => bougerMois(1)} aria-label="Mois suivant"
              style={{ fontSize: 20, color: "var(--gris)", padding: "4px 12px" }}>›</button>
          </div>
          <div className="calendrier">{JOURS.map((d, k) => <div className="jourNom" key={k}>{d}</div>)}</div>
          <div className="calendrier" style={{ marginTop: 2 }}>
            {cases.map((n, k) => {
              if (!n) return <div key={k} />;
              const date = iso(new Date(curseur.a, curseur.m, n));
              const v = vignette(date);
              const combien = creneauxDu(date).length;
              return (
                <button className="jour" key={k} onClick={() => setJour(date)}
                  data-aujourdhui={date === today ? "1" : "0"}
                  data-prevu={date > today && combien ? "1" : "0"}
                  data-img={v ? "1" : "0"}>
                  <em>{n}</em>
                  {v && <img src={v} alt="" loading="lazy" />}
                  {combien > 1 && (
                    <span style={{
                      position: "absolute", bottom: 3, right: 4, zIndex: 2, fontSize: 10,
                      color: v ? "#fff" : "var(--gris)",
                      textShadow: v ? "0 1px 3px rgba(0,0,0,.8)" : "none",
                    }}>{combien}</span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="note" style={{ marginTop: 16 }}>
            Cadre plein : tenue portée. Cadre pointillé : tenue prévue. Le chiffre indique
            le nombre de créneaux quand la journée en compte plusieurs.
          </p>
        </>
      )}

      {jour && (
        <PanneauJour key={jour} jour={jour} today={today} creneaux={creneauxDu(jour)}
          tenues={tenues} pieces={pieces} urls={urls} imageTenue={imageTenue}
          preselection={preselection}
          ajouterCreneau={ajouterCreneau} majCreneau={majCreneau} retirerCreneau={retirerCreneau}
          champPhoto={champPhoto} enregistrePhoto={enregistrePhoto} retirerPhotoJour={retirerPhotoJour}
          composer={() => { setCompo(jour); setJour(null); }}
          fermer={() => { setJour(null); setPreselection(null); }} />
      )}

      <input ref={champPhoto} type="file" accept="image/*"
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        onChange={(e) => { traiterPhoto(e.target.files); e.target.value = ""; }} />

      {compo && (
        <Compositeur pieces={pieces} urls={urls} ajouterTenue={ajouterTenue}
          dateDefaut={compo}
          apres={async (t) => { setPreselection(t.id); }}
          fermer={() => { setJour(compo); setCompo(null); }} />
      )}
    </div>
  );
}

/* Une journée de la vue semaine : le jour à gauche, ses créneaux à la suite. */
function LigneSemaine({ date, nomJour, aujourdhui, creneaux, tenues, imageTenue, ouvrir }) {
  return (
    <div style={{
      display: "flex", gap: 12, alignItems: "flex-start", background: "#fff",
      border: `1px solid ${aujourdhui ? "var(--encre)" : "var(--ligne)"}`,
      borderRadius: 1, padding: "10px 12px",
    }}>
      <button onClick={ouvrir} style={{ width: 44, flexShrink: 0, textAlign: "left", padding: 0 }}>
        <div style={{ fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--gris)" }}>
          {nomJour}
        </div>
        <div style={{ fontSize: 20, fontWeight: 300, color: aujourdhui ? "var(--encre)" : "var(--doux)" }}>
          {Number(date.split("-")[2])}
        </div>
      </button>

      {creneaux.length ? (
        <div style={{ flex: 1, display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
          {creneaux.map((c) => {
            const img = imageTenue(c.tenueId);
            const t = tenues.find((x) => x.id === c.tenueId);
            return (
              <button key={c.id} onClick={ouvrir}
                style={{ width: 62, flexShrink: 0, textAlign: "left", padding: 0 }}>
                <div style={{ width: 62, height: 82, background: "#E5E1D8", borderRadius: 1, overflow: "hidden" }}>
                  {img && <img src={img} alt="" loading="lazy"
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
                </div>
                <div style={{ fontSize: 11, color: "var(--encre)", marginTop: 4, lineHeight: 1.3 }}>{c.libelle}</div>
                {t && <div style={{ fontSize: 10, color: "var(--gris)", lineHeight: 1.3 }}>{t.nom}</div>}
              </button>
            );
          })}
        </div>
      ) : (
        <button onClick={ouvrir} style={{
          flex: 1, textAlign: "left", fontSize: 12, color: "var(--gris)",
          border: "1px dashed var(--ligne)", borderRadius: 1, padding: "14px 12px",
        }}>Ajouter une tenue</button>
      )}
    </div>
  );
}

/* Détail d'une journée : ses créneaux, l'ajout d'un créneau, la photo portée. */
function PanneauJour({ jour, today, creneaux, tenues, pieces, urls, imageTenue, preselection,
  ajouterCreneau, majCreneau, retirerCreneau,
  champPhoto, enregistrePhoto, retirerPhotoJour, composer, fermer }) {
  const [choix, setChoix] = useState(preselection || null); // tenue en cours d'ajout
  const [edition, setEdition] = useState(null);             // créneau en cours de modification
  const [confirme, setConfirme] = useState(null);

  const passe = jour <= today;
  const blocPhoto = (
    <BlocPhotoJour jour={jour} urls={urls} champPhoto={champPhoto}
      enregistrePhoto={enregistrePhoto} retirerPhotoJour={retirerPhotoJour} />
  );

  return (
    <>
      <div className="rideau" onClick={fermer} />
      <div className="panneau">
        <BoutonFermer onClick={fermer} />
        <h2 style={{ fontWeight: 300, fontSize: 20, margin: "0 0 6px" }}>{joli(jour)}</h2>
        <p className="note" style={{ margin: "0 0 16px" }}>
          {jour > today ? "Ce que tu prévois de porter." : "Ce que tu as porté."}
        </p>

        {passe && blocPhoto}

        {creneaux.length > 0 && (
          <section className="section">
            <div className="entete">créneaux · {creneaux.length}</div>
            {creneaux.map((c) => {
              const t = tenues.find((x) => x.id === c.tenueId);
              const img = imageTenue(c.tenueId);
              if (edition === c.id) {
                return (
                  <FormulaireCreneau key={c.id} depart={c} tenue={t} valider={async (v) => {
                    await majCreneau(jour, c.id, v);
                    setEdition(null);
                  }} annuler={() => setEdition(null)} texteValider="Enregistrer" />
                );
              }
              return (
                <div className="carte" key={c.id}>
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ width: 54, height: 72, flexShrink: 0, background: "#E5E1D8", overflow: "hidden" }}>
                      {img && <img src={img} alt="" loading="lazy"
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--gris)" }}>
                        {c.libelle}
                      </div>
                      <div style={{ fontSize: 17, fontWeight: 300, marginTop: 2 }}>
                        {t ? t.nom : "Tenue introuvable"}
                      </div>
                      {c.note && <p className="note" style={{ margin: "4px 0 0" }}>{c.note}</p>}
                    </div>
                  </div>
                  <div className="duo" style={{ marginTop: 12 }}>
                    <button className="bouton discret" onClick={() => setEdition(c.id)}>Modifier</button>
                    {confirme === c.id
                      ? <button className="bouton danger" onClick={async () => {
                          await retirerCreneau(jour, c.id); setConfirme(null);
                        }}>Confirmer</button>
                      : <button className="bouton danger" onClick={() => setConfirme(c.id)}>Retirer</button>}
                  </div>
                </div>
              );
            })}
          </section>
        )}

        <section className="section">
          <div className="entete">{creneaux.length ? "ajouter un autre créneau" : "ajouter un créneau"}</div>

          {choix ? (
            <FormulaireCreneau tenue={tenues.find((x) => x.id === choix)}
              valider={async (v) => { await ajouterCreneau(jour, { tenueId: choix, ...v }); setChoix(null); }}
              annuler={() => setChoix(null)} texteValider="Ajouter à cette journée" />
          ) : (
            <>
              <button className="bouton contour" disabled={!pieces.length} onClick={composer}>
                {pieces.length ? "Composer à partir de ma garde-robe" : "Ajoute d'abord une pièce"}
              </button>

              {tenues.length > 0 && (
                <div className="entete" style={{ marginTop: 22 }}>ou reprendre une tenue</div>
              )}
              {tenues.map((t) => (
                <button key={t.id} style={{ display: "block", width: "100%", textAlign: "left" }}
                  onClick={() => setChoix(t.id)}>
                  <div className="carte">
                    <div style={{ fontSize: 17, fontWeight: 300 }}>{t.nom}</div>
                    <div className="bande">
                      {t.itemIds.slice(0, 5).map((id) => urls[id]
                        ? <img key={id} src={urls[id]} alt="" loading="lazy" />
                        : <div key={id} className="vide" />)}
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}
        </section>

        {!passe && blocPhoto}
      </div>
    </>
  );
}

/* Moment et note d'un créneau. Le libellé appartient au créneau, pas à la tenue. */
function FormulaireCreneau({ depart, tenue, valider, annuler, texteValider }) {
  const [libelle, setLibelle] = useState((depart && depart.libelle) || LIBELLE_DEFAUT);
  const [note, setNote] = useState((depart && depart.note) || "");

  return (
    <div className="carte">
      {tenue && <div style={{ fontSize: 17, fontWeight: 300, marginBottom: 12 }}>{tenue.nom}</div>}

      <div className="champ">
        <label>Moment</label>
        <div className="pastilles">
          {LIBELLES.map((l) => (
            <button key={l} className="pastille" data-actif={libelle === l ? "1" : "0"}
              onClick={() => setLibelle(l)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="champ">
        <label>Ou un moment à toi</label>
        <input value={libelle} onChange={(e) => setLibelle(e.target.value)} placeholder="Brunch, mariage…" />
      </div>

      <div className="champ">
        <label>Note</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="facultative" />
      </div>

      <div className="duo">
        <button className="bouton discret" onClick={annuler}>Annuler</button>
        <button className="bouton plein" onClick={() => valider({ libelle, note })}>{texteValider}</button>
      </div>
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
  const { pieces, tenues, journal, stats, ajouterTenue, ajouterCreneau, setErreur, setOuvert, urls } = c;
  const [contexte, setContexte] = useState("");
  const [charge, setCharge] = useState(false);
  const [propositions, setPropositions] = useState([]);

  const jamais = pieces.filter((p) => !stats.parPiece[p.id]);

  const demander = async () => {
    setCharge(true); setPropositions([]);
    const today = iso(new Date());
    // Les six derniers créneaux passés, pour éviter de reproposer ce qui vient
    // d'être porté. Une journée à deux tenues pèse donc deux créneaux.
    const recentes = [...new Set(creneauxAPlat(journal)
      .filter((c2) => c2.date <= today)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .slice(-6)
      .flatMap((c2) => tenues.find((t) => t.id === c2.tenueId)?.itemIds || []))];
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
                          await ajouterCreneau(iso(new Date()), { tenueId: n.id, libelle: LIBELLE_DEFAUT });
                        }}>Je la porte</button>
                    </div>
                  } />
              ))}
            </section>
          )}

          {jamais.length > 0 && (
            <section className="section">
              <div className="entete">jamais portées · {jamais.length}</div>
              <p className="note" style={{ marginTop: 0 }}>
                Simple rappel : les propositions ci-dessus puisent dans toute la garde-robe,
                pas seulement ici.
              </p>
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

function VueDonnees({ toutes, cave, tenues, journal, setErreur }) {
  const [occupe, setOccupe] = useState(false);
  const [etat, setEtat] = useState("");
  const [enAttente, setEnAttente] = useState(null); // { data, resume } avant confirmation
  const [place, setPlace] = useState(null);
  const [code, setCode] = useState(codeLocal.lire());
  const [codeEnregistre, setCodeEnregistre] = useState(false);
  const champ = useRef(null);

  const jours = Object.keys(journal || {}).length;
  const creneaux = creneauxAPlat(journal).length;

  const enregistrerCode = () => {
    codeLocal.ecrire(code.trim());
    setCodeEnregistre(true);
    setTimeout(() => setCodeEnregistre(false), 2500);
  };

  useEffect(() => {
    estimerPlace().then(setPlace).catch(() => setPlace(null));
  }, [toutes.length, tenues.length]);

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
          {toutes.length} pièces dont {cave.length} à la cave · {tenues.length} tenues · {creneaux} créneau(x) sur {jours} jour(s)
          {place && place.total ? ` · ${poids(place.utilise)} utilisés` : ""}
        </p>
        <button className="bouton plein" disabled={occupe || !toutes.length} onClick={exporter}>
          {occupe ? "Un instant…" : "Exporter le catalogue"}
        </button>
        {!toutes.length && (
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
            <BoutonFermer onClick={() => setEnAttente(null)} desactive={occupe} />
            <h2 style={{ fontWeight: 300, fontSize: 22, margin: "0 0 8px" }}>Remplacer le catalogue ?</h2>
            <p className="note" style={{ margin: "0 0 16px" }}>
              Cette sauvegarde contient {enAttente.resume.pieces} pièces, {enAttente.resume.tenues} tenues,
              {" "}{enAttente.resume.photos} photos et {enAttente.resume.creneaux} créneau(x)
              répartis sur {enAttente.resume.jours} jour(s).
              {enAttente.resume.exporte ? ` Exportée le ${enAttente.resume.exporte.slice(0, 10)}.` : ""}
            </p>
            <p className="note" style={{ margin: "0 0 16px", color: "var(--alerte)" }}>
              Le contenu présent dans ce navigateur ({toutes.length} pièces, {tenues.length} tenues)
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
