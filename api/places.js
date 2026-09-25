// Vercel Edge Function: proxies OpenStreetMap's Nominatim (free-text search + reverse geocoding)
// and Overpass (category/amenity search) APIs for Around Me. Both are free, keyless public
// services, but a browser can't set a custom User-Agent header from fetch() — it's a forbidden
// header name per the Fetch spec, silently overridden by the browser's own UA string — so calling
// them directly from the client can never actually comply with Nominatim's usage policy, which
// asks callers to identify themselves that way. A server-side proxy can set a real one.
//
// This is also where category search (the CATEGORIES grid — "Restaurants", "Pharmacies", etc.)
// moves to Overpass instead of Nominatim: Nominatim's /search is free-text/address geocoding, not
// "find every amenity=X node near here" — passing a category label like "Restaurants" as a q=
// string searches for places literally named or tagged that, not real nearby restaurants, so
// category clicks were returning sparse or empty results independent of the app's earlier
// mock-data issue. Free-text and AI-interpreted search stay on Nominatim, which is what it's
// actually built for.
export const config = { runtime: "edge" };

const USER_AGENT = "Kroft/1.0 (+https://kroft-pied.vercel.app; support@virttechnologies.com)";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Both upstream services are free and keyless, which is exactly why they're not always fast or
// even up: Nominatim enforces a strict 1 req/s per caller, and Overpass's single public instance
// (overpass-api.de) is a well-documented bottleneck that regularly queues, slows to a crawl, or
// drops connections under load — completely independent of anything this app does. A plain
// fetch() with no timeout means a stalled upstream leaves the request hanging until the
// platform's own ceiling, which is a much worse, much slower failure than a clear, fast error.
const TIMEOUT_MS = 9000;
async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Overpass has no equivalent to a load balancer for anonymous callers, but several independent
// community-run instances mirror the same data and accept the same query language — so a second,
// different-operator instance is a real fallback when overpass-api.de itself is the thing having
// a bad day, not just a retry against the same overloaded server.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Maps each Around Me category key to the real OSM tag(s) that identify it. Some categories are
// genuinely more than one tag (there's no single "entertainment" or "transport" amenity in OSM),
// so a category can union several node/way clauses in one Overpass query.
const CATEGORY_TAGS = {
  restaurant: ['node["amenity"="restaurant"]', 'way["amenity"="restaurant"]'],
  hotel: ['node["tourism"="hotel"]', 'way["tourism"="hotel"]'],
  cafe: ['node["amenity"="cafe"]', 'way["amenity"="cafe"]'],
  hospital: ['node["amenity"="hospital"]', 'way["amenity"="hospital"]'],
  pharmacy: ['node["amenity"="pharmacy"]'],
  atm: ['node["amenity"="atm"]'],
  shopping: ['node["shop"]', 'way["shop"]'],
  fuel: ['node["amenity"="fuel"]'],
  entertainment: ['node["amenity"="cinema"]', 'node["amenity"="theatre"]', 'node["leisure"="park"]'],
  transport: ['node["highway"="bus_stop"]', 'node["railway"="station"]', 'node["amenity"="bus_station"]'],
};

// Overpass returns raw OSM elements, not places — a "way" (e.g. a building outline) has no single
// lat/lon of its own, only a computed "center" (requested via `out center` below), and plenty of
// nodes have no name tag at all (a bus stop with no signage, an unnamed shop). Skips anything that
// can't be shown as a real, named place rather than guessing a label for it.
function parseOverpassElement(el) {
  const name = el.tags?.name;
  if (!name) return null;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const address = [el.tags?.["addr:housenumber"], el.tags?.["addr:street"], el.tags?.["addr:city"]].filter(Boolean).join(" ");
  return { id:`${el.type}/${el.id}`, name, address, lat, lng:lon, type:el.tags?.amenity || el.tags?.shop || el.tags?.tourism || "" };
}

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");

  try {
    if (mode === "reverse") {
      const lat = url.searchParams.get("lat"), lon = url.searchParams.get("lon");
      if (!lat || !lon) return jsonResponse({ error: "Missing lat/lon" }, 400);
      let res;
      try {
        res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`, { headers:{ "User-Agent":USER_AGENT } });
      } catch (e) {
        return jsonResponse({ error: e.name === "AbortError" ? "Places service timed out" : "Places service unavailable" }, 504);
      }
      if (!res.ok) return jsonResponse({ error:"Places service unavailable" }, 502);
      return jsonResponse(await res.json());
    }

    if (mode === "search") {
      const q = url.searchParams.get("q"), viewbox = url.searchParams.get("viewbox");
      if (!q) return jsonResponse({ error:"Missing q" }, 400);
      const params = new URLSearchParams({ format:"jsonv2", q, limit:"12" });
      if (viewbox) { params.set("viewbox", viewbox); params.set("bounded", "1"); }
      let res;
      try {
        res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?${params}`, { headers:{ "User-Agent":USER_AGENT } });
      } catch (e) {
        return jsonResponse({ error: e.name === "AbortError" ? "Places service timed out" : "Places service unavailable" }, 504);
      }
      if (!res.ok) return jsonResponse({ error:"Places service unavailable" }, 502);
      return jsonResponse(await res.json());
    }

    if (mode === "category") {
      const category = url.searchParams.get("category");
      const lat = url.searchParams.get("lat"), lon = url.searchParams.get("lon");
      const radius = Math.min(Number(url.searchParams.get("radius")) || 3000, 10000);
      const clauses = CATEGORY_TAGS[category];
      if (!clauses || !lat || !lon) return jsonResponse({ error:"Missing or unknown category, or missing lat/lon" }, 400);
      const query = `[out:json][timeout:8];(${clauses.map(c => `${c}(around:${radius},${lat},${lon});`).join("")});out center 20;`;

      // Try each mirror in turn — a timeout or 5xx from one is exactly the "this instance is
      // having a bad day" case the second mirror exists for, not a reason to give up. A 4xx
      // (bad query) would repeat identically on every mirror, so that alone stops the loop early.
      let lastError = "Places service unavailable";
      for (const endpoint of OVERPASS_ENDPOINTS) {
        let res;
        try {
          res = await fetchWithTimeout(endpoint, {
            method:"POST",
            headers:{ "Content-Type":"application/x-www-form-urlencoded", "User-Agent":USER_AGENT },
            body:`data=${encodeURIComponent(query)}`,
          });
        } catch (e) {
          lastError = e.name === "AbortError" ? "Places service timed out" : "Places service unavailable";
          continue;
        }
        if (res.status >= 400 && res.status < 500) return jsonResponse({ error:"Places service unavailable" }, 502);
        if (!res.ok) { lastError = "Places service unavailable"; continue; }
        const data = await res.json();
        const results = (data.elements || []).map(parseOverpassElement).filter(Boolean).slice(0, 12);
        return jsonResponse({ results });
      }
      return jsonResponse({ error: lastError }, 504);
    }

    return jsonResponse({ error:"Unknown mode" }, 400);
  } catch {
    return jsonResponse({ error:"Couldn't reach the places service." }, 502);
  }
}
