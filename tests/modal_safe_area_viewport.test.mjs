import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── The first-run modals could not be dismissed in an installed iOS PWA ──────
//
// .pr-layout-001 (the overlay behind BOTH first-run modals) had no box-sizing,
// so height:100% sized its CONTENT box to the viewport and the safe-area
// padding was added on top. Measured in-browser at 402x874 with the real
// iPhone insets (59px Dynamic Island, 34px home indicator): the overlay came
// out 967px tall on an 874px screen -- 93px of overflow, exactly the two
// insets. position:fixed makes that surplus unscrollable, so Save/Skip sat
// under the home indicator where the system swipe gesture eats the tap, and a
// drag only rubber-banded and sprang back.
//
// In a Safari TAB the insets report 0, the padding falls back to 20px, and the
// 40px of overflow left the buttons inside the card's own bottom padding --
// which is why it looked PWA-specific.
//
// After the fix, same measurement: overlay exactly 874px, 0 overflow, buttons
// at 740-817 (25px clear of the home indicator) and hit-testable with the form
// scrolled to the TOP.

