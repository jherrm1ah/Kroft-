// Tests getting a ride (Uber, Bolt, inDrive). Run with: npm test
import { RIDE_APPS, rideOrder, rideLink, rideHint, rideDescription, uberLink } from "./rides.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };

eq("Nigeria: Bolt and inDrive first", rideOrder("NGN"), ["bolt", "indrive", "uber"]);
eq("elsewhere: Uber first", rideOrder("USD"), ["uber", "bolt", "indrive"]);
eq("Uber: destination filled in, same link as before", uberLink("12 Admiralty Way, Lekki"), "https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff%5Bformatted_address%5D=12+Admiralty+Way%2C+Lekki");
eq("Uber goes to Uber's link on every phone", [rideLink("uber", "Ikeja", { android: true }).startsWith("https://m.uber.com/ul/"), rideLink("uber", "Ikeja").startsWith("https://m.uber.com/ul/")], [true, true]);
eq("Bolt on Android: its Google Play page", rideLink("bolt", "Ikeja", { android: true }), "https://play.google.com/store/apps/details?id=ee.mtakso.client");
eq("inDrive on Android: its Google Play page", rideLink("indrive", "Ikeja", { android: true }), "https://play.google.com/store/apps/details?id=sinet.startup.inDriver");
eq("elsewhere: their websites", [rideLink("bolt", "x"), rideLink("indrive", "x")], ["https://bolt.eu/", "https://indrive.com/"]);
eq("an unknown app goes nowhere", rideLink("lyft", "x"), "");
eq("Bolt and inDrive: told the destination was copied", [rideHint("bolt", "Ikeja"), rideHint("indrive", "Ikeja")], ["Destination copied. Paste it in Bolt to book.", "Destination copied. Paste it in inDrive to book."]);
eq("Uber, or no destination: nothing to say", [rideHint("uber", "Ikeja"), rideHint("bolt", "")], ["", ""]);
eq("descriptions say what really happens", [rideDescription("uber"), rideDescription("bolt"), rideDescription("indrive")], [
  "No connection needed. KROFT opens Uber with your destination filled in, and you book there.",
  "No connection needed. KROFT copies your destination and takes you to Bolt, where you paste it and book.",
  "No connection needed. KROFT copies your destination and takes you to inDrive, where you paste it and book.",
]);
eq("every app has a badge colour and text colour", Object.values(RIDE_APPS).every(a => /^#[0-9a-f]{6}$/.test(a.bg) && /^#[0-9a-f]{6}$/.test(a.fg)), true);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
