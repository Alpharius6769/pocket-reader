import type { VirtueMood } from '../core/bridge';

export interface Sprite {
  file: string;
  w: number;
  h: number;
  /** White speech field inside the art, in % of the sprite (from virtue_controller.js). */
  bubble?: { top: number; left: number; width: number; height: number };
}

/** Natural sizes measured from public/assets/img/*.webp; bubble boxes from virtueCoordinates. */
export const SPRITES: Record<VirtueMood, Sprite> = {
  waving: { file: 'virtue_waving', w: 416, h: 603, bubble: { top: 52.5, left: 42, width: 55.5, height: 19.5 } },
  smile: { file: 'virtue_smile', w: 426, h: 723, bubble: { top: 33, left: 11, width: 65, height: 19.5 } },
  wink: { file: 'virtue_wink', w: 460, h: 694, bubble: { top: 37.5, left: 4.5, width: 38, height: 55 } },
  point: { file: 'virtue_point', w: 373, h: 706, bubble: { top: 49, left: 11, width: 73.5, height: 20.5 } },
  thinking: { file: 'virtue_thinking', w: 393, h: 605 },
  talking: { file: 'virtue_talking', w: 1203, h: 2084 },
  loading: { file: 'virtue_story_loading', w: 450, h: 579, bubble: { top: 34, left: 62.5, width: 30.5, height: 19.5 } },
  holding: { file: 'virtue_happy_holding_bubble', w: 362, h: 734, bubble: { top: 1.5, left: 13, width: 79, height: 23 } },
  happy: { file: 'virtue_happy_no_paws', w: 341, h: 587, bubble: { top: 38, left: 8, width: 69.5, height: 24.5 } },
  kneeling: { file: 'virtue_kneeling', w: 454, h: 489, bubble: { top: 56.5, left: 49, width: 47.5, height: 25.5 } },
  achievement: { file: 'virtue_achievement', w: 363, h: 596, bubble: { top: 26.5, left: 47, width: 51, height: 23.5 } },
  highscore: { file: 'virtue_highscore', w: 459, h: 608, bubble: { top: 39.5, left: 5.5, width: 34, height: 16.5 } },
  lowscore: { file: 'virtue_lowscore', w: 398, h: 569, bubble: { top: 57.5, left: 57.5, width: 38.5, height: 30.5 } },
  favorite: { file: 'virtue_favorite', w: 326, h: 600, bubble: { top: 21, left: 43.5, width: 50.5, height: 41 } },
  annoyed: { file: 'virtue_annoyed', w: 433, h: 602, bubble: { top: 16.5, left: 47, width: 50, height: 17 } },
  settings: { file: 'virtue_changed_settings', w: 349, h: 608 },
};

export function spriteUrl(mood: VirtueMood) {
  return `./assets/img/${SPRITES[mood].file}.webp`;
}

/** Lines in Virtue's established voice (dialogue pools in virtue_controller.js). */
export const LINES: Partial<Record<VirtueMood, string[]>> = {
  waving: [
    'Welcome home. I was getting restless waiting for you.',
    'Are you ready to listen to a story?',
    'Look who it is. Come, sit close.',
  ],
  holding: ['Your story is ready whenever you want to begin.', 'Settled in? I have the next chapter right here.'],
  point: ['Ears up! Let me scout for new chapters.', "I'll sniff out the latest chapter releases."],
  wink: ['Well? How do I sound now?', "If you want to rest your eyes, I'll take over the narration."],
  thinking: ['Adjusting things precisely to your liking?', "I'll quietly watch while you adjust these settings."],
  happy: ['All saved and locked in. You do not have to lift a finger.', 'Safe and secured for offline reading.'],
  favorite: ["A new favourite? I'll guard this fiercely.", 'Excellent taste.'],
  annoyed: ['These errors test my patience. Sit tight.', "A snag. Don't worry, I'll tear through this."],
  kneeling: ['The end. Thank you for letting me read it with you.'],
  achievement: ['Look at you. Another one for the shelf.'],
  loading: ['Fetching it now. One moment.'],
};

export function pickLine(mood: VirtueMood, seed = Date.now()) {
  const pool = LINES[mood];
  return pool?.length ? pool[seed % pool.length] : null;
}
