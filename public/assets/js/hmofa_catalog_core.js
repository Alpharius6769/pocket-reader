// ============================================================================
// HMOFA Anthronomicon catalog data layer - VENDORED. Do not hand-edit.
//
// Upstream: Alpharius6769/hmofa-story-index -> src/catalog.js
// Commit:   d4ac04e75638cd2e39d4231ad64d3e0ee23399bf
// SHA-256:  7df1d2880247e5e41dbec92104df012a122f566c882e8674518d6016b57d6411
//
// Pure data: filtering, sorting, species/POV faceting, blacklist themes,
// featured rotation, saved-list validation. It touches no DOM, no storage and
// no network, which is why it ports across unchanged.
//
// Keeping it byte-identical to upstream is the point: the masterlist must
// filter exactly like the live index, and this file stays diffable against it.
// To update, re-copy the upstream file and refresh the commit and hash above.
// Behaviour changes belong upstream, never here.
// ============================================================================
export const WORLDS = Object.freeze(["HMOFA", "ADHG", "Anthrostate"]);
export const SETTINGS = Object.freeze(["Original", "Fanfiction"]);

export const COMMUNITY_SETTINGS = Object.freeze([
  "HMOFA", "ADHG", "Anthrostate", "Daxy"
]);

export const PLACEHOLDER_SETTINGS = Object.freeze([
  "Original", "Unknown", "Unknown Setting", "Unavailable", "Not applicable", "N/A", "None"
]);

export const NON_FANDOM_SETTINGS = Object.freeze([
...COMMUNITY_SETTINGS,...PLACEHOLDER_SETTINGS
]);

export const FANDOM_SETTING_ALIASES = Object.freeze({
  "helluva boss": "Helluva Boss / Hazbin",
  "hazbin hotel": "Helluva Boss / Hazbin",
  "helluva boss / hazbin": "Helluva Boss / Hazbin",
  "helluva boss/hazbin": "Helluva Boss / Hazbin",
  "fnaf": "Five Nights at Freddy's",
  "five nights at freddys": "Five Nights at Freddy's",
  "five nights at freddy's": "Five Nights at Freddy's",
  "world of warcraft": "Warcraft",
  "sonic": "Sonic / Mobius",
  "sonic the hedgehog": "Sonic / Mobius",
  "undertale": "Undertale / Deltarune",
  "deltarune": "Undertale / Deltarune",
  "d&d": "Dungeons & Dragons",
  "dungeons and dragons": "Dungeons & Dragons",
  "dungeons & dragons": "Dungeons & Dragons",
  "iwani": "I Wani Hug that Gator!",
  "i wani hug that gator": "I Wani Hug that Gator!",
  "votv": "Voices of the Void",
  "voices of the void": "Voices of the Void",
  "warhammer 40,000": "Warhammer 40k",
  "warhammer 40000": "Warhammer 40k",
  "wh40k": "Warhammer 40k",
  "warhammer fantasy battle": "Warhammer Fantasy",
  "age of sigmar": "Warhammer Fantasy",
  "whf": "Warhammer Fantasy"
});

export function canonicalFandomSetting(value) {
  const clean = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!clean) return "";
  return FANDOM_SETTING_ALIASES[clean.toLocaleLowerCase("en-US")] ?? clean;
}

export const isFandomSetting = value =>
  Boolean(value) && !NON_FANDOM_SETTINGS.some(x => x.toLowerCase() === canonicalFandomSetting(value).toLowerCase());

export function fanfictionSettingsForRecord(record) {
  const raw = [
...(Array.isArray(record?.fanfictionSettings) ? record.fanfictionSettings : []),
...(Array.isArray(record?.tags)
      ? record.tags.filter(tag => /^Setting:\s*/i.test(tag)).map(tag => tag.replace(/^Setting:\s*/i, ""))
      : [])
  ];
  return [...new Set(raw.map(canonicalFandomSetting).filter(isFandomSetting))];
}

export function formatSetting(record) {
  if (record?.setting === "Original") return "Original";
  const fandoms = fanfictionSettingsForRecord(record);
  if (fandoms.length) return fandoms.join(", ");
  return "Fanfiction";
}
export const RATINGS = Object.freeze(["General", "Teen", "Mature", "Explicit", "Unrated"]);
export const STATUSES = Object.freeze(["Ongoing", "Complete", "Hiatus", "Abandoned", "Unknown"]);
export const ROMANCE_TYPES = Object.freeze(["Gen", "M/F", "Poly", "Other"]);
export const PLATFORMS = Object.freeze(["AO3", "Royal Road", "SoFurry", "FurAffinity", "Wattpad"]);

export const SUBSPECIES_FILTER_MINIMUM = 10;
export const DOMESTIC_SUBSPECIES_FILTER_MINIMUM = 15;
const BREED_FILTER_MINIMUM = 6;
// Empty on purpose: no species is split into subtypes.
//
// A promoted subtype REPLACED its parent bucket for any record whose tags
// matched, so a tag naming a side character took the record out of the bucket a
// reviewer had filed it under. "Rare Mammals" is a lynx story that carried a
// Cheetah tag for a background character and vanished from Medium Wildcats
// entirely; six more were hidden the same way by Arctic Wolf, Arctic Fox and
// Fennec Fox tags, each one overriding an explicit human ruling for the parent.
//
// The machinery below still works. Adding an entry here re-enables a subtype
// filter, but it should not be done while a matching tag can name someone other
// than the partner.
export const SUBSPECIES_FILTERS = Object.freeze([]);

export function subspeciesForRecord(record) {
  const species = Array.isArray(record?.partnerSpecies) ? record.partnerSpecies : [];
  const tags = Array.isArray(record?.tags) ? record.tags.join(" | ") : "";
  return SUBSPECIES_FILTERS
.filter(({ parent, pattern }) => species.includes(parent) && pattern.test(tags))
.map(({ label }) => label);
}

export function popularSubspecies(records, minimum = null) {
  const counts = new Map();
  for (const record of records) {
    for (const label of new Set(subspeciesForRecord(record))) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  const definitionByLabel = new Map(SUBSPECIES_FILTERS.map(definition => [definition.label, definition]));
  return [...counts]
.filter(([label, count]) => {
      if (minimum != null) return count >= minimum;
      const definition = definitionByLabel.get(label);
      if (definition?.minimum != null) return count >= definition.minimum;
      const parent = definition?.parent;
      const threshold = parent === "Dogs (Domestic)" || parent === "Cats (Domestic)"
        ? DOMESTIC_SUBSPECIES_FILTER_MINIMUM
        : SUBSPECIES_FILTER_MINIMUM;
      return count >= threshold;
    })
.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"));
}

export const FILTER_BUCKETS = Object.freeze({
  "African Wild Dog": "Other Wild Canines",
  "Dhole": "Other Wild Canines",
  "Maned Wolf": "Other Wild Canines",
  "Bush Dog": "Other Wild Canines",
  "Coyote": "Other Wild Canines",
  "Jackal": "Other Wild Canines",
  "Dingo": "Other Wild Canines",

  "German Shepherd": "Dogs (Domestic)",
  "Australian Shepherd": "Dogs (Domestic)",
  "Border Collie": "Dogs (Domestic)",

  "Insect": "Insects & Bugs",
  "Insects": "Insects & Bugs",
  "Spider": "Insects & Bugs",
  "Spiders": "Insects & Bugs",

  "Sheep": "Goats & Sheep",
  "Goat": "Goats & Sheep",

  "Rodent": "Rodents",

  "Bat": "Bats",

  "Rabbit": "Rabbits / Bunnies",
  "Rabbits": "Rabbits / Bunnies",

  "Tiger": "Panthera",
  "Lion": "Panthera",

  "Horse": "Horses / Equines",
  "Horses": "Horses / Equines",

  "Marine Mammal": "Aquatics / Marine",
  "Marine Mammals": "Aquatics / Marine"
});

function restrictedFacet(record) {
  const value = typeof record?.facetSpecies === "string" ? record.facetSpecies : "";
  return value && (record?.partnerSpecies ?? []).includes(value) ? value : "";
}

export function fictionalFacetValues(record) {
  const values = [
...(Array.isArray(record?.fictionalSpecies) ? record.fictionalSpecies : []),
...(record?.tags ?? [])
.filter(tag => /^Fictional Species:\s*\S/u.test(tag))
.map(tag => tag.replace(/^Fictional Species:\s*/u, ""))
  ];
  const restricted = restrictedFacet(record);
  if (restricted) return values.includes(restricted) ? [restricted] : [];
  return [...new Set(values)];
}

export function speciesFacetValues(record, promoted = new Set()) {
  const restricted = restrictedFacet(record);
  if (restricted) return [FILTER_BUCKETS[restricted] ?? restricted];
  const childLabels = new Set(subspeciesForRecord(record).filter(label => promoted.has(label)));
  const parentsWithChildren = new Set(
    SUBSPECIES_FILTERS
.filter(({ label }) => childLabels.has(label))
.map(({ parent }) => parent)
  );
  
  const hasFictional = (record?.tags ?? []).some(tag => /^Fictional Species:\s*\S/u.test(tag));

  return [
...new Set((record?.partnerSpecies ?? [])
.filter(species => 
        !parentsWithChildren.has(species) &&
        !(hasFictional && (species === "Unidentified Species" || species === "Unidentified Species: Needs Review"))
      )
.map(species => species === "Unidentified Species: Needs Review" ? "Unidentified Species" : species)
.map(species => FILTER_BUCKETS[species] ?? species)
    ),
...childLabels
  ];
}

export const BLACKLIST_THEMES = Object.freeze({
  "NTR/Cheating": {
    match: [/\bntr\b/iu, /netorare/iu, /cheat(?:ing|s|ed)?\b/iu, /infidelity/iu,
      /adulter(?:y|ous)/iu, /unfaithful/iu],
    deny: [/\bnot\s+cheating\b/iu, /\bnon-?ntr\b/iu, /\bno\s+cheating\b/iu, /\bnever\s+cheat/iu,
      /\banti-?ntr\b/iu, /\bwithout\s+cheating\b/iu]
  },
  "Poly": {
    match: [/\bpolyamor(?:y|ous)\b/iu, /\bpolycules?\b/iu, /\b(?:reverse\s+)?harems?\b/iu,
      /\bmultiple\s+(?:lovers|partners|girlfriends|mates|wives|husbands)\b/iu,
      /\b(?:threesomes?|foursomes?|moresomes?)\b/iu, /\bot[34]\b/iu,
      /\bshared\s+(?:girlfriend|mate|partner)\b/iu],
    deny: [/\bnot\s+(?:a\s+)?(?:poly|harem)\b/iu, /\bno\s+(?:poly|harem)\b/iu,
      /\bmonogam(?:y|ous)\b/iu, /\bit'?s\s+not\s+a\s+harem\b/iu]
  },
  "Cuckolding": {
    match: [/\bcuck(?:s|ing|ed)?\b/iu, /\bcuckold(?:s|ing|ed|ry)?\b/iu, /\bcuckquean(?:s|ing)?\b/iu],
    deny: [/\bno\s+cuck(?:olding)?\b/iu, /\bnot\s+cuck(?:olding)?\b/iu, /\banti-?cuck\b/iu]
  },
  "AI Generated": {
    match: [/\bai[\s-]?generated\s+text\b/iu,
      /\bai[\s-]?(?:generated|written|assisted|authored|slop)\b(?!\s+(?:art(?:work)?|image|images|cover|illustration|picture))/iu,
      /\bgenerated\s+by\s+ai\b/iu, /chat\s?gpt/iu, /\bgpt-?\d/iu, /\bllm\b/iu,
      /machine[\s-]generated/iu, /\bnovelai\b/iu, /\bsudowrite\b/iu],
    deny: [/\bnot\s+ai[\s-]?generated\b/iu, /\bno\s+ai\b/iu, /\bhuman[\s-]written\b/iu,
      /\bwritten\s+by\s+a\s+human\b/iu, /\bai[\s-]free\b/iu]
  },
  "Farts": {
    match: [/\bfarts?\b/iu, /\bfarting\b/iu, /\bflatulen(?:ce|t)\b/iu, /\bgassy\b/iu,
      /\bfart\s?fetish\b/iu, /\beproctophilia\b/iu],
    deny: [/\bno\s+farts?\b/iu, /\bnot\s+fart\b/iu, /\bfart[\s-]free\b/iu]
  },
  "Vomit": {
    match: [/\bvomit(?:s|ing|ed)?\b/iu, /\bpuk(?:e|es|ing|ed)\b/iu, /\bemeto(?:philia)?\b/iu,
      /\bthrow(?:s|ing)?\s+up\b/iu, /\bthrew\s+up\b/iu, /\bregurgitat(?:e|es|ing|ion)\b/iu],
    deny: [/\bno\s+vomit\b/iu, /\bnot\s+vomit\b/iu, /\bno\s+emeto\b/iu]
  },
  "Diapers": {
    match: [/\bdiapers?\b/iu, /\bdiaper\s+play\b/iu],
    deny: [/\bno\s+diapers?\b/iu, /\bnot\s+(?:wearing\s+)?diapers?\b/iu, /\bdiaper[\s-]free\b/iu]
  }
});

export function isBlacklistTheme(theme) {
  return typeof theme === "string" && Object.hasOwn(BLACKLIST_THEMES, theme);
}

export function matchesBlacklistTheme(record, theme) {
  if (!isBlacklistTheme(theme)) return false;
  const rule = BLACKLIST_THEMES[theme];
  if (!rule || !Array.isArray(rule.match) || !Array.isArray(rule.deny)) return false;
  const fields = [record.title ?? "", (record.tags ?? []).join(" ; "), record.summaryExcerpt ?? ""].join(" ; ");
  if (rule.deny.some(pattern => pattern.test(fields))) return false;
  return rule.match.some(pattern => pattern.test(fields));
}

export const SPECIES_SINGULAR = Object.freeze({
  "Aliens": "Alien",
  "Amphibians": "Amphibian",
  "Angel": "Angel",
  "Aquatics / Marine": "Aquatic / Marine",
  "Avians / Birds": "Avian / Bird",
  "Bats": "Bat",
  "Bears": "Bear",
  "Panthera": "Panthera",
  "Medium Wildcats": "Medium Wildcat",
  "Bovines / Cattle": "Bovine / Cattle",
  "Cats (Domestic)": "Cat (Domestic)",
  "Crocodilians / Alligators": "Crocodilian / Alligator",
  "Deer / Cervines": "Deer / Cervine",
  "Dinosaurs": "Dinosaur",
  "Dogs (Domestic)": "Dog (Domestic)",
  "Elephant": "Elephant",
  "Foxes": "Fox",
  "Gargoyle": "Gargoyle",
  "Goats & Sheep": "Goat / Sheep",
  "Horses / Equines": "Horse / Equine",
  "Hyenas": "Hyena",
  "Hybrid Canines": "Hybrid Canine",
  "Insects & Bugs": "Insect / Bug",
  "Kangaroo": "Kangaroo",
  "Kobolds": "Kobold",
  "Mustelids": "Mustelid",
  "Opossum": "Opossum",
  "Other Wild Canines": "Other Wild Canine",
  "Other Canines": "Other Canine",
  "Pig": "Pig",
  "Pig / Boar": "Pig / Boar",
  "Prehistoric Mammals": "Prehistoric Mammal",
  "Primates": "Primate",
  "Rabbits / Bunnies": "Rabbit / Bunny",
  "Raccoon": "Raccoon",
  "Reptiles": "Reptile",
  "Rodents": "Rodent",
  "Sharks": "Shark",
  "Turtle": "Turtle",
  "Wolves": "Wolf",
  "Xenarthra / Pholidota": "Xenarthra / Pholidota",

  "Dragons": "Dragon",
  "Monsters / Paranormal": "Monster / Paranormal",
  "Demons": "Demon",
  "Werewolves": "Werewolf",
  "Arirals": "Ariral",
  "Ariral": "Ariral",
  "Daxy": "Daxy",
  "Deathclaws": "Deathclaw",
  "Protogen": "Protogen",
  "Protogens": "Protogen",
  "Pokémon": "Pokémon",
  "Pokemon": "Pokémon",
  "SCP Anomalies": "SCP Anomaly",
  "SCP Anomaly": "SCP Anomaly",
  "Mobian": "Mobian",
  "Wendigos": "Wendigo / Wechuge",
  "Wendigo": "Wendigo / Wechuge",
  "Wendigo / Wechuge": "Wendigo / Wechuge",
  "Sergals": "Sergal",
  "Sergal": "Sergal"
});

export function formatPartnerSpecies(record) {
  let species = Array.isArray(record?.partnerSpecies) ? record.partnerSpecies.filter(Boolean) : [];
  
  const fictional = (record?.tags ?? [])
.filter(tag => /^Fictional Species:\s*\S/u.test(tag))
.map(tag => tag.replace(/^Fictional Species:\s*/u, ""));
    
  if (fictional.length) {
    species = species.filter(s => s !== "Unidentified Species" && s !== "Unidentified Species: Needs Review");
    species.push(...fictional);
  }

  species = species.map(s => s === "Unidentified Species: Needs Review" ? "Unidentified Species" : s);
  species = [...new Set(species)];

  if (!species.length) return "Unknown";
  const several = species.length > 1 || Boolean(record.castStructure);
  if (several) return species.join(", ");
  return SPECIES_SINGULAR[species[0]] ?? species[0];
}

export const ACCOUNT_WALLED_PLATFORMS = Object.freeze(["SoFurry", "FurAffinity"]);

const RATINGS_BELOW_WALL = Object.freeze(["General", "Teen"]);

export function requiresAccountGate(record, source) {
  if (!source || !ACCOUNT_WALLED_PLATFORMS.includes(source.platform)) return false;
  return !RATINGS_BELOW_WALL.includes(record?.rating);
}

export function normalizeString(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

export function safeJsonParse(raw, fallback, maxLength = 2_000_000) {
  if (typeof raw !== "string" || raw.length > maxLength) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function applyLiveMetadata(record, overlay) {
  if (!record || !overlay || typeof overlay !== "object") return record;

  const liveFields = [];
  const merged = {...record };

  const wordCount = Number(overlay.wordCount);
  if (Number.isFinite(wordCount) && wordCount > 0 && wordCount > (record.wordCount ?? 0)) {
    merged.wordCount = Math.round(wordCount);
    liveFields.push("wordCount");
  }

  if (typeof overlay.status === "string" && STATUSES.includes(overlay.status)
    && overlay.status !== record.status) {
    merged.status = overlay.status;
    liveFields.push("status");
  }

  if (typeof overlay.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(overlay.updatedAt)
    && new Date(`${overlay.updatedAt}T00:00:00.000Z`).toISOString().slice(0, 10) === overlay.updatedAt
    && (!record.updatedAt || overlay.updatedAt > record.updatedAt)) {
    merged.updatedAt = overlay.updatedAt;
    liveFields.push("updatedAt");
  }

  if (!liveFields.length) return record;
  merged.liveFields = liveFields;
  merged.liveRefreshedAt = typeof overlay.refreshedAt === "string" ? overlay.refreshedAt : null;
  return merged;
}

export function applyLiveMetadataAll(records, overlays) {
  if (!overlays || typeof overlays !== "object") return records;
  return records.map(record => applyLiveMetadata(record, overlays[record.id]));
}

export function formatWords(value) {
  return value === null ? "Unavailable" : Number(value).toLocaleString("en-US");
}

export function formatDate(value) {
  if (!value) return "Unavailable";
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(date);
}

export function legacyBase64Encode(value) {
  const binary = encodeURIComponent(value).replace(/%([0-9A-F]{2})/gu, (_, byte) =>
    String.fromCharCode(Number.parseInt(byte, 16))
  );
  return btoa(binary);
}

export function legacyBase64Decode(value) {
  if (typeof value !== "string" || value.length > 200_000 || !/^[A-Za-z0-9+/=_-]+$/u.test(value)) {
    throw new Error("Invalid shared-list payload");
  }
  const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(standard);
  const encoded = [...binary].map(character =>
    `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`
  ).join("");
  return decodeURIComponent(encoded);
}

export const POV_VALUES = Object.freeze([
  "1st Person POV", "2nd Person POV", "3rd Person POV", "Mixed POV", "Greentext"
]);
export const MIN_RATINGS = Object.freeze(["any", "4.5", "4.0", "3.5"]);

export const SORT_VALUES = Object.freeze([
  "title-asc", "author-asc", "updated-desc", "words-desc", "rating-desc"
]);
export const DEFAULT_SORT = "updated-desc";

const POV_TAG_PATTERNS = Object.freeze({
  "1st Person POV": /\b(?:first[\s-]person|1st[\s-]person|pov\s+first)\b/i,
  "2nd Person POV": /\b(?:second[\s-]person|2nd[\s-]person|pov\s+second)\b/i,
  "3rd Person POV": /\b(?:third[\s-]person|3rd[\s-]person|pov\s+third)\b/i,
  "Mixed POV": /\b(?:mixed|alternating|multiple|switching)[\s-]pov\b|\bpov:?\s*mixed\b|\bmultiple\s+pov\b/i,
  Greentext: /\bgreen[\s-]?text\b/i
});

const POV_STYLE_FACETS = Object.freeze({
  "First-person": "1st Person POV",
  "Second-person": "2nd Person POV",
  "Third-person limited": "3rd Person POV",
  "Third-person omniscient": "3rd Person POV",
  "Greentext style": "Greentext",
  "Mixed POV": "Mixed POV"
});

export function povsForRecord(record) {
  // The author's own keywords count too. They are stored apart from `tags` so
  // our generated labels cannot certify our own scope, but for POV the author
  // saying "First Person" or "Greentext" is the authoritative signal, and 14
  // records were carrying one that nothing read.
  const keywords = Object.values(record?.sourceKeywords ?? {}).flat();
  const haystack = [...(record.tags ?? []), ...keywords].join(" | ");
  const facets = new Set(POV_VALUES.filter(value => POV_TAG_PATTERNS[value].test(haystack)));
  const style = record?.pov?.style;
  if (style && Object.hasOwn(POV_STYLE_FACETS, style)) facets.add(POV_STYLE_FACETS[style]);
  return POV_VALUES.filter(value => facets.has(value));
}

export function meetsMinimumRating(record, minRating, communityRatings = {}) {
  if (!minRating || minRating === "any") return true;
  const threshold = Number(minRating);
  if (!Number.isFinite(threshold)) return true;
  const summary = communityRatings[record.id];
  if (!summary || !Number(summary.total)) return false;
  return (Number(summary.average) || 0) >= threshold;
}

export function normalizeFilterObject(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const allowed = {
    world: new Set(WORLDS),
    setting: new Set(SETTINGS),
    worldSetting: new Set(SETTINGS),
    rating: new Set(RATINGS),
    status: new Set(STATUSES),
    romance: new Set(ROMANCE_TYPES),
    species: null,
    subspecies: null,
    platform: new Set(PLATFORMS),
    pov: new Set(POV_VALUES)
  };
  const result = {
    search: normalizeString(source.search, 200),
    wordCount: ["all", "under-10k", "10k-50k", "50k-100k", "100k-250k", "250k-plus"].includes(source.wordCount)
      ? source.wordCount
      : "all",
    minRating: MIN_RATINGS.includes(source.minRating) ? source.minRating : "any"
  };
  for (const [key, accepted] of Object.entries(allowed)) {
    const sourceKey = key === "setting" && !Array.isArray(source.setting) ? "worldSetting" : key;
    const values = Array.isArray(source[sourceKey]) ? source[sourceKey] : [];
    result[key] = [...new Set(values
.map(item => normalizeString(item, 80))
.map(item => key === "setting" ? canonicalFandomSetting(item) : item)
.filter(item => item && (key === "setting"
        ? SETTINGS.includes(item) || isFandomSetting(item)
        : !accepted || accepted.has(item))))];
  }
  delete result.worldSetting;
  return result;
}

export function validateSavedList(value, knownIds = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = normalizeString(value.name, 80);
  if (!name || !["preset", "ids"].includes(value.type)) return null;
  if (value.type === "preset") {
    return { type: "preset", name, filters: normalizeFilterObject(value.filters) };
  }
  if (!Array.isArray(value.ids)) return null;
  const ids = [...new Set(value.ids
.map(item => normalizeString(item, 128))
.filter(item => item && (!knownIds || knownIds.has(item))))
  ].slice(0, 150);
  return ids.length ? { type: "ids", name, ids } : null;
}

export function deduplicateLists(values, knownIds = null) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const list = validateSavedList(raw, knownIds);
    if (!list) continue;
    const fingerprint = JSON.stringify(list);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(list);
  }
  return result.slice(0, 100);
}

export function normalizeRatings(value, knownIds = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [rawId, rawScore] of Object.entries(value)) {
    const id = normalizeString(rawId, 128);
    const score = Number(rawScore);
    if (!id || !Number.isInteger(score) || score < 1 || score > 5 || knownIds && !knownIds.has(id)) continue;
    result[id] = score;
  }
  return result;
}

export function mergeBackup({ currentLists, currentRatings, imported, knownIds }) {
  const legacyLists = imported?.lists;
  const legacyRatings = imported?.ratings;
  const storage = imported?.storage && typeof imported.storage === "object" ? imported.storage : {};
  const importedLists = storage.hmofa_saved_lists_v1 ?? legacyLists ?? [];
  const importedRatings = storage.hmofa_user_ratings_v2 ?? legacyRatings ?? {};
  return {
    lists: deduplicateLists([...deduplicateLists(currentLists, knownIds),...deduplicateLists(importedLists, knownIds)], knownIds),
    ratings: {
...normalizeRatings(currentRatings, knownIds),
...normalizeRatings(importedRatings, knownIds)
    }
  };
}

function inWordBucket(wordCount, bucket) {
  if (bucket === "all") return true;
  if (wordCount === null) return false;
  if (bucket === "under-10k") return wordCount < 10_000;
  if (bucket === "10k-50k") return wordCount >= 10_000 && wordCount < 50_000;
  if (bucket === "50k-100k") return wordCount >= 50_000 && wordCount < 100_000;
  if (bucket === "100k-250k") return wordCount >= 100_000 && wordCount < 250_000;
  return wordCount >= 250_000;
}

function containsAny(values, selected) {
  return !selected.size || values.some(value => selected.has(value));
}

/**
 * Match a free-text blacklist term as a WORD, not a substring.
 *
 * A plain `haystack.includes(needle)` hid stories that had nothing to do with
 * the term. Measured against this catalogue, 191 matches were wrong:
 *
 *   Anon  -> canon (80 records), stronganon, anonymous
 *   Vore  -> carnivores, herbivores, favored
 *   Micro -> the author name micro101
 *   Hyper -> "all mammals evolved to be hyperintelligent"
 *   Scat  -> scattered, geniuscatvillain
 *   Futa  -> futavirus, futapartment
 *
 * A reader who blocks "Anon" loses every story tagged Canon Divergence, which
 * is the opposite of what they asked for. Hiding a wanted story is worse than
 * missing an unwanted one, so this errs toward precision.
 *
 * A trailing plural is still matched in both directions -- "Diaper" finds
 * "Diapers" and vice versa -- because that is the same word, not a different
 * one. Anything longer ("yiff" vs "yiffing") needs its own entry.
 */
const BLACKLIST_PATTERNS = new Map();
export function blacklistWordPattern(needle) {
  const cached = BLACKLIST_PATTERNS.get(needle);
  if (cached) return cached;
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // Strip a trailing plural so the stored term and the text can differ by one.
  // "ss" is left alone: stemming "loss" to "los" would match nothing sensible.
  let stem = needle;
  if (/[^s]es$/u.test(stem) && stem.length > 4) stem = stem.slice(0, -2);
  else if (/[^s]s$/u.test(stem) && stem.length > 3) stem = stem.slice(0, -1);
  // \b only behaves next to a word character. A term like "m/f" or "(x)" gets
  // an anchor only on the sides that have one, so it still matches.
  const open = /^\w/u.test(stem) ? "\\b" : "";
  const close = /\w$/u.test(stem) ? "(?:e?s)?\\b" : "";
  const pattern = new RegExp(`${open}${escape(stem)}${close}`, "iu");
  BLACKLIST_PATTERNS.set(needle, pattern);
  return pattern;
}

export function passesPreferences(record, preferences) {
  if (!preferences || typeof preferences !== "object") return true;
  const ratingMode = preferences.rating;
  const adult = record.rating === "Mature" || record.rating === "Explicit";
  if (ratingMode === "sfw" && adult) return false;
  if (ratingMode === "nsfw" && !adult) return false;
  const fandoms = Array.isArray(preferences.fandoms) ? preferences.fandoms : [];
  if (fandoms.length && !record.worlds.some(world => fandoms.includes(world))) return false;
  const blacklist = Array.isArray(preferences.blacklist) ? preferences.blacklist : [];
  if (blacklist.length) {
    const haystack = `${record.title} ${record.authors.join(" ")} ${record.tags.join(" ")} ${record.summaryExcerpt ?? ""}`.toLocaleLowerCase("en-US");
    if (blacklist.some(item => {
      if (isBlacklistTheme(item)) return matchesBlacklistTheme(record, item);
      const needle = normalizeString(item, 160).toLocaleLowerCase("en-US");
      return Boolean(needle) && blacklistWordPattern(needle).test(haystack);
    })) return false;
  }
  const blacklistedPOVs = Array.isArray(preferences.blacklistedPOVs) ? preferences.blacklistedPOVs : [];
  if (blacklistedPOVs.length) {
    const publicTags = record.tags.map(tag => normalizeString(tag, 160).toLocaleLowerCase("en-US"));
    if (blacklistedPOVs.some(value => {
      const needle = normalizeString(value, 80).toLocaleLowerCase("en-US");
      return needle && publicTags.some(tag => tag === needle || tag.includes(needle));
    })) return false;
  }
  if (preferences.blockTagSpam) {
    const relationshipTags = record.tags.filter(tag => tag.includes("/") || tag.includes("&")).length;
    if (record.tags.length > 35 || relationshipTags > 15) return false;
  }
  if (preferences.blockAnon) {
    if (record.protagonist && typeof record.protagonist.isAnon === "boolean") {
      if (record.protagonist.isAnon) return false;
    } else {
      const haystack = `${record.title} ${record.tags.join(" ")} ${record.summaryExcerpt ?? ""}`;
      if (/\banon(?:ymous)?(?:\s+as\s+a\s+character)?\b/iu.test(haystack)) return false;
    }
  }
  return true;
}

export function filterCatalog(records, state, preferences, communityRatings = {}) {
  const query = normalizeString(state.search, 200).toLocaleLowerCase("en-US");
  const promotedSubspecies = new Set(popularSubspecies(records).map(([label]) => label));
  return records.filter(record => {
    if (!meetsMinimumRating(record, state.minRating, communityRatings)) return false;
    if (state.pov?.size && !povsForRecord(record).some(value => state.pov.has(value))) return false;
    if (!passesPreferences(record, preferences)) return false;
    if (state.customIds && !state.customIds.has(record.id) && !record.aliases.some(alias => state.customIds.has(alias))) return false;
    if (!containsAny(record.worlds, state.world)) return false;
    if (state.setting.size) {
      const matchesSetting = state.setting.has(record.setting) ||
        fanfictionSettingsForRecord(record).some(setting => state.setting.has(setting));
      if (!matchesSetting) return false;
    }
    if (state.rating.size && !state.rating.has(record.rating)) return false;
    if (state.status.size && !state.status.has(record.status)) return false;
    if (state.romance.size && !state.romance.has(record.romanceType)) return false;
    if (state.species.size) {
      const matchesSpecies = speciesFacetValues(record, promotedSubspecies).some(s => state.species.has(s)) ||
        fictionalFacetValues(record).some(value => state.species.has(value));
      if (!matchesSpecies) return false;
    }
    if (state.subspecies?.size && !subspeciesForRecord(record).some(value => state.subspecies.has(value))) return false;
    if (state.platform.size && !record.sources.some(source => state.platform.has(source.platform))) return false;
    if (!inWordBucket(record.wordCount, state.wordCount)) return false;
    if (query) {
      const haystack = [
        record.title,
...record.authors,
...record.worlds,
...record.partnerSpecies,
...(record.fictionalSpecies ?? []),
...(record.fanfictionSettings ?? []),
...record.tags
      ].join(" ").toLocaleLowerCase("en-US");
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function sortCatalog(records, sort, communityRatings = {}) {
  const copy = [...records];
  const title = (a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);
  if (sort === "author-asc") {
    const author = record => (record.authors?.[0] ?? "").toLocaleLowerCase("en-US");
    return copy.sort((a, b) => author(a).localeCompare(author(b), "en", { sensitivity: "base" }) || title(a, b));
  }
  if (sort === "updated-desc") {
    return copy.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || title(a, b));
  }
  if (sort === "words-desc") {
    return copy.sort((a, b) => (b.wordCount ?? -1) - (a.wordCount ?? -1) || title(a, b));
  }
  if (sort === "rating-desc") {
    return copy.sort((a, b) => {
      const left = communityRatings[a.id] ?? {};
      const right = communityRatings[b.id] ?? {};
      return (Number(right.average) || 0) - (Number(left.average) || 0)
        || (Number(right.total) || 0) - (Number(left.total) || 0)
        || title(a, b);
    });
  }
  return copy.sort(title);
}

export const FEATURED_COOLDOWN_PERIODS = 3;

export function getFeaturedPeriod(now = Date.now()) {
  const moment = new Date(now);
  return moment.getUTCFullYear() * 12 + moment.getUTCMonth();
}

export function getFeaturedStories(records, communityRatings = {}, excludedIds = new Set(), options = {}) {
  const {
    trending = [],
    period = getFeaturedPeriod(),
    cooldownPeriods = FEATURED_COOLDOWN_PERIODS,
    perWorld = 5
  } = options;

  const excludedSet = excludedIds instanceof Set ? excludedIds : new Set(excludedIds);
  const settings = { trending, perWorld };

  const cycle = Math.max(1, cooldownPeriods + 1);
  const bucket = ((period % cycle) + cycle) % cycle;
  const eligible = records.filter(record => stableBucket(record.id, cycle) === bucket);

  const result = periodSelection(eligible, communityRatings, excludedSet, {...settings, period });
  const target = WORLDS.length * perWorld;
  if (result.length >= target) return result;

  const pool = [...eligible];
  const seen = new Set(eligible.map(record => record.id));
  let best = result;

  for (let age = cycle - 1; age >= 1; age -= 1) {
    const older = ((bucket - age) % cycle + cycle) % cycle;
    for (const record of records) {
      if (seen.has(record.id)) continue;
      if (stableBucket(record.id, cycle) !== older) continue;
      seen.add(record.id);
      pool.push(record);
    }
    const filled = periodSelection(pool, communityRatings, excludedSet, {...settings, period });
    if (filled.length > best.length) best = filled;
    if (best.length >= target) break;
  }

  return best;
}

function stableBucket(id, cycle) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % cycle;
}

function periodSelection(records, communityRatings, excludedIds, options) {
  const { trending = [], period, perWorld = 5 } = options;
  const excludedSet = excludedIds instanceof Set ? excludedIds : new Set(excludedIds);

  const clickRank = new Map();
  trending.forEach((id, index) => {
    if (!clickRank.has(id)) clickRank.set(id, index);
  });

  const score = record => {
    const rating = communityRatings[record.id] ?? {};
    const avg = Number(rating.average) || 0;
    const count = Number(rating.total) || 0;
    const wordScore = Math.min((record.wordCount || 0) / 100_000, 2);
    const rank = clickRank.get(record.id);
    const clicks = rank === undefined ? 0 : 3 * (1 - Math.min(rank, 250) / 250);
    return (avg * 2) + Math.min(count, 10) + wordScore + clicks;
  };

  const result = [];
  const selectedIds = new Set();
  const sorted = [...records].sort((a, b) => score(b) - score(a) || a.title.localeCompare(b.title));

  for (const world of WORLDS) {
    const pool = sorted.filter(r => r.worlds.includes(world) && !excludedSet.has(r.id) && !selectedIds.has(r.id));
    if (!pool.length) continue;
    for (let i = 0; i < perWorld && i < pool.length; i += 1) {
      const record = pool[i];
      if (selectedIds.has(record.id)) continue;
      selectedIds.add(record.id);
      result.push(record.id);
    }
  }
  return result;
}

export function validateHttpUrl(value, platform = null) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) return null;
  if (platform) {
    const hosts = {
      AO3: ["archiveofourown.org"],
      "Royal Road": ["royalroad.com"],
      SoFurry: ["sofurry.com"],
      FurAffinity: ["furaffinity.net"],
      Wattpad: ["wattpad.com"]
    };
    if (!hosts[platform]?.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
  }
  return url.toString();
}
