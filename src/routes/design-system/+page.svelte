<script lang="ts">
  const swatches = [
    { name: "sea", hex: "#00b9f4", role: "links, focus, to-listen", onDark: true },
    { name: "foam", hex: "#f6f6f6", role: "surfaces, panels, fields", onDark: false },
    { name: "signal", hex: "#f01c1a", role: "danger, delete, errors", onDark: true },
    { name: "sun", hex: "#f0a202", role: "warnings, listening, stars", onDark: true },
    { name: "deep", hex: "#29339b", role: "text, primary buttons, wells", onDark: true },
  ];

  const ramps = [
    {
      name: "sea",
      steps: [
        { hex: "#aee9fd", token: "--sea-soft", text: "#29339b" },
        { hex: "#00b9f4", token: "--sea", text: "#171c55" },
        { hex: "#4dcef7", token: "--sea-mid", text: "#171c55" },
        { hex: "#006686", token: "--sea-deep", text: "#f6f6f6" },
      ],
    },
    {
      name: "foam",
      steps: [
        { hex: "#f6f6f6", token: "--foam", text: "#29339b" },
        { hex: "#e4e4e4", token: "--foam-dim", text: "#29339b" },
        { hex: "#c9c9c9", token: "--foam-line", text: "#29339b" },
      ],
    },
    {
      name: "signal",
      steps: [
        { hex: "#fda3a2", token: "--signal-soft", text: "#29339b" },
        { hex: "#f01c1a", token: "--signal", text: "#f6f6f6" },
        { hex: "#a81412", token: "--signal-deep", text: "#f6f6f6" },
      ],
    },
    {
      name: "sun",
      steps: [
        { hex: "#fcd48a", token: "--sun-soft", text: "#29339b" },
        { hex: "#f0a202", token: "--sun", text: "#171c55" },
        { hex: "#845901", token: "--sun-deep", text: "#f6f6f6" },
      ],
    },
    {
      name: "deep",
      steps: [
        { hex: "#6970b9", token: "--deep-soft", text: "#171c55" },
        { hex: "#29339b", token: "--deep", text: "#f6f6f6" },
        { hex: "#171c55", token: "--deep-deep", text: "#00b9f4" },
      ],
    },
  ];

  const pairings = [
    { fg: "#29339b", fgName: "deep", bg: "#f6f6f6", bgName: "foam", ratio: "9.5", use: "body text" },
    {
      fg: "#5e64b2",
      fgName: "ink-soft",
      bg: "#f6f6f6",
      bgName: "foam",
      ratio: "4.9",
      use: "secondary text",
    },
    {
      fg: "#006686",
      fgName: "sea-deep",
      bg: "#f6f6f6",
      bgName: "foam",
      ratio: "6.0",
      use: "links on light",
    },
    {
      fg: "#a81412",
      fgName: "signal-deep",
      bg: "#f6f6f6",
      bgName: "foam",
      ratio: "7.0",
      use: "danger text on light",
    },
    {
      fg: "#845901",
      fgName: "sun-deep",
      bg: "#f6f6f6",
      bgName: "foam",
      ratio: "5.7",
      use: "warning text on light",
    },
    {
      fg: "#00b9f4",
      fgName: "sea",
      bg: "#29339b",
      bgName: "deep",
      ratio: "4.5",
      use: "links, labels on dark",
    },
    {
      fg: "#f0a202",
      fgName: "sun",
      bg: "#29339b",
      bgName: "deep",
      ratio: "4.8",
      use: "warnings on dark",
    },
    {
      fg: "#f6f6f6",
      fgName: "foam",
      bg: "#29339b",
      bgName: "deep",
      ratio: "9.5",
      use: "primary button labels",
    },
    {
      fg: "#f6f6f6",
      fgName: "foam",
      bg: "#a81412",
      bgName: "signal-deep",
      ratio: "7.0",
      use: "danger button labels",
    },
    {
      fg: "#171c55",
      fgName: "deep-deep",
      bg: "#f0a202",
      bgName: "sun",
      ratio: "7.4",
      use: "text on amber fills",
    },
    {
      fg: "#00b9f4",
      fgName: "sea",
      bg: "#171c55",
      bgName: "deep-deep",
      ratio: "6.9",
      use: "chip / badge labels",
    },
  ];

  const typeScale = [
    { token: "--text-2xs", sample: "FILTER: uppercase micro labels" },
    { token: "--text-xs", sample: "secondary meta, chips, badges" },
    { token: "--text-base", sample: "buttons, inputs, menus, tabs" },
    { token: "--text-md", sample: "list titles, emphasised rows" },
    { token: "--text-lg", sample: "sub-headings (release artist)" },
    { token: "--text-xl", sample: "page headings, dialogs" },
  ];

  const rules = [
    {
      kind: "do",
      text: "Ink is indigo: text on light surfaces is --deep or --ink-soft.",
    },
    {
      kind: "dont",
      text: "Never set cyan or amber text on foam — 2.1:1 and 2.0:1, both fail.",
    },
    {
      kind: "do",
      text: "Cyan and amber speak on dark surfaces (deep, deep-deep, black) or as borders, washes and LED dots.",
    },
    {
      kind: "do",
      text: "Small red text on light uses --signal-deep; red fills take foam labels only at bold/large sizes.",
    },
    {
      kind: "dont",
      text: "There is no green. Done is neutral: --status-done is --drift.",
    },
    {
      kind: "do",
      text: "Pixels only: zero radius, hard 1–3px offsets, bevels over soft shadows.",
    },
  ];
</script>

<svelte:head>
  <title>Design System — On The Beach</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="main main--scroll">
  <div class="ds">
    <a href="/" class="btn btn--ghost">◄ Back</a>

    <h1 class="ds__section-title">On The Beach — Design System</h1>
    <p class="ds__intro">
      Five colours, dressed for 1997. Ink is indigo; foam carries the page; cyan, amber and red
      speak from dark surfaces or as edges and washes. Every pairing shown below is checked
      against WCAG AA.
    </p>

    <!-- ── The five ── -->
    <section class="ds__section">
      <h2 class="ds__section-title">The Five</h2>
      <div class="ds-swatches">
        {#each swatches as s (s.name)}
          <div class="ds-swatch">
            <div class="ds-swatch__chip" style:background={s.hex}>
              {#if s.onDark}
                <span class="ds-swatch__hex" style:color="var(--foam)">{s.hex}</span>
              {:else}
                <span class="ds-swatch__hex" style:color="var(--deep)">{s.hex}</span>
              {/if}
            </div>
            <div class="ds-swatch__name">{s.name}</div>
            <div class="ds-swatch__role">{s.role}</div>
          </div>
        {/each}
      </div>
    </section>

    <!-- ── Ramps ── -->
    <section class="ds__section">
      <h2 class="ds__section-title">Ramps — tints toward foam, shades toward ink</h2>
      {#each ramps as ramp (ramp.name)}
        <div class="ds-type__row">
          <span class="ds-type__label">{ramp.name}</span>
          <div class="ds-ramp">
            {#each ramp.steps as step (step.hex)}
              <div
                class="ds-ramp__step"
                style:background={step.hex}
                style:color={step.text}
                title={step.token}
              >
                {step.hex}
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </section>

    <!-- ── Pairing ledger ── -->
    <section class="ds__section">
      <h2 class="ds__section-title">Pairings — every allowed text pair</h2>
      <table class="ds-pairs">
        <thead>
          <tr>
            <th scope="col">Sample</th>
            <th scope="col">Foreground / background</th>
            <th scope="col">Ratio</th>
            <th scope="col">Use</th>
          </tr>
        </thead>
        <tbody>
          {#each pairings as p (p.fg + p.bg)}
            <tr>
              <td>
                <span class="ds-pairs__sample" style:color={p.fg} style:background={p.bg}>
                  Aa 123
                </span>
              </td>
              <td>{p.fgName} on {p.bgName}</td>
              <td class="ds-pairs__ratio">{p.ratio}:1</td>
              <td>{p.use}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <!-- ── Type scale ── -->
    <section class="ds__section">
      <h2 class="ds__section-title">Type — Tahoma, pixels only</h2>
      {#each typeScale as t (t.token)}
        <div class="ds-type__row">
          <span class="ds-type__label">{t.token}</span>
          <span style:font-size={`var(${t.token})`}>{t.sample}</span>
        </div>
      {/each}
    </section>

    <!-- ── Controls ── -->
    <section class="ds__section">
      <h2 class="ds__section-title">Controls</h2>
      <div class="ds-controls">
        <button type="button" class="ds-btn">Default</button>
        <button type="button" class="ds-btn ds-btn--primary">Primary</button>
        <button type="button" class="ds-btn ds-btn--danger">Delete</button>
        <input class="ds-input" placeholder="Sunken field" />
      </div>
    </section>

    <!-- ── Badges & LEDs ── -->
    <section class="ds__section">
      <h2 class="ds__section-title">Badges &amp; LEDs</h2>
      <div class="ds-controls">
        <span class="ds-badge">To listen</span>
        <span class="ds-badge ds-badge--warn">Listening</span>
        <span class="ds-badge ds-badge--dim">Listened</span>
        <span class="ds-badge ds-badge--alert">Overdue</span>
      </div>
      <div class="ds-controls">
        <span class="ds-led" style:--led="var(--status-todo)">To listen</span>
        <span class="ds-led" style:--led="var(--status-active)">Listening</span>
        <span class="ds-led" style:--led="var(--status-done)">Listened</span>
      </div>
    </section>

    <!-- ── Rules of the system ── -->
    <section class="ds__section">
      <h2 class="ds__section-title">Rules of the system</h2>
      {#each rules as rule (rule.text)}
        <p class="ds-rule">
          <span class="ds-rule__mark ds-rule__mark--{rule.kind}">{rule.kind === "do" ? "✓" : "✗"}</span>
          <span>{rule.text}</span>
        </p>
      {/each}
    </section>
  </div>
</main>
