/** Section 5.2: "spacing, corner, layer, elevation, and occlusion rules". */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const corner = { sm: 6, md: 10, lg: 16, xl: 24 } as const;

/** z-index layer, lowest to highest. */
export const elevation = { rail: 10, surface: 20, overlay: 40, modal: 60 } as const;

export const occlusion = { scrim: "rgba(5, 4, 9, 0.72)" } as const;
