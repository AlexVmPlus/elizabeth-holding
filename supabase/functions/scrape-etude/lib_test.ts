import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSearchUrl,
  chargesFromDetail,
  cleanDetail,
  dpeLetter,
  type GeoInfo,
  passesFilters,
  roomsParam,
  synthesize,
  typologie,
} from "./lib.ts";

const GEO: GeoInfo = { insee: "33063", nom: "Bordeaux", lat: 44.84, lng: -0.58, codePostal: "33000" };
const AT = "2026-06-10T00:00:00.000Z";

Deno.test("typologie T1..T6", () => {
  assertEquals(typologie(1), "T1");
  assertEquals(typologie(5), "T5");
  assertEquals(typologie(6), "T6");
  assertEquals(typologie(9), "T6"); // plafonne a T6
  assertEquals(typologie(0), null);
  assertEquals(typologie(null), null);
});

Deno.test("dpeLetter : chaine, objet, objet vide", () => {
  assertEquals(dpeLetter("c"), "C");
  assertEquals(dpeLetter({ letter: "D" }), "D");
  assertEquals(dpeLetter({ value: "B" }), "B");
  assertEquals(dpeLetter({}), null); // objet vide -> pas de "{}"
  assertEquals(dpeLetter(null), null);
});

Deno.test("buildSearchUrl : location -> Rent, neuf, ci numerique", () => {
  const u = buildSearchUrl("330063", "location", "2");
  assertEquals(u.includes("distributionTypes=Rent"), true);
  assertEquals(u.includes("natures=2"), true);
  // ci doit etre un NOMBRE dans places (pas une chaine)
  assertEquals(u.includes(encodeURIComponent('[{"inseeCodes":[330063]}]')), true);
});

Deno.test("buildSearchUrl : vente -> Buy", () => {
  const u = buildSearchUrl("330063", "vente", "2");
  assertEquals(u.includes("distributionTypes=Buy"), true);
});

Deno.test("roomsParam : typologie -> param SeLoger rooms", () => {
  assertEquals(roomsParam("T1"), "1");
  assertEquals(roomsParam("T3"), "3");
  assertEquals(roomsParam("T6"), "6,7,8,9,10"); // T6 = 6 pieces et plus
  assertEquals(roomsParam(""), null);
  assertEquals(roomsParam(null), null);
});

Deno.test("buildSearchUrl : filtre typologie -> param rooms", () => {
  const u = buildSearchUrl("330063", "location", "1,2", { rooms: roomsParam("T2") });
  assertEquals(u.includes("&rooms=2"), true);
  // sans typologie -> pas de param rooms
  const u2 = buildSearchUrl("330063", "location", "1,2");
  assertEquals(u2.includes("rooms="), false);
});

Deno.test("passesFilters : typologie sur le nb de pieces", () => {
  const t2 = { rooms: 2 };
  assertEquals(passesFilters(t2, { typologie: "T2" }), true);
  assertEquals(passesFilters(t2, { typologie: "T3" }), false);
  // T6 = 6 pieces et plus
  assertEquals(passesFilters({ rooms: 7 }, { typologie: "T6" }), true);
  // pas de filtre -> tout passe
  assertEquals(passesFilters(t2, {}), true);
  assertEquals(passesFilters({ rooms: null }, { typologie: "T2" }), false);
});

Deno.test("chargesFromDetail : provisions dans alur (cas reel)", () => {
  // Annonce reelle 267627119 : provisions 339,60 € dans alur
  assertEquals(chargesFromDetail({ alur: { flatRateCharges: 339.6, ifProvisionsOnCharges: true }, flatRateCharges: null, condoAnnualCharges: 0 }), 339.6);
});

Deno.test("chargesFromDetail : forfait dans alur", () => {
  assertEquals(chargesFromDetail({ alur: { flatRateCharges: 80, ifProvisionsOnCharges: false } }), 80);
});

Deno.test("chargesFromDetail : fallback flatRateCharges racine puis condoAnnualCharges/12", () => {
  assertEquals(chargesFromDetail({ alur: { flatRateCharges: 0 }, flatRateCharges: 60 }), 60);
  assertEquals(chargesFromDetail({ condoAnnualCharges: 1200 }), 100); // /12
  assertEquals(chargesFromDetail({}), null);
  assertEquals(chargesFromDetail({ alur: {}, flatRateCharges: 0, condoAnnualCharges: 0 }), null);
});

Deno.test("cleanDetail : provisions alur -> loyer_hc et prix_m2_hc (cas reel)", () => {
  const r = cleanDetail(
    {
      title: "Appartement T5 Saint-Jean Belcier",
      rooms: 5,
      livingArea: 113.2,
      price: 1698,
      alur: { flatRateCharges: 339.6, ifProvisionsOnCharges: true, price: 1698 },
      city: "Bordeaux",
      zipCode: "33800",
    },
    "location",
    "Saint Jean-Belcier",
    GEO,
    AT,
  )!;
  assertEquals(r.loyer_cc, 1698);
  assertEquals(r.charges, 339.6);
  assertEquals(r.loyer_hc, 1358.4); // 1698 - 339.6
  assertEquals(r.prix_m2_cc, 15); // 1698/113.2
  assertEquals(r.prix_m2_hc, 12); // 1358.4/113.2
  assertEquals(r.typologie, "T5");
});

Deno.test("cleanDetail : location calcule loyer_hc et prix/m2", () => {
  const r = cleanDetail(
    { title: "Appartement neuf T2", rooms: 2, livingArea: 45, price: 850, flatRateCharges: 50, city: "Bordeaux", zipCode: "33800", energyBalance: "B", propertyNature: "appartement", permalink: "https://x/1" },
    "location",
    "Saint Jean-Belcier",
    GEO,
    AT,
  )!;
  assertEquals(r.surface, 45);
  assertEquals(r.loyer_cc, 850);
  assertEquals(r.charges, 50);
  assertEquals(r.loyer_hc, 800);
  assertEquals(r.prix_m2_cc, 18.89); // 850/45
  assertEquals(r.prix_m2_hc, 17.78); // 800/45
  assertEquals(r.typologie, "T2");
  assertEquals(r.code_postal, "33800");
  assertEquals(r.source, "seloger");
});

Deno.test("cleanDetail : location sans flatRateCharges -> charges/HC null, CC exploitable", () => {
  const r = cleanDetail(
    { title: "T3 lumineux", rooms: 3, livingArea: 60, price: 1200, city: "Bordeaux", permalink: "https://x/2" },
    "location",
    "",
    GEO,
    AT,
  )!;
  assertEquals(r.loyer_cc, 1200);
  assertEquals(r.charges, null);
  assertEquals(r.loyer_hc, null);
  assertEquals(r.prix_m2_cc, 20); // 1200/60
  assertEquals(r.prix_m2_hc, null);
  assertEquals(r.url, "https://x/2"); // lit permalink
});

Deno.test("cleanDetail : rejette colocation / chambre de service", () => {
  assertEquals(cleanDetail({ title: "Chambre en colocation", rooms: 1, livingArea: 12, price: 400 }, "location", "", GEO, AT), null);
  assertEquals(cleanDetail({ title: "Chambre de service", rooms: 1, livingArea: 9, price: 350 }, "location", "", GEO, AT), null);
});

Deno.test("cleanDetail : rejette surface 0 ou prix 0", () => {
  assertEquals(cleanDetail({ title: "T2", rooms: 2, livingArea: 0, price: 800 }, "location", "", GEO, AT), null);
  assertEquals(cleanDetail({ title: "T2", rooms: 2, livingArea: 40, price: 0 }, "location", "", GEO, AT), null);
});

Deno.test("synthese : prix/m2 pondere par surface (location)", () => {
  const rows = [
    cleanDetail({ title: "T2", rooms: 2, livingArea: 45, price: 850, flatRateCharges: 50 }, "location", "", GEO, AT)!,
    cleanDetail({ title: "T2", rooms: 2, livingArea: 40, price: 800, flatRateCharges: 40 }, "location", "", GEO, AT)!,
    cleanDetail({ title: "T1", rooms: 1, livingArea: 25, price: 600, flatRateCharges: 30 }, "location", "", GEO, AT)!,
  ];
  const s = synthesize(rows, "location");
  // T2 : surfaces 45+40=85 ; CC 850+800=1650 ; HC 800+760=1560
  assertEquals(s.parTypologie.T2!.nb_annonces, 2);
  assertEquals(s.parTypologie.T2!.prix_m2_cc_pondere, 19.41); // 1650/85
  assertEquals(s.parTypologie.T2!.prix_m2_hc_pondere, 18.35); // 1560/85
  assertEquals(s.parTypologie.T2!.surface_moyenne, 42.5);
  // T1 : 600/25=24 CC, 570/25=22.8 HC
  assertEquals(s.parTypologie.T1!.prix_m2_cc_pondere, 24);
  assertEquals(s.parTypologie.T1!.prix_m2_hc_pondere, 22.8);
  // global : surfaces 110 ; CC 2250 ; HC 2130
  assertEquals(s.global!.nb_annonces, 3);
  assertEquals(s.global!.prix_m2_cc_pondere, round2(2250 / 110)); // 20.45
  assertEquals(s.global!.prix_m2_hc_pondere, round2(2130 / 110)); // 19.36
});

Deno.test("synthese : HC pondere sur les seules annonces avec charges connues", () => {
  const rows = [
    // T2 avec charges -> HC dispo
    cleanDetail({ title: "T2", rooms: 2, livingArea: 50, price: 1000, flatRateCharges: 100 }, "location", "", GEO, AT)!,
    // T2 sans charges -> CC seul, HC null
    cleanDetail({ title: "T2", rooms: 2, livingArea: 30, price: 700 }, "location", "", GEO, AT)!,
  ];
  const s = synthesize(rows, "location");
  const t2 = s.parTypologie.T2!;
  assertEquals(t2.nb_annonces, 2);
  assertEquals(t2.nb_avec_hc, 1);
  // CC pondere sur les 2 : (1000+700)/(50+30) = 1700/80 = 21.25
  assertEquals(t2.prix_m2_cc_pondere, 21.25);
  // HC pondere sur la seule annonce avec charges : 900/50 = 18
  assertEquals(t2.prix_m2_hc_pondere, 18);
});

Deno.test("synthese : vente pondere le prix de vente", () => {
  const rows = [
    cleanDetail({ title: "T3 neuf", rooms: 3, livingArea: 60, price: 300000 }, "vente", "", GEO, AT)!,
    cleanDetail({ title: "T3 neuf", rooms: 3, livingArea: 40, price: 220000 }, "vente", "", GEO, AT)!,
  ];
  const s = synthesize(rows, "vente");
  // sum prix 520000 / sum surf 100 = 5200 €/m2
  assertEquals(s.global!.prix_m2_cc_pondere, 5200);
  assertEquals(s.parTypologie.T3!.nb_annonces, 2);
});

function round2(x: number) {
  return Math.round(x * 100) / 100;
}
