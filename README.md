# Dressing

Garde-robe personnelle. Photo, identification automatique, composition de tenues,
journal de port, planification et suggestions.

Application web installable sur l'écran d'accueil. Les photos et les fiches restent
dans le navigateur du téléphone (IndexedDB), rien n'est envoyé ailleurs sauf l'image
transmise à l'API Anthropic au moment de l'identification.

## Déploiement, dans l'ordre

1. Crée un dépôt GitHub et pousse ce dossier.

2. Sur console.anthropic.com, crée une clé API et mets un peu de crédit dessus.

3. Sur vercel.com, clique sur Add New Project, choisis le dépôt.
   Vercel détecte Vite tout seul, ne change rien aux réglages de build.

4. Avant de déployer, ouvre Environment Variables et ajoute :

   | Nom | Valeur |
   |---|---|
   | `ANTHROPIC_API_KEY` | ta clé, commence par `sk-ant-` |
   | `DRESSING_CODE` | un mot de passe que tu inventes |

   `DRESSING_CODE` empêche n'importe qui trouvant l'URL de consommer ton crédit.
   L'application te le demandera une fois, puis le retiendra.

5. Déploie. Tu obtiens une adresse en `.vercel.app`.

6. Sur ton iPhone, ouvre cette adresse dans Safari, bouton Partager,
   Ajouter à l'écran d'accueil. Sur Android, menu, Installer l'application.

## En local

```
npm install
npm run dev
```

Pour tester l'identification en local il faut `vercel dev` plutôt que `npm run dev`,
sinon la route `/api/claude` n'existe pas. Sans elle, tout le reste fonctionne
et tu remplis les fiches à la main.

## Coût

Une photo identifiée coûte de l'ordre d'un demi-centime avec Sonnet. La confirmation
de marque sur le web ajoute une recherche facturée à part, donc laisse-la éteinte
pour un gros import.

## Structure

```
api/claude.js      relais vers l'API Anthropic, garde la clé côté serveur
src/db.js          IndexedDB, photos en Blob, compression à 1100 px, export/import
src/ai.js          identification des pièces et suggestions de tenues
src/App.jsx        interface
src/styles.css     direction visuelle Papier
public/sw.js       service worker, cache de l'app pour l'ouverture hors ligne
```

## Sauvegarde

Les données vivent dans le navigateur. Vider les données de site les efface.

L'onglet **données** permet d'exporter tout le catalogue dans un seul fichier
JSON (fiches, tenues, journal et photos comprises) et de le réimporter, sur le
même téléphone ou sur un autre. Exporte-le de temps en temps et garde le fichier
ailleurs : c'est ta sauvegarde. À l'import, le contenu du navigateur est remplacé
par celui du fichier, après une confirmation.

L'étape suivante, si tu veux le même dressing synchronisé en continu sur
plusieurs appareils, serait une synchronisation Supabase.
