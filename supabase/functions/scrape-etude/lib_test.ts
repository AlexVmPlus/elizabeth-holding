import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  annonceToRow,
  buildClassifiedUrl,
  buildListUrl,
  cleanUrl,
  cutProximity,
  detailResult,
  extractCityCode,
  extractClassifiedCode,
  isColocation,
  isPlausible,
  seoLocationUrl,
  villeSlug,
  matchesAnnee,
  parseArrondissement,
  arrInsee,
  arrCodePostal,
  arrSlug,
  arrLabel,
  neufListUrl,
  neufProgramLinks,
  parseNeufMeta,
  parseNeufUnits,
  isPlausibleNeuf,
  matchesNeuf,
  matchesTypologie,
  matchesTypologies,
  parseTypologies,
  mergeCharges,
  buildCommuneRef,
  matchesCommune,
  normLoc,
  parseChargesDetail,
  parseDpe,
  parseGes,
  synthesizeCharges,
  modeGrade,
  parseAnnonces,
  parseMeuble,
  synthesizeMeuble,
  parseCharges,
  parseLoyer,
  parsePieces,
  parseSurface,
  type RawAnnonce,
  type Row,
  type RowCtx,
  selogerCode,
  synthesize,
  typologie,
} from "./lib.ts";

const CTX: RowCtx = {
  ville: "Bordeaux",
  quartier: "Saint Jean-Belcier",
  code_postal: "33800",
  transaction: "location",
  scrapedAt: "2026-06-11T00:00:00.000Z",
};

Deno.test("typologie T1..T6", () => {
  assertEquals(typologie(1), "T1");
  assertEquals(typologie(6), "T6");
  assertEquals(typologie(9), "T6");
  assertEquals(typologie(0), null);
});

Deno.test("selogerCode : INSEE -> code SeLoger (insertion 0 apres le dept)", () => {
  assertEquals(selogerCode("33063"), 330063); // Bordeaux (confirme)
  assertEquals(selogerCode("69123"), 690123); // Lyon (confirme)
  assertEquals(selogerCode("75056"), 750056); // Paris
  assertEquals(selogerCode("2A004"), null); // Corse non gere
  assertEquals(selogerCode("999"), null); // format invalide
  assertEquals(selogerCode(null), null);
});

Deno.test("buildListUrl : projects, types, places, pagination", () => {
  const u = buildListUrl(330063, "location", 1);
  assertEquals(u.includes("projects=1"), true);
  assertEquals(u.includes("types=2,1"), true);
  assertEquals(u.includes(encodeURIComponent('[{"inseeCodes":[330063]}]')), true);
  assertEquals(u.includes("LISTING-LISTpg"), false); // page 1 -> pas de param page
  const u2 = buildListUrl(330063, "vente", 2);
  assertEquals(u2.includes("projects=2"), true);
  assertEquals(u2.includes("&LISTING-LISTpg=2"), true);
});

Deno.test("buildClassifiedUrl : filtre annee yearOfConstructionMin", () => {
  const u = buildClassifiedUrl("AD08FR31096", "location", 2020);
  assertEquals(u.includes("distributionTypes=Rent"), true);
  assertEquals(u.includes("estateTypes=Apartment,House"), true);
  assertEquals(u.includes("locations=AD08FR31096"), true);
  assertEquals(u.includes("yearOfConstructionMin=2020"), true);
  assertEquals(buildClassifiedUrl("AD08FR1", "vente", 2015).includes("distributionTypes=Buy"), true);
});

Deno.test("extractClassifiedCode : code AD..FR.. dans un JSON/texte", () => {
  assertEquals(extractClassifiedCode('{"id":"AD08FR31096","label":"Bordeaux"}'), "AD08FR31096");
  assertEquals(extractClassifiedCode("... locations=AD08FR1977 ..."), "AD08FR1977");
  assertEquals(extractClassifiedCode("aucun code ici"), null);
  assertEquals(extractClassifiedCode(""), null);
});

Deno.test("parseAnnonces : meme parsing pour classified-search (markdown)", () => {
  // markdown facon classified-search : memes liens /annonces/ + prix/surface
  const md = `Resultats\n\n[Appartement 2 pièces 48 m² neuf](https://www.seloger.com/annonces/locations/appartement/bordeaux-33/x/300.htm)\n980 € CC/mois\n\n[Studio 22 m²](https://www.seloger.com/annonces/locations/appartement/bordeaux-33/y/301.htm)\n640 €`;
  const a = parseAnnonces(md, []);
  assertEquals(a.length, 2);
  assertEquals(a[0].loyer, 980);
  assertEquals(a[0].surface, 48);
  assertEquals(a[1].pieces, 1); // studio
});

Deno.test("matchesAnnee : fallback best-effort (mots-cles annee/neuf)", () => {
  assertEquals(matchesAnnee("Appartement neuf", 2020), true);
  assertEquals(matchesAnnee("Programme 2024", 2020), true);
  assertEquals(matchesAnnee("Immeuble 1995", 2020), false);
  assertEquals(matchesAnnee("T2 standard", 2020), false); // pas d'indice -> exclu
  assertEquals(matchesAnnee("T2 standard", null), true); // pas de filtre -> garde
});

Deno.test("parseLoyer : euros avec espaces/insecables", () => {
  assertEquals(parseLoyer("929 € CC/mois"), 929);
  assertEquals(parseLoyer("1 250 €"), 1250); // espace normal
  assertEquals(parseLoyer("1" + "\u00A0" + "250 €"), 1250); // NBSP
  assertEquals(parseLoyer("1" + "\u202F" + "250 €"), 1250); // narrow NBSP
  assertEquals(parseLoyer("pas de prix"), null);
});

Deno.test("parseSurface : m2 / m² / decimales FR", () => {
  assertEquals(parseSurface("Appartement 53 m²"), 53);
  assertEquals(parseSurface("20m2"), 20);
  assertEquals(parseSurface("Duplex 160,2 m², 7ème étage"), 160.2); // virgule FR (titres classified)
  assertEquals(parseSurface("90.3 m²"), 90.3);
  assertEquals(parseSurface("161 m², 1 000 m² de terrain"), 161); // 1ere surface = habitable
  assertEquals(parseSurface("studio sans surface"), null);
});

Deno.test("parsePieces : pieces / studio / T2", () => {
  assertEquals(parsePieces("Appartement 2 pièces"), 2);
  assertEquals(parsePieces("Studio meuble"), 1);
  assertEquals(parsePieces("T3 lumineux"), 3);
  assertEquals(parsePieces("F4 renove"), 4);
  assertEquals(parsePieces("rien"), null);
});

Deno.test("parseCharges : forfaitaires / provision / dont X € de charges", () => {
  assertEquals(parseCharges("Charges forfaitaires 50 €/mois"), 50); // motif principal
  assertEquals(parseCharges("Provision pour charges : 80 €"), 80);
  assertEquals(parseCharges("Charges 120 €/mois"), 120);
  assertEquals(parseCharges("dont 95 € de charges"), 95);
  assertEquals(parseCharges("Loyer 929 € charges comprises"), null); // pas un montant de charges
  assertEquals(parseCharges("charges comprises 929 €"), null); // 929 = loyer, pas charges
  assertEquals(parseCharges("Loyer hors charges : 760 €"), null); // 760 = loyer HC, pas charges
  assertEquals(parseCharges("aucune mention"), null);
});

Deno.test("detailResult : 1 page detail -> charges / loyer_hc / prix_m2", () => {
  const r = detailResult(900, 50, "Loyer charges comprises 900 €. Charges forfaitaires 50 €/mois.");
  assertEquals(r.charges, 50);
  assertEquals(r.loyer_hc, 850); // 900 - 50
  assertEquals(r.prix_m2_cc, 18); // 900/50
  assertEquals(r.prix_m2_hc, 17); // 850/50
  // charges introuvables -> CC seul
  const r2 = detailResult(900, 50, "Description sans charges.");
  assertEquals(r2.charges, null);
  assertEquals(r2.loyer_hc, null);
  assertEquals(r2.prix_m2_cc, 18);
  assertEquals(r2.prix_m2_hc, null);
});

Deno.test("mergeCharges : fusion partielles + markdowns detail", () => {
  const partielles = [
    { url: "1", titre: "T2", typologie: "T2", nb_pieces: 2, surface: 50, loyer_cc: 900, charges: null, loyer_hc: null, prix_m2_cc: 18, prix_m2_hc: null },
    { url: "2", titre: "T3", typologie: "T3", nb_pieces: 3, surface: 60, loyer_cc: 1200, charges: null, loyer_hc: null, prix_m2_cc: 20, prix_m2_hc: null },
  ];
  const m = mergeCharges(partielles, ["Charges forfaitaires 50 €/mois", "pas de charges affichees"]);
  assertEquals(m[0].charges, 50);
  assertEquals(m[0].loyer_hc, 850); // 900 - 50
  assertEquals(m[0].prix_m2_hc, 17); // 850 / 50
  assertEquals(m[1].charges, null); // introuvable -> reste null
  assertEquals(m[1].loyer_hc, null);
  assertEquals(m[1].prix_m2_hc, null);
});

Deno.test("synthese : ponderation CC (toutes) et HC (seulement charges connues)", () => {
  const annonces = [
    { surface: 50, typologie: "T2", loyer_cc: 900, loyer_hc: 850, prix_m2_cc: 18, prix_m2_hc: 17 },
    { surface: 40, typologie: "T2", loyer_cc: 800, loyer_hc: null, prix_m2_cc: 20, prix_m2_hc: null },
  ];
  const s = synthesize(annonces, "location");
  assertEquals(s.parTypologie.T2!.prix_m2_cc_pondere, 18.89); // 1700/90
  assertEquals(s.parTypologie.T2!.prix_m2_hc_pondere, 17); // 850/50 (seule annonce avec HC)
  assertEquals(s.parTypologie.T2!.nb_avec_hc, 1);
});

const MD = `# 1 716 annonces de location à Bordeaux

[Appartement 2 pièces 53 m²](https://www.seloger.com/annonces/locations/appartement/bordeaux-33/saint-jean/267627119.htm)
929 € CC/mois · Bordeaux 33000

[Studio 20 m²](https://www.seloger.com/annonces/locations/appartement/bordeaux-33/centre/251925927.htm)
590 € /mois

[Appartement 3 pièces 70 m² neuf](https://www.seloger.com/annonces/locations/appartement/bordeaux-33/bastide/268338791.htm)
1 250 € CC

[Annonce sans prix 40 m²](https://www.seloger.com/annonces/locations/appartement/bordeaux-33/x/000.htm)
contact agence`;

Deno.test("parseAnnonces : decoupe le markdown en annonces (liens inline)", () => {
  const a = parseAnnonces(MD, []);
  assertEquals(a.length, 3); // la 4e (sans prix) est ecartee
  assertEquals(a[0].loyer, 929);
  assertEquals(a[0].surface, 53);
  assertEquals(a[0].pieces, 2);
  assertEquals(a[0].url, "https://www.seloger.com/annonces/locations/appartement/bordeaux-33/saint-jean/267627119.htm");
  assertEquals(a[1].pieces, 1); // studio
  assertEquals(a[1].loyer, 590);
  assertEquals(a[2].loyer, 1250);
  assertEquals(a[2].surface, 70);
});

Deno.test("parseAnnonces : retire le titre markdown de l'URL (lien Voir valide)", () => {
  // SeLoger ecrit ses liens `[texte](url "Seloger")` -> le titre ` "Seloger"`
  // ne doit PAS finir dans l'URL (sinon href casse par l'espace + guillemets).
  const md = `[Appartement 2 pièces 53 m²](https://www.seloger.com/annonces/locations/appartement/bordeaux-33/saint-jean/267627119.htm?lv=L "Seloger")
929 € CC/mois`;
  const a = parseAnnonces(md, []);
  assertEquals(a.length, 1);
  assertEquals(a[0].url, "https://www.seloger.com/annonces/locations/appartement/bordeaux-33/saint-jean/267627119.htm?lv=L");
});

Deno.test("cleanUrl : coupe au 1er espace et retire guillemets residuels", () => {
  assertEquals(cleanUrl('https://x.fr/a.htm?lv=L "Seloger"'), "https://x.fr/a.htm?lv=L");
  assertEquals(cleanUrl("https://x.fr/a.htm"), "https://x.fr/a.htm"); // url propre inchangee
  assertEquals(cleanUrl(""), null);
  assertEquals(cleanUrl(null), null);
});

Deno.test("annonceToRow : location calcule prix_m2 et typologie", () => {
  const a: RawAnnonce = { url: "u", titre: "T2", loyer: 900, surface: 45, pieces: 2 };
  const r = annonceToRow(a, CTX)!;
  assertEquals(r.loyer_cc, 900);
  assertEquals(r.charges, null);
  assertEquals(r.loyer_hc, null);
  assertEquals(r.prix_m2_cc, 20);
  assertEquals(r.prix_m2_hc, null);
  assertEquals(r.typologie, "T2");
  assertEquals(r.source, "firecrawl");
});

Deno.test("annonceToRow : charges fournies -> loyer_hc", () => {
  const a: RawAnnonce = { url: "u", titre: "T2", loyer: 900, surface: 45, pieces: 2 };
  const r = annonceToRow(a, { ...CTX, charges: 60 })!;
  assertEquals(r.charges, 60);
  assertEquals(r.loyer_hc, 840);
  assertEquals(r.prix_m2_hc, 18.67);
});

Deno.test("annonceToRow : vente -> prix_m2 sans CC/HC", () => {
  const a: RawAnnonce = { url: "u", titre: "T3", loyer: 300000, surface: 60, pieces: 3 };
  const r = annonceToRow(a, { ...CTX, transaction: "vente" })!;
  assertEquals(r.loyer_cc, null);
  assertEquals(r.prix_m2_cc, 5000);
  assertEquals(r.prix_m2_hc, 5000);
});

Deno.test("matchesTypologie / matchesNeuf / matchesAnnee", () => {
  assertEquals(matchesTypologie(2, "T2"), true);
  assertEquals(matchesTypologie(2, "T3"), false);
  assertEquals(matchesTypologie(2, null), true); // toutes
  assertEquals(matchesNeuf("Appartement neuf"), true);
  assertEquals(matchesNeuf("Appartement récent"), true);
  assertEquals(matchesNeuf("Appartement ancien"), false);
  assertEquals(matchesAnnee("T2 neuf", 2020), true);
  assertEquals(matchesAnnee("Livraison 2023", 2020), true);
  assertEquals(matchesAnnee("Construit en 2019", 2020), false);
  assertEquals(matchesAnnee("T2 lumineux", null), true); // pas de filtre
});

Deno.test("synthese : prix/m2 pondere par surface", () => {
  const rows: Row[] = [
    annonceToRow({ url: "1", titre: "T2", loyer: 850, surface: 45, pieces: 2 }, CTX)!,
    annonceToRow({ url: "2", titre: "T2", loyer: 800, surface: 40, pieces: 2 }, CTX)!,
    annonceToRow({ url: "3", titre: "T1", loyer: 600, surface: 25, pieces: 1 }, CTX)!,
  ];
  const s = synthesize(rows, "location");
  // T2 : (850+800)/(45+40)=1650/85=19.41
  assertEquals(s.parTypologie.T2!.nb_annonces, 2);
  assertEquals(s.parTypologie.T2!.prix_m2_cc_pondere, 19.41);
  // global : 2250/110 = 20.45
  assertEquals(s.global!.nb_annonces, 3);
  assertEquals(s.global!.prix_m2_cc_pondere, 20.45);
});

Deno.test("buildClassifiedUrl : pagination &page=N (p1 sans param)", () => {
  assertEquals(buildClassifiedUrl("AD08FR13100", "location", null, 1).includes("page="), false);
  assertEquals(buildClassifiedUrl("AD08FR13100", "location", null, 3).includes("&page=3"), true);
  assertEquals(buildClassifiedUrl("AD08FR13100", "location", null, 2).includes("yearOfConstructionMin"), false);
  const u = buildClassifiedUrl("AD08FR13100", "location", 2020, 2);
  assertEquals(u.includes("yearOfConstructionMin=2020") && u.includes("&page=2"), true);
});

Deno.test("villeSlug / seoLocationUrl : slug SeLoger", () => {
  assertEquals(villeSlug("Bordeaux"), "bordeaux");
  assertEquals(villeSlug("Saint-Étienne"), "saint-etienne");
  assertEquals(villeSlug("L'Haÿ-les-Roses"), "l-hay-les-roses");
  assertEquals(seoLocationUrl("Bordeaux", "33"), "https://www.seloger.com/immobilier/locations/immo-bordeaux-33/");
});

Deno.test("extractCityCode : code AD08FR le plus frequent", () => {
  // le code ville apparait dans chaque lien, les voisins 1-2 fois
  const html = 'x AD08FR13100 y AD08FR13100 z AD08FR13100 AD08FR13315 AD02FR1 AD06FR34';
  assertEquals(extractCityCode(html), "AD08FR13100");
  assertEquals(extractCityCode("AD08FR9 une-seule-occurrence"), null); // < 3 occurrences -> douteux
  assertEquals(extractCityCode(""), null);
});

Deno.test("cutProximity : coupe la section 'Plus d'annonces à proximité'", () => {
  const md = "annonce exacte 800 € 40 m²\n\nPlus d'annonces à proximité\n\nannonce voisine 900 € 50 m²";
  assertEquals(cutProximity(md).includes("voisine"), false);
  assertEquals(cutProximity(md).includes("exacte"), true);
  assertEquals(cutProximity("sans section"), "sans section");
});

Deno.test("parseSurface : priorite au format titre, pas au 1er m² venu", () => {
  // une chambre de 9 m² citee AVANT la surface du titre ne doit plus gagner
  assertEquals(parseSurface("chambre de 9 m² ... 5 pièces, 4 chambres, 161 m²"), 161);
  assertEquals(parseSurface("Maison à louer - 3 325 € - 6 pièces, 145,5 m², 1 000 m² de terrain"), 145.5);
  assertEquals(parseSurface("1 pièce, 18 m²"), 18); // singulier
  assertEquals(parseSurface("balcon 1 000 m² de terrain"), null); // terrain seul -> rien
});

Deno.test("isColocation : titre ou URL", () => {
  assertEquals(isColocation("Colocation à louer - Bordeaux", null), true);
  assertEquals(isColocation("Chambre en coloc meublée", null), true);
  assertEquals(isColocation("Appartement T3", "https://www.seloger.com/annonces/locations/colocation/bordeaux-33/x.htm"), true);
  assertEquals(isColocation("Appartement T3", "https://www.seloger.com/annonces/locations/appartement/bordeaux-33/x.htm"), false);
});

Deno.test("isPlausible : garde-fou surfaces/prix", () => {
  assertEquals(isPlausible(2, 400, "location"), false); // surface < 9 (parsing rate)
  assertEquals(isPlausible(128, 4.8, "location"), false); // coloc 620 €/128 m²
  assertEquals(isPlausible(17, 65, "location"), false); // > 60 €/m²
  assertEquals(isPlausible(17, 36, "location"), true); // studio cher mais plausible
  assertEquals(isPlausible(86, 5081, "vente"), true); // vente : pas de fourchette loyer
  assertEquals(isPlausible(5, 5000, "vente"), false); // mais surface mini quand meme
});

Deno.test("neufListUrl : liste programmes + pagination par chemin", () => {
  assertEquals(neufListUrl("Bordeaux", "33"), "https://www.selogerneuf.com/immobilier/neuf/immo-bordeaux-33/bien-programme/");
  assertEquals(neufListUrl("Saint-Étienne", "42", 3), "https://www.selogerneuf.com/immobilier/neuf/immo-saint-etienne-42/bien-programme/3/");
});

Deno.test("neufProgramLinks : filtre ville, dedup fragments, fallback voisins", () => {
  const links = [
    "https://www.selogerneuf.com/annonces/neuf/programme/bordeaux-33/239371723/#m=xxx",
    "https://www.selogerneuf.com/annonces/neuf/programme/bordeaux-33/239371723/",
    "https://www.selogerneuf.com/annonces/neuf/programme/bruges-33/257906145/",
    "https://www.selogerneuf.com/immobilier/neuf/immo-bordeaux-33/bien-programme/2/",
  ];
  const bdx = neufProgramLinks(links, "bordeaux");
  assertEquals(bdx, ["https://www.selogerneuf.com/annonces/neuf/programme/bordeaux-33/239371723/"]);
  assertEquals(neufProgramLinks(links, null).length, 2); // bordeaux + bruges
  // que des voisins -> fallback tous (petites communes)
  assertEquals(neufProgramLinks(links, "pessac").length, 2);
});

Deno.test("parseNeufUnits : lots Studio / N pièces (extrait reel selogerneuf)", () => {
  const md = `Logements disponibles

- StudioDe 141 100 € à 189 500 €

61 biens

  - Studio

    141 100 €

    Soit 7 521 €/m²

    19 m²

    1er étageExposition Sud EstAscenseur

- Appartement2 piècesDe 221 400 € à 227 000 €

  - Appartement2 pièces

    221 400 €

    Soit 6 340 €/m²

    35 m²
`;
  const u = parseNeufUnits(md);
  assertEquals(u.length, 2);
  assertEquals(u[0], { pieces: 1, prix: 141100, prix_m2: 7521, surface: 19 });
  assertEquals(u[1], { pieces: 2, prix: 221400, prix_m2: 6340, surface: 35 });
});

Deno.test("parseNeufMeta : nom / promoteur / adresse / livraison", () => {
  const md = `Proposé par Marignan, mis à jour le 12/06/2026

# L'Ecrin des Chartrons

249 Rue du Jardin Public, 33000 Bordeaux

Livraison

3e trimestre 2027
`;
  const m = parseNeufMeta(md);
  assertEquals(m.nom, "L'Ecrin des Chartrons");
  assertEquals(m.promoteur, "Marignan");
  assertEquals(m.adresse, "249 Rue du Jardin Public, 33000 Bordeaux");
  assertEquals(m.livraison, "3e trimestre 2027");
  // echappements markdown retires du nom
  assertEquals(parseNeufMeta("# KLEEZI \\| THIERS BORDEAUX\n").nom, "KLEEZI | THIERS BORDEAUX");
});

Deno.test("isPlausibleNeuf : fourchette 2500-15000 EUR/m2", () => {
  assertEquals(isPlausibleNeuf(5735), true);
  assertEquals(isPlausibleNeuf(2400), false);
  assertEquals(isPlausibleNeuf(16000), false);
  assertEquals(isPlausibleNeuf(null), false);
});

Deno.test("parseArrondissement : Paris 8 / 8e / 8ème / 75008 / Lyon / Marseille", () => {
  assertEquals(parseArrondissement("Paris 8"), { ville: "Paris", arr: 8 });
  assertEquals(parseArrondissement("paris 8e"), { ville: "Paris", arr: 8 });
  assertEquals(parseArrondissement("Paris 8ème"), { ville: "Paris", arr: 8 });
  assertEquals(parseArrondissement("75008"), { ville: "Paris", arr: 8 });
  assertEquals(parseArrondissement("Lyon 3eme"), { ville: "Lyon", arr: 3 });
  assertEquals(parseArrondissement("69003"), { ville: "Lyon", arr: 3 });
  assertEquals(parseArrondissement("13012"), { ville: "Marseille", arr: 12 });
  assertEquals(parseArrondissement("Paris 1er"), { ville: "Paris", arr: 1 });
  assertEquals(parseArrondissement("Paris 21"), null); // hors plage
  assertEquals(parseArrondissement("Lyon 10"), null);
  assertEquals(parseArrondissement("Bordeaux"), null);
  assertEquals(parseArrondissement("75021"), null);
});

Deno.test("arrInsee / arrCodePostal / arrSlug / arrLabel", () => {
  const p8 = { ville: "Paris", arr: 8 };
  assertEquals(arrInsee(p8), "75108");
  assertEquals(arrCodePostal(p8), "75008");
  assertEquals(arrSlug(p8), "paris-8eme");
  assertEquals(arrLabel(p8), "Paris 8e");
  const l3 = { ville: "Lyon", arr: 3 };
  assertEquals(arrInsee(l3), "69383");
  assertEquals(arrCodePostal(l3), "69003");
  const p1 = { ville: "Paris", arr: 1 };
  assertEquals(arrSlug(p1), "paris-1er");
  assertEquals(arrLabel(p1), "Paris 1er");
  assertEquals(selogerCode(arrInsee(p8)), 750108); // list.htm fallback OK
});

Deno.test("URLs arrondissement : neuf (CP complet) + SEO location (dept)", () => {
  const p8 = { ville: "Paris", arr: 8 };
  assertEquals(neufListUrl("Paris", "75", 1, p8), "https://www.selogerneuf.com/immobilier/neuf/immo-paris-8eme-75008/bien-programme/");
  assertEquals(seoLocationUrl("Paris", "75", p8), "https://www.seloger.com/immobilier/locations/immo-paris-8eme-75/");
});

Deno.test("neufProgramLinks strict : pas de fallback voisins en arrondissement", () => {
  const links = [
    "https://www.selogerneuf.com/annonces/neuf/programme/paris-8eme-75/209313613/",
    "https://www.selogerneuf.com/annonces/neuf/programme/clichy-92/240422587/",
  ];
  assertEquals(neufProgramLinks(links, "paris-8eme", true).length, 1);
  // strict + aucun lien exact -> vide (pas Clichy !)
  assertEquals(neufProgramLinks([links[1]], "paris-8eme", true).length, 0);
});

Deno.test("extractCityCode : AD09 (arrondissement) majoritaire", () => {
  const html = "AD09FR33 ".repeat(98) + "AD08FR31096 ".repeat(34) + "AD02FR1 ".repeat(36);
  assertEquals(extractCityCode(html), "AD09FR33");
});

Deno.test("parseNeufMeta : TVA 5,5% detectee, sinon 20%", () => {
  assertEquals(parseNeufMeta("# X\n\nÉligibilité\n\nLMNPTVA 5,5%PTZ").tva, "5,5%");
  assertEquals(parseNeufMeta("# X\n\nTVA réduite").tva, "5,5%");
  assertEquals(parseNeufMeta("# X\n\nLMNP PTZ").tva, "20%");
});

Deno.test("parseMeuble : tri-state (meuble / non meuble / indetermine)", () => {
  assertEquals(parseMeuble("Appartement meublé à louer - Bordeaux"), true);
  assertEquals(parseMeuble("Studio meuble lumineux"), true);
  assertEquals(parseMeuble("Appartement non meublé"), false);
  // "non meublé" doit etre teste AVANT "meublé" (sinon matchait true = ancien bug)
  assertEquals(parseMeuble("NON-MEUBLÉ charges comprises"), false);
  assertEquals(parseMeuble("Appartement non-meuble"), false);
  // pas de mention -> indetermine (null), PAS un faux "non meuble"
  assertEquals(parseMeuble("Appartement 3 pièces"), null);
  assertEquals(parseMeuble(null), null);
  // "immeuble" / "ameublement" ne doivent pas matcher "meuble"
  assertEquals(parseMeuble("Bel appartement dans immeuble haussmannien"), null);
});

Deno.test("synthesizeMeuble : observes + convertis (x1,15 / x0,85 sur CC)", () => {
  const rows = [
    { surface: 20, typologie: "T1", prix_m2_cc: 30, meuble: true },  // meuble observe
    { surface: 20, typologie: "T1", prix_m2_cc: 20, meuble: false }, // non meuble observe
  ];
  const s = synthesizeMeuble(rows);
  const t1 = s.parTypologie.T1!;
  // NM pondere : (30*0.85*20 + 20*20)/40 = (510+400)/40 = 22.75
  assertEquals(t1.non_meuble, 22.75);
  assertEquals(t1.non_meuble_source, "observe");
  // M pondere : (30*20 + 20*1.15*20)/40 = (600+460)/40 = 26.5
  assertEquals(t1.meuble, 26.5);
  assertEquals(t1.meuble_source, "observe");
  // que du non meuble -> meuble ESTIME = x1,15
  const s2 = synthesizeMeuble([{ surface: 40, typologie: "T2", prix_m2_cc: 20, meuble: false }]);
  assertEquals(s2.parTypologie.T2!.meuble, 23); // 20*1.15
  assertEquals(s2.parTypologie.T2!.meuble_source, "estime");
  assertEquals(s2.parTypologie.T2!.non_meuble_source, "observe");
  assertEquals(s2.base, "CC");
  // meuble indetermine (null) -> EXCLU des deux moyennes
  const s3 = synthesizeMeuble([
    { surface: 20, typologie: "T1", prix_m2_cc: 30, meuble: true },
    { surface: 20, typologie: "T1", prix_m2_cc: 99, meuble: null }, // ignore
  ]);
  assertEquals(s3.parTypologie.T1!.nb_meuble, 1); // le null n'est pas compte
  assertEquals(s3.parTypologie.T1!.nb_non_meuble, 0);
  assertEquals(s3.parTypologie.T1!.meuble, 30); // 99 (indetermine) exclu
});

Deno.test("parseAnnonces : meuble extrait du bloc", () => {
  const md = `[Appartement meublé 2 pièces 40 m²](https://www.seloger.com/annonces/locations/appartement/bordeaux-33/x/1.htm)\n900 € CC/mois\n\n[Appartement 3 pièces 60 m²](https://www.seloger.com/annonces/locations/appartement/bordeaux-33/y/2.htm)\n1100 €`;
  const a = parseAnnonces(md, []);
  assertEquals(a[0].meuble, true);
  assertEquals(a[1].meuble, null); // pas de mention -> indetermine (exclu des moyennes)
});

Deno.test("parseTypologies / matchesTypologies : choix multiple", () => {
  assertEquals(parseTypologies("T1,T3,T4"), ["T1", "T3", "T4"]);
  assertEquals(parseTypologies("t2, t3"), ["T2", "T3"]);
  assertEquals(parseTypologies("T2"), ["T2"]);
  assertEquals(parseTypologies(""), null);
  assertEquals(parseTypologies("xyz"), null);
  // tableau envoye par le front (BUG 1) : accepte et normalise ; [] = toutes
  assertEquals(parseTypologies(["T2"]), ["T2"]);
  assertEquals(parseTypologies(["t2", "T3", "x"]), ["T2", "T3"]);
  assertEquals(parseTypologies([]), null);
  assertEquals(matchesTypologies(1, ["T1", "T3"]), true);
  assertEquals(matchesTypologies(2, ["T1", "T3"]), false);
  assertEquals(matchesTypologies(3, ["T1", "T3"]), true);
  assertEquals(matchesTypologies(2, null), true); // pas de filtre
});

Deno.test("normLoc : minuscules, sans accents, separateurs unifies", () => {
  assertEquals(normLoc("Boulogne-Billancourt"), "boulogne billancourt");
  assertEquals(normLoc("Boulogne   Billancourt"), "boulogne billancourt");
  assertEquals(normLoc("L'Haÿ-les-Roses"), "l hay les roses");
  assertEquals(normLoc(null), "");
});

Deno.test("matchesCommune : commune simple -> rejette les communes voisines", () => {
  const ref = buildCommuneRef("Boulogne-Billancourt", "92100");
  // bon : titre ou URL portant la commune (slug URL = ".../boulogne-billancourt-92/...")
  assertEquals(matchesCommune("Appartement à louer - Boulogne-Billancourt - 2 pièces", null, ref), true);
  assertEquals(matchesCommune(null, "https://www.seloger.com/annonces/locations/appartement/boulogne-billancourt-92/x/1.htm", ref), true);
  assertEquals(matchesCommune("Boulogne Billancourt centre", null, ref), true); // variante sans tiret
  // CP exact
  assertEquals(matchesCommune("Joli T2 - 92100", null, ref), true);
  // debordement : Issy, Paris -> rejetes
  assertEquals(matchesCommune("Appartement Issy-les-Moulineaux 3 pièces", "https://www.seloger.com/annonces/locations/appartement/issy-les-moulineaux-92/y/2.htm", ref), false);
  assertEquals(matchesCommune("Studio Paris 16ème arrondissement", "https://www.seloger.com/.../paris-16eme-75016/z/3.htm", ref), false);
  assertEquals(matchesCommune("Appartement 3 pièces", null, ref), false); // aucun lieu -> rejet
});

Deno.test("matchesCommune : arrondissement -> uniquement le bon arrondissement", () => {
  const ref = buildCommuneRef("Paris 8e", "75008");
  assertEquals(matchesCommune("Appartement Paris 8ème", null, ref), true);
  assertEquals(matchesCommune("Paris 8e - studio", null, ref), true);
  assertEquals(matchesCommune("Loft - Paris 8 arrondissement", null, ref), true);
  assertEquals(matchesCommune(null, "https://www.seloger.com/.../paris-8eme-75008/x/1.htm", ref), true);
  assertEquals(matchesCommune("Bien - 75008 Paris", null, ref), true);
  // autres arrondissements -> rejetes (pas de confusion 8 / 18 / 28 / 80)
  assertEquals(matchesCommune("Appartement Paris 18ème", null, ref), false);
  assertEquals(matchesCommune("Studio Paris 16e", null, ref), false);
  assertEquals(matchesCommune(null, "https://www.seloger.com/.../paris-16eme-75016/x/1.htm", ref), false);
  assertEquals(matchesCommune("Maison Issy-les-Moulineaux", null, ref), false);
});

Deno.test("buildCommuneRef : detecte l'arrondissement et son CP", () => {
  const a = buildCommuneRef("Paris 8e", null);
  assertEquals(a.arr?.arr, 8);
  assertEquals(a.cp, "75008"); // CP deduit de l'arrondissement si non fourni
  const v = buildCommuneRef("Boulogne-Billancourt", "92100");
  assertEquals(v.arr, null);
  assertEquals(v.villeNorm, "boulogne billancourt");
});

Deno.test("parseChargesDetail : Provisions pour charges X €/mois + fallback", () => {
  assertEquals(parseChargesDetail("Provisions pour charges : 120 €/mois"), 120);
  assertEquals(parseChargesDetail("Provisions pour charges récupérables estimées à 95 €/mois"), 95);
  assertEquals(parseChargesDetail("Provision pour charges\n\n80 €"), 80); // valeur ligne suivante
  assertEquals(parseChargesDetail("Charges forfaitaires 50 €/mois"), 50); // fallback parseCharges
  assertEquals(parseChargesDetail("Loyer charges comprises (sans montant détaillé)"), null);
});

Deno.test("parseDpe / parseGes : lettre A-G apres le libelle", () => {
  assertEquals(parseDpe("Diagnostic de performance énergétique (DPE)\n\n**D**\n145 kWh"), "D");
  assertEquals(parseDpe("DPE : C"), "C");
  assertEquals(parseDpe("Classe énergie\nB"), "B");
  assertEquals(parseDpe("DPE en cours de réalisation"), null); // pas de lettre isolee
  assertEquals(parseDpe("Bel appartement"), null);
  assertEquals(parseGes("Gaz à effet de serre (GES) : E"), "E");
  assertEquals(parseGes("GES\n\nA"), "A");
});

Deno.test("detailResult : charges/HC + DPE/GES, ignore charges >= loyer", () => {
  const r = detailResult(900, 50, "Provisions pour charges : 60 €/mois. DPE : D. GES : B.");
  assertEquals(r.charges, 60);
  assertEquals(r.loyer_hc, 840);
  assertEquals(r.prix_m2_hc, 16.8);
  assertEquals(r.dpe, "D");
  assertEquals(r.ges, "B");
  // montant douteux (>= loyer, ex parking cite) -> ignore
  const r2 = detailResult(800, 40, "Loue place de parking 1 200 € ... charges comprises");
  assertEquals(r2.charges, null);
  assertEquals(r2.loyer_hc, null);
});

Deno.test("modeGrade : DPE le plus frequent (ignore vides/invalides)", () => {
  assertEquals(modeGrade(["D", "D", "C", null, "x", "D"]), "D");
  assertEquals(modeGrade([null, undefined, ""]), null);
});

Deno.test("synthesizeCharges : charges reelles vs estimees + HC pondere", () => {
  const rows = [
    { surface: 50, typologie: "T2", loyer_cc: 1000, charges: 100, dpe: "D" }, // reel : 2 €/m²
    { surface: 50, typologie: "T2", loyer_cc: 1000, charges: null, dpe: "D" }, // estime
    { surface: 30, typologie: "T1", loyer_cc: 600, charges: null, dpe: "C" }, // estime
  ];
  const s = synthesizeCharges(rows);
  assertEquals(s.ratio_m2_moyen, 2); // 100 / 50
  assertEquals(s.nb_charges_reelles, 1);
  assertEquals(s.dpe_frequent, "D");
  const t2 = s.parTypologie.T2!;
  assertEquals(t2.charges_m2_moyen, 2); // sur l'annonce reelle uniquement
  assertEquals(t2.charges_moyen, 100);
  assertEquals(t2.nb_charges_reelles, 1);
  assertEquals(t2.nb_charges_estimees, 1);
  // HC pondere T2 : ann1 (1000-100)/50 + ann2 estimee (1000-100)/50 = 1800 € / 100 m² = 18 €/m²
  assertEquals(t2.loyer_hc_m2_pondere, 18);
});
