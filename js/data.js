// Contenu fictif de démonstration : voir le README.
const COURSE_DATA = {
    "title": "L Almanach du CIP",
    "demo": true,
    "last_update": "2026-10-30",
    "modules": [
        {
            "name": "0 MODULE - Arriver à la Maison Horizon",
            "ccp": "CCP 1 - Accueillir pour analyser la demande",
            "cp": [
                "CP1",
                "CP2",
                "CP5"
            ],
            "sub_modules": [
                {
                    "name": "La matinée de Nadia",
                    "files": [
                        "matinee-nadia.pdf"
                    ]
                },
                {
                    "name": "Le classeur qui ne se perd jamais",
                    "files": [
                        "classeur.pdf"
                    ]
                }
            ]
        },
        {
            "name": "1 MODULE - Explorer Valbourg",
            "ccp": "CCP 1 - Accueillir pour analyser la demande",
            "cp": [
                "CP3",
                "CP4"
            ],
            "sub_modules": [
                {
                    "name": "Dessiner la carte du quartier",
                    "files": [
                        "carte-quartier.pdf"
                    ]
                },
                {
                    "name": "Le café des voisins",
                    "files": [
                        "cafe-voisins.pdf"
                    ]
                }
            ]
        },
        {
            "name": "2 MODULE - Le carnet de route",
            "ccp": "CCP 2 - Accompagner les personnes dans leur parcours",
            "cp": [
                "CP6",
                "CP7",
                "CP8"
            ],
            "sub_modules": [
                {
                    "name": "Inès ouvre son carnet",
                    "files": [
                        "carnet-ines.pdf"
                    ]
                },
                {
                    "name": "Trois petits pas plutôt qu'un grand",
                    "files": [
                        "trois-pas.pdf"
                    ]
                }
            ]
        },
        {
            "name": "3 MODULE - L'atelier du jeudi",
            "ccp": "CCP 2 - Accompagner les personnes dans leur parcours",
            "cp": [
                "CP9",
                "CP10",
                "CP11"
            ],
            "sub_modules": [
                {
                    "name": "Préparer la salle et le déroulé",
                    "files": [
                        "deroule.pdf"
                    ]
                },
                {
                    "name": "Quand le groupe se tait",
                    "files": [
                        "groupe-silence.pdf"
                    ]
                }
            ]
        },
        {
            "name": "4 MODULE - Les voisins qui embauchent",
            "ccp": "CCP 3 - Mettre en œuvre une offre de services employeurs",
            "cp": [
                "CP12",
                "CP13",
                "CP14"
            ],
            "sub_modules": [
                {
                    "name": "Le coup de fil au garage Moreau",
                    "files": [
                        "garage-moreau.pdf"
                    ]
                },
                {
                    "name": "La première semaine de Karim",
                    "files": [
                        "semaine-karim.pdf"
                    ]
                }
            ]
        },
        {
            "name": "5 MODULE - Ranger, protéger, partager",
            "ccp": "Transversal - Compétences Support",
            "cp": [
                "CT1",
                "CT2",
                "CP15"
            ],
            "sub_modules": [
                {
                    "name": "La phrase de passe de la Maison Horizon",
                    "files": [
                        "phrase-passe.pdf"
                    ]
                },
                {
                    "name": "Moins de papier, plus de clarté",
                    "files": [
                        "moins-papier.pdf"
                    ]
                }
            ]
        }
    ]
};

const RNCP_REFERENTIEL = {
    "CCP 1 - Accueillir pour analyser la demande des personnes": {
        short: "CCP 1 — Accueil & Diagnostic",
        color: "#6366f1",
        competences: [
            { code: "CP1", label: "Informer des ressources en insertion et services dématérialisés",
              criteres: ["Les mesures du territoire sont identifiées", "La présentation est adaptée au public", "Les techniques de reformulation sont mises en œuvre"] },
            { code: "CP2", label: "Analyser la demande et poser les bases d'un diagnostic partagé",
              criteres: ["Les techniques d'entretien sont adaptées", "Les éléments du diagnostic sont identifiés", "L'adhésion de la personne est recherchée"] },
            { code: "CP3", label: "Exercer une veille informationnelle, technique et prospective",
              criteres: ["Les caractéristiques du territoire sont identifiées", "La méthode de recueil est pertinente", "La présentation est claire et structurée"] },
            { code: "CP4", label: "Travailler en équipe, en réseau et dans un cadre partenarial",
              criteres: ["Les partenariats sont identifiés", "Les acteurs mobilisés répondent aux besoins", "Les échanges respectent la confidentialité"] },
            { code: "CP5", label: "Réaliser le traitement administratif et les écrits professionnels",
              criteres: ["Les procédures internes sont respectées", "Les principes éthiques sont respectés", "Les outils bureautiques sont utilisés à bon escient"] }
        ]
    },
    "CCP 2 - Accompagner les personnes dans leur parcours": {
        short: "CCP 2 — Accompagnement",
        color: "#10b981",
        competences: [
            { code: "CP6",  label: "Contractualiser et suivre le parcours d'insertion",
              criteres: ["L'alliance de travail est créée", "L'accompagnement est contractualisé", "Les étapes sont cohérentes avec le diagnostic"] },
            { code: "CP7",  label: "Accompagner à l'élaboration du projet professionnel",
              criteres: ["Une méthodologie d'élaboration est mise en œuvre", "Les compétences sont identifiées avec la personne", "La confrontation avec les réalités est planifiée"] },
            { code: "CP8",  label: "Accompagner la réalisation des projets professionnels",
              criteres: ["L'implication de la personne est favorisée", "Le plan d'actions est cohérent", "Les outils proposés favorisent la mise en œuvre"] },
            { code: "CP9",  label: "Concevoir des ateliers thématiques",
              criteres: ["L'analyse de la demande est pertinente", "La progression pédagogique est adaptée", "Le dispositif d'évaluation est en adéquation"] },
            { code: "CP10", label: "Préparer et animer des ateliers thématiques",
              criteres: ["Les activités sont adaptées aux participants", "L'animation favorise la dynamique de groupe", "Le bilan est rédigé clairement"] },
            { code: "CP11", label: "Analyser sa pratique professionnelle",
              criteres: ["Les faits, opinions et émotions sont distingués", "Les axes d'amélioration sont identifiés", "Les propositions d'ajustement sont pertinentes"] }
        ]
    },
    "CCP 3 - Mettre en œuvre une offre de services employeurs": {
        short: "CCP 3 — Relation Employeurs",
        color: "#f59e0b",
        competences: [
            { code: "CP12", label: "Déployer des actions de prospection avec les employeurs",
              criteres: ["L'analyse du territoire est pertinente", "La stratégie est cohérente", "L'évaluation de l'action permet de mesurer les écarts"] },
            { code: "CP13", label: "Apporter un appui technique aux employeurs en recrutement",
              criteres: ["L'analyse du besoin de recrutement est pertinente", "Les profils proposés sont adaptés", "Les mesures pour l'emploi sont mobilisées"] },
            { code: "CP14", label: "Faciliter l'intégration et le maintien du salarié",
              criteres: ["Un parcours d'intégration est défini", "Le suivi du salarié est assuré", "Les difficultés font l'objet d'une médiation"] },
            { code: "CP15", label: "Inscrire ses actes dans une démarche de développement durable et inclusive",
              criteres: ["Les dimensions DD sont intégrées", "Les solutions éco-citoyennes sont favorisées", "La posture professionnelle respecte les principes DD"] }
        ]
    },
    "Transversal": {
        short: "Transversal",
        desc: "compétences transversales mobilisées dans tous les blocs : respect des règles et procédures (CT1) et mobilisation des environnements numériques (CT2)",
        color: "#94a3b8",
        competences: [
            { code: "CT1", label: "Respecter des règles et des procédures",
              criteres: ["Les procédures sont respectées", "La confidentialité est respectée", "Une veille réglementaire est effectuée"] },
            { code: "CT2", label: "Mobiliser les environnements numériques",
              criteres: ["Les bonnes pratiques de sécurité sont appliquées", "Les applicatifs sont utilisés à bon escient", "Les outils collaboratifs sont utilisés de façon pertinente"] }
        ]
    }
};

const CIP_GLOSSAIRE = [
    {
        "terme": "Fiche d'accueil",
        "def": "Feuille remplie avec le visiteur pour garder la trace de sa première venue.",
        "cp": "CP5"
    },
    {
        "terme": "Résumé à voix haute",
        "def": "Moment où l'on redit ce qu'on a compris pour laisser l'autre corriger.",
        "cp": "CP2"
    },
    {
        "terme": "Classeur commun",
        "def": "Meuble fermé à clé où l'équipe range les dossiers des visiteurs.",
        "cp": "CP5"
    },
    {
        "terme": "Carte vivante",
        "def": "Plan de la ville que toute l'équipe met à jour chaque semaine.",
        "cp": "CP3"
    },
    {
        "terme": "Café des voisins",
        "def": "Rencontre mensuelle entre les structures du quartier.",
        "cp": "CP4"
    },
    {
        "terme": "Accord préalable",
        "def": "Permission demandée à la personne avant de parler de sa situation.",
        "cp": "CP4"
    },
    {
        "terme": "Carnet de route",
        "def": "Cahier personnel où la personne note ses idées et ses prochaines actions.",
        "cp": "CP7"
    },
    {
        "terme": "Prochaine action",
        "def": "Petite tâche unique choisie à la fin d'un rendez-vous.",
        "cp": "CP6"
    },
    {
        "terme": "Point d'étape",
        "def": "Court rendez-vous pour regarder ce qui a été fait et ajuster la suite.",
        "cp": "CP8"
    },
    {
        "terme": "Déroulé d'atelier",
        "def": "Feuille qui indique les étapes d'une séance, leur durée et le matériel.",
        "cp": "CP9"
    },
    {
        "terme": "Tour de table",
        "def": "Moment où chaque participant prend la parole à son tour.",
        "cp": "CP10"
    },
    {
        "terme": "Journal de bord",
        "def": "Carnet où l'animatrice note ce qu'elle veut refaire ou modifier.",
        "cp": "CP11"
    },
    {
        "terme": "Fiche entreprise",
        "def": "Page qui résume ce que l'on sait d'un employeur et de ses besoins.",
        "cp": "CP12"
    },
    {
        "terme": "Binôme d'arrivée",
        "def": "Collègue expérimenté qui guide une personne qui vient d'arriver.",
        "cp": "CP14"
    },
    {
        "terme": "Phrase de passe",
        "def": "Suite de quatre mots faciles à retenir, plus solide qu'un mot de passe court.",
        "cp": "CT2"
    },
    {
        "terme": "Page partagée",
        "def": "Document unique que toute l'équipe lit et complète.",
        "cp": "CP15"
    }
];

window.CIP_GLOSSAIRE = CIP_GLOSSAIRE;
window.COURSE_DATA = COURSE_DATA;
window.RNCP_REFERENTIEL = RNCP_REFERENTIEL;
