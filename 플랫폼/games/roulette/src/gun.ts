// The revolver (side view, pointing right) and its cylinder (seen from the front), as inline SVG.
// The markup is fixed: nothing from the players goes into it.

/** The muzzle in the revolver's viewBox: the flash goes there. The gun turns about the cylinder's middle. */
export const REVOLVER_PIVOT = { x: 150, y: 64, w: 380, h: 180 };

export const revolverSvg = `
<svg class="revolver" viewBox="0 0 ${REVOLVER_PIVOT.w} ${REVOLVER_PIVOT.h}" aria-hidden="true">
  <defs>
    <linearGradient id="rv-steel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#eef1f7"/><stop offset=".35" stop-color="#a3abbb"/>
      <stop offset=".55" stop-color="#5d6476"/><stop offset="1" stop-color="#262a35"/>
    </linearGradient>
    <linearGradient id="rv-dark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8b93a5"/><stop offset=".5" stop-color="#3e4352"/><stop offset="1" stop-color="#181b23"/>
    </linearGradient>
    <linearGradient id="rv-wood" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a65a2b"/><stop offset=".45" stop-color="#6b3415"/><stop offset="1" stop-color="#3a1907"/>
    </linearGradient>
    <radialGradient id="rv-flash">
      <stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="#ffe27a"/>
      <stop offset=".65" stop-color="#ff7a1a"/><stop offset="1" stop-color="#ff3d00" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <!-- grip -->
  <path d="M84 70 L118 112 Q112 146 84 172 Q54 178 42 160 Q58 122 54 88 Q58 66 84 70 Z" fill="url(#rv-wood)" stroke="#1d0d04" stroke-width="2"/>
  <path d="M66 96 Q72 126 62 152" stroke="#2a1205" stroke-width="2" fill="none" opacity=".55"/>
  <circle cx="82" cy="118" r="4" fill="#c9a24a" stroke="#4a3510"/>
  <!-- frame -->
  <path d="M74 50 H196 V98 H168 L158 112 H112 L94 92 Z" fill="url(#rv-dark)" stroke="#11131a" stroke-width="2"/>
  <!-- trigger guard and trigger -->
  <path d="M116 110 Q114 146 144 146 Q166 146 166 110" fill="none" stroke="url(#rv-dark)" stroke-width="7"/>
  <path class="rv-trigger" d="M136 110 Q142 126 132 136" stroke="#c4cad6" stroke-width="6" fill="none" stroke-linecap="round"/>
  <!-- barrel, ejector rod, front sight -->
  <rect x="190" y="54" width="170" height="24" rx="4" fill="url(#rv-steel)" stroke="#1a1d26" stroke-width="1.5"/>
  <rect x="190" y="76" width="140" height="11" rx="4" fill="url(#rv-dark)"/>
  <rect x="346" y="45" width="9" height="11" rx="2" fill="#aeb5c4"/>
  <line x1="196" y1="60" x2="352" y2="60" stroke="#fff" stroke-opacity=".5" stroke-width="2"/>
  <!-- cylinder -->
  <rect x="124" y="44" width="72" height="60" rx="12" fill="url(#rv-steel)" stroke="#161922" stroke-width="2"/>
  <g stroke="#2b2f3b" stroke-width="4" stroke-linecap="round" opacity=".55">
    <line x1="134" y1="58" x2="186" y2="58"/><line x1="134" y1="74" x2="186" y2="74"/><line x1="134" y1="90" x2="186" y2="90"/>
  </g>
  <!-- hammer -->
  <path class="rv-hammer" d="M88 52 L72 28 Q68 20 78 21 L100 46 Z" fill="url(#rv-dark)" stroke="#11131a" stroke-width="2"/>
  <!-- muzzle flash and smoke -->
  <g class="rv-flash" transform="translate(372 66)">
    <circle r="46" fill="url(#rv-flash)"/>
    <polygon points="0,-30 9,-8 40,0 9,8 0,30 -6,8 -18,0 -6,-8" fill="#fff6c2"/>
  </g>
  <g class="rv-smoke" transform="translate(372 66)">
    <circle r="16" fill="#d9dce4"/><circle cx="18" cy="-8" r="12" fill="#c7cbd6"/><circle cx="10" cy="12" r="10" fill="#e6e8ee"/>
  </g>
</svg>`;

/** The cylinder from the front: six chambers, the one at the top fires next. */
export function cylinderSvg(chambers: number): string {
  const holes = Array.from({ length: chambers }, (_, i) => {
    const a = ((i * 360) / chambers - 90) * (Math.PI / 180);
    return `<circle class="cyl-chamber" data-i="${i}" cx="${(Math.cos(a) * 33).toFixed(2)}" cy="${(Math.sin(a) * 33).toFixed(2)}" r="13"/>`;
  }).join('');
  return `
<svg class="cylinder" viewBox="-62 -62 124 124" aria-hidden="true">
  <defs>
    <radialGradient id="cyl-steel" cx=".35" cy=".3">
      <stop offset="0" stop-color="#e4e8f0"/><stop offset=".6" stop-color="#6c7385"/><stop offset="1" stop-color="#262a35"/>
    </radialGradient>
    <radialGradient id="cyl-brass" cx=".35" cy=".35">
      <stop offset="0" stop-color="#fff3c4"/><stop offset=".5" stop-color="#d4a640"/><stop offset="1" stop-color="#7a5514"/>
    </radialGradient>
  </defs>
  <g class="cyl-rot">
    <circle r="58" fill="url(#cyl-steel)" stroke="#12141b" stroke-width="3"/>
    ${holes}
    <circle r="9" fill="#2b2f3b" stroke="#9aa1b1" stroke-width="2"/>
  </g>
  <path class="cyl-mark" d="M0 -62 L-7 -74 L7 -74 Z"/>
</svg>`;
}
