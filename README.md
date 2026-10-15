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
