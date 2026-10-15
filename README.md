# Mon CRM (PWA)

Application web installable (PWA), sans dépendance ni étape de build. Fonctionne hors ligne.

## Tester en local
    cd app && python3 -m http.server 8080
puis ouvrir http://localhost:8080 (le service worker exige http://localhost ou https).

## Mettre en ligne (gratuit, HTTPS requis pour l'installation sur téléphone)
Déposer le dossier `app/` sur Netlify Drop (https://app.netlify.com/drop), Cloudflare Pages ou GitHub Pages.
Ouvrir l'URL sur le téléphone, puis « Ajouter à l'écran d'accueil ».

## Fonctionnement
- Contacts, relances (avec bouton WhatsApp et ajout à Google Agenda), échanges, documents (liens Google Drive).
- Données stockées dans IndexedDB sur l'appareil. Sauvegarde/restauration via Réglages > Exporter/Importer (JSON).
- Pas de synchro entre appareils pour l'instant : `db.js` est la seule couche de stockage à remplacer pour ajouter un cloud.
- Après une modification des fichiers, incrémenter `CACHE` dans `sw.js` si besoin.

## Google (synchro + réunions Meet)
Sans ID client, l'appli fonctionne en local uniquement. Pour activer :
1. console.cloud.google.com : créer un projet, activer *Google Calendar API* et *Google Drive API*.
2. Google Auth Platform : écran de consentement (Interne si le projet est dans le Workspace de l'utilisatrice, sinon Externe en mode test avec son adresse en utilisateur test).
   Scopes : `drive.appdata`, `calendar.readonly`, `drive.readonly`.
3. Clients : créer un ID client OAuth « Application Web », origine JavaScript autorisée `https://brisco-ops.github.io`.
4. Coller l'ID dans `config.js` (GOOGLE_CLIENT_ID) ou dans Réglages > Google.

- Synchro : fichier `crm-data.json` dans l'espace caché de l'appli sur Drive, fusion « dernier modifié gagne » par enregistrement.
- Réunions : événements Agenda des 45 derniers jours dont un invité a l'email d'un contact ; pièces jointes Doc (notes Gemini) et vidéo (enregistrement).
