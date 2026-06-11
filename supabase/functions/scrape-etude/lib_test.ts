import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  annonceToRow,
  buildListUrl,
  matchesAnnee,
  matchesNeuf,
  matchesTypologie,
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

Deno.test("parseLoyer : euros avec espaces/insecables", () => {
  assertEquals(parseLoyer("929 € CC/mois"), 929);
  assertEquals(parseLoyer("1 250 €"), 1250); // espace normal
  assertEquals(parseLoyer("1" + "\u00A0" + "250 €"), 1250); // NBSP
  assertEquals(parseLoyer("1" + "\u202F" + "250 €"), 1250); // narrow NBSP
  assertEquals(parseLoyer("pas de prix"), null);
});

Deno.test("parseSurface : m2 / m²", () => {
  assertEquals(parseSurface("Appartement 53 m²"), 53);
  assertEquals(parseSurface("20m2"), 20);
  assertEquals(parseSurface("studio sans surface"), null);
});

Deno.test("parsePieces : pieces / studio / T2", () => {
  assertEquals(parsePieces("Appartement 2 pièces"), 2);
  assertEquals(parsePieces("Studio meuble"), 1);
  assertEquals(parsePieces("T3 lumineux"), 3);
  assertEquals(parsePieces("F4 renove"), 4);
  assertEquals(parsePieces("rien"), null);
});

Deno.test("parseCharges : provision / charges", () => {
  assertEquals(parseCharges("Provision pour charges : 80 €"), 80);
  assertEquals(parseCharges("Charges 120 €/mois"), 120);
  assertEquals(parseCharges("aucune mention"), null);
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
