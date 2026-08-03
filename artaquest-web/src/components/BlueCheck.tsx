/** The verified "blue check" — a brand-blue seal with a tick. Shown next to a verified member's name. */
export function BlueCheck({ size = 16, className = "", title = "Verified identity" }: { size?: number; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`inline-block shrink-0 align-text-bottom ${className}`} role="img" aria-label={title}>
      <title>{title}</title>
      <path
        fill="#2352E8"
        d="M12 1.5l2.4 1.9 3 .2.9 2.9 2.3 1.9-1 2.9 1 2.9-2.3 1.9-.9 2.9-3 .2L12 22.5l-2.4-1.9-3-.2-.9-2.9L3.4 15.6l1-2.9-1-2.9 2.3-1.9.9-2.9 3-.2L12 1.5z"
      />
      <path d="M8.2 12.2l2.5 2.5 5.1-5.4" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
