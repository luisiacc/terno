/** The Terno mark (brand/terno-icon.svg), drawn inline so it costs no request. Decorative: the link around it is named. */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className={className}>
      <rect width="100" height="100" rx="24" fill="#2F5BFF" />
      <rect x="18" y="30" width="64" height="44" rx="7" fill="none" stroke="#FFFFFF" strokeOpacity="0.45" strokeWidth="4" />
      <path d="M24 40 L45 56 M76 40 L55 56" fill="none" stroke="#FFFFFF" strokeOpacity="0.45" strokeWidth="4" strokeLinecap="round" />
      <rect x="18" y="28" width="64" height="12" rx="6" fill="#FFFFFF" />
      <rect x="44" y="28" width="12" height="46" rx="6" fill="#FFFFFF" />
    </svg>
  );
}
