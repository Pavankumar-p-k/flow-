/* ===========================================================================
   INTRO CONFIG — the one place to tweak file names and timings.
   Used by main.js (window + shortcuts) and intro.js (animation), so both
   sides always agree.  Paths are relative to the app root.
   =========================================================================== */
module.exports = {
  // Step 1 — three clips, played back to back, no gaps.
  //   clip1 = cat jumps across · clip2 = cat turns and looks up
  //   clip3 = cat jumps to the notch
  clips: [
    "assets/intro/clip1.mp4",
    "assets/intro/clip2.mp4",
    "assets/intro/clip3.mp4",
  ],
  fadeInMs: 150,                     // video layer fades in at the start

  // Step 2 — black burst from the notch centre (ease-in: slow start, fast finish)
  burstMs: 600,
  burstEase: "cubic-bezier(0.42, 0, 1, 1)",
  flashMs: 80,                       // white-blue flash at the notch

  // Step 3 — hold fully black
  holdMs: 300,

  // Step 4 — circle shrinks back into the notch (ease-out)
  revealMs: 800,
  revealEase: "cubic-bezier(0, 0, 0.58, 1)",
  finalRadius: 14,                   // DIP radius where the real notch takes over

  // Debug
  replayShortcut: "CommandOrControl+Alt+N",   // replay the intro
  skipKey: "Escape",                           // skips straight to step 4
};
