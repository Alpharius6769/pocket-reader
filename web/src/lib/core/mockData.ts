/**
 * Fake content for the mock bridge. Every title, author and line of prose here
 * is invented placeholder text for design review; none of it is a real work.
 */
import type {
  Achievement,
  Ao3Result,
  CatalogEntry,
  CatalogFacet,
  Chapter,
  LibraryEntry,
  Story,
  StorySummary,
} from './bridge';

const PROSE = [
  'The lamp in the window of the ferry house had been burning for three nights when Wren finally knocked.',
  'Nobody answered at first. The wind off the estuary carried salt and the low complaint of moored boats, and somewhere past the reeds a bell rang twice and stopped.',
  '"You are late," said the voice behind the door, as though the visit had been arranged weeks ago and she had merely mislaid the hour.',
  'Inside, the room was warmer than it had any right to be. Maps covered the table, weighted at the corners with teacups, a brass compass and one very old boot.',
  'Marrow sat in the only good chair, ears turned toward the fire, tail curled over her feet like a scarf she had forgotten she was wearing.',
  '"I came about the crossing," Wren said. "They told me you were the only one who still makes it after the tide turns."',
  '"They tell a lot of stories in the village." Marrow did not look up from the map. "Most of them are about me, and most of them are wrong in the interesting places."',
  'The kettle began to sing. Neither of them moved to take it off the hook, and for a while the only conversation in the room belonged to the water.',
  'When Marrow finally stood, she was taller than Wren had expected, and she moved the way people move when they have spent a long time on decks that do not hold still.',
  '"Sit," she said. "Drink something. Then tell me what is waiting on the other side that cannot wait until morning."',
  'Wren told her. It took longer than it should have, because some parts of the truth are heavy and have to be set down carefully or they break.',
  'At the end of it Marrow was quiet for so long that the fire settled twice. Then she reached for the boot on the map and turned it, very slowly, until its toe pointed north.',
  '"Then we leave at the second bell," she said. "Bring nothing you would mind losing to the river."',
  'Outside, the fog had come in thick and white, swallowing the lamp-post at the end of the jetty and then the jetty itself.',
  'The boat was smaller than Wren had pictured, painted the colour of a robin\'s breast and patched in so many places that the patches had patches.',
  '"She floats," Marrow said, noticing the look. "That is the only promise a boat ever needs to keep."',
  'They pushed off without a word. The oars made a sound like someone turning the pages of a heavy book, and the shore went soft and then went away entirely.',
  'Halfway across, the bell rang again, closer now, and this time it did not stop at two.',
];

function makeChapters(count: number, seed: number, titles?: string[]): Chapter[] {
  return Array.from({ length: count }, (_, c) => {
    const len = 10 + ((seed + c * 7) % 9);
    const paragraphs = Array.from({ length: len }, (_, p) => PROSE[(seed * 3 + c * 5 + p) % PROSE.length]);
    return { title: titles?.[c] ?? `Chapter ${c + 1}`, paragraphs };
  });
}

interface Seed {
  summary: StorySummary;
  chapterTitles?: string[];
  entry?: Partial<Omit<LibraryEntry, 'story'>>;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = Date.now();

const SEEDS: Seed[] = [
  {
    summary: {
      key: 'mock-ferry-house',
      title: 'The Ferry House at Low Tide',
      author: 'Placeholder Author',
      source: 'ao3',
      url: 'https://archiveofourown.org/works/0000001',
      synopsis:
        'A ferrywoman who only crosses after dark, a traveller with a debt to pay on the far bank, and a river that remembers everyone who has ever tried to cheat it.',
      fandoms: ['Original Work'],
      tags: ['Slow Burn', 'Found Family', 'Rivers', 'Fog'],
      rating: 'Teen',
      words: 84210,
      chapterCount: 14,
      complete: false,
    },
    chapterTitles: [
      'The Lamp in the Window',
      'Second Bell',
      'What the River Keeps',
      'Patchwork',
      'Salt and Iron',
      'The Far Bank',
      'A Debt in Copper',
      'Fog Country',
      'The Lantern Fair',
      'Undertow',
      'Marrow, Awake',
      'Low Water',
      'The Crossing Back',
      'Morning, Finally',
    ],
    entry: { position: { chapter: 6, paragraph: 4 }, progress: 0.44, lastOpenedAt: now - 2 * HOUR, favourite: true, rating: 5, cache: { state: 'complete', done: 214, total: 214 }, subscribed: true, hasUpdate: true },
  },
  {
    summary: {
      key: 'mock-lighthouse',
      title: 'Letters to the Lighthouse Keeper',
      author: 'Sample Writer',
      source: 'hmofa',
      synopsis: 'Forty-one letters, one lighthouse, and a keeper who has stopped answering.',
      tags: ['Epistolary', 'Slice of Life'],
      rating: 'General',
      words: 32800,
      chapterCount: 9,
      complete: true,
    },
    entry: { position: { chapter: 2, paragraph: 0 }, progress: 0.22, lastOpenedAt: now - 1 * DAY, cache: { state: 'partial', done: 40, total: 128 } },
  },
  {
    summary: {
      key: 'mock-orchard',
      title: 'An Orchard of Small Hours',
      author: 'Example Pen',
      source: 'ao3',
      url: 'https://archiveofourown.org/works/0000002',
      synopsis: 'Every night at 3 a.m. the orchard rearranges itself. Only one of the pickers has noticed.',
      fandoms: ['Original Work'],
      tags: ['Magical Realism', 'Mystery'],
      rating: 'Teen',
      words: 51200,
      chapterCount: 11,
      complete: true,
    },
    entry: { position: { chapter: 10, paragraph: 12 }, progress: 1, finished: true, lastOpenedAt: now - 4 * DAY, rating: 4 },
  },
  {
    summary: {
      key: 'mock-copper-wolves',
      title: 'Copper Wolves',
      author: 'Placeholder Author',
      source: 'hmofa',
      synopsis: 'The mountain pass is closed for winter. The wolves who run the toll gate have other ideas.',
      tags: ['Adventure', 'Winter'],
      rating: 'Mature',
      words: 126400,
      chapterCount: 22,
      complete: false,
    },
    entry: { position: { chapter: 0, paragraph: 0 }, progress: 0, lastOpenedAt: undefined, favourite: true, subscribed: true },
  },
  {
    summary: {
      key: 'mock-tea-shop',
      title: 'The Tea Shop on Nettle Street',
      author: 'Sample Writer',
      source: 'upload',
      synopsis: 'A cosy story about a shop that only opens when it rains.',
      tags: ['Cosy', 'Romance'],
      words: 18900,
      chapterCount: 5,
      complete: true,
    },
    entry: { position: { chapter: 3, paragraph: 8 }, progress: 0.7, lastOpenedAt: now - 6 * DAY },
  },
  {
    summary: {
      key: 'mock-starlings',
      title: 'Where the Starlings Go',
      author: 'Demo Author',
      source: 'ao3',
      url: 'https://archiveofourown.org/works/0000003',
      synopsis: 'Two cartographers, one map of a city that keeps moving, and a deadline neither of them can afford to miss.',
      fandoms: ['Original Work'],
      tags: ['Rivals to Friends', 'City Fantasy'],
      rating: 'Teen',
      words: 67000,
      chapterCount: 16,
      complete: false,
    },
    entry: { position: { chapter: 1, paragraph: 3 }, progress: 0.08, lastOpenedAt: now - 9 * DAY, rating: 3 },
  },
  {
    summary: {
      key: 'mock-winter-garden',
      title: 'Winter Garden',
      author: 'Example Pen',
      source: 'hmofa',
      synopsis: 'A greenhouse at the edge of the world, and the one gardener who stayed behind.',
      tags: ['Quiet', 'Hurt/Comfort'],
      rating: 'General',
      words: 9400,
      chapterCount: 3,
      complete: true,
    },
    entry: { position: { chapter: 0, paragraph: 0 }, progress: 0 },
  },
  {
    summary: {
      key: 'mock-glass-road',
      title: 'The Glass Road',
      author: 'Demo Author',
      source: 'url',
      url: 'https://example.com/stories/glass-road',
      synopsis: 'A desert caravan, a broken compass, and a road that only appears under a full moon.',
      tags: ['Travel', 'Adventure'],
      words: 41500,
      chapterCount: 8,
      complete: true,
    },
    entry: { position: { chapter: 4, paragraph: 0 }, progress: 0.5, lastOpenedAt: now - 15 * DAY, cache: { state: 'complete', done: 110, total: 110 } },
  },
];

export function buildStories(): Map<string, Story> {
  const map = new Map<string, Story>();
  SEEDS.forEach((s, i) => {
    map.set(s.summary.key, { ...s.summary, chapters: makeChapters(s.summary.chapterCount, i + 1, s.chapterTitles) });
  });
  return map;
}

export function buildLibrary(): LibraryEntry[] {
  return SEEDS.map((s, i) => ({
    story: s.summary,
    addedAt: now - (30 - i) * DAY,
    position: { chapter: 0, paragraph: 0 },
    progress: 0,
    finished: false,
    favourite: false,
    rating: 0,
    cache: { state: 'none', done: 0, total: 0 },
    hasUpdate: false,
    subscribed: false,
    bookmarks:
      i === 0
        ? [
            { id: 'bm-1', storyKey: s.summary.key, chapter: 1, paragraph: 4, excerpt: PROSE[4].slice(0, 100), createdAt: now - 3 * DAY },
            { id: 'bm-2', storyKey: s.summary.key, chapter: 5, paragraph: 11, excerpt: PROSE[11].slice(0, 100), label: 'The boot points north', createdAt: now - 1 * DAY },
          ]
        : [],
    ...s.entry,
  }));
}

const FANDOMS = ['Original Work', 'Original Work', 'Placeholder Fandom', 'Sample Universe'];
const AO3_TITLES = [
  'A Map of Quiet Places',
  'The Clockmaker\'s Apprentice',
  'Small Gods of the Hedgerow',
  'Ninety Days of Rain',
  'The Last Train to Elsewhere',
  'Ink & Ember',
  'Under the Salt Moon',
  'A Field Guide to Leaving',
  'Moth Season',
  'The Borrowed Lantern',
  'Paper Boats',
  'What the Snow Remembers',
];

export function ao3Results(query: string, page: number): Ao3Result[] {
  const base = (page - 1) * 6;
  return Array.from({ length: 6 }, (_, i) => {
    const n = base + i;
    const title = AO3_TITLES[n % AO3_TITLES.length];
    return {
      key: `ao3-mock-${n}`,
      title,
      author: ['Placeholder Author', 'Sample Writer', 'Example Pen', 'Demo Author'][n % 4],
      source: 'ao3' as const,
      url: `https://archiveofourown.org/works/${1000000 + n}`,
      synopsis: query
        ? `Placeholder summary for a search on “${query}”. ${PROSE[n % PROSE.length]}`
        : `Placeholder summary. ${PROSE[n % PROSE.length]}`,
      fandoms: [FANDOMS[n % FANDOMS.length]],
      tags: [['Slow Burn', 'Fluff'], ['Angst', 'Hurt/Comfort'], ['Adventure'], ['Found Family', 'Humor']][n % 4],
      rating: (['General', 'Teen', 'Mature', 'Teen'] as const)[n % 4],
      words: 4000 + ((n * 7919) % 120000),
      chapterCount: 1 + ((n * 13) % 30),
      complete: n % 3 !== 0,
      updated: `2026-${String(1 + (n % 11)).padStart(2, '0')}-${String(3 + (n % 25)).padStart(2, '0')}`,
      kudos: 120 + ((n * 431) % 9000),
    };
  });
}

const SPECIES = ['Fox', 'Wolf', 'Dragon', 'Cat', 'Rabbit', 'Deer', 'Otter'];
const CATALOG_TITLES = [
  'Den of Lanterns',
  'The Ranger\'s Promise',
  'Embers Over Anthrostate',
  'A Quiet Burrow',
  'Scale and Sinew',
  'Field Notes from the Border',
  'The Otter Who Kept Time',
  'Night Market',
  'Antler Crown',
  'Stray Signal',
  'Copper Wolves',
  'Moonlit Hollow',
  'Second Winter',
  'The Long Way Home',
  'River Folk',
  'Cinder & Pine',
];

export function catalogEntries(): CatalogEntry[] {
  return CATALOG_TITLES.map((title, n) => ({
    key: `hmofa-mock-${n}`,
    id: `hmofa-${n}`,
    title,
    author: ['Placeholder Author', 'Sample Writer', 'Example Pen', 'Demo Author'][n % 4],
    source: 'hmofa' as const,
    synopsis: PROSE[(n * 5) % PROSE.length],
    world: [(['HMOFA', 'ADHG', 'Anthrostate'] as const)[n % 3]],
    species: [SPECIES[n % SPECIES.length]],
    rating: (['General', 'Teen', 'Mature', 'Explicit'] as const)[n % 4],
    status: (['Complete', 'Ongoing', 'Complete', 'Hiatus'] as const)[n % 4],
    romance: (['M/F', 'Gen', 'M/F', 'Poly'] as const)[n % 4],
    platforms: [['AO3'], ['Royal Road'], ['AO3', 'SoFurry'], ['Wattpad']][n % 4],
    words: 6000 + ((n * 15485) % 260000),
    chapterCount: 1 + ((n * 7) % 40),
    tags: [['Romance'], ['Adventure', 'Slow Burn'], ['Slice of Life'], ['Drama']][n % 4],
    updatedAt: `2026-${String(1 + (n % 11)).padStart(2, '0')}-14`,
    communityRating: n % 5 === 0 ? undefined : 3 + ((n * 3) % 20) / 10,
  }));
}

export function catalogFacets(entries: CatalogEntry[]): CatalogFacet[] {
  const count = (pick: (e: CatalogEntry) => string[]) => {
    const m = new Map<string, number>();
    entries.forEach((e) => pick(e).forEach((v) => m.set(v, (m.get(v) ?? 0) + 1)));
    return [...m.entries()].map(([value, count]) => ({ value, count }));
  };
  return [
    { key: 'world', label: 'World', values: count((e) => e.world) },
    { key: 'species', label: 'Species', values: count((e) => e.species) },
    { key: 'rating', label: 'Rating', values: count((e) => (e.rating ? [e.rating] : [])) },
    { key: 'status', label: 'Status', values: count((e) => [e.status]) },
    {
      key: 'length',
      label: 'Length',
      values: [
        { value: 'under-10k', count: 0 },
        { value: '10k-50k', count: 0 },
        { value: '50k-100k', count: 0 },
        { value: '100k-250k', count: 0 },
        { value: '250k-plus', count: 0 },
      ],
    },
  ];
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_book', title: 'First Edition', description: 'Add your very first story to your library.', icon: 'ach_first_book', unlockedAt: now - 30 * DAY },
  { id: 'alexandrian', title: 'Alexandrian', description: 'Build up a personal library of several favorites.', icon: 'ach_alexandrian', progress: { value: 2, target: 5 } },
  { id: 'hoarder', title: 'Hoarder', description: 'Stack up unread stories — the to-be-listened pile.', icon: 'ach_hoarder', progress: { value: 3, target: 10 } },
  { id: 'eclectic', title: 'Eclectic Taste', description: 'Add stories from different genres to your collection.', icon: 'ach_eclectic', tier: 'Bronze', unlockedAt: now - 12 * DAY, progress: { value: 5, target: 7 } },
  { id: 'avid_listener', title: 'Avid Listener', description: 'Total hours of narration listened to.', icon: 'ach_avid_listener', tier: 'Silver', unlockedAt: now - 3 * DAY, progress: { value: 14, target: 100 } },
  { id: 'days_streak', title: 'Days Listening Streak', description: 'Longest run of consecutive days with any playback.', icon: 'ach_days_streak', tier: 'Bronze', unlockedAt: now - 2 * DAY, progress: { value: 5, target: 7 } },
  { id: 'page_one', title: 'Page One', description: 'Celebrate 1 week since your first day with the app.', icon: 'ach_page_one', unlockedAt: now - 23 * DAY },
  { id: 'chapter_two', title: 'Chapter Two', description: 'Celebrate 1 month with the app.', icon: 'ach_chapter_two', progress: { value: 30, target: 30 }, unlockedAt: now - 1 * DAY },
  { id: 'annual_edition', title: 'The Annual Edition', description: '1 year anniversary with the app.', icon: 'ach_annual_edition', progress: { value: 31, target: 365 } },
  { id: 'plutarch_peer', title: "Plutarch's Peer", description: 'Open the app on many distinct days.', icon: 'ach_plutarch_peer', progress: { value: 19, target: 25 } },
  { id: 'marking_page', title: 'Marking the Page', description: 'Save your first bookmark during a story.', icon: 'ach_marking_page', unlockedAt: now - 3 * DAY },
  { id: 'drifting_off', title: 'Drifting Off', description: 'Use the sleep timer for the first time.', icon: 'ach_drifting_off' },
  { id: 'critic', title: 'The Critic', description: 'Leave your first rating on a story.', icon: 'ach_critic', unlockedAt: now - 9 * DAY },
];
