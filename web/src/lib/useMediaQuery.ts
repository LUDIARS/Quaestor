import { useEffect, useState } from "react";

/** matchMedia を購読するフック。 SSR 無しなので初期値は同期で取る。 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Tailwind の md 未満 (767px 以下) をスマホ扱いにする */
export const MOBILE_QUERY = "(max-width: 767px)";
