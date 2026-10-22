/** A viewfinder ring with a centre dot: what the product does, in one glyph. */
export function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="var(--accent)" strokeWidth="1.75" />
      <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="var(--accent)" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.25" fill="var(--text)" />
    </svg>
  );
}

/** The brand: the logo and the name, one size everywhere, always a link back to the overview. */
export function Brand() {
  return (
    <a href="#" className="sl-tap flex shrink-0 items-center gap-2 text-title font-medium text-text" title="Back to the overview">
      <Logo />
      Sightline
    </a>
  );
}
