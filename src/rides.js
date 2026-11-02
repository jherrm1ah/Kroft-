// Getting a ride from KROFT: Uber, Bolt and inDrive. None of them lets an app book or price a ride
// without a business partnership, so KROFT hands over to the ride app and the booking happens there.
//
// Uber publishes a keyless "Ride Request Deeplink" that opens Uber with the destination filled in.
// Bolt and inDrive publish no such link, so for them KROFT copies the destination (to paste in) and
// takes the person to the app: on Android its Google Play page, whose Open button starts it (and
// which offers to install it if it isn't there); elsewhere the company's website.
//
// Plain functions so they can be tested; nothing here touches the screen.

export const RIDE_APPS = {
  uber:    { id: "uber",    name: "Uber",    bg: "#000000", fg: "#ffffff", fillsDestination: true },
  bolt:    { id: "bolt",    name: "Bolt",    bg: "#1fa463", fg: "#ffffff", android: "ee.mtakso.client",       web: "https://bolt.eu/" },
  indrive: { id: "indrive", name: "inDrive", bg: "#c1f11d", fg: "#141414", android: "sinet.startup.inDriver", web: "https://indrive.com/" },
};

// Uber isn't available to everyone (it left Nigeria), so people paying in naira see Bolt and inDrive first.
export const rideOrder = currency => (currency === "NGN" ? ["bolt", "indrive", "uber"] : ["uber", "bolt", "indrive"]);

export function uberLink(address) {
  const url = new URL("https://m.uber.com/ul/");
  url.searchParams.set("action", "setPickup");
  url.searchParams.set("pickup", "my_location");
  if (address) url.searchParams.set("dropoff[formatted_address]", address);
  return url.toString();
}

// Where tapping a ride app goes. android: true on Android phones (the website or the app).
export function rideLink(appId, address, { android = false } = {}) {
  const app = RIDE_APPS[appId];
  if (!app) return "";
  if (app.fillsDestination) return uberLink(address);
  return android ? `https://play.google.com/store/apps/details?id=${app.android}` : app.web;
}

// What the person is told after tapping, or "" when the app already has the destination.
export function rideHint(appId, address) {
  const app = RIDE_APPS[appId];
  if (!app || app.fillsDestination || !address) return "";
  return `Destination copied. Paste it in ${app.name} to book.`;
}

// The line under each ride app in Profile › Connected apps.
export const rideDescription = appId => (RIDE_APPS[appId]?.fillsDestination
  ? "No connection needed. KROFT opens Uber with your destination filled in, and you book there."
  : `No connection needed. KROFT copies your destination and takes you to ${RIDE_APPS[appId]?.name}, where you paste it and book.`);
