# Visual Language

## Theme direction

The main stylesheet is `src/styles/main.css`. It uses a deliberate retro desktop aesthetic rather than a neutral modern app look.

## Repeated motifs

- Windows 95/98 chrome colors and bevel borders
- title-bar gradients and pixel-sharp edges
- Winamp-style playlist blacks and electric blues
- mono display accents for ratings, counters, and utility text

## Practical guidance

- Prefer extending the existing CSS variables in `:root` before adding one-off colors.
- Keep borders square. Rounded corners would break the established look.
- Use restrained iconography and tactile button states that feel native to the theme.
- New UI should look consistent with the current title bar, chrome panels, and playlist-style list treatments.

The AGENTS guidance for this repo is accurate: aim for Encarta, Windows 97, and Discworld energy, not generic SaaS styling.
