# Modèle de données et migration

Objectif : ne jamais enfermer les données. Tout export doit pouvoir alimenter HubSpot (ou un autre CRM) sans ressaisie.

## Principes
1. **Identifiants stables** : chaque enregistrement a un UUID créé une fois. Les sociétés (déduites du nom) ont un identifiant déterministe `co_<hash du nom>`, les affaires `deal_<id du contact>`. Les exports portent cet identifiant (`mon_crm_id`) : un second import met à jour au lieu de créer des doublons.
2. **Données normalisées à l'enregistrement** (`model.js`, `normalizeContact`) : prénom et nom séparés, email en minuscules, téléphone en E.164 (`phoneE164`), dates en ISO 8601, devise ISO (`EUR`, `XOF`). Le texte saisi (`phone`) est conservé tel quel.
3. **Une valeur stockée = une valeur métier** : pas de texte formaté en base (« 3 000 € »). Les libellés, symboles et couleurs ne vivent que dans l'interface.
4. **Stockage simple, export canonique** : l'interface lit un stockage plat et rapide ; `toCanonical()` le traduit vers un modèle proche de HubSpot (sociétés, contacts, affaires, activités, tâches). Changer l'interface ne casse pas les exports, et inversement.
5. **Versionné** : `SCHEMA_VERSION` (actuellement 2). `upgradeRecord()` met chaque enregistrement au format courant, de façon idempotente, au chargement et après chaque synchro.
6. **Pas d'identifiants externes dans le code métier** : le champ `ext` (`externalIds`) est réservé pour stocker les identifiants du CRM cible après une migration.

## Stockage (IndexedDB `crm`)
| Store | Champs principaux |
|---|---|
| contacts | id, firstName, lastName, name (dérivé), jobTitle, company, phone, phoneE164, email, status, amount, currency, entity, source, driveUrl, notes, lastContact, createdAt, updatedAt |
| tasks | id, contactId, text, due (YYYY-MM-DD), done, doneAt, createdAt, updatedAt |
| notes (échanges) | id, contactId, channel, date, text, fileId?, createdAt, updatedAt |
| docs | id, contactId, title, url, kind, date, fileId?, createdAt, updatedAt |
| tombs | id, store, at (suppressions à propager à la synchro, 90 jours) |

## Modèle canonique (export JSON « Complet »)
`companies`, `contacts`, `deals`, `activities` (note / call / meeting / email / whatsapp), `tasks`, `documents`, `warnings`. Toutes les dates sont en ISO 8601, les liens sont des identifiants (`contactId`, `companyId`, `dealId`).

Règles de dérivation :
- **Société** : une par nom d'entreprise distinct (insensible à la casse). Le domaine est déduit de l'email, sauf messageries grand public.
- **Affaire** : une par contact qui a atteint « RDV planifié » ou plus loin, ou qui a un montant. Montant et devise viennent de la fiche.
- **Activités** : WhatsApp et Email deviennent des notes préfixées `[WhatsApp]`, `[Email]` côté HubSpot ; Appel, Google Meet et En personne deviennent des appels ou réunions.
- **Documents** : HubSpot n'importe pas de fichiers par lien ; les liens Drive sont conservés dans des notes.

## Correspondance des étapes (modifiable : `STAGES` dans `model.js`)
| Étape | Cycle de vie HubSpot | Statut du lead | Étape d'affaire (pipeline par défaut) |
|---|---|---|---|
| Nouveau | lead | NEW | (pas d'affaire) |
| Contacté | lead | IN_PROGRESS | (pas d'affaire) |
| RDV planifié | opportunity | OPEN_DEAL | appointmentscheduled |
| Proposition envoyée | opportunity | OPEN_DEAL | contractsent |
| Gagné | customer | | closedwon |
| Perdu | other | UNQUALIFIED | closedlost |

Si le portail HubSpot a un pipeline personnalisé, adapter la colonne `dealstage` (ou `STAGES`).

## Migrer vers HubSpot
1. Réglages > Changer de CRM > **HubSpot (ZIP de CSV)**.
2. Dans HubSpot, créer les propriétés personnalisées : `mon_crm_id` (texte, unique) sur sociétés, contacts, affaires et activités ; `mon_crm_source`, `mon_crm_entite`, `mon_crm_dossier_drive` sur les contacts ; `mon_crm_entite` sur les affaires.
3. Importer dans l'ordre : `1-societes`, `2-contacts`, `3-affaires`, puis `4-notes`, `5-appels`, `6-reunions`, `7-taches`.
4. Pendant l'import, mapper `associated_contact_email` (ou `associated_contact_mon_crm_id`) et `associated_company_name` sur les colonnes d'association proposées par l'assistant. **À vérifier lors du premier import** : l'intitulé exact de ces colonnes d'association peut varier selon la version de HubSpot.
5. Contrôler `LISEZ-MOI.txt` du ZIP (contacts sans email, qui devront être rattachés à la main).

## Autres CRM (Pipedrive, Zoho, Salesforce…)
Utiliser **Contacts (CSV)** (en-têtes en français, téléphone E.164, étape, montant, devise, entité) ou le JSON complet, et mapper les colonnes dans l'assistant d'import du CRM cible. Pour un nouveau format, ajouter une fonction dans `model.js` qui consomme `toCanonical()` : le reste de l'application n'a pas à changer.

## Limites connues
- Le découpage prénom / nom n'est automatique que pour les anciennes fiches (dernier mot = nom) ; les nouvelles fiches ont deux champs distincts.
- Pas d'export des fichiers eux-mêmes (seulement les liens), ni de l'historique d'emails ou de WhatsApp (seulement les résumés saisis).
- Les montants de plusieurs devises ne sont jamais additionnés : les totaux sont affichés par devise.
