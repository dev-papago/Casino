// Inline SVG art. All three cups use the same CUP_SVG markup; nothing tells one cup from another.

// Shared gradients and symbols, mounted once. Hidden by size, not display:none (Chrome drops gradients then).
export const DEFS_SVG = `
<svg class="svg-defs" width="0" height="0" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="g-cup" x1="0" x2="1">
      <stop offset="0" stop-color="#5e0515"/><stop offset=".16" stop-color="#a80f29"/>
      <stop offset=".3" stop-color="#f0566a"/><stop offset=".44" stop-color="#d21b37"/>
      <stop offset=".78" stop-color="#990b23"/><stop offset="1" stop-color="#4a030f"/>
    </linearGradient>
    <linearGradient id="g-cup-top" x1="0" x2="1">
      <stop offset="0" stop-color="#8f0c22"/><stop offset=".35" stop-color="#ff7487"/><stop offset="1" stop-color="#7a0a1c"/>
    </linearGradient>
    <linearGradient id="g-gold" x1="0" x2="1">
      <stop offset="0" stop-color="#7d4f08"/><stop offset=".3" stop-color="#ffe7a3"/>
      <stop offset=".5" stop-color="#f5bb3c"/><stop offset=".8" stop-color="#b47812"/><stop offset="1" stop-color="#5f3a05"/>
    </linearGradient>
    <linearGradient id="g-gloss" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="g-ball" cx=".36" cy=".32" r=".78">
      <stop offset="0" stop-color="#fffdf0"/><stop offset=".3" stop-color="#ffe45c"/>
      <stop offset=".78" stop-color="#f29a05"/><stop offset="1" stop-color="#a85b00"/>
    </radialGradient>
    <symbol id="s-cup" viewBox="0 0 200 220">
      <path d="M54 30 L12 200 A88 16 0 0 0 188 200 L146 30 Z" fill="url(#g-cup)"/>
      <path d="M48.6 52 A51.4 11 0 0 0 151.4 52 L154.4 64 A54.4 12 0 0 1 45.6 64 Z" fill="url(#g-gold)"/>
      <path d="M19.4 170 A80.6 15 0 0 0 180.6 170 L184 184 A84 15.5 0 0 1 16 184 Z" fill="url(#g-gold)"/>
      <polygon fill="url(#g-gold)" stroke="#6b4206" stroke-width="1.5"
        points="100,92 105.3,108.7 122.9,109.2 108.6,118.8 113.9,135.8 100,126 86.1,135.8 91.4,118.8 77.1,109.2 94.7,108.7"/>
      <path d="M64 36 L77 36 L50 194 L34 191 Z" fill="url(#g-gloss)"/>
      <path d="M12 200 A88 16 0 0 0 188 200 L189 206 A89 16.5 0 0 1 11 206 Z" fill="#3d020c"/>
      <ellipse cx="100" cy="30" rx="46" ry="10" fill="url(#g-cup-top)" stroke="#5e0515" stroke-width="2"/>
    </symbol>
    <symbol id="s-chip" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="48" fill="#c8102e" stroke="#5e0515" stroke-width="3"/>
      <circle cx="50" cy="50" r="40" fill="none" stroke="#fff4dc" stroke-width="11" stroke-dasharray="12.57 12.57"/>
      <circle cx="50" cy="50" r="29" fill="url(#g-gold)" stroke="#5e0515" stroke-width="2.5"/>
      <circle cx="50" cy="50" r="21" fill="none" stroke="#7d4f08" stroke-width="2" stroke-dasharray="3 3"/>
    </symbol>
  </defs>
</svg>`;

export const CUP_SVG = '<svg class="cup-svg" viewBox="0 0 200 220" aria-hidden="true"><use href="#s-cup"/></svg>';

export const BALL_SVG = `<svg class="ball-svg" viewBox="0 0 100 100" aria-hidden="true">
  <circle cx="50" cy="50" r="46" fill="url(#g-ball)" stroke="#8a4a00" stroke-width="2"/>
  <ellipse cx="36" cy="31" rx="15" ry="9" fill="#fff" opacity=".75"/>
</svg>`;

export const CHIP_SVG = '<svg class="chip-svg" viewBox="0 0 100 100" aria-hidden="true"><use href="#s-chip"/></svg>';

const SPEAKER = '<path d="M3 9v6h4l5 4V5L7 9H3z" fill="currentColor"/>';
export const SOUND_ON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}
  <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
export const SOUND_OFF_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}
  <path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
