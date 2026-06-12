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
  seoLocationUrl,
  villeSlug,
  matchesAnnee,
  matchesNeuf,
  matchesTypologie,
  mergeCharges,
  parseAnnonces,
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
