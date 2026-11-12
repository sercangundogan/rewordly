/**
 * "Disable Rewordly on this page" (context menu) stores the page's origin, or its exact URL, in
 * rewordlyDisabledPages. The checker must honour it everywhere on that page: also inside iframes
 * (the editor of a page is often framed, from another origin), and the moment the setting changes.
 */

export interface PageIdentity {
  href: string;
  origin: string;
  /** Origins of the frames above this one, nearest first (location.ancestorOrigins). */
  ancestorOrigins: readonly string[];
}

export function isDisabledHere(disabledPages: readonly string[] | undefined, page: PageIdentity): boolean {
  if (!disabledPages || disabledPages.length === 0) return false;
  const here = new Set([page.href, page.origin, ...page.ancestorOrigins].filter((v) => v && v !== 'null'));
  return disabledPages.some((entry) => here.has(entry));
}

export function currentPage(): PageIdentity {
  return {
    href: location.href,
    origin: location.origin,
    ancestorOrigins: Array.from(location.ancestorOrigins ?? []),
  };
}
