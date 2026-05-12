'use strict';
// =================================================
// SHARED SAFE-AREA / BACKGROUND COLOR SYNC
// Used by: ear-tuner, microbreaker
// =================================================
// Keeps Safari notch and bottom-bar color in sync with the app phase.
// Syncs four targets: bg-fill element, body, html, and meta-theme-color.
//
// Callers use design-token values:
//   --color-orange-edge (#4d1903), --color-green-dark (#0d2a1a),
//   --color-bg-panel (#1a1a1a), --color-parchment (#f5efe6)
//
// Note: $ is a global defined in each app's render.js
//       (id => document.getElementById(id))

function setBg(color) {
  const bg = document.getElementById('bg-fill');
  if (bg) bg.style.backgroundColor = color;
  document.body.style.backgroundColor = color;
  document.documentElement.style.backgroundColor = color;
  const mt = document.getElementById('meta-theme');
  if (mt) mt.setAttribute('content', color);
}
